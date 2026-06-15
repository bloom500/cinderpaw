# Connector Surface v1 — Discord inbound — Design

**Date:** 2026-06-15
**Status:** Approved design, ready for planning
**Related:** flagship "Feral devine al tău" (local moat + messaging reach); MCP fix commit `7c2c024`

## Context

Today Feral can drive Discord *outbound* (the `mcp-discord` MCP server: the agent
sends/reads when prompted from the Feral app). What the user wants — and what
OpenClaw/Hermes offer — is the *inbound* direction: **talk to the agent directly
from Discord** and have it reply there, using the local runtime (local model,
local tools, the user's machine). That is the "Connector Surface": a thin
messaging surface over the local agent, not a headless pivot. The moat (your
model, your flows, your machine) travels to where you already chat; a cloud
gateway like OpenClaw/Hermes structurally cannot reach your local UI/weights.

This spec covers **Discord inbound** as the first connector and the
**Connectors** section of the app that will host every future platform
(Telegram, WhatsApp/OpenWA, Slack-as-connector, …).

## Architecture fit (why this is clean, not a hack)

The sidecar's agent core is already transport-agnostic
(`FeralAgent/src/transports/interface.ts`, `types.ts` `Transport` /
`InboundMessage` / `OutboundEvent`). Message handling funnels through
`agent.handle(sessionId, content, id, emit)` where `emit` is a **per-message**
callback (`index.ts:688`). So multiple transports can share ONE agent instance,
each routing its own replies. No global router needed.

The Discord connector runs **alongside** the Tauri transport in the same sidecar
process (not a second agent, not a second model load). Tauri transport keeps its
full control-message handling (set_model, stop, ask_user, desktop_control,
cron). The Discord connector only uses the `message` path.

## Components

### 1. Shared message handler (sidecar refactor — small)
Extract the `type === "message"` branch of `transport.onMessage` in `index.ts`
into a reusable `handleUserMessage(agent, { sessionId, content, id, images?,
inferParams?, skillsContext? }, emit)`. Tauri transport and Discord connector
both call it. Net change: move ~20 lines into a function; behavior identical for
Tauri.

### 2. `DiscordConnector` (`FeralAgent/src/transports/discord.ts`)
- Connects with `discord.js` `Client`, intents: `Guilds`, `GuildMessages`,
  `MessageContent`, `DirectMessages`.
- On `messageCreate`: ignore bots/self; **allowlist check** (exact Discord user
  ID); accept only **DMs** or **@mentions** in guild channels (v1 scope).
- Maps to a user message; `sessionId = "discord:" + channelId` (one
  conversation per channel/DM). Calls `handleUserMessage` with an `emit` that:
  - buffers `chunk`/`done` text, shows a typing indicator while working,
  - posts the final `done.content` to the originating channel (split at 2000
    chars), prefixed/threaded as a reply,
  - posts `error.message` on failure.
- `desktop_control_request` still flows to the Rust host (host-level, transport-
  independent) — works unchanged.
- `ask_user` over Discord (v1): post the question text; the user's next message
  in that channel is fed as a normal follow-up message. Structured options are a
  v2 refinement.

### 3. `ConnectorManager` (sidecar)
Starts after the Tauri transport is ready. Reads `~/.feral/connectors.json`,
starts an enabled connector with its token + allowlist. Handles a new inbound
control message `connectors_reload` (added to `InboundMessage` + `isInbound`)
so toggling in the UI reconciles connectors without restarting the sidecar.

### 4. Connector config store (Rust — `src-tauri/src/connectors.rs`)
Mirrors `mcp.rs` shape/discipline.
- Persists `~/.feral/connectors.json`: `[{ id, enabled, token, allowlist:
  Vec<String> }]`. Token + allowlist stay backend-side; the frontend never
  receives the token (view exposes `has_token: bool` + `allowlist`).
- Catalog: `discord` (live); `telegram`, `whatsapp` (OpenWA), `slack` marked
  `coming_soon` (rendered disabled).
- Commands (`#[tauri::command]`, specta): `connectors_catalog`,
  `connectors_list`, `connectors_save(id, token?, allowlist)`,
  `connectors_set_enabled(id, enabled)`, `connectors_remove(id)`. Each that
  mutates also signals the sidecar (`connectors_reload`).
- **Token preservation (explicit user requirement):** when the Discord
  connector has no token yet, seed it from the existing `mcp.json` `discord`
  server's `DISCORD_TOKEN` env. The token the user already entered in
  Extensions carries over automatically — no re-entry.

### 5. Frontend `ConnectorsPage` (`frontend-react/src/pages/ConnectorsPage.tsx`)
- New route `/connectors` (router.tsx) + Sidebar entry directly under
  Extensions.
- Visual language reused from `ExtensionsPage`: hero, "Connected" section with
  on/off + status dot, "Available" grid. Connectable apps as cards (Discord
  live; Telegram/WhatsApp/Slack "Coming soon", disabled).
- Discord card config form: **Bot token** (password) + **Allowed Discord user
  IDs** (multiline / comma list). On/off toggle. Pre-fills `has_token`/allowlist
  from `connectors_list`.

## Security (decided: allowlist + full tools)

- Allowlist of **exact Discord user IDs** (not usernames — spoofable). Default
  empty = only the owner once they add their own ID. Non-allowlisted senders are
  **ignored silently**.
- Allowlisted users get the **full tool profile** (same as in-app), per user
  choice. High power, high stakes — mitigations:
  - Allowlist is the gate; empty by default; exact-ID match only.
  - Desktop control keeps its existing opt-in + confirmation gate (host-level),
    so "full tools" does not bypass that guard.
  - Token never crosses to the frontend.
- Honest note in the UI: "Anyone you add here can command your assistant — and
  its tools — on this machine."

## Scope (YAGNI for v1)

IN: Discord; DM + @mention; allowlist; full tools; buffered single-message
reply (split >2000); typing indicator; token preservation; Connectors page with
coming-soon cards.

OUT (v2+): token-streaming/edited replies; structured ask_user over Discord;
Telegram/WhatsApp/Slack implementations; per-connector restricted tool profiles;
slash commands; threaded multi-turn UX niceties.

## Key implementation risks

1. **`discord.js` under `bun build --compile`** (sidecar ships as a compiled
   `.exe`; see Sidecar Binary Flow). Validate it bundles. Fallback: lighter
   `@discordjs/core` + `@discordjs/ws`, or a minimal raw Gateway WS client.
   Prove this in Slice 2 before building the UI on top.
2. **Sidecar rebuild discipline:** TS changes need `bun run build` + copy to
   `src-tauri/binaries/`; `cargo tauri dev` does NOT auto-rebuild the sidecar.

## Implementation slices

1. **Backend store** — `connectors.rs` (config, catalog, commands, token
   preservation), registered in `lib.rs`. Verify: `cargo check`.
2. **Sidecar engine** — shared `handleUserMessage` refactor; `DiscordConnector`;
   `ConnectorManager`; `connectors_reload` inbound. Verify: `bunx tsc`,
   `bun build --compile` (the discord.js compile test), a local stdio smoke run.
3. **Frontend** — `ConnectorsPage`, route, sidebar, tauri command bindings.
   Verify: `bunx tsc`, frontend build.
4. **Wire + live test** — toggle→reload path end-to-end; user runs a real
   Discord DM against their bot token to confirm round-trip.

## Verification

- `cargo check` (backend), `bunx tsc --noEmit` + `bun build --compile`
  (sidecar), frontend typecheck/build.
- Compile smoke: send `initialize`-equivalent inbound to the sidecar with a
  Discord connector configured but offline token → starts without crashing.
- Live (user): DM the bot from an allowlisted ID → agent replies in the DM;
  message from a non-allowlisted ID → ignored.
