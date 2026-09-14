# Fresh-install test, Windows

The one release check nobody's development machine can run: this repo's
authors all have `~/.cinderpaw`, a model downloaded, keys in the vault and
Bun on the PATH. A stranger has none of that. The 2026-09-13 release gate
lists "the Tauri app on a clean Windows" as untried; this is the procedure,
with what the screen must show at each step, so the run is a pass/fail and
not an impression.

## Where to run it

A machine that has never had Cinderpaw or Feral on it. In order of cost:

1. **Windows Sandbox** (Windows 10/11 Pro): `Turn Windows features on or off`
   → Windows Sandbox → reboot. Every launch is a clean Windows; nothing
   survives closing it, which is the point. Needs admin once to enable.
2. A Hyper-V or VirtualBox VM from a stock Windows 11 ISO.
3. Another physical PC, after `winget uninstall Cinderpaw` and deleting
   `%USERPROFILE%\.cinderpaw` and `%USERPROFILE%\.feral`.

Do NOT use a machine that had a previous build: the profile-dir rename and
the old vault format have both hidden first-run bugs before.

## Which installer

The release workflow builds `Cinderpaw_<version>_x64-setup.exe` (NSIS) and
the `.msi` on a tag; take the `-setup.exe` from the GitHub release, or from
the `cinderpaw-windows-unsigned` artifact of the run if the tag is not cut
yet. A local `bun tauri build` produces the same file under
`target/release/bundle/nsis/` and takes about an hour on a laptop.

## The run

Tick each line only when the screen shows it. Anything else is a finding:
write down the exact text on screen (or "nothing"), and the step.

1. **Download and open the installer.**
   Expected: SmartScreen says "Windows protected your PC / Unknown publisher"
   (unsigned build) and `More info → Run anyway` proceeds. A signed build
   shows no warning. Either is a pass; note which.
2. **Install with the defaults.** Expected: finishes without asking for
   anything but the folder, and offers to launch.
3. **First launch.** Expected within 15 seconds: the app window, and the
   guided setup (choose a model: local download or a cloud key). NOT
   expected: a blank window, a console, a "sidecar failed" dialog, or the
   main chat with no setup.
4. **Cancel setup and try to chat anyway.** Expected: a sentence on screen
   saying no model is configured and where to choose one. NOT expected:
   silence, a spinner, or a stack trace.
5. **Pick a cloud provider and paste a key.** Expected: the key is accepted
   or rejected with a sentence; on accept, one test message gets a reply.
6. **Open Connectors.** Expected: 18 cards enabled, 3 marked coming soon
   (iMessage, Tlon, Zalo personal). Open LINE: the card text names the
   port (18790) and the path (`/connectors/line`) BEFORE any field is
   filled.
7. **Enable Telegram with an empty allowlist.** Expected: the card or the
   log says nobody can reach it and how to fix it. NOT expected: "connected"
   and nothing else.
8. **Close the app and reopen it.** Expected: no setup again; the key and
   the chat history are still there.
9. **Uninstall.** Expected: `%USERPROFILE%\.cinderpaw` still exists
   (promise 7: uninstalling does not throw away your things).

## Reporting

One line per step: `N pass` or `N FAIL: <exact screen text>`. Attach
`%USERPROFILE%\.cinderpaw\gateway.log` and `...\logs\cinderpaw.log` if any step
failed. A run with any FAIL is
a release blocker; a run where a step shows something not listed above is
a finding to file, not a pass.
