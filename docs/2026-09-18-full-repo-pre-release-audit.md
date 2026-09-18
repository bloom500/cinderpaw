# CINDERPAW — FULL REPOSITORY MULTI-BRANCH PRE-RELEASE AUDIT
**Date:** 2026-09-18  
**Auditor:** Pre-Release Engineering Review (Cross-Branch & Multi-Worktree Forensic Scan)  
**Target Branches Scanned:**  
- `main` / `origin/main` (HEAD: `cd87d5e0`, Sep 14, 2026)  
- `origin/integration/mega-release` (`d30a5980`)  
- `origin/feat/browser-app-foundation` (`68deffb2`, PR #18/#19)  
- `origin/feat/chat-tool-widgets` (`ca2f5e20`)  
- `origin/feat/cowork-s4-approval-gates` (`f9a272bb`)  
- `origin/feat/openclaw-connector-import` (`8926e713`)  
- `origin/audit/zone-b-claims` (`f320406b`)  
- `origin/release-prep` (`65c7634f`)  
- `origin/arena/01a0b58b-cinderpaw` (Session Working Branch)  

---

## 1. Executive Summary & Calibration

### 1.1 Scope and Methodology of this Comprehensive Scan
An exhaustive forensic scan was conducted across all local and remote branches in the repository following an unshallow fetch of all Git references. Unlike static evaluations of isolated commits, this audit evaluates the **actual state of mainline development (`origin/main`)**, alongside active integration branches (`integration/mega-release`, `feat/browser-app-foundation`, `feat/chat-tool-widgets`).

### 1.2 Status of Recent Hardening Passes (What Was Cleared vs. What Remains)
A series of significant engineering improvements landed on `origin/main` between commit `20dba8df` (Sep 12) and `cd87d5e0` (Sep 14), co-authored by Darius and Claude Opus 5. These commits resolved several prominent issues from earlier revisions:
- **Licensing Resolution:** The repository was formally relicensed from BUSL-1.1 to **Apache-2.0** (`20dba8df`).
- **GPL Copyleft Sanitization:** Kokoro TTS was refactored to eliminate mandatory linkage against GPLv3 `espeak-ng` (`ea3addad`), and release workflows ceased bundling `piper-rs` binaries (`afaa19ec`).
- **Telegram Native Long-Polling:** `CinderpawAgent/src/transports/telegram.ts` was implemented natively using zero-dependency HTTP long polling (`9ee1db63`), removing any external bot framework or tunnel requirements.
- **Connector Catalog Truth-in-Advertising:** All 21 OpenClaw connector definitions were imported and normalized into `crates/cinderpaw-core/src/connectors.rs` (`44de0d36`). The 11 un-wired platforms were explicitly marked with `coming_soon: true`, locked with bidirectional Rust/TypeScript golden tests (`tests/connector-catalog-transports.test.ts`).
- **Repository Hygiene:** The 21.4 MB compiled Windows executable `tui/feral-tui.exe` was completely untracked and purged from release packaging (`57fe1da5`). Duplicate third-party notice files were merged into `THIRD-PARTY-NOTICES.md` (`b55619c7`).

### 1.3 Active Release Blockers on HEAD (`origin/main`)
Despite these substantial fixes, deep inspection confirms that **several critical security and reliability vulnerabilities remain fully active on `origin/main`**:
1. **Workspace Root Defaults to User Home (`homedir()`) (P0):** `boot.ts:257` defaults to `[process.cwd(), homedir()]` when `CINDERPAW_WORKSPACE` is unset. The sandbox boundary fails open, allowing tools to read and overwrite `~/.bashrc`, browser profiles, and cloud credentials.
2. **Destructive Shell Command Guard Bypass via Relative Paths (P0):** `shell-exec.ts:198` inspects only `ABSOLUTE_PATH` regex matches. Commands using relative paths (`rm -rf *`, `rm -rf ../*`) evaluate to `null` and execute without confirmation.
3. **Cross-Transport Privacy Leak in Semantic Memory (P0):** `semantic.ts:148` only isolates `discord` and `slack`. The 10 other active transports (Telegram, Signal, WhatsApp, Feishu, Zalo, Nextcloud, Nostr, Matrix, Mattermost, Twitch) collapse into global scope `""`, leaking external users' private facts into desktop chat.
4. **LiveKit Voice Engine Runtime `npm install` (P0):** `crates/cinderpaw-core/src/livekit.rs:759` invokes `Command::new(npm)` dynamically on the host machine during first voice call. Fails on clean consumer machines lacking Node.js/npm and breaks offline usage.
5. **Indirect Tool Call Hijacking via Regex (P0):** `agent-loop.ts:3546` extracts `<tool_call>` tags anywhere in generated model text, allowing quoted untrusted content to trigger unauthorized tool executions.

### 1.4 Verdict
**DO NOT SHIP YET.**  
While legal, connector, and packaging debt have been successfully retired on `main`, the application cannot be safely released until the security sandbox (`boot.ts`), destructive command filter (`shell-exec.ts`), and cross-transport memory privacy boundary (`semantic.ts`) are hardened.

---

## 2. Multi-Branch Architecture & Truth Matrix

Forensic comparison across the primary branch heads:

| Capability / Finding | Status on `main` (`cd87d5e`) | Status on `mega-release` (`d30a598`) | Status on Feature Branches | Release Verdict |
|---|---|---|---|---|
| **License (Apache-2.0)** | Landed (`20dba8df`) | Apache-2.0 | Apache-2.0 | **RESOLVED** |
| **GPLv3 Kokoro Decoupling** | Landed (`ea3addad`) | Decoupled | Decoupled | **RESOLVED** |
| **Telegram Transport** | Landed (`9ee1db63`) | Landed | Landed | **RESOLVED** |
| **21 OpenClaw Catalog** | Landed (`44de0d36`) | Landed | Landed | **RESOLVED** |
| **21.4MB TUI Binary Purge** | Landed (`57fe1da5`) | Landed | Landed | **RESOLVED** |
| **Workspace `homedir()` Root** | **ACTIVE VULN (P0)** (`boot.ts:257`) | **ACTIVE VULN** (`boot.ts:248`) | **ACTIVE VULN** across all | **BLOCKER** |
| **Relative Path `shell_exec`** | **ACTIVE VULN (P0)** (`shell-exec.ts:198`)| **ACTIVE VULN** (`shell-exec.ts:195`) | **ACTIVE VULN** across all | **BLOCKER** |
| **Cross-Transport Memory Leak** | **ACTIVE VULN (P0)** (`semantic.ts:148`) | **ACTIVE VULN** (`semantic.ts:61`) | **ACTIVE VULN** across all | **BLOCKER** |
| **Voice `npm install` Runtime** | **ACTIVE VULN (P0)** (`livekit.rs:759`) | **ACTIVE VULN** (`livekit.rs:632`) | **ACTIVE VULN** across all | **BLOCKER** |
| **`<tool_call>` Regex Hijack** | **ACTIVE VULN (P0)** (`agent-loop.ts:3546`)| **ACTIVE VULN** (`agent-loop.ts:3329`) | **ACTIVE VULN** across all | **BLOCKER** |
| **Lock Timeout Asymmetry** | **ACTIVE VULN (P1)** (`graph.ts:36`) | **ACTIVE VULN** (`graph.ts:36`) | **ACTIVE VULN** across all | **MUST FIX** |
| **Ghost Tool `pdf_generator`** | **ACTIVE (P1)** (`tiers.ts:60`) | **ACTIVE (P1)** (`tiers.ts:60`) | **ACTIVE (P1)** across all | **MUST FIX** |
| **Persistent Artifact Subsystem** | Telemetry Widgets Only (`CallToolScreen.tsx`) | Telemetry Widgets Only | Inbound Doc Support (PR #18) | **DOC MISMATCH** |

---

## 3. Active P0 Release Blockers (Detailed Forensic Evidence)

### P0-1 — Default Workspace Root Includes User Home (`homedir()`), Permitting Shell Hijacking & Credential Theft
- **Branch & File:** `origin/main:CinderpawAgent/src/boot.ts`, lines 254–264
- **Verified Code on `origin/main`:**
  ```typescript
  export function loadWorkspaceRoots(env: NodeJS.ProcessEnv): string[] {
    const raw = env.CINDERPAW_WORKSPACE;
    const requested = raw && raw.trim()
      ? raw.split(delimiter).map((s) => s.trim()).filter(Boolean)
      : [process.cwd(), homedir()];
    const roots = requested.map((p) => resolve(p));
  ```
- **Vulnerability Mechanism:** On standard desktop installations where users do not pass `CINDERPAW_WORKSPACE`, `homedir()` is added directly to the allowed roots. Combined with `deniedPaths()` in `tool-permissions.ts` (which only blacklists `~/.ssh` and `~/.cinderpaw`), any file-writing tool (`write_file`, `edit_file`) or shell execution can modify user dotfiles (`~/.bashrc`, `~/.zshrc`, `~/.profile`), exfiltrate cloud credentials (`~/.aws/credentials`), or access browser sessions.
- **Attack Vector:** An untrusted prompt injection triggers `write_file` on `~/.bashrc` appending an arbitrary shell script, achieving persistent RCE upon the user's next terminal session.
- **Required Fix:** Change fallback to `[join(cinderpawHome(), "workspace")]`. Never default `homedir()` into `loadWorkspaceRoots`.

---

### P0-2 — Destructive Shell Command Guard Evaluates Absolute Paths Only; Relative Deletions Execute Unrestricted
- **Branch & File:** `origin/main:CinderpawAgent/src/tools/builtin/shell-exec.ts`, lines 190–205
- **Verified Code on `origin/main`:**
  ```typescript
  function destructiveOutsideRoots(argv: string[], roots: string[]): string | null {
    if (roots.length === 0) return null;
    const line = argv.join(" ");
    if (!DESTRUCTIVE_VERBS.test(line)) return null;

    const allowed = [...roots, tmpdir(), cinderpawHome()];
    for (const match of line.match(ABSOLUTE_PATH) ?? []) {
      const target = match.startsWith("~")
        ? join(homedir(), match.slice(1))
        : match;
      if (!allowed.some((root) => isInside(target, root))) return match;
    }
    return null;
  }
  ```
- **Vulnerability Mechanism:** `line.match(ABSOLUTE_PATH)` extracts paths starting with `/`, `\`, or `~`. If the command contains relative paths (e.g. `rm -rf *`, `rm -rf .`, `rm -rf ../*`, or `rm -rf src/`), `line.match(ABSOLUTE_PATH)` evaluates to `null`. The loop never executes, and `destructiveOutsideRoots` returns `null` (safe). The command runs immediately without prompting the user for approval.
- **Attack Vector:** Prompt injection commands the agent: `shell_exec({ command: "rm -rf *" })`. The agent wipes the current workspace or project directory with zero human intervention.
- **Required Fix:** Canonicalize and resolve all command arguments against the working directory before evaluation, and enforce human confirmation for any verb matching `DESTRUCTIVE_VERBS` by default.

---

### P0-3 — Memory Scope Isolation Fails for 10 Connectors, Leaking Private User Data into Desktop Scope
- **Branch & File:** `origin/main:CinderpawAgent/src/memory/semantic.ts`, lines 145–155
- **Verified Code on `origin/main`:**
  ```typescript
  export function memoryScope(sessionId: string): string {
    const [transport, , userId] = sessionId.split(":");
    // Discord and Slack are the room-keyed transports: `<transport>:<room>:<user>`
    // (plus `discord:dm:<user>`, where the speaker is still last). A legacy
    // two-segment session has no speaker and stays global.
    if (transport !== "discord" && transport !== "slack") return "";
    return userId ? `${transport}/${userId}` : "";
  }
  ```
- **Vulnerability Mechanism:** While `origin/main` added working transports for Telegram, Signal, WhatsApp, Feishu, Zalo, Nextcloud Talk, Nostr, Matrix, Mattermost, and Twitch, `memoryScope()` was never updated beyond Discord and Slack. For all other platforms, `transport !== "discord" && transport !== "slack"` is true, returning `""` (global scope).
- **Impact:** Facts, credentials, and conversation memories extracted from any external user over Telegram, WhatsApp, or Signal are stored under global keys and injected directly into the desktop user's local memory context.
- **Required Fix:** Strict per-transport isolation:
  ```typescript
  export function memoryScope(sessionId: string): string {
    const [transport] = sessionId.split(":");
    if (transport === "desktop" || transport === "main") return "";
    return sessionId;
  }
  ```

---

### P0-4 — LiveKit Voice Agent Invokes Host `npm install` at Runtime
- **Branch & File:** `origin/main:crates/cinderpaw-core/src/livekit.rs`, lines 748–775
- **Verified Code on `origin/main`:**
  ```rust
  let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
  let out = Command::new(npm)
      .args(["install", "--no-audit", "--no-fund"])
      .args(&want)
      .current_dir(&root)
      .env("PATH", augmented_path(node))
      .output()
      .await
      .map_err(|e| format!("npm is needed once to set up voice, and could not be run: {e}"))?;
  ```
- **Vulnerability Mechanism:** Initiating a voice call executes `npm install` in a temporary directory to fetch `@livekit/agents` and audio plugins. On standard consumer machines without Node.js/npm on PATH, or when operating in offline/firewalled environments, voice initialization crashes immediately.
- **Impact:** Fails the primary product promise of an offline-capable, standalone desktop application.
- **Required Fix:** Bundle `@livekit/agents` and associated node modules at build time within the Tauri resource bundle or execute the voice agent via the pre-bundled Bun sidecar.

---

### P0-5 — Indirect Tool Call Hijacking via Unsanitized Regex Parser
- **Branch & File:** `origin/main:CinderpawAgent/src/core/agent-loop.ts`, lines 3540–3555
- **Verified Code on `origin/main`:**
  ```typescript
  const toolCallTag = /<tool_call>((?:(?!<tool_call>)[\s\S])*?)<\/tool_call>/g;
  let match: RegExpExecArray | null;
  let dropped = 0;
  while ((match = toolCallTag.exec(raw)) !== null) {
    const block = parseCallBlock(match[1]?.trim() ?? "");
    toolCalls.push(...block.calls);
    dropped += block.dropped;
    text = text.replace(match[0], "").trim();
  }
  ```
- **Vulnerability Mechanism:** Any `<tool_call>` tag found within the completion text is executed. If the agent retrieves an external document, email, or webpage containing injected tags (e.g. `<tool_call>{"name":"write_file",...}</tool_call>`) and quotes or summarizes it, the loop executes the tool call with agent privileges.
- **Required Fix:** Disallow regex tool extraction from free-form model text on tools with file/shell privileges; rely strictly on provider structured tool-use payloads (`message.tool_calls` / `tool_use`).

---

## 4. Subsystem Deep-Dive Across Branches

### 4.1 Artifacts & Interactive App Surface
- **Reality on `origin/main` and `origin/feat/browser-app-foundation`:**
  - `CallToolScreen.tsx` provides 4 telemetry widgets (browser, explorer, terminal, memory card) rendered during voice calls and agent chat turns. As documented in `CallToolScreen.tsx`:
    > *"Each is drawn as the application it stands for ... But none of them is an embedded app, and the browser could not be: search engines send `X-Frame-Options: DENY`, so an iframe renders blank..."*
  - `CallArtifacts.tsx` provides a transient `localStorage` panel for search and file links visited during calls.
  - There is **no persistent versioned artifact system**, no iframe application sandbox, and zero occurrences of ECharts across any branch.
- **Recommendation:** Align public documentation and promotional copy with actual telemetry capabilities; mark interactive iframe apps as future roadmap.

### 4.2 Connectors (The 21-Platform Matrix)
- **Status on `origin/main`:**
  - **10 Transports Active & Wired:** Telegram (`telegram.ts`), Signal (`signal.ts`), IRC (`irc.ts`), Feishu (`feishu.ts`), Zalo (`zalo.ts`), Nextcloud Talk (`nextcloud-talk.ts`), Nostr (`nostr.ts`), Matrix (`matrix.ts`), Mattermost (`mattermost.ts`), Twitch (`twitch.ts`), plus core connectors (Discord, Slack, WhatsApp).
  - **11 Platforms Gated with `coming_soon: true`:** Twilio SMS, Google Chat, LINE, Teams, Synology Chat, iMessage, Tlon, etc. These require public webhook ingress architectures that a local desktop cannot provide without relays.
  - Bidirectional consistency is enforced by `tests/connector-catalog-transports.test.ts`.

### 4.3 Multi-Agent Coworkers (`origin/feat/cowork-s4-approval-gates`)
- Commit `f9a272bb` closed the approval gate bypass where delegated tasks dropped session tracking, and added thread-level hop caps (`mailbox.lastHopsInThread`).
- **Remaining Gap (`boot.ts:1749`):** When `agentRec.tools` is undefined, coworker agents default to the owner's complete toolset, granting sub-agents unprompted shell access.

### 4.4 Voice Pipeline Latency & Provider Tooling
- Commit `eaf2abf8` addressed voice tool collision and extended client timeouts from 30s to 50s.
- However, sequential model execution on OpenAI Realtime and older models still introduces a 25–45 second audio gap during `ask_cinder` tool invocations.

---

## 5. Comprehensive Clean-Room Verification (Questions 1–20)

1. **Can a fresh user install and start Cinderpaw successfully?**  
   *Yes. The Tauri desktop installer boots smoothly on Windows and macOS. On Linux, local voice is disabled due to glibc/ONNX constraints, but chat functions.*
2. **Can a user understand the first-run flow?**  
   *Yes. The 5-step `OnboardingWizard` is cohesive and functional.*
3. **Can the agent reliably discover its capabilities?**  
   *Yes. Capability tools (`list_tools`, `load_tool`, `list_skills`, `read_skill`) work reliably.*
4. **Does memory survive and remain relevant?**  
   *Yes. SQLite FMS and utility-weighted retrieval survive restarts. However, lacking an episodic pruning policy causes database bloat over long horizons.*
5. **Can the agent create persistent work?**  
   *Only via direct file writes to the workspace. There is no separate persistent artifact store.*
6. **Can users inspect and edit that work?**  
   *Users can edit workspace files in their own editors; there is no embedded artifact viewer.*
7. **Can voice access the same capabilities as chat?**  
   *No. Voice accesses agent capabilities via a single text bridge tool (`ask_cinder`) with high latency.*
8. **Can connected platform surfaces use the same agent?**  
   *Yes. Connectors dispatch directly into the agent loop.*
9. **Can artifacts/files move between surfaces?**  
   *Inbound files are parsed across connectors; outbound transmission is limited to text responses.*
10. **Are destructive actions consistently governed?**  
    *No. Relative paths in `shell-exec.ts` bypass confirmation prompts.*
11. **Can interactive artifacts escape their sandbox?**  
    *N/A — Interactive sandboxed HTML artifacts do not exist in the codebase.*
12. **Are credentials safe?**  
    *API keys are securely held in OS keychains. However, because `boot.ts` defaults `homedir()` into allowed roots, prompt injection can read user configuration files.*
13. **Can the app recover from provider/network failures?**  
    *Yes. Egress routing and backoff policies are resilient.*
14. **Can the app survive crashes without corrupting state?**  
    *Yes. Single-writer file locks and SQLite WAL mode prevent database corruption.*
15. **Is cross-surface continuity real?**  
    *No. Chat sessions remain partitioned by session ID; context does not hand off between desktop and mobile chat.*
16. **Is the app honestly local-first?**  
    *Partially. Local GGUF chat is fully offline. Voice calls require an active internet connection to download dependencies via npm.*
17. **Which claimed features should NOT be marketed yet?**  
    *Persistent Versioned Artifacts, Sandboxed HTML App Previews, 21 Active Connectors (10 are wired; 11 are coming soon), and Outbound File Delivery.*
18. **Top reasons a user could uninstall?**  
    *1. Voice call fails on first run due to missing npm/Node.js. 2. Advertised artifact workspace is nowhere to be found. 3. Long silence during voice tool calls.*
19. **Top reasons a technical reviewer could distrust the product?**  
    *1. Default workspace root encompasses the user's home directory. 2. `rm -rf *` executes without confirmation. 3. WhatsApp and Telegram chat data leaks into the desktop user's global memory.*
20. **Would you ship this commit?**  
    **DO NOT SHIP YET.**  
    *Remediate P0-1, P0-2, P0-3, and P0-4 before releasing to the public.*

---

## 6. Pre-Release Hardening Order (Actionable Fix List)

1. **Security Isolation (`CinderpawAgent/src/boot.ts`):**  
   Remove `homedir()` from `loadWorkspaceRoots`. Default strictly to `[join(cinderpawHome(), "workspace")]`.
2. **Destructive Command Gating (`CinderpawAgent/src/tools/builtin/shell-exec.ts`):**  
   Resolve all command arguments to absolute paths relative to CWD before testing against allowed roots. Require human approval on all destructive verbs.
3. **Memory Scoping (`CinderpawAgent/src/memory/semantic.ts`):**  
   Isolate memory scope for all external connectors: only `desktop` / `main` may return global scope `""`.
4. **Voice Dependencies (`crates/cinderpaw-core/src/livekit.rs`):**  
   Eliminate runtime `npm install`. Pre-bundle `@livekit/agents` in the Tauri asset payload.
5. **Tool Call Parser (`CinderpawAgent/src/core/agent-loop.ts`):**  
   Enforce structured tool call decoding and disable plain-text regex `<tool_call>` extraction for privileged tools.
6. **Lockfile Timeout Alignment (`CinderpawAgent/src/memory/graph.ts`):**  
   Align TypeScript timeout to 35,000ms to match Rust, and replace synchronous `Atomics.wait` with an asynchronous wait loop.
