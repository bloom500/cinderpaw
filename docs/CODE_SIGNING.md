# Windows Code Signing (Authenticode) — via SignPath Foundation

> Status: **pipeline wired, FREE, pending project approval.** Every signing step
> in the release workflow is gated on `SIGNPATH_API_TOKEN`. Until you register
> the project and add the values below, releases ship **unsigned** exactly as
> today — nothing breaks.

## Why

Unsigned Windows installers trigger SmartScreen's "Unknown publisher" warning,
which scares off a large share of non-technical users (Feral's primary
audience). An Authenticode signature removes that warning and proves the
installer came from Bloom Media and wasn't tampered with in transit. It does
**not** change how the app runs — only the trust/installation experience.

## Why SignPath (and why it's free)

Since June 2023, every publicly-trusted code-signing certificate must live on a
hardware token or cloud HSM — you can't get a cheap `.pfx` for CI anymore, and
certs cost €200–400/yr. **SignPath Foundation signs open-source projects for
free.** Feral is open-source, so it qualifies. No certificate to buy, no
hardware token.

## One-time setup (you)

1. Apply at **https://signpath.org/apply** (the *Foundation* / free OSS program —
   not the paid signpath.io). Provide the public repo `github.com/bloom500/feral`,
   project name "Feral", and the license.
2. They review that it's a genuine OSS project (a few days).
3. After approval, the SignPath dashboard gives you:
   - **Organization ID**
   - **Project slug** (e.g. `feral`)
   - **Signing policy slug** (e.g. `release-signing`)
   - an **API token**
4. Configure the SignPath project's *artifact configuration* to sign the
   uploaded `.exe`/`.msi` (their onboarding walks you through it).

## Add to GitHub

`Settings → Secrets and variables → Actions`:

| Kind | Name | Value |
| --- | --- | --- |
| **Secret** | `SIGNPATH_API_TOKEN` | the API token |
| **Variable** | `SIGNPATH_ORGANIZATION_ID` | organization ID |
| **Variable** | `SIGNPATH_PROJECT_SLUG` | project slug |
| **Variable** | `SIGNPATH_POLICY_SLUG` | signing policy slug |

No code changes needed — the workflow already reads these. The next tagged
release signs automatically.

## How it's wired (`.github/workflows/release.yml`)

Windows only, all steps gated on `SIGNPATH_API_TOKEN`:

```
tauri-action build → unsigned installers + latest.json uploaded
   │
   ├─ Collect installers (.exe / .msi)
   ├─ Upload as a GitHub artifact
   ├─ SignPath signs them (Authenticode) and returns signed copies
   └─ Regenerate updater .sig over the SIGNED installer, then
      clobber the release assets + latest.json
                              ▲
        so manual downloads AND auto-update get a signed, verifiable file
```

The updater re-sign matters: Tauri's auto-updater checks the `.sig` against the
downloaded bytes, so after SignPath changes the installer the signature must be
regenerated — otherwise auto-update would reject the signed file.

## To confirm on the first signed release (together)

The only thing that can't be tested before approval is the live run. On the
first signed tag, verify:

1. `Get-AuthenticodeSignature .\Feral_*_x64-setup.exe` → `Status: Valid`,
   signer = Bloom Media (via SignPath).
2. Fresh install on a clean Windows VM → no "Unknown publisher" SmartScreen
   (reputation may take a few downloads to fully warm up).
3. **Auto-update** applies cleanly from the previous version (this exercises the
   regenerated `.sig` — the one Windows-updater interaction to watch).

If `tauri signer sign` or the `latest.json` patch needs a tweak, it's isolated to
the gated Windows steps — dev, other platforms, and unsigned releases are
unaffected.

## Notes

- The Tauri updater **public key** in `src-tauri/tauri.conf.json` is a separate
  mechanism from Authenticode — see `docs/UPDATER_KEY_MIGRATION.md`. Both must be
  consistent (private key in CI secret ↔ matching public key shipped in the app).
- macOS signing is tracked separately (currently ad-hoc `signingIdentity: "-"`).
