# Releasing Cinderpaw

Cinderpaw uses **calendar versioning (CalVer)**: a release is named by its date,
`YYYY.MM.DD` (e.g. `2026.06.17`).

## The padded vs. unpadded rule

- **What users see** (release name, git tag, the app's About screen): the padded
  date, `2026.06.17`.
- **What the manifests store**: the *unpadded* semver equivalent, `2026.6.17`.

Why two forms: Tauri's updater compares versions as **semver**, and semver
forbids leading zeros — `2026.06.17` is invalid, `2026.6.17` is valid. The app
zero-pads the version only for display (`formatDisplayVersion` in
`frontend-react/src/hooks/useAppVersion.ts`).

**Never hand-edit a version to a padded form** in `tauri.conf.json`,
`Cargo.toml`, or a `package.json` — it will break the build and the updater. Use
the script below, which does the conversion for you.

## Cutting a release

```sh
# 1. Set the version everywhere (defaults to today's date).
node scripts/set-release-version.mjs           # or: ... 2026.06.17

# 2. Add a CHANGELOG.md section with the PADDED header (no leading `v`):
#      ## 2026.06.17

# 3. Commit, then tag with the padded date and a leading `v`:
git commit -am "release: 2026.06.17"
git tag v2026.06.17
git push origin main --tags
```

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which builds and
publishes the signed bundles plus the updater manifest.

## Same-day re-release

A pure date can't be bumped twice in one day under semver (only three numeric
parts). If you must ship again the same day, advance the day component
(`2026.6.17` → `2026.6.18`) — it stays a valid, monotonically increasing version;
the displayed date will be one day ahead, which is an accepted rare edge.

## The `feral-agent` npm package

The npm package is versioned and released independently (tag `feral-agent-v*`,
see `.github/workflows/publish-npm.yml`). Its `package.json` version follows the
same CalVer scheme but on its own cadence.

It ships **cross-platform** via the esbuild/swc pattern: the workflow builds one
per-platform package per OS/arch (`feral-agent-win32-x64`, `-darwin-arm64`,
`-darwin-x64`, `-linux-x64`), each carrying just that platform's `feral-cli` +
sidecar binaries with `os`/`cpu` set, then publishes the umbrella `feral-agent`
that lists all four as `optionalDependencies`. `npm install -g feral-agent`
pulls only the one matching the user's machine; `bin/cinderpaw.js` resolves it.

Cutting an npm release:

```sh
node scripts/set-release-version.mjs 2026.06.17   # bumps CinderpawAgent/package.json too
git tag feral-agent-v2026.6.17                     # UNPADDED semver, matches package.json
git push origin feral-agent-v2026.6.17
```

Requires the `NPM_TOKEN` repository secret (an npm automation/granular token with
publish rights). To rehearse without publishing, run the workflow manually with
`dry_run: true` — it builds all four platforms and `npm pack`s without touching
the registry. A same-day re-release needs a fresh version (npm versions are
immutable); advance the day component like the app does.
