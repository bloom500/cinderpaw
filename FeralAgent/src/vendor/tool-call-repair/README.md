# tool-call-repair (vendored)

`grammar.ts` and `payload.ts` are copied **verbatim** from OpenClaw
(`packages/tool-call-repair/src/`), MIT licensed — see `LICENSE`.

Source: https://github.com/openclaw/openclaw

## Why this is vendored rather than reimplemented

It parses the tool-call shapes models emit when they abandon the format we
asked for. We were discovering those shapes one at a time, at ~45 minutes per
walk-away bench run; this package already enumerates them:

- `<function=name><parameter=k>v</parameter></function>`
- `[tool:name]` and `[name]` followed by JSON
- Harmony: `<|channel|>` / `<|message|>` / `<|call|>`, channels
  `commentary` / `analysis` / `final`
- the legacy `[END_TOOL_REQUEST]` marker

**Harmony is narrower than that list reads**, and the tests pin the real
behaviour. Verified against the vendored code, not assumed:

- The literal `code` is REQUIRED after the tool name —
  `to=read_file code<|message|>{…}` parses, `to=read_file<|message|>{…}` does
  not.
- `to=functions.NAME` does NOT resolve: the scanner's tool-name charset stops
  at the dot. That is the shape Hermes documents for GPT-OSS, so it is likely
  the common one in the wild. We normalise `to=functions.` to `to=` in
  `repairWithVendoredScanner` before the second attempt — in OUR file, so this
  one stays a clean copy. The allowlist still applies after the rewrite.

Two properties are worth more than the format list:

- **A character scanner with three states** — `complete` / `prefix` /
  `invalid`. `prefix` means "this could still become a call, keep buffering",
  which a regex cannot express. Our own `parseResponse` is regex-based and has
  no way to say "not yet".
- **`allowedToolNames`, fail-closed.** Repair is only safe because an
  unrecognised name is rejected rather than invented. We pass the live registry
  in, so the allowlist is never stale.

Plus bounded input: 256 KB per payload, 120 characters per tool name, so
hostile or runaway output cannot exhaust memory.

## What was deliberately NOT taken

`stream-normalizer.ts` and `promote.ts` are coupled to OpenClaw's streaming
event model and its `@openclaw/normalization-core` dependency. `grammar.ts` and
`payload.ts` import nothing but each other, which is what makes this a copy
instead of a port.

## Modifications

One, so the files load under our resolver: the import in `payload.ts` reads
`./grammar.ts` instead of `./grammar.js`. Nothing else is changed — keep it
that way, so a future upgrade stays a re-copy rather than a merge.

## Caveat when reading the code

`parseStandalonePlainTextToolCallBlocks` returns `null` unless the ENTIRE text
parses as tool-call blocks. That is intentional, not a bug: it fires only when
a message is unambiguously nothing but calls. Mixed prose-plus-call is handled
by our own `parseInvokeXml` in `core/agent-loop.ts`.
