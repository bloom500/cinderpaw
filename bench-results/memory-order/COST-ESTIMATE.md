# Memory-order headroom: cost estimate (nothing paid was called)

470 LongMemEval-S questions (non-abstention) x 6 arms = 2820 answer calls + 2820 judge calls. Questions with no has_answer turn (ORACLE = FMS for them): 0.
Answer z-ai/glm-5.3-flash pinned to z-ai/fp8: $0.075 / $0.250 per M in/out. Judge openai/gpt-4o-2024-08-06 (LongMemEval's official judge): $2.50 / $10.00. Prices read live from OpenRouter 2026-09-15.
Answer input tokens (upper bound): 1.87 M.

| scenario | answer $ | judge $ | total $ |
|---|---|---|---|
| short answers, reasoning off (150 tok) | 0.25 | 2.55 | 2.80 |
| long answers (500 tok) | 0.49 | 5.02 | 5.51 |
| reasoning leaks through (2500 tok) | 1.90 | 19.12 | 21.02 |

Add ~20% for retries. The run refuses to start without --approved-usd and stops when spend reaches it.
