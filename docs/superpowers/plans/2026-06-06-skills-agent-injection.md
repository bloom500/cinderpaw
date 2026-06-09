# Skills → Agent Injection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Installed skills (SKILL.md files in `~/.feral/skills/`) are automatically injected into the Feral Agent's system prompt when sending a message, so the agent knows about and follows them.

**Architecture:** Tauri backend reads all installed skills via the existing `skills::local_list()` + `skills::get_installed_content()` functions, serialises their content into a single `skillsContext` string, and includes it in the JSON envelope sent to the sidecar. The sidecar appends it to the system prompt for that session.

**Tech Stack:** Rust (Tauri backend, `src-tauri/src/`), TypeScript/Bun (Feral Agent sidecar, `FeralAgent/src/`)

---

## File Map

| File | Change |
|------|--------|
| `FeralAgent/src/types.ts` | Add `skillsContext?: string` to `InboundMessage` |
| `FeralAgent/src/core/agent-loop.ts` | Pass optional extra context into `#memoryFor()` / `WorkingMemory` |
| `FeralAgent/src/index.ts` | Forward `msg.skillsContext` to `agent.handle()` |
| `src-tauri/src/lib.rs` | Read skills in `feral_send_message`, include in JSON envelope |

No new files. `src-tauri/src/skills.rs` is used as-is (functions are already `pub`).

---

## Task 1: Add `skillsContext` field to InboundMessage type

**Files:**
- Modify: `FeralAgent/src/types.ts:224-235`

- [ ] **Step 1: Edit the InboundMessage interface**

  Open `FeralAgent/src/types.ts`. The interface currently ends at line 235. Add one optional field after `apiKey`:

  ```typescript
  export interface InboundMessage {
    type: "message" | "ping" | "shutdown" | "set_model";
    id?: string;
    content?: string;
    sessionId?: string;
    provider?: string;
    model?: string;
    baseUrl?: string;
    /** API key injected by Rust from the BYOK store — never touches React. */
    apiKey?: string;
    /** Installed skill contents, concatenated by Rust before sending. Present only on type==="message". */
    skillsContext?: string;
  }
  ```

- [ ] **Step 2: Type-check**

  ```bash
  cd FeralAgent && bun run tsc --noEmit
  ```
  Expected: no errors.

- [ ] **Step 3: Commit**

  ```bash
  git add FeralAgent/src/types.ts
  git commit -m "feat(agent): add skillsContext field to InboundMessage type"
  ```

---

## Task 2: Thread skillsContext through AgentLoop

**Files:**
- Modify: `FeralAgent/src/core/agent-loop.ts` — `handle()` method (line 94) and `#memoryFor()` (line 253)

The system prompt is built once in the constructor (`this.#systemPrompt`, line 87) and used per-session in `#memoryFor()` (line 256: `new WorkingMemory(this.#systemPrompt)`). The simplest correct fix: `handle()` accepts an optional `extraContext`, derives the effective prompt for that session, and passes it to `#memoryFor()`.

- [ ] **Step 1: Update `handle()` signature to accept `skillsContext`**

  Current signature (line 94):
  ```typescript
  async handle(
    sessionId: string,
    userText: string,
    messageId: string,
    emit: EventSink,
  ): Promise<string>
  ```

  New signature:
  ```typescript
  async handle(
    sessionId: string,
    userText: string,
    messageId: string,
    emit: EventSink,
    skillsContext?: string,
  ): Promise<string>
  ```

- [ ] **Step 2: Pass `skillsContext` into `#memoryFor()`**

  Current call at line 100:
  ```typescript
  const memory = this.#memoryFor(sessionId);
  ```

  New:
  ```typescript
  const memory = this.#memoryFor(sessionId, skillsContext);
  ```

- [ ] **Step 3: Update `#memoryFor()` to inject skills on first use**

  Current implementation (lines 253-260):
  ```typescript
  #memoryFor(sessionId: string): WorkingMemory {
    let memory = this.#sessions.get(sessionId);
    if (!memory) {
      memory = new WorkingMemory(this.#systemPrompt);
      this.#sessions.set(sessionId, memory);
    }
    return memory;
  }
  ```

  New:
  ```typescript
  #memoryFor(sessionId: string, skillsContext?: string): WorkingMemory {
    let memory = this.#sessions.get(sessionId);
    if (!memory) {
      const prompt = skillsContext
        ? `${this.#systemPrompt}\n\n## Installed skills\n${skillsContext}`
        : this.#systemPrompt;
      memory = new WorkingMemory(prompt);
      this.#sessions.set(sessionId, memory);
    }
    return memory;
  }
  ```

  Note: skills are injected only when a NEW session is created (first message). Subsequent messages in the same session reuse the existing WorkingMemory. This is correct — skills don't change mid-conversation.

- [ ] **Step 4: Type-check**

  ```bash
  cd FeralAgent && bun run tsc --noEmit
  ```
  Expected: no errors.

- [ ] **Step 5: Commit**

  ```bash
  git add FeralAgent/src/core/agent-loop.ts
  git commit -m "feat(agent): inject skillsContext into WorkingMemory on session creation"
  ```

---

## Task 3: Forward skillsContext in the transport handler

**Files:**
- Modify: `FeralAgent/src/index.ts:208-231` — the `case "message":` handler

- [ ] **Step 1: Extract and forward `skillsContext`**

  Current handler (line 221):
  ```typescript
  await agent.handle(sessionId, content, id, (event) => {
  ```

  New handler — extract skillsContext from msg and pass it through:
  ```typescript
  case "message": {
    const id = msg.id ?? crypto.randomUUID();
    const sessionId = msg.sessionId ?? "default";
    const content = msg.content ?? "";
    const skillsContext = msg.skillsContext;   // ← add this line
    if (!content.trim()) {
      transport.send({ type: "error", id, message: "empty message content" });
      return;
    }
    mood.applyEvent("message_received");
    await agent.handle(sessionId, content, id, (event) => {
      transport.send(event);
      if (event.type === "done")      mood.applyEvent("message_answered");
      if (event.type === "tool_done") {
        const r = event.result as { ok?: boolean } | null;
        mood.applyEvent(r?.ok === false ? "tool_error" : "tool_success");
      }
      if (event.type === "error")     mood.applyEvent("inference_error");
    }, skillsContext);                          // ← add skillsContext as 5th arg
    break;
  }
  ```

- [ ] **Step 2: Type-check**

  ```bash
  cd FeralAgent && bun run tsc --noEmit
  ```
  Expected: no errors.

- [ ] **Step 3: Commit**

  ```bash
  git add FeralAgent/src/index.ts
  git commit -m "feat(agent): pass skillsContext from transport message to agent.handle()"
  ```

---

## Task 4: Read installed skills in Rust and inject into the message envelope

**Files:**
- Modify: `src-tauri/src/lib.rs:555-578` — `feral_send_message` function

The existing `skills::local_list()` and `skills::get_installed_content()` are already `pub` and usable from `lib.rs`.

- [ ] **Step 1: Build the skills context string**

  Current `feral_send_message` (lines 555-578):
  ```rust
  async fn feral_send_message(
      state: State<'_, AppState>,
      content: String,
      session_id: String,
  ) -> Result<String, String> {
      let id = uuid::Uuid::new_v4().to_string();
      let msg = serde_json::json!({
          "type": "message",
          "id": &id,
          "content": content,
          "sessionId": session_id,
      })
      .to_string();
      // ...
  ```

  Replace with:
  ```rust
  async fn feral_send_message(
      state: State<'_, AppState>,
      content: String,
      session_id: String,
  ) -> Result<String, String> {
      let id = uuid::Uuid::new_v4().to_string();

      // Collect installed skill contents and bundle them for the sidecar.
      // Failures are non-fatal: the agent still responds, just without skill context.
      let skills_context: Option<String> = (|| {
          let metas = skills::local_list().ok()?;
          if metas.is_empty() { return None; }
          let parts: Vec<String> = metas
              .iter()
              .filter_map(|m| {
                  let body = skills::get_installed_content(&m.id).ok()?;
                  Some(format!("### Skill: {}\n{}", m.name, body))
              })
              .collect();
          if parts.is_empty() { None } else { Some(parts.join("\n\n")) }
      })();

      let mut payload = serde_json::json!({
          "type": "message",
          "id": &id,
          "content": content,
          "sessionId": session_id,
      });
      if let Some(ctx) = skills_context {
          payload["skillsContext"] = serde_json::Value::String(ctx);
      }
      let msg = payload.to_string();

      // ... rest of function unchanged (extract tx, send, return id)
  ```

  The rest of the function (lines 569-578) stays unchanged:
  ```rust
      let tx = {
          let guard = state.feral_agent_tx.lock();
          guard
              .as_ref()
              .ok_or_else(|| "feral-agent is not running".to_string())?
              .clone()
      };
      tx.send(msg).await.map_err(|e| e.to_string())?;
      Ok(id)
  }
  ```

- [ ] **Step 2: Verify Rust compiles**

  ```bash
  cd src-tauri && cargo check
  ```
  Expected: no errors. If `skills` module needs to be referenced, it's already in scope via `use crate::skills` or the module is in the same crate — check existing `use` statements at the top of `lib.rs`.

- [ ] **Step 3: Commit**

  ```bash
  git add src-tauri/src/lib.rs
  git commit -m "feat(agent): read installed skills in feral_send_message and inject as skillsContext"
  ```

---

## Task 5: Re-trigger v0.1.5 release

The v0.1.5 CI run (ID 27058299719) already **failed** — the build succeeded but release creation failed with `Resource not accessible by integration`. This was fixed by moving `permissions: contents: write` to workflow level (commit `12e5bcb` already on main).

The tag `v0.1.5` still points to an older commit. To re-trigger:

- [ ] **Step 1: Update CHANGELOG entry for the skills injection**

  In `CHANGELOG.md`, find the `## v0.1.5` section and add under `### Agent`:
  ```
  - **Installed skills injected into agent.** Skills installed via the Skills tab are now
    automatically included in the agent's system prompt at session start. The agent can
    read, follow, and reason about your installed skill instructions.
  ```

- [ ] **Step 2: Commit CHANGELOG**

  ```bash
  git add CHANGELOG.md
  git commit -m "docs: add skills injection to v0.1.5 changelog"
  ```

- [ ] **Step 3: Delete old tag and re-push**

  ```bash
  git tag -d v0.1.5
  git push origin :refs/tags/v0.1.5
  git tag v0.1.5
  git push origin v0.1.5
  ```

  This triggers a fresh CI run on the latest `main` commit (which has the permissions fix + skills injection + changelog extraction step).

- [ ] **Step 4: Monitor Actions until green**

  Go to `https://github.com/bloom500/feral/actions` and confirm the run completes successfully. The release will appear at `https://github.com/bloom500/feral/releases/tag/v0.1.5` with the CHANGELOG notes as the release body.
