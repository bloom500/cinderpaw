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

### Ported so far

Thirteen of the 21, all on `main`. Discord, Slack and WhatsApp predate this import
and live in `src/transports/connectors.ts`; the rest have a file each. `coming_soon` in
`crates/cinderpaw-core/src/connectors.rs` is the source of truth and two tests
hold it there: `connector-catalog-transports.test.ts` fails if a card is live
with no transport behind it, and `catalog_endpoints.rs` fails until somebody
writes a review arm for the newly live card by hand.

| platform | what it proved |
|---|---|
| discord, slack, whatsapp | predate the import; they are why the registry exists |
| matrix | HTTP long poll with an instance token |
| mattermost | the same pairing as Matrix over an entirely different wire |
| twitch | an OAuth device flow, with nothing for the user to paste |
| telegram | long polling: no public URL needed, and no dependency at all |
| irc | a raw socket, and the byte budget that makes a newline an injection |
| signal | a local daemon the user installs, and saying so on screen |
| nostr | no operator at all: the identity is a keypair, and several relays at once |
| nextcloud-talk | that a webhook design can be re-pointed: paired as a user, polled, so it works behind a router |
| zalo | that the HTTP status can lie: a rejected token comes back 200 with `ok:false` |
| feishu | that a webhook connector can hide a socket the platform dials out on, and that a two-cloud product can be probed instead of asked about |
| line | the first on the inbound receiver (`inbound.ts`): the signature is checked on the raw bytes before parsing, and the user brings the public address |
| sms | that a signature can cover the public URL itself, so the URL becomes a pairing field the person types, not something the receiver can infer |
| synology-chat | that "a public address" can be a LAN address, and that a loopback default is then a silent failure the card has to pre-empt |
| googlechat | that a proof can be a signed token instead of a shared secret: RS256 against published certificates, with `node:crypto` and no dependency |
| msteams | that a token can name where replies may go (`serviceurl`), and that a card with no pairing fields is coming_soon by another name |

Nostr is the first that needed a new dependency: `nostr-tools`, for the BIP-340
Schnorr signature `node:crypto` does not have. It is Unlicense, so it adds
nothing to the notice file. Check any candidate the same way before porting it,
with `python scripts/openclaw/license-inventory.py`.

### What is left, and the one thing blocking most of it

Three remain (18 of 21 are live as of 2026-09-14). The five webhook platforms
below were the eight's largest group, and they shipped on one receiver in one
day once the decision was made; what follows records why they were blocked:

**Five need an inbound public URL** and cannot work on a home machine without
one: `line`, `sms`, `synology-chat`, `googlechat` and `msteams`, all ported
2026-09-14 on the receiver (`CinderpawAgent/src/transports/inbound.ts`). Each is a
webhook platform: the provider POSTs to an address you own. A person running
Cinderpaw behind a router has no such address, no certificate, and no way to
get one without a tunnel.

**It was six twice, and both corrections are worth keeping.** Nextcloud Talk
left the list by being re-pointed rather than re-implemented: Talk has a
user-facing chat API next to its bot webhook, so pairing as a user and polling
reaches the same messages with nothing exposed. Zalo was never in it: its Bot
API long-polls with `getUpdates` by default and webhooks are the option, which
upstream documents plainly. Our own extracted manifest agrees, it carries no
`webhookPath` or `webhookUrl` field for zalo while all five above do. The
lesson is that "needs a webhook" is a claim about a platform's WHOLE API, and
reading the connector OpenClaw happened to write is not the same as reading
what the platform offers.

For the five that remain it was one product decision, not five ports, and the
decision is made: **`docs/decisions/2026-09-12-webhook-inbound.md`**. Cinderpaw
does not operate a relay. We ship the inbound receiver; the user supplies the
address with a tunnel, a reverse proxy or a domain. Recurring cost to us stays
zero and promise 2 in `PROMISES.md` stays literally true. The price is the
user's and it is real: these five will never be one-click behind a router, so
each card now says it needs a public address before anyone pastes a token, and
`catalog_endpoints.rs` fails if that sentence disappears.

`audit-out/webhook-inbound-2026-09-12.md` remains the reference for what a
hosted service would have to contain. It recommended the hosted option; the
decision went the other way on cost, and the record says why.

Note that the recommendation does NOT cover Nextcloud Talk, and must not be
applied to it: its catalog card says "Nothing goes through anyone else's
server", which the polling port keeps true and a relay would make false.

**Three are blocked on something other than a URL:**

- `imessage` — macOS only, and needs the `imsg` bridge installed locally. Same
  shape as Signal. Portable, but untestable from a Windows box.
- `tlon` — an Urbit ship over its own channel API, no public URL needed, but it
  needs a running ship to test against and pulls the AWS S3 SDK for attachments.
- `zalouser` — logs into a PERSONAL Zalo account by QR through `zca-js`, an
  unofficial reimplementation of their private client protocol. That is an
  account-ban risk for the user and a support burden for us. It should be a
  deliberate yes, not the next item on a list.
