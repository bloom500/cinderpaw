# tau2-bench raw results

The files behind the tau2 numbers Cinderpaw publishes. Each is tau2's own
`results.json`, gzipped, with every conversation and its grade.

Check them yourself:

```bash
python bench-results/tau2/score.py
```

| File | Score | What it is |
|---|---|---|
| `airline-cinderpaw-2026-09-02` | 45/50 = 90.0% | Cinderpaw on airline |
| `airline-reference-agent-2026-09-02` | 41/50 = 82.0% | tau2's own `llm_agent`, same day, same setup |
| `telecom-cinderpaw-2026-09-02` | 113/114 = 99.1% | Cinderpaw on telecom (114-task split) |
| `retail-cinderpaw-2026-09-10` | 89/114 = 78.1% | Cinderpaw on retail, no reference arm |

Setup for every run: agent `z-ai/glm-5.3-flash` through OpenRouter, pinned to
the Z.AI provider with fallbacks off; user simulator `gemini-2.5-flash`;
`max_steps` 200; every task ended normally.

Read these before quoting a number:

- **Airline** is the fair comparison: both agents ran on the same model and
  harness. Against the public leaderboard, this harness ran ~4.7 points high
  (the reference agent scored 82.0% here, 77.3% published).
- **Telecom** mostly measures how clearly the agent tells the user what to do:
  about 73% of graded actions are done by the simulated user. Never average it
  with airline.
- **Retail** has no reference run and no public tau2 retail leaderboard.
