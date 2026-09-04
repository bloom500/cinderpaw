# Updater key migration plan (0.1.x → 0.2.0)

**Status:** plan approved for 0.2.0 release · **Owner:** release manager
**Background:** the original Tauri updater signing key (`.tauri-key`) was
committed to the public repository (commits `7a96557` / `295fd5d`) and must be
treated as **compromised**. A new keypair was generated on 2026-06-10
(`~/.tauri/cinderpaw-updater.key`) and `tauri.conf.json` now embeds the new public
key. The old key file was removed from the working tree and the git history
purge + `TAURI_SIGNING_PRIVATE_KEY` GitHub Actions secret rotation are done.

## The problem

Tauri's updater verifies every downloaded update against the **pubkey baked
into the installed app**. Installed 0.1.x apps carry the OLD pubkey:

- Releases signed with the **new** key → 0.1.x clients fail signature
  verification and silently refuse the update. Users are stranded.
- Releases signed with the **old** key → verification passes, but anyone with
  the leaked key can forge "valid" updates. Unacceptable for anything except
  a narrow transition window.

## Decision: one transitional release, then hard cut

### Step 1 — transitional release `0.1.8` (signed with the OLD key)

A minimal release whose only purpose is to carry the new pubkey to existing
installs:

- Bump version, no feature changes beyond what's already on `main`.
- `tauri.conf.json > plugins.updater.pubkey` = **new** pubkey (already done).
- Sign the artifacts with the **old** key (one-off, local, air-gapped step —
  the old key must NOT go back into CI; CI already holds only the new key).
- Publish with an explicit release note: *"maintenance release — updates the
  app's update-verification key; please install promptly."*

Risk window: an attacker with the leaked key could also publish a forged
"0.1.8". Mitigations: (a) the window is short — `latest.json` on the GitHub
release endpoint is controlled by repo access, not by the key, so a forged
artifact would still need a repo compromise to be *served* to clients;
(b) the release notes and checksums are published on the repo page.
The leaked key alone does not let an attacker reach clients through the
official update channel.

### Step 2 — `0.2.0` and everything after (signed with the NEW key)

- CI signs with `TAURI_SIGNING_PRIVATE_KEY` = new key (already rotated).
- 0.1.8 clients verify against the new pubkey they received in Step 1 → OK.
- 0.1.7-and-older clients that skipped 0.1.8 will fail verification on
  0.2.0. They keep working but stop auto-updating.

### Step 3 — stranded-user story

For users who never installed 0.1.8:

- The 0.2.0 release page states plainly: *"updating from 0.1.7 or older
  requires downloading the installer manually (one time)."*
- The README installation section links straight to the latest installer, so
  the manual path is always one click away.
- In-app: 0.1.x's update check fails verification silently; there is no
  mechanism to notify those users in-app (that is exactly why the
  transitional release should stay up for a long time).

## Checklist

- [x] New keypair generated; old key removed from tree (2026-06-10)
- [x] `tauri.conf.json` pubkey updated
- [x] Git history purged of `.tauri-key` (user, 2026-06-10)
- [x] `TAURI_SIGNING_PRIVATE_KEY` secret rotated in GitHub Actions (user)
- [ ] Cut `0.1.8` transitional release, signed locally with the old key
- [ ] Verify on a real 0.1.7 install that 0.1.8 is offered and installs
- [ ] Cut `0.2.0` signed by CI with the new key
- [ ] Verify on a 0.1.8 install that 0.2.0 is offered and installs
- [ ] Destroy local copies of the old key (`~/.tauri/compromised-key-backup/`)
      after the transition window closes
