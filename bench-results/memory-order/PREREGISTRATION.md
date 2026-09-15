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
