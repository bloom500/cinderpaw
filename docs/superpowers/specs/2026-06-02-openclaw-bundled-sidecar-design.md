# OpenClaw Bundled Sidecar Design

**Date:** 2026-06-02  
**Status:** Approved

## Goal

Bundle OpenClaw with Feral so users never need to install or start it manually. When Feral launches, OpenClaw starts automatically. When Feral quits, OpenClaw stops.

## Architecture

```
CI build
  → npm install openclaw@latest + npx pkg → openclaw-x86_64-pc-windows-msvc.exe
  → placed in src-tauri/binaries/
  → tauri.conf.json bundle.externalBin → included in installer

Feral launch sequence
  1. Check PATH for existing openclaw binary
     → found: skip bundled (user manages their own)
  2. Not found: resolve bundled binary from app resource dir
  3. Generate UUID auth token
  4. Save token to ~/.feral/openclaw_connection.json (gateway_token)
  5. Spawn: tokio::process::Command → openclaw start --port 18789
     env: OPENCLAW_GATEWAY_TOKEN=<token>
  6. Store Child handle in AppState.openclaw_process: Arc<Mutex<Option<Child>>>

Feral quit
  → app.on_window_event(WindowEvent::Destroyed) → child.kill()

All existing OpenClaw HTTP calls (warmup, run_openclaw, test_message)
  → read token via openclaw_connection::load() → work unchanged
```

## Components

### 1. `src-tauri/src/openclaw_sidecar.rs` (new file)

```rust
pub fn find_openclaw_binary(app: &AppHandle) -> Option<PathBuf>
```
- Checks PATH first via `locate_openclaw()` in openclaw.rs (reuse existing)
- Falls back to `app.path().resource_dir() / "openclaw(.exe)"`
- Returns `None` if neither found

```rust
pub fn start_openclaw_sidecar(binary: PathBuf, token: &str) -> Result<Child>
```
- Spawns `binary start --port 18789` with `OPENCLAW_GATEWAY_TOKEN` env var
- `CREATE_NO_WINDOW` on Windows (suppress console)
- Returns `Child` handle for lifecycle management

### 2. `src-tauri/src/lib.rs` changes

AppState gains:
```rust
pub openclaw_process: Arc<Mutex<Option<tokio::process::Child>>>,
```

In `tauri::Builder` setup (after `manage(state)`):
- If no PATH openclaw: call `start_openclaw_sidecar`
- On success: save generated token to `openclaw_connection`
- On failure: log warn, continue (non-fatal — agent runs local llama.cpp as fallback)

In `app.run()` event handler:
```rust
WindowEvent::Destroyed => {
    if let Ok(mut guard) = state.openclaw_process.lock() {
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
        }
    }
}
```

### 3. `tauri.conf.json` change

```json
"bundle": {
  "externalBin": ["binaries/openclaw"]
}
```

Tauri appends the target triple automatically:
- Windows: `binaries/openclaw-x86_64-pc-windows-msvc.exe`

### 4. `.github/workflows/release.yml` change

Add before the tauri-action build step:

```yaml
- name: Build OpenClaw standalone binary
  run: |
    npm install -g pkg
    mkdir -p src-tauri/binaries
    npm pack openclaw@latest
    tar -xzf openclaw-*.tgz
    pkg package/bin/openclaw.js \
      --target node18-win-x64 \
      --output src-tauri/binaries/openclaw-x86_64-pc-windows-msvc.exe
```

## Token Management

- Generated fresh each Feral launch using `uuid::Uuid::new_v4().to_string()`
- Written to `~/.feral/openclaw_connection.json` as `gateway_token`
- Passed to the sidecar as `OPENCLAW_GATEWAY_TOKEN` environment variable
- All existing HTTP callers use `openclaw_connection::load()` → no changes needed

## Error Handling

| Condition | Behaviour |
|-----------|-----------|
| PATH openclaw found | Skip bundled entirely, user manages lifecycle |
| Binary missing from resource dir | Log warn, continue without OpenClaw |
| Sidecar fails to start | Log warn, continue (agents fall back to llama.cpp) |
| Sidecar crashes mid-session | Not restarted (v1 scope); next launch will restart |
| Token write fails | Log warn, continue without auth (gateway may reject requests) |

Start failure is always **non-fatal** — Feral works without OpenClaw, agents just use local llama.cpp.

## Dev Mode

During `cargo tauri dev`, the binary won't be in the resource dir. `find_openclaw_binary` falls back to PATH. Developers install OpenClaw globally for local testing: `npm install -g openclaw@latest`.

## What Does NOT Change

- `src-tauri/src/openclaw.rs` — zero changes
- `src-tauri/src/openclaw_connection.rs` — zero changes  
- All frontend code — zero changes
- `openclaw_warmup_agent` behaviour — unchanged
- Agent `run_openclaw()` — unchanged

## Out of Scope (v1)

- macOS / Linux binaries (CI is Windows-only)
- Auto-restart on crash
- OpenClaw version pinning / update checks
- Exposing sidecar status to frontend UI
