# Checkpoint — where the tokens actually go

**2026-08-26.** Measured on Darius's machine from a live session: 3 hours,
75 completions, 1.2M prompt tokens, via `costReport()` against the real DB.
Not estimates, not vendor figures.

## The headline

**~70% of everything sent is the fixed prefix.** The conversation — what the
person asked and what the agent answered — is under 6%.

| category | tokens | share |
|---|---:|---:|
| tool_schemas (three boots) | 441,506 | 39.2% |
| system_prompt | 344,646 | 30.7% |
| tool_output | ~112,000 | ~10% |
| episodic_replay | 92,273 | 8.2% |
| **conversation** | **64,771** | **5.7%** |

## The floor, decomposed

```
system prompt      5,884
├─ base            1,959   rules, style, how to call a tool
│  └─ "CinderpawAgent base" section alone: 1,090
├─ SOUL.md         1,899   personality, on every completion
├─ IDENTITY.md       506
└─ capability index + user config  ~1,500

tool schemas       6,913   (44 of 89 advertised — the drawer holds 45 back)
notebook doctrine  1,490   (scales with tool count: 48 tools -> 1,246)
                  ──────
per completion    14,813
```

`PRODUCT.md` (3,969 tokens) is NOT in the prefix — loaded on demand through
`product_info`. That is why its 16KB budget test matters: it is a tool result,
charged when called.

## Prompt caching WORKS — 41.9%

```
505,160 read from cache · 699,560 fresh
```

This had been an open unknown twice in the session ("the mechanism is there,
I cannot tell you it saves anything"). It does. So the 70% prefix is partly
amortised, and the thing to do about caching is not to improve it but to
PROTECT it: provider fallback and mid-session model switches break it.
`FERAL_BRAIN` (per-turn routing) is `false` by default — if it is ever turned
on, measure the cache first.

## Notebook: preliminary, unfavourable

```
drawer | notebook       41,473 tokens of doctrine (~28 completions)
tool_output | notebook      60 tokens actually used
```

Enabling it moved the floor from 10,704 to 12,185 (+13.8%), so it must cut at
least **12.2% of completions** to pay for itself. So far it has been called
about once. Too early to be a verdict — the session was mostly conversation,
not tool work — but the pattern is pure cost.

If it stays that way, two exits: shorten the doctrine (1,246-1,490 tokens to
say "you can write code" is a lot, and most of it is an enumeration of all 88
tool identifiers), or inject it only when a turn looks like multi-tool work.
The enumeration is the part that scales, and it duplicates what
`buildCapabilityIndex` already lists for drawered tools.

## Ranked levers

1. **MCP pruning.** 89 tools vs 48 without extensions: 41 extra tools ≈ 2,300
   tokens on every completion. GitHub measured 8-12 KB per call from unused
   MCP tools alone. No code, just configuration.
2. **System prompt.** 30.7%, and SOUL.md is 1,899 of it on every completion.
   A product judgement about how much personality "what is a deadlock" needs
   — not a refactor.
3. **Notebook** attacks the NUMBER of rounds rather than their size. Verdict
   pending real tool work.
4. **Protect the cache.** Already at 41.9%; the risk is regression, not
   absence.

## Method notes, for whoever measures next

- Individual tool calls are NOT written to `~/.cinderpaw/logs/cinderpaw.log`.
  A grep there for `tool_start` returns zero whether or not tools ran — it
  cost one wrong conclusion in this session before the cost report was run.
- `costReport(db, { since })` is the instrument. `token_usage` renders it in
  chat; it lives in the drawer, because advertising it cost ~260 tokens on
  every completion, which the boot line caught within minutes of adding it.
- The two tables in that report are deliberately not joined: cache is reported
  per request, never per message, so no category carries a cache share. Any
  number claiming otherwise is invented.
