# Changelog

## v0.2.1

*Released 2026-06-12 — Windows, macOS (Apple Silicon + Intel), and Linux.*

### Fixed

- **Raw tool calls no longer leak into the chat.** Two holes closed: the
  inference providers streamed the re-encoded `<tool_call>{json}</tool_call>`
  tag to the UI as visible tokens, and the frontend only suppressed tool-call
  text at the *start* of a streamed answer — prose followed by a mid-message
  tool call (e.g. `<tool_call>{"name="memory_graph">`) was displayed verbatim.
  Tool calls now travel only through the parsed content channel, and the
  streaming view cuts tool-call text anywhere it appears (including a partial
  opener at the end of the buffer), keeping the prose before it visible.
- **The agent no longer stops mid-task on a malformed tool call.** When a
  model emitted a tool call with corrupted JSON, the parser scrubbed it but
  executed nothing, and the loop treated the turn as a final answer — the
  task silently died. The loop now detects the malformed attempt and feeds a
  corrective nudge back to the model so it can re-emit a valid call (bounded
  at 3 retries).
- **Parallel tool calls are no longer dropped.** All providers (OpenAI-
  compatible, Ollama, Anthropic) re-encoded only the *first* native tool call
  of a turn; any additional calls were silently discarded, leaving the model
  waiting on results that never arrived. Every call in the turn is now
  executed.
- **`ask_user` works reliably with native function calling.** The native tool
  schema declared `questions` as a bare array with no item structure, so
  models had to guess the nested `{question, options:[{label}]}` shape and
  most calls failed validation. Tools can now publish a full JSON Schema per
  parameter, and `ask_user` ships one — including option labels, descriptions,
  the `recommended` flag, and multi-select.

## v0.2.0

*Released 2026-06-12 — Windows, macOS (Apple Silicon + Intel), and Linux.*

### ⚠️ Migration notes from 0.1.x

- **Updater key rotation.** The original update-signing key was exposed in the
  public git history and has been rotated. Upgrading from **0.1.7 or older**
  requires either installing the transitional **0.1.8** release first (it
  carries the new verification key) or downloading the 0.2.0 installer
  manually one time. Full plan: `docs/UPDATER_KEY_MIGRATION.md`.
- Onboarding, conversations, models, and BYOK keys carry over unchanged.

### New

- **Vision — the agent can finally see your images.** Pasted screenshots
  (Ctrl+V) and uploaded image files now reach the model as real pixel data
  (base64 data URLs), not just a `[Image attached: …]` filename note. Works on
  both inference paths: direct chat (BYOK cloud via OpenAI `image_url` content
  parts) and the Feral Agent sidecar (OpenAI-compatible, Ollama `images`, and
  Anthropic base64 blocks). Local llama.cpp GGUF models remain text-only and
  keep the filename note.
- **Memory that actually carries over.** New conversations no longer start
  cold: the chat tab now injects a "[Memory context]" block (facts from the
  shared knowledge graph) into the system prompt on every send, and runs a
  background extraction pass after each completed turn that writes
  subject–predicate–object triples back into `~/.feral/memory-graph.json` —
  the same graph the agent sidecar maintains. The sidecar side recalls graph
  facts at every turn too, extracts from the very first assistant turn
  (previously only every 3rd — short chats never learned anything), and the
  previously-unregistered `memory_ops` / `memory_graph` tools are now live so
  "remember X" / "forget Y" take effect immediately.
- **Memory Graph page redesign.** Cognee-inspired dark visualization: glowing
  neon nodes on a near-black canvas, degree-scaled node sizes, a filter rail
  with per-type counts, relation chips, free-text node search, a labels
  toggle, and a click-to-inspect detail card showing a node's connections.
- **MCP Extensions (native connector).** Feral now consumes Model Context
  Protocol servers through the official `rmcp` Rust SDK, managed entirely in
  the Tauri host. New "Extensions" entry in the sidebar (under Skills) with an
  app-store style UI: curated catalog (File Access, Long-term Memory, GitHub,
  Web Search, Browser Automation, Deep Reasoning), one-click install, on/off
  toggle, "What can it do?" tool listing, and humanized errors. No transports,
  JSON-RPC, raw values, internal paths, or API keys ever reach the frontend;
  configs (including keys) live backend-side in `~/.feral/mcp.json`.
- **Drag & drop + paste attachments — any file type.** Files and images can
  be dropped onto the chat input, and screenshots paste straight from the
  clipboard (Ctrl+V). PDFs and Office documents (.docx, .pptx, .xlsx, .odt)
  are now parsed natively (new Rust `extract_file_text` command) so their
  text reaches the model; plain-text files of any extension work as before;
  and true binaries are attached as a path reference the agent can open with
  its file tools instead of becoming a dead "Unsupported format" chip. The
  agent path now receives every attachment too — previously files whose text
  couldn't be extracted were silently dropped and never reached the model.
- **macOS and Linux releases.** The release pipeline now builds and signs
  installers for Windows (.msi/.exe), macOS Apple Silicon + Intel (.dmg),
  and Linux (.deb/.rpm) from a single tag, updater manifest included.
  The agent sidecar resolves its per-platform binary on all five targets.
- **Mascot redesign — the real Feral monster.** The pixel companion is now
  the brand mascot itself: charcoal-black fluffy monster with orange horns,
  an orange face plate with big black eyes, tiny white fangs, and a round
  orange belly. 55 animated variants across all 22 states, composed from a
  single base sprite so the cast stays consistent (laptop typing, thought
  clouds and lightbulbs, magnifier searches, party hats, heart eyes, a real
  side-run cycle, dissolve-in spawning, and more). It also renders 26%
  larger at a crisp integer 3× pixel scale, so every state, variant, and
  effect is clearly readable without crowding the chat input. A procedural
  pixel-effects layer plays around it per state: confetti on celebrate,
  rising hearts, drifting Z's while sleeping, thought dots, an orbiting
  search ring, a drawn-in green check on done, flashing error cross, work
  sparks during tool calls.
- **Sonnet-style agent voice.** SOUL.md rewritten (super friendly + ultra
  useful), plus new bundled IDENTITY.md and AGENTS.md companions — each
  user-overridable at `~/.feral/<NAME>.md` — composed into the system prompt.
- **Contributor guide.** `docs/CONTRIBUTOR_GUIDE.md`: three-runtime
  architecture, IPC protocols, test matrix, build & release flow.

### Stability

- **macOS/Linux: cloud model selection works in agent mode.** The agent
  sidecar binary is now resolved next to the main executable
  (`Contents/MacOS/feral-agent` in the .app bundle, `/usr/bin/feral-agent`
  on deb/rpm installs) where Tauri actually places it — previously only the
  resource directory was checked, so the sidecar was silently dead on
  macOS/Linux production installs and picking a cloud (BYOK) model from the
  model selector did nothing. Model-switch failures (sidecar offline,
  provider disabled, missing key) now surface as error notifications
  instead of vanishing silently.
- **Agent stop actually stops (this release).** The Stop button's signal now
  travels the whole chain: new `feral_stop_generation` Tauri command → `stop`
  message over sidecar stdin → `AgentLoop.stop(sessionId)` aborts the
  in-flight inference fetch and any running tool. Previously the frontend
  called a Rust command that didn't exist, so agent generations were
  unstoppable.
- **Agent tasks survive chat/tab switches.** A live per-session mirror
  (`lib/feralLiveSession.ts`) accumulates streamed content, tool bubbles, and
  agent phase even while another chat is on screen; re-opening the in-flight
  conversation rehydrates all of it instead of showing the stale disk
  snapshot (which made tasks look reset during long tool runs).
- **Tool-call bubbles behave.** The mascot's tool-call stack now grows upward
  from above the mascot (it could previously extend down over the typing
  bar), and each finished bubble fades out on its own after 4s instead of
  piling up until the turn ended.

- **Unified stream stop (A2).** One stop entry point (`lib/streamControl.ts`)
  routes Stop to whichever path (chat backend / agent sidecar) actually owns
  the in-flight generation. Previously the Stop button in Agent mode told the
  idle chat backend to stop while the sidecar kept generating. Feral streams
  are stoppable per-session, and a new send interrupts the previous in-flight
  stream on both paths.
- **Sidecar supervision (#11).** The Tauri shell now watches the agent sidecar
  process, restarts it with backoff on crashes, and shows an "agent offline /
  restarting" banner. Before: a sidecar crash made Agent mode silently mute.
- **GGUF chat template (A4).** The prompt format is now read from the model's
  own GGUF metadata (`tokenizer.chat_template`) via llama.cpp's template
  engine; the filename-based guess is only a fallback. A renamed GGUF no
  longer gets a wrong template and corrupted output.
- **Real tokenizer endpoint (P3).** New `/tokenize` route on the local API
  backed by the loaded model's actual vocabulary; the agent's context
  accounting no longer relies on GPT-2 BPE guesses, and token counts are
  cached per message text.
- **Idle-timeout transparency (#13).** A stream that stalls for 300s is now
  reported as an explained error ("model stopped responding…") instead of
  silently ending in a fake "stopped by user" state.
- **No more mid-reasoning dead ends.** When a completion exhausts its
  per-call token limit while the model is still thinking, the agent loop now
  feeds the partial reasoning back and asks the model to finish — up to 4
  automatic continuations — instead of surfacing "(The model used all
  available tokens on reasoning and produced no answer)". Tasks complete
  end-to-end regardless of the Max Tokens slider.

### Error handling

- **Root React ErrorBoundary (#9).** A render exception now shows a recovery
  screen (try again / reload) instead of a blank window.
- **Humanized inference errors (#10).** Raw provider errors (401/429/network/
  context overflow…) are mapped to plain-English messages with a fix-it
  action (e.g. "key rejected → Open Cloud Keys"); the raw error stays
  available under "Technical details". Local-engine failures no longer leak
  `[Error: …]` text into the chat transcript.
- **Cron visibility (X3).** Scheduled jobs now run through the full agent
  loop (tools, memory, budgets) instead of a bare LLM call, and their results
  and failures surface as toasts. Failed runs emit a `cron_error` event.

### First-run experience

- **Zero-models flow (#14).** After the first model download finishes, it is
  loaded automatically (when nothing else is loaded), taking a fresh install
  from "empty app" to "ready to chat" without a manual Load click.
- **Hardware-aware recommendation (#15).** The onboarding wizard's final step
  now reads your RAM/VRAM/Vulkan detection and recommends a concrete model
  size + quantization to download.
- **Slow-start indicator (#16).** While a model loads (with %) or a long
  prompt prefills, the chat shows an explanatory status instead of silent
  dots.
- **Onboarding sequencing (#17).** The agent-creation flow now actually
  mounts (it was unreachable) and never stacks on top of the first-run
  wizard.

### UI

- **Tool-call bubbles (#18)** are interactive: finished calls expand to show
  the tool's output (or error), and long-running tools show live
  retry/progress notes.
- **Empty states (#19)**: HuggingFace browse now explains "no results" instead
  of rendering a blank list.
- **i18n groundwork (#20)**: typed EN/RO dictionary wired to the existing
  language setting; chat surface migrated first, the rest moves incrementally.
- **Accessibility (#21)**: the search overlay is a proper dialog (focus
  restore, Escape from anywhere, arrow-key navigation, combobox semantics).
- **Window dragging (#22)**: Models and Settings pages gained drag regions —
  the frameless window is now movable from every page, not just Chat.
- **Mascot (#23–26)**: reacts to ask_user prompts (curious) and sidecar
  downtime (asleep); can be disabled in Settings → Appearance; greets you in
  the onboarding wizard; single-animation states gained cadence variants so
  long sessions don't loop one identical animation.

### Docs

- README rewritten for 0.2.0 (install matrix, hardware requirements, BYOK
  quick start, honest privacy section, current screenshots).
- New: `SECURITY.md` (threat model + reporting), `docs/UPDATER_KEY_MIGRATION.md`,
  `docs/USER_GUIDE.md` (Agent vs Chat, tools, skills), `docs/CONTRIBUTING.md`
  (architecture, tests, builds).

## v0.1.7

### Agent

- **SOUL.md identity document.** Feral Agent now ships with a bundled `SOUL.md` that defines its identity, tone, communication style, epistemic standards, and ethical boundaries. The document is the source of truth for how the agent thinks, speaks, and acts — it is injected verbatim as the **first block** of the system prompt (highest priority, overrides vague or contradictory instructions elsewhere in the prompt chain). Concretely:
  - `FeralAgent/src/SOUL.md` — bundled default, version-controlled with the codebase, ships inside the sidecar binary.
  - `~/.feral/SOUL.md` — user override. Create this file to customize the agent's identity without recompiling; the loader prefers the user file when present.
  - `FeralAgent/src/core/soul-loader.ts` — `loadSoul()` (single read, returns `{ content, source, version, loadedAt, approxTokens }`), `watchSoul()` (debounced `fs.watch` on the user override, hot-reloads without restarting the agent), and `resolveSoulPaths()` for "edit your soul here" diagnostics.
  - `AgentLoop.buildSystemPrompt(registry, soul)` — the soul content is the first system-prompt block, separated from the mechanics (tool list, call format) by a `---` divider. Legacy opener is used as a backwards-compatible fallback when no soul is provided.
  - Hot-reload scope: only **new** sessions pick up SOUL changes mid-run. Active sessions keep their original system prompt so the conversation stays coherent.
  - Size guard: soft warning at >4K tokens, hard warning at >10K tokens. Catches accidentally-large edits that would inflate every LLM call.

### Security (process sandbox)

F0 hardening pass. Every tool that calls out to the host shell now has explicit regression tests for the most dangerous attack surfaces, and a latent escape was closed.

- **Symlink escape closed.** `resolveAllowedPath()` in `sandbox/tool-permissions.ts` now uses `realpathSync()` to follow symlinks before checking containment. A symlink inside an allowed root that points outside (e.g. `/allowed/escape → /etc/passwd`) is now rejected with `PermissionDeniedError`. Previously only `path.resolve()` was used, which normalized `..`/`.` but did NOT follow symlinks — a symlink-based containment bypass was possible. The check falls back to `path.resolve()` for paths that don't exist yet, so write-tools can target brand-new files inside the root.
- **`which()` helper unit tests.** Direct unit tests for the bare-name → absolute-path resolver. Confirms it finds real binaries, rejects names with path separators, and returns null for empty / unknown names.
- **Environment blocklist verified by test.** `LD_PRELOAD`, `LD_AUDIT`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`, `PYTHONPATH` are all stripped from caller-supplied env before reaching the child. A new regression test passes each of these through `run()` and asserts they do not reach the spawned process. `PATH` overrides from the caller are silently ignored (test confirms the process still completes without error).
- **Output truncation verified by test.** A regression test runs a runaway writer (`yes` on POSIX, `for /L` on Windows) and asserts the output cap kicks in, the result is marked `outputTruncated: true`, and the truncation marker is present. Runaway children can no longer fill the host's memory.
- **PATH-hijack guidance documented.** A test confirms the recommended hardening: when `allowedExecutables` uses **absolute paths** (e.g. `["/bin/sh"]`), a malicious `sh` placed earlier in `safeBaseEnv.PATH` cannot shadow the real one — the sandbox matches by path (Case B), not by basename+PATH-walk (Case C). Current `shell_exec` and `git_*` manifests still use bare names (`["sh"]`, `["git"]`) for cross-platform flexibility; a future hardening pass should resolve bare names to absolute paths at manifest registration time to close the last PATH-hijack window.

### Sidecar

- Rebuilt `feral-agent-x86_64-pc-windows-msvc.exe` to bundle the new SOUL loader, hardened `resolveAllowedPath`, and the new regression tests. Size delta: ~1.5K tokens of system prompt per call (negligible cost with prompt caching; uncached, ~$0.0045 per call on Anthropic).

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
