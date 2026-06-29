# What Feral Is (and what it isn't)

This is the honest, technical companion to the pitch. If a claim in our
marketing sounds big, this document is where we show our work. We'd rather a
skeptic read this and become a believer than read the hype and feel sold to.

---

## What Feral is

Feral is a **local-first AI agent runtime** — a desktop app that runs an AI
agent against **your own local model**, on your machine. No account required,
no per-token billing, no cloud round-trip for normal use.

It has three parts worth understanding:

### 1. The agent runtime
A tool-using agent loop (chat, file access, shell, web, desktop control,
connectors) running on top of whatever local model you point it at. This is
the part you talk to.

### 2. FMS — Fractal Memory Search
A hierarchical (RAPTOR-style) memory: your history is clustered into a tree,
and retrieval works in **tiers** — overview/summaries, scoped layers, and
exact-snippet lookup — instead of one flat similarity search. It only ships a
retrieval change if it **beats a plain full-text-search baseline on recall**
in a benchmark we run ourselves. Memory quality is measured, not assumed.

### 3. RSI — the self-optimization engine
This is the part people get excited (and confused) about, so read carefully.

Feral runs an **evolutionary search over the agent's own configuration and
strategy** — temperature, prompts, strategy parameters, etc. (genomes). It
mutates, crosses over, and selects among a *population* of configs, and:

- **Eval-gated:** a candidate only "wins" if it scores higher on a frozen
  evaluation suite. Improvements that don't measurably help do not land.
- **Git-ratcheted:** accepted improvements are committed to a git substrate.
  It's a monotonic ratchet — you only move up, and every step is recorded and
  reversible. Regressions are culled (extinction).
- **Closed loop:** the winning config (the "champion") is projected onto the
  **live agent you're actually using.** It's not a notebook of advice nobody
  reads — the evolved settings reach the agent in front of you.
- **Dream Cycle:** the engine is **event-driven**. It runs *one bounded
  episode* when you're idle, or when real errors pile up — then sleeps. Hard
  caps on wall-clock, iterations, tokens, and cost (whichever fires first).
  **Local-only by default; a cloud model is refused unless you explicitly
  opt in.** It does not run a continuous always-on loop, and it cannot
  silently burn your money.

You can watch all of this happen: `~/.feral/rsi/dream.jsonl` (one line per
episode) and the git history of the ratchet.

---

## What Feral is **not** — and we mean it

- **It does not rewrite its own source code or model weights.** "RSI" here
  means recursive improvement of the agent's *configuration/strategy* against
  an eval suite — not weight-level self-modification. That's a real, narrow,
  defensible thing. It is not Skynet.
- **It does not "beat" Fable 5 / GPT / Claude.** Feral optimizes how *your
  local model* is driven. It does not make a 7B model smarter than a frontier
  model. Comparing it to a frontier LLM is a category error — Feral is the
  harness, not the engine.
- **It is not a cloud orchestrator/router.** It doesn't route your prompts
  through frontier models in a datacenter. The intelligence is your local
  model; Feral makes it self-tuning and tool-capable on-device.
- **It is not magic, and the gate is only as good as the eval.** The honest
  risk: if the evaluation suite is weak, the ratchet optimizes the wrong
  thing. Eval quality is the real moat and the real limitation. We treat it
  as such.

---

## Honest limitations (current)

- RSI optimizes config/strategy space, not weights. On-device weight-level
  personalization (LoRA) is a separate, future track.
- Improvement quality is bounded by the eval suite's quality.
- It needs a real local model; against a placeholder it does nothing (by
  design — no learning from empty responses).
- Some telemetry fields are still minimal (e.g. ratchet counts) — observable,
  not yet a full dashboard.

---

## How this differs from "an LLM with a dreaming skill"

A typical "self-improving" setup is a model with a prompt that says *reflect
and update your own instructions.* That is **self-assessed** (the model judges
itself), **free-form** (it can drift and regress silently), **single-track**
(no population, no selection), and **ungrounded** (no eval, no measurement).

Feral differs on every axis: **eval-gated** instead of self-assessed,
**git-ratcheted** instead of drifting, a **population** instead of one track,
and **closed onto the live agent** instead of notes nobody reads — all
**bounded and local-first** instead of an always-on cloud burn.

The difference in one sentence: *a classic system **asserts** it improved;
Feral **measures and commits** the improvement — or doesn't apply it.*
