# Checkpoint 2026-09-25: voice call and Jev, end to end

Written at the end of the pre-release bug-hunt session so the next one starts
from facts, not from memory. **Current code wins over this file**: check a claim
here against the code before building on it.

- Branch: `claude/vigilant-knuth-jqrbqc`
- PR: bloom500/cinderpaw#21
- Release target: Sunday 2026-09-27 (tag `v2026.09.27`)

## State of the PR

- **Second session (25 Sep, 22:10-23:10 UTC)**: items 1 and 2 below are done
  and green on CI (Linux GTK 3 on 22.04, macOS runner, Windows). `sign-off`
  is still red for the reason below. `./scripts/verify.sh` passed except
  one cinderpaw-core test that is order-dependent under parallel runs
  (`settings::...legacy_home...`, passes alone 3/3; queued as its own task).

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
- Named elements (second session, 25 Sep evening): `desktop_control_atspi.rs`
  (Linux, AT-SPI over D-Bus with `zbus`) and `desktop_control_ax.rs` (macOS,
  AX through System Events, JXA). Same UIA role names and
  `AccessibilityElement` fields as Windows; `NO_ELEMENT_TREE` is gone.
  - Element id `pid:0.<check>.<path>`: 0 is never a window, `path` is child
    indices, `check` is FNV of role + name. A stale id is refused
    (`element_not_found`), never pressed.
  - Keys to an element: its window to the front, the element asked for focus
    (best effort, as Windows `ensure_focused`), never into a password field.
  - A query for Documents alone does not enter the Document (Jev's keys).
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

## Third session (26 Sep, 00:00-01:30 UTC): Jev "stop" and fluidity

**Jev**: "stop" is the brake on what Cinder was handed and never ends the
call; `hang_up` ("hang up", "end the call") does (`bc2bfb9`, the user's own
reading of the word).

**UI/UX fluidity**, measured in Chromium on the real build with the Tauri IPC
stubbed (see "Measuring the UI" below):
- Chat text: fenced code rendered as inline pills and Mermaid never drew (a
  `startsWith('language-')` test against "hljs language-ts"); every code
  element remounted per token; the whole reply re-parsed per token. Now
  block-memoized Markdown (`lib/markdownBlocks.ts`, equivalence-tested on a
  corpus and every streaming prefix): 11.4 -> 4.3 ms per update, 1,324 -> 5
  code mounts. ChatPage no longer re-renders per token; agent tokens render
  once per frame.
- Background scene: animated lights under full-window frosted glass
  re-blurred the window every frame. Still now: idle CPU 2,220 -> 184 ms/s.
- Per-letter JS animations (composer examples, ShimmeringText) moved to CSS.
- Call pill window loads only the pill: first pixel 952 -> 320 ms (CPU x4).
- Menus are non-modal (no body restyle): model picker 200 -> 104 ms.
- Home: the mascot covered the "W" of the question; the greeting leaves room.
- Menus click through on the page (user's call, 26 Sep): checked in
  Chromium with New, Browser, the composer, another chat row, a second "…",
  Escape and Delete (which always asks). Inside Search and dialogs they stay
  modal (`MenuInOverlay`), so dismissing a menu does not close Search too.
- The alpha notice has real buttons (Report a bug, Contribute) and drops its
  paragraph below 1,280 px so it never covers the home question.

Still slow-ish (click to paint, CPU x4): Browser panel ~200 ms (not the
glass: unchanged without backdrop), search overlay ~150 ms (88 without its
backdrop blur), new chat ~170 ms.

**Measuring the UI** (none of it committed): `vite build`, `vite preview`,
Playwright's Chromium (`/opt/pw-browsers/...`) with an init script that
defines `window.__TAURI_INTERNALS__` (`invoke` returning `[]` for list-like
commands and `null` otherwise, `transformCallback`, `metadata`), click
"Skip" on the onboarding. Idle cost: CPU ticks of the Chromium process tree
over 5 s. Clicks: `PerformanceObserver({type:'event'})` durations with
`Emulation.setCPUThrottlingRate(4)`. Causes: CDP tracing with
`devtools.timeline.invalidationTracking` (style recalcs and who caused them).

## Open, in priority order

0. The first macOS CI run found that the host did not compile on macOS at all:
   `call_pill.rs` called `.transparent()`, which needs `macos-private-api`.
   That is fixed by gating it; the pill is opaque on macOS. The next macOS run
   may surface further macOS-only compile errors: fix each one as it appears.
   Enabling `macos-private-api` (a transparent pill) is a product decision:
   ask first.

1. **macOS CI** (done, second session). The runner grants Accessibility; it
   does not grant Automation for TextEdit, so an Apple Event *to TextEdit*
   waits for a consent dialog and times out (-1712). The product never sends
   one (only System Events), and the tests no longer do: TextEdit is opened
   with `open -e` and read through AX.
   `rust / macos-latest` on `9d84967`: 22/22, the four live TextEdit tests
   included (keys, close button pressed by name, stale id refused, text area
   filled and read). The first failure of the press test was a System
   Events read failing while TextEdit was busy, not a closed window: the
   check now retries and prints what it saw. One `macos-latest /
   cinderpaw-agent` run failed only the FMS 10k `summaries()` p99 timing
   (320 ms on a shared runner); the next run passed.
2. **Click by name on macOS and Linux** (done, second session).
   - Linux live tests (zenity; local GTK 4 and GTK 3 via yad; CI GTK 3 on
     22.04): press "Yes" by name and read the exit code, a forged id refused,
     text set and read, keys typed after focus, Document falls back to the
     window.
   - Never call AT-SPI `GetActions`: at-spi2-atk 2.38 (Ubuntu 22.04) aborts
     the *target app* on it. Actions are read with `NActions` + `GetName(i)`.
   - GTK 4 answers "" to `GetText(0, -1)` and has no `GrabFocus`.
   - Known limits: a Qt app needs `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`; on
     macOS every AX read is an Apple Event, so Jev's `clickInFront` (up to four
     walks of the page) is slow on big pages; `automation_id` is empty on
     macOS; `perform_action` there is press/toggle/focus only.
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
