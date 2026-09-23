# Pre-release checklist

Branch: `integration/release-2026-09-17`. Last public release: **v2026.08.11**.
Status as of 23 Sep 2026, evening. `[x]` done, `[ ]` open, `[~]` partly.

## 1. The code is green

- [~] `scripts/verify.sh`. Non-cargo half green on 23 Sep at the commit that
      adds this file: agent 4315 pass / 0 fail + tsc, React 978 pass / 0 errors
      + tsc, TUI tests + build. (One unhandled error in the React run, a route
      warm-up landing after test teardown, was fixed on the way.) The cargo half
      (check, host and core tests, including the new `title_locked` and
      `file_args` tests) must run with the dev app **closed**: a second cargo
      against the dev build's target dir deadlocks both.
- [ ] Sidecar binary in `src-tauri/binaries/` rebuilt from the release commit.

## 2. What a stranger sees (fresh machine)

- [x] Sidecar boots against an empty home: exit 0, prints "NO MODEL CONFIGURED"
      and "user not onboarded" (23 Sep).
- [ ] The installed app on a Windows that never had Cinderpaw: wizard, counter
      notice, Sign in with OpenRouter, first answer under 90 s.
- [ ] Send to > Cinderpaw appears after install and disappears after uninstall
      (NSIS hook, never built yet; MSI has no hook).
- [ ] Three-stranger test: `docs/usability/stranger-test.md`.

## 3. Features Darius has not tried yet (23 Sep)

- [ ] Sign in with OpenRouter (creates a key on his account).
- [ ] Alt+Space from another app.
- [ ] Appearance -> Background: Glass / Solid.
- [ ] Memory -> Forget, then Undo.
- [ ] A new chat gets a generated title; a renamed chat keeps its name.
- [ ] Esc with the browser open; Ctrl+N from the composer.
- [ ] Delete a chat, then Undo.
- [ ] Taskbar-while-fullscreen fix, mascot wall, Language row, "play X on
      Spotify", Jev edit / open_folder / screenshot (from the 23 Sep morning).
- [ ] One 5-minute call to read the stage timings (`lib/callTiming.ts`).

## 4. The gate he set (19 Sep)

- [ ] Astra reviews the recent work (voice + workstation).
- [ ] Mascot done.

## 5. Release notes

- [x] `CHANGELOG.md` "Unreleased" lists what shipped since August (written
      23 Sep from the commit log; it had two entries for ~900 commits).
- [ ] At release: rename `## Unreleased` to the release date. `release.yml`
      extracts only the tag's section, so an unrenamed heading ships empty notes.
- [ ] Version: `node scripts/set-release-version.mjs YYYY.MM.DD` (all manifests).

## 6. Release day (his hands; see memory `release-day-checklist-2026-09`)

- [ ] Merge to main (the classifier refuses it for agents; he runs it).
- [ ] `git tag vYYYY.MM.DD` and push -> installers.
- [ ] `git tag cinderpaw-agent-vYYYY.MM.DD` and push -> npm.
- [ ] `npm deprecate feral-agent "Renamed: npm install -g cinderpaw-agent"`.
- [ ] `npm view cinderpaw-agent version` matches; `GET /install` counts one.
