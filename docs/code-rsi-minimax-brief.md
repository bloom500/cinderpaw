# MiniMax M3 brief — Faza 2 Slice 1: parseUnifiedDiff + CodeGenome serializer

Context: Feral's code-RSI (Faza 2) skeleton landed in
`FeralAgent/src/rsi/code-genome.ts`. Two pure leaves are yours. The policy
wall (`validateCodePatch`) is already implemented and is NOT yours to touch —
parsing and judging are deliberately separate.

## Task 1 — implement `parseUnifiedDiff` (replace the throwing stub)

File: `FeralAgent/src/rsi/code-genome.ts`. The FULL contract (input, output,
per-file rules, error cases) is in the comment block directly above the stub —
follow it exactly. Pure function: no IO, no fs, no policy decisions, never
throw (malformed input → `DiffParseError`).

## Task 2 — CodeGenome serializer

Same file (or `code-genome-io.ts` sibling if it reads cleaner):
`serializeCodeGenome(g: CodeGenome): string` / `deserializeCodeGenome(s:
string): CodeGenome | null` with a versioned envelope `{ version: 1, genome }`
— mirror the discipline of `population-snapshot.ts` (version check, null on
mismatch/corrupt, never throw).

## Tests

Extend `FeralAgent/tests/rsi-code-genome.test.ts` (policy-wall suite already
there — do not modify existing tests):
- parser: single-file edit, multi-file, create (`--- /dev/null`), delete
  (`+++ /dev/null`), rename pair, binary marker, CRLF input, malformed hunk
  header → `DiffParseError`. Inline fixtures, no fs.
- serializer: round-trip equality; corrupt JSON → null; wrong version → null.
- Every test asserts real behaviour — a test that passes with the stub
  deleted is a bug.

## Definition of done

`bunx tsc --noEmit` clean + `bun test tests/rsi-code-genome.test.ts` green,
existing 11 policy tests untouched and still green. Do not edit any other
file. Do not add dependencies.
