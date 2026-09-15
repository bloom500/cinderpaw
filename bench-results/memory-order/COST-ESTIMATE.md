# Memory-order headroom: cost estimate (nothing paid was called)

470 LongMemEval-S questions (non-abstention) x 6 arms = 2820 answer calls + 2820 judge calls. Questions with no has_answer turn (ORACLE = FMS for them): 0.
Answer deepseek/deepseek-v4-flash pinned to deepinfra/fp8: $0.090 / $0.180 per M in/out. Judge openai/gpt-5.6-luna pinned to openai: $0.20 / $1.20, plus 50 agreement judgements by LongMemEval's official judge openai/gpt-4o-2024-08-06. Endpoint prices read live from OpenRouter 2026-09-15.
Answer input tokens (upper bound): 1.87 M.

| scenario | answer $ | judge $ | total $ |
|---|---|---|---|
| answers 150 tok, judge reasons 100 tok | 0.24 | 0.58 | 0.83 |
| answers 500 tok, judge reasons 300 tok | 0.42 | 1.46 | 1.88 |
| answer reasoning leaks 2500 tok, judge 1000 tok | 1.44 | 4.95 | 6.39 |

Add ~20% for retries. The run refuses to start without --approved-usd and stops when spend reaches it.
