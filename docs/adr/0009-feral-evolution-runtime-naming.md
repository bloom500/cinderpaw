# ADR-0009: Feral Evolution Runtime (FER) Naming

**Status:** Accepted
**Date:** 2026-06-30

## Context

Feral is in a transitional moment. The existing docs use "Feral",
"Feral Agent", and "the agent" interchangeably. With BRSI in scope,
the project is no longer "another agent" — it is the **runtime that
agents run on**. Conflating the two causes:

1. **Wrong mental model.** A reviewer reads "Feral Agent evolves" and
   thinks "agent modifies its own weights". They miss that the
   runtime modifies the **policy on top of** the foundation model.
2. **Wrong category.** "Feral Agent" places Feral alongside Hermes
   Agent, OpenClaw, OpenHands, Cursor — AI agents with tools,
   memory, and planning. Feral's contribution is different: it is
   the **runtime** that those agents could run on, with bounded
   evolution built in.
3. **Wrong rebrand ceiling.** "Feral + Gemma" and "Feral + Qwen"
   are awkward if "Feral" is the agent. "Feral Evolution Runtime +
   Gemma" is clean — the runtime is foundation-model-agnostic.

## Decision

Adopt a strict two-tier naming:

- **Feral Evolution Runtime (FER).** The runtime itself. What this
  doc and the codebase refer to as "Feral" when speaking
  architecturally. The thing that has Memory, Governance, Genome,
  Champion, Species, Ratchet, LoRA, Lineage, Contract, Journal.

- **Personal Agent** (or "Personal AI"). The user-facing assistant
  that runs ON the FER. The thing the user talks to. Today this is
  the Feral sidecar agent loop; tomorrow it could be a different
  agent entirely (e.g., a third-party agent calling FER via API).

**Convention going forward:**

- "FER" or "Feral Evolution Runtime" → the runtime, the engine, the
  bounded self-improvement system.
- "Personal Agent" or "the agent" → the user-facing AI, the chat
  loop, the thing that has a name and a memory.
- "Foundation model" → Gemma, Qwen, Llama, etc. Swappable. The FER
  does not own it; the FER evolves the policy on top of it.

**What changes:**

- New docs and ADRs use "FER" / "Feral Evolution Runtime" for the
  system; "Personal Agent" for the user-facing AI.
- Existing docs (`rsi-evolution-spec.md`, the older
  `continual-personal-adaptation-plan.md`) still use "Feral Agent"
  in places. A future sweep updates them, but it's not in scope for
  this session.
- Marketing/user-facing copy uses "Evolution Runtime for Local AI
  Agents" or "Adaptive Agent Runtime" — phrases that describe what
  it does, not what category it sits in.

## Consequences

**Easier:**

- The "FER + any model" framing becomes natural: Feral Evolution
  Runtime + Gemma, + Qwen, + Llama. The runtime is foundation-
  model-agnostic.
- Distinguishes Feral from agent frameworks (LangChain, Hermes,
  OpenClaw). The FER is what agents could run on; the agent is one
  possible consumer.
- Aligns with the Gen 1/2/3 framing (chatbot → agent → evolution
  runtime). Feral is Gen 3.
- The architecture naturally expresses a microkernel (ADR-0010):
  the FER is the kernel; Personal Agents and foundation models are
  clients.

**Harder:**

- Two names to maintain. Discipline required: docs that say "Feral
  Agent" when they mean the runtime are now imprecise.
- Users who already know Feral as "the agent" will need to
  recalibrate. Mitigation: brief reframing in release notes.
- Engine internal names (`RsiEngine`, `RsiSidecar`, etc.) still use
  "Rsi" — renaming them to "Fer" is a separate, larger refactor.

**Trade-offs accepted:**

- Some docs are temporarily inconsistent until a sweep rename lands.

## Related

- `docs/feral_philosophy.md` (Positioning section — to be added)
- ADR-0001 (BRSI naming) — this ADR extends the naming discipline to
  the runtime vs agent distinction
- ADR-0010 (Microkernel architecture) — the architecture that
  motivates this naming split
- `docs/brsi-spec.md` §1.2 (the "Evolutionary Operating System for
  AI Agents" framing — the runtime is the OS, the Personal Agent is
  the application)