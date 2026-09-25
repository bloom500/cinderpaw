# Checkpoint 2026-09-25: voice call and Jev, end to end

Written at the end of the pre-release bug-hunt session so the next one starts
from facts, not from memory. **Current code wins over this file**: check a claim
here against the code before building on it.

- Branch: `claude/vigilant-knuth-jqrbqc`
- PR: bloom500/cinderpaw#21
- Release target: Sunday 2026-09-27 (tag `v2026.09.27`)

## State of the PR

- **CI** was green on `3d580e2f` except `sign-off`. DCO: no commit carries
  `Signed-off-by`, and only the author can add it (`git rebase --signoff main`).
- **Head `b3448825`** adds the macOS rust job and the live desktop steps. Their
  first CI result was still pending when this was written. Check
  `rust / macos-latest`, and the live steps on Linux and macOS, first thing.
- `./scripts/verify.sh` passed locally on Linux before the cross-platform
  commits. After them:
  - `cargo test -p cinderpaw desktop_control -- --include-ignored` under Xvfb:
    17/17.
  - frontend: 978/978.

## Done in this session (do not redo)

**Voice / call pill**
- LiveKit: a mute survived a vendor close; the pill never showed the caller's
  words after the first answer; a worker that died left the window
  "listening" to nobody.
- Host: `Session::dead` and `drop_dead_chain` reboot a dead voice chain.
- Jev: a hang-up during the microphone prompt now stays a hang-up.
- The pill is no longer orphaned when a call ends while it is being built.
- The answer under the sphere is clamped.
- The pill shows "Working · subject" while a tool runs.

**computer_use**
- `find_elements` returns ids, roles and names; before, it returned only a count.
- `under_role` is documented to the model.
- Scroll goes to the Document.
- A successful `find` is no longer a failure.

**Cross-platform desktop control**
- New files: `src-tauri/src/desktop_control_unix.rs` (osascript on macOS,
  xdotool on Linux) and `desktop_control_keys.rs` (the shared key-spec parser).
- What works: windows, focus, keys, typed text, app list and launch.
- Named elements are refused with `NO_ELEMENT_TREE`.
- Packaging: `Info.plist` (NSAppleEventsUsageDescription), `entitlements.plist`
  (apple-events), and xdotool in the deb and rpm depends.

**Jev**
- Per-OS key maps (`frontend-react/src/lib/siteKeys.ts`: `platform()`,
  `MAC_KEYS`, `LINUX_KEYS`, `browserKeys`). Mac Control+Tab, not Cmd+Tab.
- New `type_text` action (dictation).
- Refusals are worded per OS.

**Browser**
- Shortcuts, Stop, tab habits, the lock indicator.
- History (Ctrl+H).
- `localhost:3000`.
- Stale notices; download feedback.
- Readability vendored.

## Open, in priority order

1. **Watch the macOS CI result.** If `text_reaches_textedit` fails only for
   TCC (Accessibility) on the runner, do not skip it. Find how the runner grants
   it, or make the step report the missing permission clearly. A compile error
   there is a real bug: fix it.
2. **Click by name on macOS and Linux.** Jev's `click` plans and computer_use's
   `click`/`find_elements`/`get_tree` return `NO_ELEMENT_TREE` there.
   - macOS: AX through `osascript` (System Events `UI elements`, `click`), or the
     AX C API through a crate. It must be tested on the macOS runner with a real
     app (TextEdit, Safari).
   - Linux: AT-SPI (the `atspi` crate, or `python3-pyatspi` through a helper).
     Test it under Xvfb with a GTK app (for example `zenity`) and at-spi2-core
     running.
   - Keep the element id shape `pid:<n>...` and the `AccessibilityElement`
     fields, so Jev's `clickInFront` and `decideClick` work unchanged.
3. **Latency, like Andy Gao's demo** (acting before the sentence ends). Today
   Jev records until 1 s of silence, transcribes the whole blob, then calls
   `jev_decide`.
   - Stream the transcription (partials), and run `decide` on a stable partial.
   - Start the obvious actions early: open a site or app named by the first
     words.
   - Measure first: `[jev] ... in Nms` is logged per decision.
4. **Parked Jev call with the window hidden (Windows).** The VAD uses a 60 ms
   `setInterval` in a hidden WebView2, which Chromium may throttle to 1 Hz, so
   short commands would be lost. Verify it on Windows. If it is throttled, move
   the VAD to an AudioWorklet (the audio thread is not throttled).
   `useJevCallSession.ts` `listenOnce`.
5. **Windows mouse fallback in `invoke()`**
   (`desktop_control_windows.rs`, last resort).
   - The problem: it clicks at the centre of the element without bringing the
     window in front or checking what is under the point, so it can hit
     another window.
   - The fix: `ensure_focused` first, `ScrollItemPattern.ScrollIntoView` when
     the element is offscreen, `ElementFromPoint` equal to the element or a
     descendant, otherwise refuse.
   - The user decided this does NOT ship untested before the release: only with
     a Windows CI test.
6. **Voice regressions** the user asked about. The code-level fixes are in; they
   still need a hands-on pass: late transcript, overlap on the sphere or pill,
   tools with no visual feedback, a call and the UI disagreeing about whether
   it is on. Also: kill the Node voice worker mid-call, and check that the next
   call boots fresh.
7. **Jev "stop" means hang up.** A person watching a video who says "stop" ends
   the call. Consider mapping a bare "stop" to media pause when media is
   playing in front, and "stop the call" to hang up. Ask the user first: it is
   product behaviour.

## Gotchas learned here

- **`pgrep -f` / `pkill -f` match their own shell.** A wait loop with
  `pgrep -f "cargo test ..."` never ends, and `pkill -f "<pattern>"` killed the
  running tool shell. Wait on a log line instead (`grep -q '^EXIT' log`).
- **xev does not set `_NET_WM_PID`,** so xdotool cannot map its window to a
  pid. Real GTK/Qt/Electron apps do. The live test sets it with `xprop`.
- **Xvfb has no window manager,** so `windowactivate` and `getactivewindow`
  fail. The backend falls back to `windowfocus` and `getwindowfocus -f`.
- **`src-tauri` needs `webkit2gtk-4.1`, the sidecar binary and `frontend/dist`**
  to compile. `scripts/verify.sh` builds the sidecar first.
- **CI runs on PRs and on pushes to `main` only,** so a branch push alone is
  not checked. PRs also run the DCO job.
- **AGENTS.md rules:**
  - Keep diffs to 3 files or fewer unless the user says otherwise; the user did
    say so for Jev cross-platform.
  - Do not touch `useCallSession.ts`, `vad.ts`, the Rust audio pipeline or
    `mcp.json` unless named.
  - Run `./scripts/verify.sh` before calling anything done.
- **The topic files `docs/agents-memory/*`** named in AGENTS.md are not in the
  repo; they live on the user's machine.
