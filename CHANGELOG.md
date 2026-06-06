# Changelog

## v0.1.6

### Skills
- **Claude Code-style skill injection.** The system prompt now carries only a short "Available skills" menu (id, name, description) instead of dumping every installed skill's full body. The new `read_skill` tool lets the LLM load the full `SKILL.md` body of any installed skill on demand. Skills are refreshed every turn from Rust, so installing or removing a skill mid-conversation shows up in the next message without resetting the session.

### Agent
- **Helpful message on empty thinking completions.** When a model is cut off mid-reasoning and produces no visible answer, the chat now shows a clear message (distinguishing "model used all tokens on reasoning" from a true empty response) instead of a silent empty bubble.
- **`selectLocalAgent` routes through the model store.** In Agent mode, picking a local model from the chat header now goes through the store's `load()` method, so the ModelPill renders a real progress bar (with `role="progressbar"`) instead of bare text.

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
