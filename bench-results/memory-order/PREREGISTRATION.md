# Memory-order headroom: preregistration (written 2026-09-15, before any paid call)

**Question.** CinderBrain, or any learned reranker, can only change which of the memories FMS
already found reach the model, and in what order. How many answer-accuracy points could a
PERFECT choice add, in the format production actually injects? If even perfect cannot add
enough, no brain belongs on this seam.

**Why LongMemEval-S instead of real Cinderpaw workflows:** its questions carry labelled evidence
turns (`has_answer`), which gives a perfect-reranker arm with no human in the loop, and FMS is
already measured on it (recall@10 = 94.3% on 50). Stated limitation: it is chat memory QA, not
agentic tool work; a positive result here is necessary, not sufficient, for the agent.

**Setup, fixed now.**
- 470 non-abstention questions, all of them, stratified order (scripts/longmemeval.ts `stratify`).
- Retrieval: the production FMS path exactly as scripts/longmemeval.ts runs it (bge-m3 embeddings,
  RAPTOR tree, FTS5 hybrid), candidate pool 40.
- Production format: at most 10 hits (MAX_CONTEXT_HITS), 200-character snippets, 4000-character
  block cut on a line boundary (CINDERPAW_RECALL_INJECTION_MAX_CHARS). Summary "via" paths are not
  shown in any arm (display only).
- Arms: NONE, FMS, REVERSED, RANDOM (10 of FMS top 40), ORACLE (evidence first, FMS fill, cut
  snippets), ORACLE-FULL (evidence uncut). Definitions in scripts/memory-order-headroom.ts `armIds`.
- Answer: z-ai/glm-5.3-flash pinned to provider z-ai/fp8, no fallbacks, reasoning disabled,
  temperature 0, max 512 tokens, LongMemEval's own non-CoT answer prompt.
- Judge: openai/gpt-4o-2024-08-06, LongMemEval's official per-type prompts verbatim, temperature 0,
  max 10 tokens, correct = "yes" in the reply.
- Stats: paired difference vs FMS per arm, wins / losses / ties, seeded bootstrap 95% CI (2000).
- Guards: refuses to run without an approved dollar cap and stops at it; stops after 30 answers if
  they average over 1500 tokens (reasoning not off).

**Decision rules (adapted from Astra's 15 Sep rerank screen; +10 points is the bar she set).**
1. RERANK HEADROOM = ORACLE - FMS.
   - CI lower bound >= +10 points: reordering is worth pursuing on this seam (a learned reranker
     first, CinderBrain only if it later beats that reranker).
   - CI upper bound < +10 points: drop learned reranking on this seam, CinderBrain included; even a
     perfect order cannot add 10 points in the production format.
   - Otherwise: inconclusive, say so; no rerun with a different k or model to rescue it.
2. SNIPPET CUT = ORACLE-FULL - ORACLE. CI lower bound >= +10 points: the 200-character cut, not the
   order, is the bottleneck, which is a product fix that needs no brain. Reported either way.
3. REVERSED - FMS and RANDOM - FMS are reported as the order-only and no-signal references.
No arm, subset or question type is selected after the run; per-type numbers are descriptive only.

**Cost:** see COST-ESTIMATE.md (live prices). Nothing runs until Darius approves a cap.
**Run needs:** OPENROUTER_API_KEY, and the bge-m3 llama-server on 127.0.0.1:18099 (not running on
15 Sep evening).

## Amendment, 2026-09-15 (before any paid call): models changed by Darius, for cost
- Answer: deepseek/deepseek-v4-flash pinned to deepinfra/fp8 (no fallbacks), reasoning disabled,
  temperature 0, max 512. Replaces z-ai/glm-5.3-flash.
- Judge: openai/gpt-5.6-luna pinned to openai, reasoning effort minimal, max 1000 tokens (its
  reasoning counts against max_tokens), no temperature (the model takes none). Replaces
  LongMemEval's official gpt-4o-2024-08-06; the official per-type prompts are unchanged.
- Because the judge is no longer the official one, a guard is added before trusting it: the first
  50 FMS-arm judgements are also judged by gpt-4o-2024-08-06; if Luna agrees on fewer than 45 of
  50, the run stops and no accuracy is reported. Also stops if more than 5 of the first 100 Luna
  replies are empty. Parsing is now a whole-word "yes".
- Results stay comparable across arms (same judge everywhere); they are NOT comparable with
  published LongMemEval QA numbers, which use gpt-4o.
- Estimate with pinned endpoint prices: $0.83 (short) / $1.88 (long) / $6.39 (both models reason
  far beyond the settings). See COST-ESTIMATE.md.

## Embedding server, fixed 2026-09-15 before any paid call
`C:\Users\Darius\AppData\Local\Programs\Ollama\lib\ollama\llama-server.exe -m ~/.cinderpaw/models/bge-m3-Q8_0.gguf --embeddings --pooling mean --port 18099 -c 8192 -b 8192 -ub 8192`.
Checked against the 12 Sep LongMemEval cache on 5 questions: cosine 0.9998-1.0000 with mean pooling,
0.79-0.82 with cls. So the 12 Sep FMS numbers were produced with MEAN pooling, and this run uses the
same. Side note, not acted on: bge-m3's reference pooling is CLS; whether that changes FMS recall is
a separate question.
