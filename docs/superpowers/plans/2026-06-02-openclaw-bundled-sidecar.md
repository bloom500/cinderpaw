# OpenClaw Bundled Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bundle OpenClaw as a Tauri sidecar so users never install or start it manually — Feral starts it automatically on launch with an auto-generated auth token.

**Architecture:** A new `openclaw_sidecar.rs` module handles binary discovery (PATH first, resource dir fallback) and process spawning. AppState gains a `Child` handle that gets killed on app exit. The CI workflow builds a standalone OpenClaw executable using `pkg` and places it where Tauri's `bundle.externalBin` expects it.

**Tech Stack:** Rust, tokio::process::Command, parking_lot::Mutex (already used in AppState), uuid (already in Cargo.toml), GitHub Actions (Windows), npx pkg

---

## File Map

| File | Change |
|------|--------|
| `src-tauri/src/openclaw_sidecar.rs` | New: binary finder + sidecar launcher |
| `src-tauri/src/lib.rs` | Add `openclaw_process` to AppState, start sidecar in setup, kill on exit |
| `src-tauri/tauri.conf.json` | Add `bundle.externalBin` |
| `.github/workflows/release.yml` | Add step: build standalone OpenClaw binary via pkg |

No new Cargo dependencies. `uuid`, `parking_lot`, `tokio` are already in Cargo.toml.

---

## Task 1: `openclaw_sidecar.rs` — binary finder and launcher

**Files:**
- Create: `src-tauri/src/openclaw_sidecar.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod openclaw_sidecar;`)

### Context

`locate_openclaw()` in `openclaw.rs` is async and uses the Tokio process API. For sidecar startup (which happens during app setup, before the async runtime is freely available), we need a **sync** PATH lookup using `std::process::Command`. The resource dir path comes from `AppHandle::path().resource_dir()`.

On Windows the binary is `openclaw.exe`; on other platforms it has no extension.

- [ ] **Step 1.1: Write the failing tests**

Add a new file `src-tauri/src/openclaw_sidecar.rs` with just the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn openclaw_binary_name_windows() {
        let name = sidecar_binary_name();
        #[cfg(windows)]
        assert_eq!(name, "openclaw.exe");
        #[cfg(not(windows))]
        assert_eq!(name, "openclaw");
    }

    #[test]
    fn probe_path_returns_none_for_fake_binary() {
        // "openclaw-feral-test-nonexistent" will never be on PATH
        assert!(probe_path("openclaw-feral-test-nonexistent").is_none());
    }

    #[test]
    fn generate_token_is_nonempty_and_unique() {
        let t1 = generate_token();
        let t2 = generate_token();
        assert!(!t1.is_empty());
        assert_ne!(t1, t2);
    }
}
```

- [ ] **Step 1.2: Run to confirm compile error**

```
cd d:\FeralLocalAI\src-tauri && cargo test openclaw_sidecar -- --test-threads=1 2>&1 | tail -10
```

Expected: compile error — module does not exist.

- [ ] **Step 1.3: Add `mod openclaw_sidecar;` to `lib.rs`**

In `src-tauri/src/lib.rs`, add after `mod openclaw_connection;` (line ~10):

```rust
mod openclaw_sidecar;
```

- [ ] **Step 1.4: Implement `openclaw_sidecar.rs`**

Create `src-tauri/src/openclaw_sidecar.rs` with this full content:

```rust
//! Bundled OpenClaw sidecar: binary discovery and process lifecycle.
//!
//! Discovery order:
//!   1. PATH  — user's existing OpenClaw installation takes priority.
//!   2. Tauri resource dir — bundled binary shipped with the installer.
//!
//! The process is started once on app launch and killed on app exit.
//! Start failure is non-fatal: agents fall back to local llama.cpp.

use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri::Manager;

/// Platform-specific binary filename.
pub fn sidecar_binary_name() -> &'static str {
    if cfg!(windows) { "openclaw.exe" } else { "openclaw" }
}

/// Generate a random UUID token for the sidecar gateway.
pub fn generate_token() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Check PATH for an `openclaw` binary synchronously.
/// Returns the full path if found.
pub fn probe_path(name: &str) -> Option<PathBuf> {
    let (program, arg) = if cfg!(windows) {
        ("where", name)
    } else {
        ("which", name)
    };
    let output = std::process::Command::new(program)
        .arg(arg)
        .output()
        .ok()?;
    if output.status.success() {
        let line = String::from_utf8_lossy(&output.stdout);
        let first = line.lines().next()?.trim();
        if first.is_empty() { None } else { Some(PathBuf::from(first)) }
    } else {
        None
    }
}

/// Resolve the bundled binary from the Tauri resource directory.
/// Returns `None` during `cargo tauri dev` (resource dir won't have it).
pub fn bundled_binary_path(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let binary = resource_dir.join(sidecar_binary_name());
    if binary.exists() { Some(binary) } else { None }
}

/// Find the OpenClaw binary. PATH has priority over bundled.
pub fn find_binary(app: &AppHandle) -> Option<PathBuf> {
    probe_path("openclaw").or_else(|| bundled_binary_path(app))
}

/// Start the OpenClaw gateway sidecar. Returns the child process on success.
///
/// Passes `OPENCLAW_GATEWAY_TOKEN` so all callers that read from
/// `openclaw_connection::load()` authenticate correctly.
pub fn start_sidecar(
    binary: &Path,
    token: &str,
) -> Result<tokio::process::Child, String> {
    let mut cmd = tokio::process::Command::new(binary);
    cmd.arg("start")
        .env("OPENCLAW_GATEWAY_TOKEN", token)
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

- [ ] **Step 1.5: Run tests to confirm they pass**

```
cd d:\FeralLocalAI\src-tauri && cargo test openclaw_sidecar -- --test-threads=1 2>&1 | tail -10
```

Expected: `3 tests passed`

- [ ] **Step 1.6: Commit**

```
cd d:\FeralLocalAI && git add src-tauri/src/openclaw_sidecar.rs src-tauri/src/lib.rs && git commit -m "feat(sidecar): add openclaw_sidecar module with binary finder and launcher"
```

---

## Task 2: AppState + lifecycle in `lib.rs`

**Files:**
- Modify: `src-tauri/src/lib.rs`

### Context

`AppState` uses `parking_lot::Mutex` throughout (not `std::sync::Mutex`). The child process handle must be `tokio::process::Child` since `start_sidecar` uses `tokio::process::Command`. To kill it at exit, we call `child.start_kill()` (non-blocking, works from sync context).

The sidecar is started in `.setup()` using `tauri::async_runtime::spawn` so it doesn't block startup. The kill happens in the `RunEvent::Exit` handler passed to `.build().run(handler)`.

Note: the current code ends with `.run(tauri::generate_context!()).expect(...)`. This task changes it to `.build(...).expect(...).run(handler)`.

Token is written to `openclaw_connection.json` via `openclaw_connection::save()` so all existing HTTP callers pick it up automatically.

- [ ] **Step 2.1: Add `openclaw_process` to `AppState`**

Find this struct in `src-tauri/src/lib.rs`:

```rust
pub struct AppState {
    pub manager: Arc<ModelManager>,
    pub downloads: Arc<Mutex<HashMap<String, CancelFlag>>>,
    pub stop_signal: Arc<AtomicBool>,
    pub settings: Settings,
    pub system_info_cache: Arc<Mutex<Option<SystemInfo>>>,
}
```

Replace with:

```rust
pub struct AppState {
    pub manager: Arc<ModelManager>,
    pub downloads: Arc<Mutex<HashMap<String, CancelFlag>>>,
    pub stop_signal: Arc<AtomicBool>,
    pub settings: Settings,
    pub system_info_cache: Arc<Mutex<Option<SystemInfo>>>,
    /// Bundled OpenClaw sidecar process. None if the user has OpenClaw on PATH
    /// (they manage it themselves) or if the sidecar failed to start.
    pub openclaw_process: Arc<Mutex<Option<tokio::process::Child>>>,
}
```

- [ ] **Step 2.2: Update the AppState constructor**

Find this block (~line 1213):

```rust
    let state = AppState {
        manager: manager.clone(),
        downloads: Arc::new(Mutex::new(HashMap::new())),
        stop_signal: Arc::new(AtomicBool::new(false)),
        settings,
        system_info_cache,
    };
```

Replace with:

```rust
    let state = AppState {
        manager: manager.clone(),
        downloads: Arc::new(Mutex::new(HashMap::new())),
        stop_signal: Arc::new(AtomicBool::new(false)),
        settings,
        system_info_cache,
        openclaw_process: Arc::new(Mutex::new(None)),
    };
```

- [ ] **Step 2.3: Start sidecar in `.setup()`**

Find this block in the `.setup()` closure (~line 1305):

```rust
        .setup(move |app| {
            specta_builder_for_setup.mount_events(app);
            let _handle = app.handle().clone();
            // Start API server in background if enabled.
            let cfg = settings::load();
            if cfg.api_server_enabled {
                let api_state = api::ApiState { manager: manager.clone() };
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = api::serve(api_state, cfg.api_port).await {
                        tracing::error!(?e, "api server stopped");
                    }
                });
            }
            Ok(())
        })
```

Replace with:

```rust
        .setup(move |app| {
            specta_builder_for_setup.mount_events(app);
            let _handle = app.handle().clone();
            // Start API server in background if enabled.
            let cfg = settings::load();
            if cfg.api_server_enabled {
                let api_state = api::ApiState { manager: manager.clone() };
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = api::serve(api_state, cfg.api_port).await {
                        tracing::error!(?e, "api server stopped");
                    }
                });
            }

            // Start bundled OpenClaw sidecar if no system-wide OpenClaw is on PATH.
            // PATH takes priority: users who installed OpenClaw themselves keep their version.
            let sidecar_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Both probe_path and bundled_binary_path are sync (filesystem/process).
                // Run them together in one blocking task to avoid stalling the async runtime.
                let result = tokio::task::spawn_blocking({
                    let h = sidecar_handle.clone();
                    move || {
                        // If on PATH, user manages it — skip bundled entirely.
                        if crate::openclaw_sidecar::probe_path("openclaw").is_some() {
                            return None; // None means "skip, user manages"
                        }
                        crate::openclaw_sidecar::bundled_binary_path(&h)
                    }
                }).await.unwrap_or(None);

                let Some(binary) = result else {
                    tracing::info!("OpenClaw sidecar: PATH version found or no binary — skipping");
                    return;
                };

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
            });

            Ok(())
        })
```

- [ ] **Step 2.4: Change `.run()` to `.build().run(handler)` to kill sidecar on exit**

Find the end of the builder chain:

```rust
        .invoke_handler(specta_builder.invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
```

Replace with:

```rust
        .invoke_handler(specta_builder.invoke_handler())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Ok(state) = app_handle.try_state::<AppState>() {
                    let mut guard = state.openclaw_process.lock();
                    if let Some(child) = guard.as_mut() {
                        let _ = child.start_kill();
                        tracing::info!("OpenClaw sidecar stopped");
                    }
                }
            }
        });
```

- [ ] **Step 2.5: Verify it compiles**

```
cd d:\FeralLocalAI\src-tauri && cargo build 2>&1 | grep -E "^error" | head -20
```

Expected: no `error` lines (warnings OK).

- [ ] **Step 2.6: Commit**

```
cd d:\FeralLocalAI && git add src-tauri/src/lib.rs && git commit -m "feat(sidecar): start bundled OpenClaw on launch, kill on exit"
```

---

## Task 3: `tauri.conf.json` — register the external binary

**Files:**
- Modify: `src-tauri/tauri.conf.json`

### Context

Tauri's `bundle.externalBin` tells the bundler to include extra binaries in the installer. At runtime, `app.path().resource_dir()` resolves to where these binaries land. The array values are path prefixes relative to `src-tauri/`; Tauri appends the target triple and `.exe` automatically:

- Config: `"binaries/openclaw"`
- Tauri looks for: `src-tauri/binaries/openclaw-x86_64-pc-windows-msvc.exe`
- Installed to: `<resource_dir>/openclaw-x86_64-pc-windows-msvc.exe`

**Important:** `bundled_binary_path()` in `openclaw_sidecar.rs` looks for `sidecar_binary_name()` (`openclaw.exe`) not the triple-suffixed name. Tauri strips the target triple suffix at install time, so the installed binary is just `openclaw.exe` in the resource dir. This is correct.

During `cargo tauri dev`, the resource dir does not contain the binary — `bundled_binary_path()` returns `None` and the sidecar is skipped. Developers use their own `openclaw` on PATH.

- [ ] **Step 3.1: Add `externalBin` to `bundle` in `tauri.conf.json`**

Find:

```json
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
```

Replace with:

```json
  "bundle": {
    "active": true,
    "targets": "all",
    "externalBin": [
      "binaries/openclaw"
    ],
    "icon": [
```

- [ ] **Step 3.2: Create the `binaries/` directory with a placeholder for dev**

```
mkdir -p d:/FeralLocalAI/src-tauri/binaries
echo "# Binaries built by CI — not committed" > d:/FeralLocalAI/src-tauri/binaries/.gitkeep
```

Add `.gitignore` entry so the actual `.exe` is not committed:

Open `src-tauri/.gitignore` (or create it) and add:

```
binaries/*.exe
binaries/openclaw
```

- [ ] **Step 3.3: Verify `cargo build` still succeeds (binary missing is OK for dev)**

```
cd d:\FeralLocalAI\src-tauri && cargo build 2>&1 | grep -E "^error" | head -10
```

Expected: no errors. The missing binary only matters at bundle time, not compile time.

- [ ] **Step 3.4: Commit**

```
cd d:\FeralLocalAI && git add src-tauri/tauri.conf.json src-tauri/binaries/.gitkeep && git commit -m "feat(sidecar): register openclaw as Tauri externalBin; add binaries/ dir"
```

---

## Task 4: CI workflow — build standalone OpenClaw binary

**Files:**
- Modify: `.github/workflows/release.yml`

### Context

The CI runs on `windows-latest`. Before `tauri-action` runs, we need `src-tauri/binaries/openclaw-x86_64-pc-windows-msvc.exe` to exist.

Strategy:
1. `npm install openclaw@latest` — install the package locally
2. Use PowerShell to read the `bin.openclaw` entry from its `package.json`
3. `npx pkg <entry> --target node18-win-x64` — compile to standalone `.exe`
4. Move to `src-tauri/binaries/openclaw-x86_64-pc-windows-msvc.exe`

`pkg` (by Vercel) bundles Node.js + the JS app into a single executable with no runtime dependency.

- [ ] **Step 4.1: Add the build step to `release.yml`**

Find this block in `.github/workflows/release.yml`:

```yaml
      - name: Build, sign and publish release
        uses: tauri-apps/tauri-action@v0
```

Insert before it:

```yaml
      - name: Build OpenClaw standalone binary
        shell: pwsh
        run: |
          # Install openclaw package and pkg bundler
          npm install openclaw@latest
          npm install -g @vercel/pkg

          # Read the JS entry point from openclaw's package.json
          $pkgJson = Get-Content ./node_modules/openclaw/package.json | ConvertFrom-Json
          $entry = $pkgJson.bin.openclaw
          if (-not $entry) {
            # Fallback: use main field
            $entry = $pkgJson.main
          }
          $entryPath = "./node_modules/openclaw/$entry"
          Write-Host "Packaging entry: $entryPath"

          # Build standalone Windows x64 binary
          New-Item -ItemType Directory -Force -Path src-tauri/binaries | Out-Null
          npx pkg $entryPath `
            --target node18-win-x64 `
            --output src-tauri/binaries/openclaw-x86_64-pc-windows-msvc.exe

          # Verify
          if (-not (Test-Path src-tauri/binaries/openclaw-x86_64-pc-windows-msvc.exe)) {
            Write-Error "Binary not produced — pkg step failed"
            exit 1
          }
          Write-Host "OpenClaw binary built successfully"

```

- [ ] **Step 4.2: Commit**

```
cd d:\FeralLocalAI && git add .github/workflows/release.yml && git commit -m "ci: build standalone OpenClaw binary with pkg before tauri bundle"
```

---

## Task 5: Full verification pass

- [ ] **Step 5.1: Run all Rust tests**

```
cd d:\FeralLocalAI\src-tauri && cargo test 2>&1 | grep -E "test result|FAILED|^error" | head -20
```

Expected: all pass, no errors.

- [ ] **Step 5.2: Run frontend tests**

```
cd d:\FeralLocalAI\frontend-react && npx vitest run 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Step 5.3: Dev build smoke test**

```
cd d:\FeralLocalAI\src-tauri && cargo build 2>&1 | grep -E "^error|Finished" | head -5
```

Expected: `Finished dev profile`.

- [ ] **Step 5.4: Final commit if any fixups were needed**

Only needed if steps above revealed issues.

```
cd d:\FeralLocalAI && git add -p && git commit -m "fix: sidecar verification pass"
```
