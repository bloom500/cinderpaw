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
models dir (or `FERAL_EMBED_MODEL` points at a GGUF). Then launch the app with:

```
FERAL_RUN_FRACTAL_BENCH=1 <launch the app / sidecar>
```

On startup the sidecar builds the tree if needed, runs the gate, logs the
verdict, and writes `data/fractal-bench-report.json`.

### Env knobs

| Var | Default | Meaning |
|---|---|---|
| `FERAL_RUN_FRACTAL_BENCH` | (off) | Set to any value to run the gate at startup. |
| `FERAL_FRACTAL_BENCH_QUERIES` | (none) | Path to a hand-labelled JSONL query set. Overrides generation. |
| `FERAL_FRACTAL_BENCH_COUNT` | `50` | Number of queries to generate when no JSONL is given. |
| `FERAL_FRACTAL_BENCH_SEED` | `1` | Seed for deterministic query sampling. |

## Query sets — two sources

1. **Hand-labelled JSONL** (gold) — one object per line:
   ```jsonl
   {"query": "how do I roll back a release", "relevant": [4213]}
   {"query": "what's my OpenAI key var", "relevant": [991, 992]}
   ```
   `relevant` are episodic row ids that *should* be retrieved.

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
