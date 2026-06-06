# Changelog

## v0.1.7

### Agent

- **SOUL.md identity document.** Feral Agent now ships with a bundled `SOUL.md` that defines its identity, tone, communication style, epistemic standards, and ethical boundaries. The document is the source of truth for how the agent thinks, speaks, and acts — it is injected verbatim as the **first block** of the system prompt (highest priority, overrides vague or contradictory instructions elsewhere in the prompt chain). Concretely:
  - `FeralAgent/src/SOUL.md` — bundled default, version-controlled with the codebase, ships inside the sidecar binary.
  - `~/.feral/SOUL.md` — user override. Create this file to customize the agent's identity without recompiling; the loader prefers the user file when present.
  - `FeralAgent/src/core/soul-loader.ts` — `loadSoul()` (single read, returns `{ content, source, version, loadedAt, approxTokens }`), `watchSoul()` (debounced `fs.watch` on the user override, hot-reloads without restarting the agent), and `resolveSoulPaths()` for "edit your soul here" diagnostics.
  - `AgentLoop.buildSystemPrompt(registry, soul)` — the soul content is the first system-prompt block, separated from the mechanics (tool list, call format) by a `---` divider. Legacy opener is used as a backwards-compatible fallback when no soul is provided.
  - Hot-reload scope: only **new** sessions pick up SOUL changes mid-run. Active sessions keep their original system prompt so the conversation stays coherent.
  - Size guard: soft warning at >4K tokens, hard warning at >10K tokens. Catches accidentally-large edits that would inflate every LLM call.

### Sidecar

- Rebuilt `feral-agent-x86_64-pc-windows-msvc.exe` to bundle the new SOUL loader and identity document. Size delta: ~1.5K tokens of system prompt per call (negligible cost with prompt caching; uncached, ~$0.0045 per call on Anthropic).

## v0.1.6

### Skills

Feral's skill system was redesigned around the same "menu + on-demand body" pattern that powers Claude Code's tool guidance. The previous design dumped every installed skill's full `SKILL.md` into the agent's system prompt on the first turn of a session. That worked for 2–3 skills but degraded quickly — every additional skill added hundreds of tokens to the system prompt whether or not the user actually needed that skill's guidance for the current message.

- **Skill menu in the system prompt.** Rust now ships a `Vec<SkillMeta>` roster with every locally-installed skill (id, name, description, version, tags) on each `message` envelope. The agent renders the roster as a short "Available skills" system message in `WorkingMemory`, with one line per skill. The LLM reads the menu and decides which skill (if any) is relevant before doing any work.
- **`read_skill` tool loads skill bodies on demand.** New tool in `FeralAgent/src/tools/builtin/read-skill.ts`. The LLM calls it with a skill id; the tool reads `~/.feral/skills/<id>/SKILL.md` (validated id charset + path-traversal guard) and returns the raw markdown. Bodies are capped at 64 KB. After loading, the LLM follows the skill's instructions exactly.
- **Per-turn roster refresh.** Because Rust rebuilds the roster on every `feral_send_message`, installing a new skill from the Skills tab is reflected in the agent's available-menu on the very next message — no need to start a new chat, no need to reset the session.
- **Skills menu replaces first-session injection.** The previous "bake the skills into the system prompt on first session" hack in `AgentLoop.#memoryFor()` was removed. Skill install/remove mid-conversation now takes effect immediately.

### Agent

Two real bugs that affected the local-model experience were fixed.

- **Helpful message on empty thinking completions.** When a thinking model (Qwen 3, DeepSeek-R1, Gemma with thinking mode) is cut off mid-reasoning — most often because the model's `max_tokens` was exhausted during the chain-of-thought block — the previous code returned `"(no response)"` and the user saw a silent empty bubble. Worse, the dangling-`<think>` fallback in `stripThinking` discarded everything after the open tag, including the model's final answer if it followed the thinking. The agent loop now distinguishes two cases: if the raw completion contained any thinking tag, it returns a descriptive message explaining the cut-off and how to mitigate (shorter prompt, larger model, or increase `max_tokens`); otherwise it returns a generic "empty response" message. Either way the user gets an actionable explanation instead of silence.
- **`selectLocalAgent` routes through the model store.** In Agent mode, picking a local model from the chat header used to call `tauri.models.startLoad` directly, bypassing the `useModel` Zustand store. The store's `isLoading` and `loadProgress` were never set, so the ModelPill had no progress to display. The flow now goes through `store.load()` which sets up the `model-load-progress` event listener, updates the store, and lets the UI render. The ModelPill now shows a thin `role="progressbar"` bar at the bottom of the trigger that fills as the model loads — the user always knows whether the load is in progress or done.

### Deferred to v0.1.7

- **ChatGPT Subscription OAuth.** The architecture is researched (issuer `https://auth.openai.com`, PKCE S256, redirect `http://localhost:1455/auth/callback`, scope `openid profile email offline_access api.connectors.read api.connectors.invoke`, token-exchange grant to derive an API key from the OAuth token). The Codex CLI's `CLIENT_ID` is still missing from the public research; the OAuth UI and Rust flow will land in v0.1.7 once the client id is sourced.

## v0.1.5

### Mascot
- **8-bit animated mascot.** A 16×16 pixel-art fluffy black monster with orange horns, big eyes, and two fangs now lives permanently on the typing bar. Reacts to what you're doing: blinks while idle, looks down while you type, eyes dart side-to-side while thinking, scans down while calling a tool, hops happily when the model finishes.
- **Idle boredom run.** After 18 seconds of inactivity the mascot gets bored, switches to a side-profile silhouette, and runs across the full width of the typing bar — leaving small pixel dust puffs in its wake — then flips around and runs back. Any activity (typing, streaming) snaps it straight back to the perch.
- **Reduced-motion support.** All canvas animations respect `prefers-reduced-motion`.

### Agent
- **Token cap removed.** No more daily or per-conversation token budget. Feral Agent runs on BYOK (user pays own provider), so capping was pointless and caused agent sessions to silently stall. Budget can be re-enabled via `FERAL_BUDGET_DAY` / `FERAL_BUDGET_CONVERSATION` env vars if needed.
- **CI sidecar fix.** Release builds now compile the Feral Agent sidecar from the vendored `FeralAgent/` directory in the monorepo instead of cloning an outdated external repository. Eliminates a class of "agent not responding in production release" bugs.

### UI fixes
- **Real app version in sidebar.** The version badge now reads from the Tauri API instead of the previously hardcoded `v0.1.3` string.
- **Context ring in agent mode.** The ring no longer stays stale when using the agent. It now shows a comet-arc activity indicator during agent streaming (the sidecar doesn't emit live token counts, so the spinning arc is the honest signal).

## v0.1.4

### Agent mode
- **Native Feral Agent runtime.** Agents now run on a built-in Feral Agent sidecar (Bun/TS) wired directly into the chat stream — no external gateway process. A Chat/Agent toggle in the composer switches modes and auto-loads the selected local model into the agent engine.
- **DeepResearch & adaptive reasoning.** Dynamic max-iteration budgets for deep-research and complex tasks, model-fitness scoring, error-correcting control loop, and persistent agent memory.
- **Sturdier tool calls.** Parser now handles Gemma-style `<tool_call>`, bracket and bare-JSON formats, and the `arguments` key; adds silent tool calls and an empty-response fallback; raises token budgets for thinking models.

### Chat & UI
- **Live context ring.** Real token usage straight from the model — exact prompt tokens from llama.cpp locally, real usage stats from cloud providers — with a hover popover showing tokens used, free space and message count, and the model's true context window instead of an estimate.
- **Streaming polish.** Words fade in one-by-one as tokens stream, and a phase indicator shows Thinking / Calling tool / Processing.
- **Thinking blocks.** Support for multiple formats (`<think>`, `<thinking>`, `<|channel>`), a thinking timer, and blocks that now persist across chat and tab switches.
- **Response resilience.** Partial responses are always persisted, and responses survive navigating away and back, tab switches, and hot-swapping the active model.

### Stability & performance
- Fix a `GGML_ASSERT` crash on long agent prompts by chunking the prefill batch.
- Memoize message rendering so streaming no longer re-parses already-completed messages.
- Warning-free `cargo clippy` on the inference build, repo hygiene (`.gitattributes`, corrected `.gitignore`), and `unist-util-visit` pinned as a direct dependency.

## v0.1.3

Initial tracked release. See the GitHub release for details.
