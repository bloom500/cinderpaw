# Fractal Memory Search — Benchmark Gate

The spec's **non-negotiable gate**: only promote the RAPTOR hybrid over flat
FTS5 if it does not regress recall **and** stays within the latency budget.

> Ship only if `recall@10(fractal) ≥ recall@10(FTS5)` **and** `p99(fractal) < 80 ms`.

By construction the hybrid takes FTS5's hits as a *subset* of its inputs, so it
can never score *below* FTS5 on recall — the gate's real question is whether the
semantic layer **adds** recall without blowing the latency budget.

## Why it runs inside the sidecar

Embeddings live in Rust (`inference.rs`, `llama-cpp-2` FFI) and are reached only
over the stdin/stdout bridge. A standalone `bun run` script has no Rust partner,
so it cannot embed the query. The benchmark therefore runs **inside the live
sidecar process**, triggered by an env var, where the embed bridge works.

## Running it

Embeddings must be available — i.e. `bge-small-en-v1.5.Q8_0.gguf` is in the
models dir (or `CINDERPAW_EMBED_MODEL` points at a GGUF). Then launch the app with:

```
CINDERPAW_RUN_FRACTAL_BENCH=1 <launch the app / sidecar>
```

On startup the sidecar builds the tree if needed, runs the gate, logs the
verdict, and writes `data/fractal-bench-report.json`.

### Env knobs

| Var | Default | Meaning |
|---|---|---|
| `CINDERPAW_RUN_FRACTAL_BENCH` | (off) | Set to any value to run the gate at startup. |
| `CINDERPAW_FRACTAL_BENCH_QUERIES` | (none) | Path to a hand-labelled JSONL query set. Overrides generation. |
| `CINDERPAW_FRACTAL_BENCH_COUNT` | `50` | Number of queries to generate when no JSONL is given. |
| `CINDERPAW_FRACTAL_BENCH_SEED` | `1` | Seed for deterministic query sampling. |

## Query sets — two sources

1. **Hand-labelled JSONL** (gold) — one object per line:
   ```jsonl
   {"query": "how do I roll back a release", "relevant": [4213]}
   {"query": "what's my OpenAI key var", "relevant": [991, 992]}
   {"query": "what windows do I have open right now", "relevant": [], "task": "live-state"}
   {"query": "hey, are you there?", "relevant": [], "task": "no-memory"}
   ```
   `relevant` are episodic row ids that *should* be retrieved.

   `task` declares **what the query asks of memory**, and defaults to
   `historical` so a file written without it scores exactly as before:

   | `task` | What answers it | Scored by recall@k? |
   |---|---|---|
   | `historical` | a past record | yes — this is the gate's number |
   | `live-state` | a live tool call, not an archive | no |
   | `no-memory` | nothing; the turn needs no retrieval | no |

   Why it exists: a question like *"what apps do I have open right now"* has no
   correct historical answer, so averaging its zero into recall@10 marks the
   engine down for a question document retrieval cannot answer — and rewarding
   a hit there would be rewarding a stale snapshot. Unscored queries still run
   and still count toward the latency percentiles, because they cost the user
   the same wait. The report says what the recall figure covers: `n` is what
   ran, `scoredN` is what the recall is over, and `describeScope(report)`
   turns the difference into the sentence the boot log prints. A `task` value
   that is not one of the three throws at parse time rather than quietly
   falling back to `historical`.

2. **Self-supervised generation** (default, free) — BEIR-style: sample real
   memories, ask the local model to paraphrase each into a query, label the
   source memory as the single relevant doc. Reproducible (seeded) and unbiased
   between lexical and semantic retrieval because the wording is varied.

   **Caveat:** a single-gold synthetic set measures *"can the system find the
   memory this query was written from"*, not full human relevance. It is the
   honest free default; a hand-labelled JSONL supersedes it whenever one exists.

## Code map

| File | Role |
|---|---|
| `metrics.ts` | pure: `recallAtK`, `percentile`, ship `verdict` |
| `runner.ts` | drive a query set through two retrievers, time + aggregate |
| `query-gen.ts` | `parseQuerySet` (JSONL) + `generateQuerySet` (self-supervised) |
| `run-benchmark.ts` | `runFractalBenchmark(deps)` — wires the above; injectable |
| `FractalMemory.benchmark(opts)` | one-call entrypoint over the live tree |

Everything except the env-gated sidecar trigger is unit-tested with fakes
(`tests/fractal-bench-*.test.ts`, `tests/fractal-memory-benchmark.test.ts`).
