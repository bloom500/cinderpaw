# Pre-release checklist

Release: **v2026.10.16, Friday 16 Oct 2026**. Last public release: **v2026.08.11**.
Sections 1-4 last updated 23 Sep 2026; 5-6 on 14 Oct. `[x]` done, `[ ]` open, `[~]` partly.

## 1. The code is green

- [~] `scripts/verify.sh`. Non-cargo half green on 23 Sep at the commit that
      adds this file: agent 4315 pass / 0 fail + tsc, React 978 pass / 0 errors
      + tsc, TUI tests + build. (One unhandled error in the React run, a route
      warm-up landing after test teardown, was fixed on the way.) The cargo half
      (check, host and core tests, including the new `title_locked` and
      `file_args` tests) must run with the dev app **closed**: a second cargo
      against the dev build's target dir deadlocks both.
- [ ] Sidecar binary in `src-tauri/binaries/` rebuilt from the release commit.
- [ ] `cd frontend-react && bun run voice:check` exits 0: every Cubby line has
      audio made from its current words (a changed line otherwise loses its
      Listen button).

## 2. What a stranger sees (fresh machine)

- [x] Sidecar boots against an empty home: exit 0, prints "NO MODEL CONFIGURED"
      and "user not onboarded" (23 Sep).
- [ ] The installed app on a Windows that never had Cinderpaw: wizard, counter
      notice, Sign in with OpenRouter, first answer under 90 s.
- [ ] Send to > Cinderpaw appears after install and disappears after uninstall
      (NSIS hook, never built yet; MSI has no hook).
- [ ] Three-stranger test: `docs/usability/stranger-test.md`.
- [ ] Windows notification in the INSTALLED app: ask something long, switch to
      another window, a toast appears when it finishes. In `tauri dev` the dev-only
      "Send a test notification" button showed nothing (9 Oct); dev builds have no
      installed app identity, so only the installer proves it.
- [ ] Settings in the installed app has no test buttons: no voice call self-test,
      no sound pack list, no Cubby voice sample, no test notification (dev only).
- [ ] UI sounds on by default at 35%: send a message, a reply finishes, a switch flips.

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
- [ ] Models -> Cloud: the key cards moved here from Settings (2dc969e); every
      "add a key" button (wizard, empty chat, error notice) lands on them.
- [ ] Settings -> Learning: the new tab (c42aedb); Agent tab is short now; read
      the words and say which still sound like an engineer.

## 4. The gate he set (19 Sep)

- [ ] Astra reviews the recent work (voice + workstation). Her two reviews of 19 Sep are answered on
      main (`ab8b383` pre-release, `17ff104` voice); her voice verdict stayed "necertificat", 7 of 14
      rows unverifiable for lack of correlated logs.

Mascot gate dropped by Darius on 13 Oct: the app ships with Cubby.

## 5. Release notes

- [x] `CHANGELOG.md` "Unreleased" lists what shipped since August (written
      23 Sep from the commit log; it had two entries for ~900 commits).
- [x] `## 2026.10.16` in CHANGELOG.md. `release.yml` extracts only the tag's
      section, so its opening note is all a Feral user reads about the rename.
- [x] Version: `node scripts/set-release-version.mjs 2026.10.16` (all manifests).

## 6. Release day (his hands; see memory `release-day-checklist-2026-09`)

- [ ] Merge to main (the classifier refuses it for agents; he runs it).
- [ ] `git tag vYYYY.MM.DD` and push -> installers.
- [ ] `git tag cinderpaw-agent-vYYYY.MM.DD` and push -> npm.
- [ ] `npm deprecate feral-agent "Renamed: npm uninstall -g feral-agent, then npm install -g cinderpaw-agent"`
      (both packages install a `feral` command, so npm refuses the second while the first is there).
- [ ] `npm view cinderpaw-agent version` matches; `GET /install` counts one.
- [ ] Before the site: `npx wrangler deploy` in `workers/bug-report` (the 5-codes-per-address
      limit), then the site's `/leaderboard` page committed and live. PROMISES.md links it.
- [ ] Site: merge branch `release/2026-10-16` and deploy only AFTER every installer is on the
      release. Then open each download button once: none may still give `Feral_*`.
- [ ] A Windows machine with Feral v2026.08.11 and a saved API key: let it update. Cinderpaw
      opens with the key and the old memories readable (keys move on first read, 1c0b7f5).

## 7. The update a real person gets (GATE: no final tag without it)

2026.10.16 shipped with the item above unticked, and as written it would have passed anyway:
the installer starts the new app once by itself (`/R`), so "Cinderpaw opens" is true even when
nothing on the machine can open it a second time. That is exactly what happened: a Feral update
left Cinderpaw with no shortcut and Feral still in place (fixed in `src-tauri/windows/hooks.nsh`).

Windows is automatic: the Release run's **Update path** job (`.github/workflows/update-path.yml`)
installs the previous public release and the last Feral, updates both to the new installer, and
fails if a shortcut, the app list or the old app is wrong. It must be green on the beta you promote.
The steps below are for macOS and Linux, and for Windows when that job could not run.

On a machine with the CURRENT public release installed (GitHub "Latest", not a beta):
- [ ] Run the candidate's `*-setup.exe /P /R /UPDATE` (what the updater runs; it only ever reads
      the Latest release, so a beta never reaches the real updater).
- [ ] Close the app. Open it again from the Start menu, then from the Desktop if there was a
      shortcut. Both open the NEW version.
- [ ] Settings > Apps: one entry, the new one. The old one is gone if the name changed.
- [ ] Anything that changes `productName`, `identifier` or `mainBinaryName` gets this test on
      Windows, macOS and Linux before tagging, not after.
