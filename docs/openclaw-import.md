# Importing OpenClaw's connectors and providers

Measured against OpenClaw at `9252b5911bab1482c91dddebcddfcc76d0204906`
(2026-09-11), MIT licensed.

## What is and is not portable

OpenClaw ships 21 third-party chat platforms and 58 model providers. The
temptation is to copy them. The numbers say why that is not available:

| platform | lines (non-test) | files |
|---|---:|---:|
| discord | 73,789 | 450 |
| telegram | 63,109 | 314 |
| matrix | 43,523 | 240 |
| slack | 41,083 | 221 |
| feishu | 35,541 | 165 |
| imessage | 24,844 | 133 |
| whatsapp | 24,375 | 180 |
| msteams | 23,612 | 137 |
| mattermost | 13,469 | 81 |
| signal | 12,860 | 77 |
| line | 12,202 | 77 |
| tlon | 7,844 | 47 |
| googlechat | 6,769 | 55 |
| zalo | 6,340 | 47 |
| nostr | 5,150 | 40 |
| sms | 4,716 | 24 |
| synology-chat | 4,409 | 27 |
| irc | 4,037 | 37 |
| nextcloud-talk | 3,963 | 44 |
| twitch | 3,738 | 29 |
| zoom-meetings | 1,388 | 22 |

~417,000 lines. And none of it stands alone: every extension is written
against their host — `src/plugin-sdk` (55,679 lines), `src/plugins`
(138,286) and `src/channels` (47,410), over 240,000 lines of runtime that a
plugin plugs into. Lifting `extensions/discord` means lifting the agent it
was written for.

So the split is:

- **Take the data.** Their manifests are pure declaration with zero runtime
  coupling. `scripts/openclaw/extract-manifests.py` pulls all of it.
- **Take the shape.** A plugin is a self-contained folder with a declarative
  manifest and a ~30 line entry file that only registers. That is the
  contract we were otherwise going to invent.
- **Port the protocol, not the code.** Their implementation is the reference
  for the parts that are expensive to learn: retries, rate limits, and each
  API's ugly corners. Expect 1,000 to 3,000 lines per platform against our
  host, not a copy.

## The manifest, and why it matters here

Every channel declares the same core in all 21 of 21: `id`, `label`,
`selectionLabel`, `docsPath`, `blurb`, `setup`. 17 of 21 add
`configuredState` (how to tell the thing is set up). `setup.fields` carries
33 sensitive fields across the 21, each already flagged `sensitive: true`
with its env var names.

Our own `crates/cinderpaw-core/src/connectors.rs` catalog is the same idea
hardcoded for three platforms. Theirs solves the general case, and the
extracted JSON is directly the input our catalog needs.

Six of their 27 declared channels are not third-party platforms (`a2a`,
`buzz`, `clickclack`, `qa-channel`, `raft`, `reef`) and the extractor skips
them by name.

## Known intake risks

- **Signal needs an external daemon.** Its extension depends only on `ws`
  and `zod`; the blurb confirms a `signal-cli` linked device with a local
  RPC. Good for licensing, since the GPL binary stays outside our tree, but
  it means a fresh install cannot reach Signal without the user installing
  something first. That has to be said on screen, not in a log.
- **42 distinct runtime dependencies** across the 21 platforms, mostly
  official platform SDKs (`@slack/bolt`, `grammy`, `matrix-js-sdk`,
  `@twurple/*`, `baileys`, `@line/bot-sdk`, `@microsoft/teams.*`). The list
  is captured per platform in `openclaw-channels.json` under `_deps`. Their
  licences have NOT been resolved yet. Do that before the first platform
  lands, not after twenty.
- **Drift is only answerable if we record where we copied from.** Both
  extracted files carry `_upstreamCommit`, and the extractor is committed,
  so re-running it against a newer clone makes `git diff` the drift report.
  This is the thing `src/vendor/tool-call-repair` lacked: its README still
  says `payload.ts` is a verbatim copy, and it has not been one for a while
  (upstream has since added `resolveProtectedRanges`, which we do not have).

## Order of work

1. Extract the manifests. Done, this commit.
2. Write our plugin contract, informed by the trust boundary in
   `audit-out/zone-c-claude.md`.
3. Port platform by platform, cheapest first, to prove the contract on
   genuinely different protocols before the expensive ones: twitch (3,738),
   nextcloud-talk (3,963), irc (4,037), synology-chat (4,409). Discord and
   Telegram last.

Step 3 is roughly a month, not a week. Said here so the estimate is on the
record before the third platform rather than after it.
