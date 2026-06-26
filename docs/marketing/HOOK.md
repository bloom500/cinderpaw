# Feral — hook draft (aggressive pitch)

> Working copy for README hero / Show HN / Product Hunt / YouTube pitch.
> **Rule: every line here is filmable or verifiable.** Hype lives in the
> energy, not in the claims. Caveats + limits live in `WHAT_FERAL_IS.md`.

---

## One-liner (pick per channel)

- **Tech-nerd:** *Self-improving AI that runs on your laptop — and commits its own improvements to git so you can read every one.*
- **Broad:** *Your own AI that gets smarter the more you use it. No cloud. No subscription. No one watching.*
- **Anti-cloud-router:** *They route your prompts through someone else's models in someone else's datacenter. Feral runs on yours.*

## Hero block

# Feral
### The AI that improves itself — on your machine, with receipts.

Every other "self-improving" agent asks you to trust it. Feral **commits its
improvements to git** and **gates every one on an eval suite you can read.**
It runs your local model, learns your workflows, touches your real files —
and never sends a token to anyone's cloud unless you tell it to.

`100% on-device · $0 per token · open & inspectable · self-optimizing with proof`

[ Download ] [ Watch it improve itself (90s) ] [ What Feral really is → ]

## The 90-second demo script (this is the star-bait)

1. Open Feral. Point it at a local model. **Zero cloud.**
2. Use it normally for a few minutes.
3. Go idle. → Watch the log: `rsi dream: arming event-driven scheduler`.
4. A **dream cycle** fires. Watch `~/.feral/rsi/dream.jsonl` fill up — one
   line per bounded episode: trigger, iterations, tokens, stop reason.
5. `git log` the RSI substrate → **every improvement is a commit.** Watch the
   eval score ratchet up. Nothing lands that didn't measurably help.
6. The winning config is applied to the **live agent you're talking to**
   (`rsi champion: applied genome … → agent {…}`). The loop closes.

> No other agent lets you *watch* it improve, with a git history and an eval
> gate. That's the whole demo. It can't be faked, because it's all on disk.

## Why now / why this vs the hype

- Closed cloud routers (e.g. Sakana Fugu) match benchmarks **they report
  themselves**, behind a proprietary router, billed per token, **unavailable
  in the EU.** Feral is local, free per token, inspectable, and yours.
- "Self-improving" is the most over-claimed phrase in AI. Feral is the only
  one that ships the **receipts**: git ratchet + readable eval gate.

## What we will NOT say (so we never get debunked)

- ❌ "Beats Fable 5 / GPT / Claude." (We optimize *your* model's config, not
  a frontier model. Different game. See `WHAT_FERAL_IS.md`.)
- ❌ "Rewrites its own code / weights." (It evolves agent **configuration**,
  eval-gated. The honest claim is strong enough.)
- ❌ Any benchmark we can't hand someone a repo to reproduce.

The honest story is already the best story. Sell that, loudly.
