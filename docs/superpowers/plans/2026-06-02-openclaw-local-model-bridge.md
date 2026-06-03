# OpenClaw Local Model Bridge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire OpenClaw as Feral's agent execution engine backed by Feral's local llama.cpp, so every agent created via onboarding runs on the user's local model with zero cloud dependency.

**Architecture:** Feral writes `~/.feral/openclaw-feral.json` at launch, configuring OpenClaw's gateway (port 18790) to use Feral's Ollama-compatible API (port 11435) as the model provider. OpenClaw dispatches to `feral/current`; Feral's API ignores the model field and serves whatever GGUF is loaded. All agent runs flow through `run_openclaw()` SSE → OpenClaw → Feral API → llama.cpp.

**Tech Stack:** Rust (Tauri backend, `src-tauri/src/`), React + TypeScript (frontend, `frontend-react/src/`), Vitest + Testing Library (frontend tests), `#[test]` / `#[tokio::test]` (Rust tests)

---

## File Map

| File | Change |
|---|---|
| `src-tauri/src/openclaw_config.rs` | **New.** Writes `~/.feral/openclaw-feral.json` with gateway + model provider config. |
| `src-tauri/src/openclaw_sidecar.rs` | **Modify.** Add `config_path: &Path` param to `start_sidecar`, pass `OPENCLAW_CONFIG_PATH` env var. |
| `src-tauri/src/lib.rs` | **Modify.** Call `openclaw_config::write_feral_config`, pass config path to `start_sidecar`, save port 18790 as `gateway_endpoint_override`. |
| `frontend-react/src/components/agents/onboarding/AgentsOnboarding.tsx` | **Modify.** Set `preferred_runtime: 'openclaw'` when saving agent in `handleSave`. |
| `frontend-react/src/components/agents/onboarding/steps/DoneStep.tsx` | **Modify.** Update failure badge text to be model-focused, not OpenClaw-focused. |
| `frontend-react/src/components/agents/main/AgentCard.tsx` | **Modify.** Remove `RuntimeSelector` + `OpenClawTestBody`; `AgentRunPanel` always runs via `tauri.agents.run` SSE. |

---

## Task 1 — `openclaw_config.rs`: Config file writer

**Files:**
- Create: `src-tauri/src/openclaw_config.rs`

- [ ] **Step 1: Write the tests first**

Create `src-tauri/src/openclaw_config.rs` with the tests only:

```rust
use anyhow::Result;
use std::path::PathBuf;

pub const FERAL_GATEWAY_PORT: u16 = 18790;

pub fn config_path() -> PathBuf {
    crate::paths::feral_dir().join("openclaw-feral.json")
}

pub fn write_feral_config(token: &str) -> Result<()> {
    crate::paths::ensure_dirs()?;
    let content = build_config(token);
    std::fs::write(config_path(), content)?;
    Ok(())
}

fn build_config(token: &str) -> String {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feral_gateway_port_is_18790() {
        assert_eq!(FERAL_GATEWAY_PORT, 18790);
    }

    #[test]
    fn build_config_contains_gateway_port() {
        let cfg = build_config("test-token-abc");
        assert!(cfg.contains("18790"), "expected port 18790, got:\n{cfg}");
    }

    #[test]
    fn build_config_contains_token() {
        let cfg = build_config("my-secret-token");
        assert!(cfg.contains("my-secret-token"), "token missing from config:\n{cfg}");
    }

    #[test]
    fn build_config_contains_feral_api_url() {
        let cfg = build_config("tok");
        assert!(cfg.contains("http://localhost:11435/v1"), "got:\n{cfg}");
    }

    #[test]
    fn build_config_contains_feral_current_model() {
        let cfg = build_config("tok");
        assert!(cfg.contains("feral/current"), "model ref missing:\n{cfg}");
    }

    #[test]
    fn build_config_is_valid_json() {
        let cfg = build_config("tok-xyz");
        serde_json::from_str::<serde_json::Value>(&cfg)
            .expect("config must be valid JSON");
    }
}
```

- [ ] **Step 2: Run tests — expect them to panic on `todo!()`**

```powershell
cd src-tauri
cargo test openclaw_config 2>&1 | Select-String -Pattern "FAILED|error|todo"
```

Expected: tests that call `build_config` fail with "not yet implemented".

- [ ] **Step 3: Implement `build_config`**

Replace the `todo!()` with:

```rust
fn build_config(token: &str) -> String {
    format!(
        r#"{{
  "gateway": {{
    "port": {port},
    "bind": "loopback",
    "auth": {{ "mode": "token", "token": "{token}" }}
  }},
  "models": {{
    "providers": {{
      "feral": {{
        "baseUrl": "http://localhost:11435/v1",
        "models": [{{ "id": "current" }}]
      }}
    }}
  }},
  "agents": {{
    "defaults": {{
      "model": {{ "primary": "feral/current" }}
    }}
  }}
}}"#,
        port = FERAL_GATEWAY_PORT,
        token = token,
    )
}
```

- [ ] **Step 4: Run tests — expect all to pass**

```powershell
cargo test openclaw_config
```

Expected output: `test openclaw_config::tests::... ok` × 6

- [ ] **Step 5: Register module in `lib.rs`**

In `src-tauri/src/lib.rs`, find the block of `mod` declarations near the top (around line 1–15) and add:

```rust
mod openclaw_config;
```

- [ ] **Step 6: Build to confirm it compiles**

```powershell
cargo build 2>&1 | Select-String "error"
```

Expected: no errors.

- [ ] **Step 7: Commit**

```powershell
git add src-tauri/src/openclaw_config.rs src-tauri/src/lib.rs
git commit -m "feat(openclaw): add openclaw_config module — writes ~/.feral/openclaw-feral.json"
```

---

## Task 2 — `openclaw_sidecar`: Add config path to `start_sidecar`

**Files:**
- Modify: `src-tauri/src/openclaw_sidecar.rs`

- [ ] **Step 1: Write the new test**

In `src-tauri/src/openclaw_sidecar.rs`, add this test to the existing `#[cfg(test)] mod tests` block:

```rust
#[test]
fn start_sidecar_signature_accepts_config_path() {
    // Calling with a non-existent binary returns Err — we're only checking
    // the function is callable with the new signature.
    use std::path::Path;
    let result = start_sidecar(
        Path::new("nonexistent-binary"),
        "tok",
        Path::new("/tmp/config.json"),
    );
    assert!(result.is_err(), "expected Err for nonexistent binary");
}
```

- [ ] **Step 2: Run test — expect compile error**

```powershell
cargo test openclaw_sidecar 2>&1 | Select-String "error"
```

Expected: compile error about wrong number of arguments.

- [ ] **Step 3: Update `start_sidecar` signature and body**

Replace the current `start_sidecar` function in `src-tauri/src/openclaw_sidecar.rs`:

```rust
/// Start the OpenClaw gateway sidecar. Returns the child process on success.
///
/// `config_path` is passed as `OPENCLAW_CONFIG_PATH` so OpenClaw loads
/// Feral's model-provider config instead of its default `~/.openclaw/openclaw.json`.
pub fn start_sidecar(
    binary: &Path,
    token: &str,
    config_path: &Path,
) -> Result<tokio::process::Child, String> {
    let mut cmd = tokio::process::Command::new(binary);
    cmd.arg("gateway")
        .env("OPENCLAW_GATEWAY_TOKEN", token)
        .env("OPENCLAW_CONFIG_PATH", config_path)
        .kill_on_drop(true);

    // Suppress console window on Windows.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn().map_err(|e| format!("Failed to start OpenClaw sidecar: {e}"))
}
```

- [ ] **Step 4: Run tests — expect all to pass**

```powershell
cargo test openclaw_sidecar
```

Expected: all tests pass including `start_sidecar_signature_accepts_config_path`.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/openclaw_sidecar.rs
git commit -m "feat(openclaw): pass OPENCLAW_CONFIG_PATH env to sidecar"
```

---

## Task 3 — `lib.rs`: Wire config write + endpoint override into startup

**Files:**
- Modify: `src-tauri/src/lib.rs` (lines ~1344–1362)

- [ ] **Step 1: Find the sidecar startup block**

The block to modify is in the `setup` closure. It looks like this (around line 1344):

```rust
let token = crate::openclaw_sidecar::generate_token();

// Persist token so warmup/run_openclaw/test_message all authenticate.
let mut conn = crate::openclaw_connection::load();
conn.gateway_token = Some(token.clone());
if let Err(e) = crate::openclaw_connection::save(&conn) {
    tracing::warn!("OpenClaw sidecar: failed to save token: {e}");
}

match crate::openclaw_sidecar::start_sidecar(&binary, &token) {
    Ok(child) => {
        tracing::info!("OpenClaw sidecar started (pid {:?})", child.id());
        let state = sidecar_handle.state::<AppState>();
        *state.openclaw_process.lock() = Some(child);
    }
    Err(e) => {
        tracing::warn!("OpenClaw sidecar failed to start: {e}");
    }
}
```

- [ ] **Step 2: Replace the block with the updated version**

Replace the entire block above with:

```rust
let token = crate::openclaw_sidecar::generate_token();

// Write Feral's OpenClaw config: provider pointing to Feral API + port 18790.
let config_path = crate::openclaw_config::config_path();
if let Err(e) = crate::openclaw_config::write_feral_config(&token) {
    tracing::warn!("OpenClaw sidecar: failed to write config: {e}");
}

// Persist token and endpoint so all OpenClaw callers (warmup, run, test)
// authenticate and route to the correct port.
let mut conn = crate::openclaw_connection::load();
conn.gateway_token = Some(token.clone());
conn.gateway_endpoint_override = Some(format!(
    "http://localhost:{}",
    crate::openclaw_config::FERAL_GATEWAY_PORT,
));
if let Err(e) = crate::openclaw_connection::save(&conn) {
    tracing::warn!("OpenClaw sidecar: failed to save connection: {e}");
}

match crate::openclaw_sidecar::start_sidecar(&binary, &token, &config_path) {
    Ok(child) => {
        tracing::info!("OpenClaw sidecar started (pid {:?})", child.id());
        let state = sidecar_handle.state::<AppState>();
        *state.openclaw_process.lock() = Some(child);
    }
    Err(e) => {
        tracing::warn!("OpenClaw sidecar failed to start: {e}");
    }
}
```

- [ ] **Step 3: Check `openclaw_connection` has `gateway_endpoint_override` field**

Run:

```powershell
grep -n "gateway_endpoint_override" src-tauri/src/openclaw_connection.rs
```

Expected: should find the field definition. If not, open the file and add:
```rust
pub gateway_endpoint_override: Option<String>,
```
with `#[serde(default)]`.

- [ ] **Step 4: Build**

```powershell
cargo build 2>&1 | Select-String "error"
```

Expected: no errors. Fix any type errors (e.g., `config_path` is a `PathBuf`, pass `&config_path`).

- [ ] **Step 5: Run all Rust tests**

```powershell
cargo test 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/lib.rs
git commit -m "feat(openclaw): write feral config + save port 18790 endpoint at sidecar launch"
```

---

## Task 4 — `AgentsOnboarding.tsx`: Set `preferred_runtime` on save

**Files:**
- Modify: `frontend-react/src/components/agents/onboarding/AgentsOnboarding.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend-react/src/components/agents/onboarding/__tests__/AgentsOnboarding.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentsOnboarding } from '../AgentsOnboarding';
import { tauri, type AgentConfig } from '@/lib/tauri';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      agents: {
        ...actual.tauri.agents,
        getPresets: vi.fn(),
        save: vi.fn(),
      },
      models: {
        ...actual.tauri.models,
        loaded: vi.fn(),
      },
      openclaw: {
        ...actual.tauri.openclaw,
        warmupAgent: vi.fn(),
      },
    },
  };
});

const mockGetPresets = vi.mocked(tauri.agents.getPresets);
const mockSave       = vi.mocked(tauri.agents.save);
const mockLoaded     = vi.mocked(tauri.models.loaded);

const fakePreset: AgentConfig = {
  id: 'preset-1',
  name: 'Research Assistant',
  system_prompt: 'You research things.',
  model_id: '',
  tools: ['web_search'],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPresets.mockResolvedValue([fakePreset]);
  mockLoaded.mockResolvedValue(null);
  mockSave.mockImplementation(async (cfg) => ({ ...cfg, id: 'saved-id-1' }));
  vi.mocked(tauri.openclaw.warmupAgent).mockResolvedValue({
    kind: 'ok', response_text: 'ok', error_message: null, endpoint_tried: null,
  });
});

describe('AgentsOnboarding', () => {
  it('saves agent with preferred_runtime = openclaw', async () => {
    const user = userEvent.setup();
    render(<AgentsOnboarding onDone={vi.fn()} onSkip={vi.fn()} />);

    // Welcome → pick preset
    await user.click(await screen.findByRole('button', { name: /continue/i }));

    // Pick preset card
    const card = await screen.findByText('Research Assistant');
    await user.click(card);
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Name step — name is pre-filled from preset; just continue
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Review step → save
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(mockSave).toHaveBeenCalled());

    const savedCfg = mockSave.mock.calls[0][0];
    expect(savedCfg.preferred_runtime).toBe('openclaw');
  });
});
```

- [ ] **Step 2: Run the test — expect it to fail**

```powershell
cd frontend-react
npx vitest run src/components/agents/onboarding/__tests__/AgentsOnboarding.test.tsx 2>&1 | tail -20
```

Expected: FAIL — `preferred_runtime` is `undefined` not `'openclaw'`.

- [ ] **Step 3: Add `preferred_runtime` to `handleSave` in `AgentsOnboarding.tsx`**

Find the `cfg` object in `handleSave` (around line 104). Change it from:

```ts
const cfg: AgentConfig = {
  name:          agentName.trim(),
  system_prompt: preset?.system_prompt ?? DEFAULT_SCRATCH_PROMPT,
  model_id:      loadedModel?.path ?? '',
  tools:         preset?.tools ?? [],
};
```

To:

```ts
const cfg: AgentConfig = {
  name:              agentName.trim(),
  system_prompt:     preset?.system_prompt ?? DEFAULT_SCRATCH_PROMPT,
  model_id:          loadedModel?.path ?? '',
  tools:             preset?.tools ?? [],
  preferred_runtime: 'openclaw',
};
```

- [ ] **Step 4: Run the test — expect it to pass**

```powershell
npx vitest run src/components/agents/onboarding/__tests__/AgentsOnboarding.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run the full frontend test suite to check for regressions**

```powershell
npx vitest run 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```powershell
git add frontend-react/src/components/agents/onboarding/AgentsOnboarding.tsx `
       frontend-react/src/components/agents/onboarding/__tests__/AgentsOnboarding.test.tsx
git commit -m "feat(onboarding): set preferred_runtime=openclaw on agent save"
```

---

## Task 5 — `DoneStep.tsx`: User-facing copy — no OpenClaw mentions

**Files:**
- Modify: `frontend-react/src/components/agents/onboarding/steps/DoneStep.tsx`

The DoneStep already fires `warmupAgent` on mount and handles success/failure states. The only change is the failure badge copy — currently says "OpenClaw not connected — check Settings → OpenClaw" which exposes internal infrastructure to the user.

- [ ] **Step 1: Write the failing test**

Create `frontend-react/src/components/agents/onboarding/steps/__tests__/DoneStep.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DoneStep } from '../DoneStep';
import { tauri } from '@/lib/tauri';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      openclaw: {
        ...actual.tauri.openclaw,
        warmupAgent: vi.fn(),
      },
    },
  };
});

const mockWarmup = vi.mocked(tauri.openclaw.warmupAgent);

beforeEach(() => vi.clearAllMocks());

describe('DoneStep', () => {
  it('shows model-load prompt when warmup fails', async () => {
    mockWarmup.mockResolvedValue({
      kind: 'error',
      response_text: null,
      error_message: 'gateway unreachable',
      endpoint_tried: null,
    });

    render(
      <DoneStep
        agentName="Test"
        agentId="agent-1"
        onViewAgents={vi.fn()}
      />
    );

    await waitFor(() => expect(mockWarmup).toHaveBeenCalled());

    // Must NOT mention OpenClaw to the user
    expect(screen.queryByText(/openclaw/i)).toBeNull();
    // Must tell user to load a model
    expect(screen.getByText(/load a model/i)).toBeTruthy();
  });

  it('shows ready state when warmup succeeds', async () => {
    mockWarmup.mockResolvedValue({
      kind: 'ok',
      response_text: 'ready',
      error_message: null,
      endpoint_tried: null,
    });

    render(
      <DoneStep
        agentName="Test"
        agentId="agent-1"
        onViewAgents={vi.fn()}
      />
    );

    await waitFor(() => expect(mockWarmup).toHaveBeenCalled());
    expect(screen.getByText(/ready/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

```powershell
npx vitest run src/components/agents/onboarding/steps/__tests__/DoneStep.test.tsx 2>&1 | tail -20
```

Expected: FAIL — "OpenClaw not connected" text is present (fails the `queryByText(/openclaw/i)` assertion) and "Load a model" text is absent.

- [ ] **Step 3: Update the failure badge copy in `DoneStep.tsx`**

Find the failure branch in the `badge` computation (around line 52):

```tsx
) : (
  <div className="text-xs text-amber-400 text-center">
    OpenClaw not connected —{' '}
    <span className="text-text-muted">check Settings → OpenClaw.</span>
  </div>
);
```

Replace with:

```tsx
) : (
  <div className="text-xs text-text-muted text-center">
    Load a model in the Models tab to activate this agent.
  </div>
);
```

Also update the "running" spinner copy from "Connecting to OpenClaw…" to "Activating agent…":

```tsx
<div className="flex items-center justify-center gap-1.5 text-xs text-text-muted">
  <Loader2 size={12} className="animate-spin" />
  Activating agent…
</div>
```

And the success badge from "OpenClaw ready" to "Agent ready":

```tsx
<div className="flex items-center justify-center gap-1.5 text-xs text-green-400">
  <CheckCircle size={12} />
  Agent ready
</div>
```

- [ ] **Step 4: Run the test — expect it to pass**

```powershell
npx vitest run src/components/agents/onboarding/steps/__tests__/DoneStep.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run full suite**

```powershell
npx vitest run 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 6: Commit**

```powershell
git add frontend-react/src/components/agents/onboarding/steps/DoneStep.tsx `
       frontend-react/src/components/agents/onboarding/steps/__tests__/DoneStep.test.tsx
git commit -m "feat(onboarding): remove OpenClaw copy from DoneStep — user-facing language only"
```

---

## Task 6 — `AgentCard.tsx`: Remove runtime toggle, unify run panel

**Files:**
- Modify: `frontend-react/src/components/agents/main/AgentCard.tsx`

Currently `AgentRunPanel` has a `Runtime` type (`'local' | 'openclaw'`), a `RuntimeSelector` component, and two separate bodies (`LocalTestBody` / `OpenClawTestBody`). Since all agents now run through `tauri.agents.run()` (which dispatches to OpenClaw), we keep only the streaming run body and remove the selector.

- [ ] **Step 1: Write the failing test**

Add to the existing `frontend-react/src/components/agents/main/__tests__/AgentCard.test.tsx`. First read the current test file to understand what's already there, then add this test at the end:

```tsx
describe('AgentCard runtime selector', () => {
  it('does not render a Local / OpenClaw toggle', () => {
    render(
      <AgentCard
        agent={agent}
        gatewayUp={true}
        onDelete={vi.fn()}
      />
    );
    expect(screen.queryByText(/local feral/i)).toBeNull();
    expect(screen.queryByText(/openclaw test mode/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

```powershell
npx vitest run src/components/agents/main/__tests__/AgentCard.test.tsx 2>&1 | tail -20
```

Expected: FAIL — "Local Feral" text is rendered.

- [ ] **Step 3: Remove `Runtime` type, `RuntimeSelector`, `RuntimeButton`, `OpenClawTestBody`, `OpenClawResultPanel` from `AgentCard.tsx`**

Delete the following:
- The `type Runtime = 'local' | 'openclaw';` line
- The entire `RuntimeSelector` component function
- The entire `RuntimeButton` component function
- The entire `OpenClawTestBody` component function
- The entire `OpenClawResultPanel` component function

- [ ] **Step 4: Simplify `AgentRunPanel`**

Replace the full `AgentRunPanel` function with:

```tsx
function AgentRunPanel({ agent }: { agent: AgentConfig }) {
  const [prompt, setPrompt]         = useState('');
  const [running, setRunning]       = useState(false);
  const [tokenText, setTokenText]   = useState('');
  const [items, setItems]           = useState<DisplayItem[]>([]);
  const [runError, setRunError]     = useState<string | null>(null);
  const channelRef                  = useRef<Channel<string> | null>(null);

  const hasOutput: boolean = !!(tokenText || items.length > 0 || runError);

  const handleRun = async () => {
    if (!prompt.trim() || running) return;
    setRunning(true);
    setTokenText('');
    setItems([]);
    setRunError(null);

    const ch = new Channel<string>();
    channelRef.current = ch;

    ch.onmessage = (raw: string) => {
      try {
        const ev = JSON.parse(raw) as AgentEvent;
        if (ev.kind === 'token') {
          setTokenText((t) => t + ev.text);
        } else if (ev.kind === 'tool_call') {
          setItems((prev) => [...prev, {
            type: 'tool_call',
            name: ev.name,
            args: typeof ev.args === 'string' ? ev.args : JSON.stringify(ev.args, null, 2),
          }]);
        } else if (ev.kind === 'tool_result') {
          setItems((prev) => [...prev, {
            type: 'tool_result', name: ev.name, ok: ev.ok, output: ev.output,
          }]);
        } else if (ev.kind === 'final') {
          setTokenText('');
          setItems((prev) => [...prev, { type: 'final', text: ev.text }]);
        } else if (ev.kind === 'error') {
          setItems((prev) => [...prev, { type: 'error', message: ev.message }]);
        }
      } catch {
        // malformed event — ignore
      }
    };

    try {
      await tauri.agents.run(agent.id!, prompt.trim(), ch);
    } catch (e) {
      setRunError(String(e));
    } finally {
      setRunning(false);
      channelRef.current = null;
    }
  };

  return (
    <div className="border-t border-border-subtle bg-bg-primary p-4 space-y-3">
      <div className="flex gap-2">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleRun();
            }
          }}
          placeholder="Enter a prompt… (Enter to run, Shift+Enter for newline)"
          rows={2}
          disabled={running}
          className="flex-1 rounded-md border border-bg-hover bg-bg-surface px-3 py-2 text-xs text-text-primary outline-none focus:ring-1 focus:ring-brand placeholder:text-text-muted resize-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void handleRun()}
          disabled={running || !prompt.trim()}
          aria-label={running ? 'Stop agent' : 'Run agent'}
          className="shrink-0 px-3 py-2 rounded-md bg-brand text-white text-xs font-medium hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
        >
          {running ? <Square size={11} /> : <Play size={11} />}
          {running ? 'Running…' : 'Run'}
        </button>
      </div>

      {hasOutput && (
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {tokenText && (
            <pre className="text-[11px] text-text-secondary font-mono whitespace-pre-wrap break-words bg-bg-hover rounded p-2">
              {tokenText}
              {running && <span className="animate-pulse">▌</span>}
            </pre>
          )}
          {items.map((item, i) => {
            if (item.type === 'tool_call') {
              return (
                <div key={i} className="rounded border border-border-subtle bg-bg-surface p-2 space-y-1">
                  <p className="text-[11px] font-medium text-text-muted">
                    🔧 Calling <span className="text-text-primary">{item.name}</span>
                  </p>
                  {item.args && item.args !== '{}' && (
                    <pre className="text-[10px] text-text-muted font-mono whitespace-pre-wrap break-words">
                      {item.args}
                    </pre>
                  )}
                </div>
              );
            }
            if (item.type === 'tool_result') {
              return (
                <div key={i} className={cn(
                  'rounded border p-2 space-y-1',
                  item.ok
                    ? 'border-green-500/20 bg-green-500/5'
                    : 'border-red-500/20 bg-red-500/5',
                )}>
                  <p className="text-[11px] font-medium text-text-muted">
                    {item.ok ? '✓' : '✗'} Result from <span className="text-text-primary">{item.name}</span>
                  </p>
                  <pre className="text-[10px] text-text-muted font-mono whitespace-pre-wrap break-words max-h-24 overflow-y-auto">
                    {item.output}
                  </pre>
                </div>
              );
            }
            if (item.type === 'final') {
              return (
                <div key={i} className="rounded border border-brand/30 bg-brand/5 p-3">
                  <p className="text-[11px] font-medium text-brand mb-1">Answer</p>
                  <p className="text-xs text-text-primary whitespace-pre-wrap break-words">{item.text}</p>
                </div>
              );
            }
            if (item.type === 'error') {
              return (
                <div key={i} className="flex items-start gap-2 rounded border border-red-500/30 bg-red-500/5 p-2">
                  <AlertCircle size={11} className="text-red-400 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-red-400">{item.message}</p>
                </div>
              );
            }
            return null;
          })}
          {runError && (
            <div className="flex items-start gap-2 rounded border border-red-500/30 bg-red-500/5 p-2">
              <AlertCircle size={11} className="text-red-400 shrink-0 mt-0.5" />
              <p className="text-[11px] text-red-400">{runError}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Clean up unused imports in `AgentCard.tsx`**

Remove from the import line any icons or types no longer used. The remaining used imports are: `useRef`, `useState`, `Trash2`, `AlertCircle`, `ChevronDown`, `Play`, `Square`, `Server` (can remove), `CheckCircle`, `Clock` (can remove), `ShieldAlert` (can remove), `Plug`, `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogFooter`, `tauri`, `Channel`, `AgentConfig`, `AgentEvent`, `cn`, `TOOL_LABELS`.

Remove: `FlaskConical`, `Server`, `Clock`, `ShieldAlert`, `OpenClawTestMessageResult` (no longer needed in this file).

- [ ] **Step 6: Run the test — expect it to pass**

```powershell
npx vitest run src/components/agents/main/__tests__/AgentCard.test.tsx 2>&1 | tail -30
```

Expected: all tests pass including the new one.

- [ ] **Step 7: Run full suite**

```powershell
npx vitest run 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 8: Commit**

```powershell
git add frontend-react/src/components/agents/main/AgentCard.tsx
git commit -m "feat(agents): remove runtime selector — all agents run through OpenClaw"
```

---

## Task 7 — Final build and smoke test

- [ ] **Step 1: Full Rust test suite**

```powershell
cd src-tauri && cargo test 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 2: Full frontend test suite**

```powershell
cd frontend-react && npx vitest run 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 3: Build the app**

```powershell
cd ..
npm run tauri dev 2>&1 | Select-String "error|Error" | head -20
```

Expected: app launches without errors. In the Agents tab, the onboarding flow leads to an agent card with a clean run panel (no "Local Feral / OpenClaw" toggle). Running the agent shows streaming output.

- [ ] **Step 4: Final commit if needed**

If there were any fixes during smoke test:

```powershell
git add -p
git commit -m "fix(openclaw-bridge): smoke test fixes"
```
