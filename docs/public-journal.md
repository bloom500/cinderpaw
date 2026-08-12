# Public Journal — publishing Cubby's telemetry

How a Feral instance publishes a sanitized slice of its Evolution Journal to a
public page, and why it is built the way it is.

---

## 1. The shape of it

```
Feral instance (private)
  ~/.feral/rsi/journal/journal-YYYY-MM-DD.jsonl     hash-chained, complete, local
        │
        │  read-only, one direction
        ▼
  src/public-journal/exporter.ts                    outbound HTTPS + bearer token
        │
        ▼
  POST /api/public-journal/ingest                   landing page, re-validates
        │
        ▼
  sanitized event store                             append-only, deduped
        │
        ▼
  /cubby                                            public, read-only
```

The important property is the direction. The landing page never connects to a
Feral instance: it has no address for one, no credential to one, and no code
path that calls one. If the machine is off, the page simply stops hearing from
it — which is exactly the signal it needs to say Cubby is asleep.

## 2. Three Cubbies, deliberately not merged

They share a name and nothing else.

| | What it is | Who can reach it |
| --- | --- | --- |
| **Private Cubby** | The actual Feral instance: real memory, real BRSI state, real filesystem. | Only its operator. |
| **Public Cubby Journal** | Sanitized, read-only telemetry on the landing page. | Everyone. Read-only. |
| **Community Cubby / Paw** | Sandboxed Discord interaction, rate limited, separate model budget. | The Discord community. |

Public users cannot execute Feral tools, read private memory, touch the
filesystem, see private evolution state, or spend the private instance's model
budget. None of those are reachable from the public page or from Discord,
because none of those systems are connected to each other — only the one-way
event flow above crosses between them.

## 3. What may be published

`src/public-journal/public-event.ts` is the whole privacy boundary. It does not
filter the journal — filtering means a new field leaks by default the day
someone adds one. It **rebuilds** a small event from values it can prove are
safe:

- **Allowlisted keys only.** The output object is constructed literally; there
  is no object spread anywhere in the file.
- **No free text, ever.** `observed`, `hypothesized`, `experimented.change` and
  `decided.reason` are written by the engine and by models, and can contain
  paths, prompt fragments, or user data. None of them are published. Summaries
  come from templates with only numbers and enum members interpolated.
- **Identifiers are hashed.** `candidateId` and `cycleId` become truncated
  SHA-256 refs, so lineage stays traceable publicly without publishing a name
  that might be a file path.
- **Numbers are validated.** Each metric must be a finite number inside a
  declared range, then it is rounded. Out of range is dropped, not clamped — an
  out-of-range value means the source changed meaning.
- **Defence in depth.** `assertPublicSafe` re-scans the finished event for
  secret-shaped strings (keys, tokens, paths, JWTs, emails, IPs, env var
  references) and throws. The allowlist should make it unreachable; it exists so
  a bug in the allowlist fails closed.

The same scan runs again on the landing page, over the raw request body, before
anything is stored. A publisher that sends a secret gets a 422 rather than a
quiet cleanup, because a publisher sending one is broken.

### Event types

Only types with a real emitter today:

| Type | Source |
| --- | --- |
| `evolution.promoted` | Journal row with `decided.action === "accept"` |
| `evolution.rejected` | Journal row with `decided.action === "reject"` |
| `evolution.halted` | Journal row with `decided.action === "halt"` |

Adding a type with no emitter would put a category on the public page that can
never fill. Memory adaptation (L0), LoRA promotion (L2), code patches (L3) and
module lifecycle (L4) all get published automatically as soon as those layers
write journal rows — they map through the same `decided.action`, carrying their
own `layer`. No new code is needed for them; they need the layers to run.

### Event identity

Ids are deterministic over the source **row**, so replays dedupe rather than
duplicate. `cycleId` alone is not unique — the live engine writes several rows
per cycle (~4.5 on real journals) — so the id is derived from the row's
hash-chain `hash` where present, falling back to cycle + timestamp + decision on
legacy rows written before the chain landed.

## 4. Liveness

The exporter sends a heartbeat with every publish, including publishes with zero
events. A publisher may only ever claim `online` or `working`. It cannot claim
to be asleep: `sleeping` is what the reader concludes when a heartbeat goes
stale (5 minutes, against a 60-second beat), so an instance that dies mid-beat
cannot leave a stale "online" on the page.

## 5. Running it

### Configuration

See `docs/CONFIGURATION.md` §3b. The minimum:

```bash
export FERAL_PUBLIC_JOURNAL_URL="https://your-site/api/public-journal/ingest"
export FERAL_PUBLIC_JOURNAL_TOKEN="<the token the site expects>"
```

With those unset the exporter refuses to start, so nothing leaves the machine by
default. The token is refused over plain HTTP unless the host is localhost.

### Commands

```bash
bun scripts/publish-public-journal.ts             # one pass, then exit
bun scripts/publish-public-journal.ts --watch     # publish every 60s
bun scripts/publish-public-journal.ts --dry-run   # print the payload, send nothing
```

Always run `--dry-run` first against a new instance and read what comes out. It
is the payload, exactly.

### As a service

```ini
# /etc/systemd/system/feral-public-journal.service
[Unit]
Description=Feral public journal exporter
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/root/.feral/self-src/FeralAgent
Environment=FERAL_PUBLIC_JOURNAL_URL=https://your-site/api/public-journal/ingest
EnvironmentFile=/root/.feral/public-journal.env
ExecStart=/root/.bun/bin/bun scripts/publish-public-journal.ts --watch
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
```

Keep the token in `EnvironmentFile` (mode `600`), not in the unit — unit files
are world-readable.

### Resumption

The cursor lives at `~/.feral/public-journal/cursor.json`. It is an optimisation,
not a correctness mechanism: deleting it causes a re-send that the store dedupes.
If you want to republish history, delete it.

## 6. Testing

`bun test tests/public-journal.test.ts` in `FeralAgent/`. The suite is mostly
adversarial — it feeds the serializer journal rows carrying paths, prompt text,
keys and emails, and asserts none of it appears in the output.
