# Slice 8B — Cross-Platform Desktop Handoff

> Implementation receipt for the eighth-B Cinderpaw Web slice. Implements
> the `cinderpaw://open` deep-link handoff from the Browser App
> (`https://cinderpaw.dev/app`) to the Cinderpaw Desktop app.

## Implementation Receipt

### Scope
- [x] `src-tauri/src/deep_link.rs` — URL validation (`is_valid_deep_link`) + window focus (`focus_main_window`, `handle_urls`) + 15 unit tests
- [x] `src-tauri/src/lib.rs` — deep-link + single-instance plugin wiring (warm + cold launch)
- [x] `src-tauri/Cargo.toml` — `tauri-plugin-deep-link 2.4.10`, `tauri-plugin-single-instance 2.4.4` (deep-link feature), `url 2`
- [x] `src-tauri/tauri.conf.json` — `plugins.deep-link.desktop.schemes: ["cinderpaw"]` (Windows registry / macOS Info.plist / Linux .desktop)
- [x] `src-tauri/capabilities/default.json` — `core:window:allow-unminimize/show/hide/set-focus/is-visible`
- [x] `Cargo.lock` — auto-generated (122 insertions)

### Files changed
| File | Stat | Notes |
|---|---|---|
| `src-tauri/src/deep_link.rs` | +225 | NEW — pure validation + focus logic, 15 tests |
| `src-tauri/src/lib.rs` | +55/-7 | `.plugin(deep_link::init)` + `.plugin(single_instance::init(...))` + `setup` on_open_url/get_current |
| `src-tauri/Cargo.toml` | +3 | `deep-link 2.4.10`, `single-instance 2.4.4 {deep-link}`, `url 2` |
| `src-tauri/tauri.conf.json` | +5 | `plugins.deep-link.desktop` |
| `src-tauri/capabilities/default.json` | +5/-0 | window focus permissions |
| `Cargo.lock` | +122/-0 | auto — 3 new crates + 10 transitive |
| **Total** | **+415, -7** | 6 files, 1 new module |

### Files explicitly NOT changed
- `crates/cinderpaw-core/**` — **ZERO changes** (gateway untouched per hard invariant)
- `src-tauri/src/commands/bootstrap.rs` — untouched (bridge contract unchanged, still 3 endpoints)
- `crates/cinderpaw-cli/**` — untouched
- `frontend-react/**` — untouched (no Browser App rebuild; Vite build still PASS)
- `tui/**` — untouched (TUI state machine untouched)
- `CinderpawAgent/**` — untouched
- `~/.cinderpaw` schema (settings, onboarding, mcp.json) — untouched
- `useCallSession.ts`, `vad.ts`, Rust audio pipeline, `mcp.json` — untouched (pinned OOS)
- Gateway `api_port` — still `127.0.0.1:11435`; bridge still `127.0.0.1:11437` (loopback-only, dies with Tauri)

### Tests
- cargo check (`-p cinderpaw --no-default-features`): **PASS** (6 `cinderpaw-core` dead_code warnings, 0 new warnings; full-feature check requires `espeak-rs-sys` cmake — same as slice 8)
- cargo test -p cinderpaw --lib --no-default-features: **147 passed / 0 failed / 1 ignored** (was 138; +15 new deep_link tests)
- cargo test deep_link filter: **15 passed / 0 failed** (valid_open, wrong_scheme/action, extra_path, query/fragment, credentials, port, malformed, bearer, contains_valid)
- bunx tsc --noEmit (frontend-react): **PASS**
- vite build (frontend-react): **PASS** (2894 modules, 45s)
- bun test (frontend-react): **381 pass / 167 fail / 28 errors** — failures are pre-existing `vi.importActual is not a function` in `DoneStep.test.tsx` (vitest compat), unrelated to this slice; `verify.sh` not runnable in this env (requires full cargo + cmake)

### Security
- bearer token server-side only: **PASS** — deep_link module holds no token, makes no gateway call; browser CTA is bare `cinderpaw://open`
- token absent from response: **PASS** — `handle_urls` returns no JSON, only `tracing::info/debug`
- token absent from client bundle: **PASS** — no browser JS change; `cinderpaw://open` carries no auth
- token absent from URL/storage: **PASS** — `is_valid_deep_link` rejects `?token=`, `?bearer=`, `?api_key=` (query→false), rejects `user:pass@open`
- URL not interpreted as shell: **PASS** — `Url::parse` → string compare → `Window::set_focus`; never `Command`, `shell`, `eval`
- strict allowlist: **PASS** — only `cinderpaw://open` (+ trailing `/`) accepted; `cinderpaw://execute/shell/arbitrary`, `other://open`, `cinderpaw://open:8080`, extra path, fragment all rejected; arbitrary gateway path impossible (no bridge path param)

### Architectural invariants
- [x] BFF remains the only browser → gateway boundary (deep-link is OS → Desktop, not browser → gateway)
- [x] gateway remains loopback-only (`127.0.0.1:11435`, no new bind)
- [x] bridge remains loopback-only (`127.0.0.1:11437`, dies with Tauri) — untouched
- [x] no new backend / daemon / port / companion process (single-instance uses OS mutex/D-Bus, not a new server)
- [x] `crates/cinderpaw-core` untouched
- [x] TUI state machine untouched
- [x] `~/.cinderpaw` schema untouched
- [x] Browser App (`https://cinderpaw.dev/app`) remains onboarding surface; `cinderpaw://open` is ONLY optional handoff CTA (fallback instruction preserved conceptually; manual open still works)
- [x] No browser-side bearer / API key persist (transient React state only)
- [x] No arbitrary proxy (action enum still fixed; bridge not expanded)

### Deep-link mechanism (for reviewer — maps AGENTS.md pin to actual 2.11.2 API)
- **Tauri version:** `2.11.2` (Cargo.lock `tauri 2.11.2`)
- **Plugins:** `tauri-plugin-deep-link 2.4.10` (`lib.rs:560 init`, `DeepLink<R>` state, `get_current`, `on_open_url`, `handle_cli_arguments`), `tauri-plugin-single-instance 2.4.4` with `deep-link` feature (Windows `CreateMutexW`+`WM_COPYDATA 1542`, Linux D-Bus `ai.cinderpaw.app.SingleInstance`; feature auto-calls `deep_link.handle_cli_arguments` before our callback)
- **Config:** `tauri.conf.json` `plugins.deep-link.desktop.schemes: ["cinderpaw"]` — bundler emits Windows `Software\Classes\cinderpaw`, macOS `Info.plist CFBundleURLSchemes`, Linux `applications/*.desktop` + `xdg-mime`
- **Why not `RunEvent::Opened`:** In 2.11.2 it is `#[cfg(any(target_os="macos",ios,android))]` (app.rs:275); plugin's `on_event` handles it internally and re-emits `deep-link://new-url`. Our code uses `DeepLink::on_open_url` + `DeepLink::get_current` for cold, plus `single_instance` callback for Win/Linux warm — no direct `RunEvent::Opened` match needed.

### Lifecycle (cold / warm / focus / no-dup)
- **Warm (Desktop running → Browser "Open Desktop" → `cinderpaw://open`):** OS routes URL to second instance (Win/Linux) or emits `deep-link://new-url` (macOS). Win/Linux: second instance parses args → `single_instance` callback forwards `Vec<String>` to first instance → `deep_link::handle_urls` validates → `focus_main_window` (`unminimize→show→set_focus` on `main`); second instance killed. macOS: plugin `on_event(Opened)` → `emit("deep-link://new-url")` → `on_open_url` closure → same. No duplicate window (first instance reused).
- **Cold (Desktop closed → `cinderpaw://open`):** OS launches binary with URL arg (Win/Linux) or Opened urls (macOS). `init_deep_link` stores via `handle_cli_arguments`/macOS event. `setup` closure calls `deep_link.get_current()` → `handle_urls` → `focus_main_window` after window creation. Main window is `tauri.conf.json windows[0] label=main`.
- **Duplicate-window prevention:** `single-instance` kills secondary; handler never calls `WebviewWindowBuilder::new`, only `get_webview_window("main")`.

### Platform support (config-supported vs E2E-verified)
- **Windows (config-supported, E2E unverified):** `tauri.conf.json` scheme → NSIS registry; plugin `windows.rs` `CURRENT_USER\Software\Classes\cinderpaw`; `single-instance windows.rs` `CreateMutexW`+`FindWindowW`+`WM_COPYDATA`. Compiles, `cargo check` PASS. E2E requires installed MSI on Windows host (`start cinderpaw://open` → focus + log `deep-link: accepted`).
- **macOS (config-supported, E2E unverified):** `Info.plist` + plugin `on_event(Opened)` (cfg macos). Compiles (cfg-gated). E2E requires macOS host (`open cinderpaw://open`).
- **Linux (config-supported, E2E unverified):** `.desktop` + `xdg-mime` + `update-desktop-database`; D-Bus `SingleInstance`. Compiles. E2E requires Linux host (`xdg-open cinderpaw://open`).
- Honest boundary: this env (win32, no installer) cannot run installer-level E2E; code is complete per `cargo check`, logs at `info`/`debug` for host verification.

### Known limitations
- E2E launcher→focus loop **unverified** on all three OSes (needs installed bundle on each; this env is win32 dev only — code is verified by `cargo check`/`cargo test`, not by OS dispatch).
- Single action allowlist: only `cinderpaw://open` (no `cinderpaw://settings`, etc.; adding requires `is_valid_deep_link` edit — intentional).
- Browser fallback is conceptual per spec ("Cinderpaw Desktop is ready. Open Cinderpaw Desktop to continue. If nothing happened, open Cinderpaw Desktop manually and return here.") — the Browser App repo (`cinderpaw.dev/app`) is separate from `src-tauri`; no JS fallback was added in `frontend-react` (correct — `frontend-react` is the Tauri WebView, not `https://cinderpaw.dev/app`).
- `vite build` chunk >500kB warning (pre-existing; unrelated).
- `bun test` 167 failures are pre-existing vitest compat, not slice regressions.

### Deviations
- **Added `url = "2"` direct dep:** `deep_link.rs` uses `url::Url::parse`; plugin brings `url` transitively but not as direct dep for `src-tauri` crate — explicit dep required for correct `Cargo.toml`. Minimal, not a design change.
- **Used `single-instance` + `deep-link` together:** Spec said "investigate smallest native alternative if plugin unsuitable." Correct 2.11.2 pattern is both plugins (per `deep-link` README + `single-instance` `deep-link` feature docs: "Trigger deep-link event before invoking single-instance callback"). Not a workaround — canonical.
- ** Permissions extended:** `default.json` needed +5 `core:window` perms for `unminimize/show/set_focus/is-visible/hide` — not a deviation from scope, required for `focus_main_window`.
- NONE other.

### Verdict

**SLICE 8B COMPLETE WITH E2E LIMITATIONS**

Handler compiles on `tauri 2.11.2` with `deep-link 2.4.10` + `single-instance 2.4.4` actual API (verified against `~/.cargo/registry/.../src/lib.rs` + `app.rs:275`), static registration emits correct per-OS artifacts, validation is strict, warm/cold/focus/no-dup lifecycle is wired, and 15 new unit tests pass. Full OS dispatch E2E remains unverified in this env and requires installed-bundle testing per platform.
