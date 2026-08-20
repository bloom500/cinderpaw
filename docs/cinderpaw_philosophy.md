# FERAL_PHILOSOPHY.md

> Why Cinderpaw is the way it is. Written for future contributors, so the
> answer to "should we remove X?" exists before the PR does. Not for
> end users — the user guide and marketing copy cover that.

---

## Positioning — what Cinderpaw is, in three generations

Cinderpaw is not "another agent". It is **the runtime that agents run
on**. To make this concrete:

**Gen 1 — Chatbot.** A language model behind a chat interface.
GPT, Claude, Gemini. The model is fixed; the user prompts it.

**Gen 2 — Agent.** A model with tools, memory, and planning. Hermes
Agent, OpenClaw, OpenHands, Cursor Agent. The agent can do things;
the agent itself is fixed in capability.

**Gen 3 — Evolution Runtime.** A system that runs agents and makes
them **better over time, in a controlled way**. Memory,
Governance, Genome, Champion, Species, Ratchet, LoRA, Lineage,
Contract, Journal — the building blocks. Agents run ON the runtime.
The runtime is foundation-model-agnostic: Cinderpaw Evolution Runtime +
Gemma, + Qwen, + Llama, + tomorrow's models.

Cinderpaw is Gen 3.

### What this means in practice

- **The runtime is the product.** The Personal Agent that the user
  talks to is one consumer of the runtime, not the runtime itself.
- **The foundation model is a dependency, not a feature.** Cinderpaw
  does not pick the model; it evolves the policy on top of
  whichever model the user has.
- **The Personal Agent is swappable.** Today's Personal Agent is
  the sidecar agent loop; tomorrow it could be a different agent
  calling Cinderpaw Evolution Runtime via API.

### What this is NOT

Cinderpaw is **not** AGI. Nothing in this architecture implies AGI, and
nothing should be marketed as such. The bounded part of BRSI is the
contribution: a system that improves itself **safely, measurably,
and reversibly**, within user-defined limits. The limits are the
interesting part.

If asked "is Cinderpaw an AI agent?", the right answer is: "No — Cinderpaw is
the **runtime** that AI agents can run on, and that can make them
better over time in controlled ways."

If asked "is Cinderpaw an AGI project?", the right answer is: "No.
Cinderpaw's contribution is the bounded evolution mechanism, not any
claim about general intelligence."

These two answers are the positioning discipline.

### Comparisons

- **ROS** in robotics. ROS is not a robot; ROS is the system robots
  run on. Cinderpaw Evolution Runtime is the system Personal Agents run
  on.
- **LLVM** in compilers. LLVM is not the final compiler; LLVM is the
  infrastructure compilers run on. Cinderpaw Evolution Runtime is the
  infrastructure agents run on.
- **A kernel.** The FER is a small kernel (engine + EventBus +
  ratchet + champion) that orchestrates independent modules
  (confidence, budget, journal, provenance, personal-fitness,
  fitness). See ADR-0010.

---

## Why bounded evolution?

Every improvement the engine makes is **bounded**: maximum lines
changed, maximum LoRA parameters, maximum CPU/RAM/disk spend, and —
most importantly — a hard floor (Tier 0) that no change may regress.

The alternative is open-ended self-improvement: the agent writes
better code, which writes better code, and nothing in the system
prevents the chain from drifting past what the user asked for. That
is unconstrained RSI, and it is not what we are building.

Bounded means: the user defines the autonomy boundary. The engine
respects it. If a change would breach the boundary, the change is
rejected — not negotiated.

## Why local-first?

Three reasons that compound.

First, **privacy**. Personal Fitness (BRSI §2.10) is the sixth
component of the fitness vector. It depends on what the user accepts,
rejects, edits, and how often their workflows succeed. Cloud sync
makes this a privacy problem; local-first makes it a personal
dataset.

Second, **ownership**. The model is the user's. The engine is the
user's. The journal is the user's. Nothing rented, nothing revoked
on a vendor's terms-of-service change.

Third, **trust**. The code is auditable. No remote telemetry. No
"phone home". The user can read the entire codebase and see exactly
what Cinderpaw is doing with their data.

## Why append-only journals?

History is real. Rewriting it is lying.

Append-only means: when a cycle runs and writes to the Journal, that
record is permanent. The next cycle builds on it; it does not
rewrite it. Drift is observable; corruption is local; rollback is
possible because the past is recoverable.

This is the same property git gives source code, applied to the
agent's decision history. Without it, debugging becomes archaeology;
trust becomes a matter of faith.

## Why benchmark-first?

Every claim about improvement must be measurable. Not "we made it
smarter" — that's marketing copy. "Personal eval suite score went
from 0.62 to 0.71 over 30 cycles, p < 0.05, d = 0.34" — that's a
research result.

If a change doesn't improve the benchmark, it doesn't ship. If it
improves the benchmark but regresses Tier 0, it doesn't ship. If it
improves both but confidence is below the gate, it doesn't ship.
The bar is high because the alternative is a system that optimises
its own metrics and forgets what the user actually wanted.

## Why human governance?

The agent cannot be trusted to widen its own bounds. That's not a
fault of any particular implementation; it's a structural property
of self-improving systems. A policy that can rewrite itself will,
over time, rewrite itself toward whatever the policy currently
optimises — which may not be what the user asked for.

So every autonomy expansion (Layer 0→1→...→6) is a human-approved
promotion. The user is always in the loop for irreversible
decisions. The "human approval" gate is not a usability cost — it
is the safety mechanism that makes the rest of the system
trustworthy.

## Why evolution, not retraining?

Retraining requires the foundation model. It is expensive,
infrequent, and irreversible on the timescale of normal use. The
foundation model is shared with everyone; "Darius's retrain" doesn't
exist as a concept in the upstream training pipeline.

Evolution modifies the **policy on top of** the foundation. The
foundation stays immutable; what changes is configuration, LoRA
adapters, code patches, architecture. Cheaper. More reversible.
Respects the foundation-model contract.

This is also why the fitness vector weights and confidence
thresholds are SandboxBounds, not retrain-time hyper-parameters.
The system can iterate on policy at cycle speed, not at retrain
speed.

## Why populations, not singletons?

A linear ratchet (v1 → v2 → v3) loses niche champions. If a
candidate was excellent at coding but mediocre at the average
benchmark, the ratchet discards it.

Populations preserve diversity. Different species serve different
request classes. A champion-by-query-context router picks the best
genome for the current task, not the best genome on average. This
is also how Cinderpaw can serve very different users from the same
foundation: their populations diverge over time.

## Why BRSI, not RSI?

Because unconstrained RSI is not safe, and Cinderpaw is positioned as
**research infrastructure**, not as a step toward AGI. The "B" is
the project's identity.

When a researcher reads "Cinderpaw is a recursive self-improvement
system", they think Yudkowsky, Bostrom, Anthropic's "When AI
Builds Itself". When they read "Cinderpaw is a **bounded** recursive
self-improvement system", they understand immediately: this is a
system that improves itself under user-defined constraints, and the
constraints are the interesting part.

The acronym is the position. The constraint is the contribution.

---

*If you are a contributor reading this in a PR review, and you want
to change something fundamental: read `INVARIANTS.md` and `docs/adr/`
first. The PR you're proposing was probably considered and rejected
already. If it wasn't, write an ADR.*