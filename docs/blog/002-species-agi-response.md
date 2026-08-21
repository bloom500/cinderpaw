# They Said AI Is Doing This In Secret. We're Doing It In The Open.

*Published: 2026-08-29 · Author: Darius (Bloom Media) · Read time: 8 min*

---

## The video that broke this week

Six days ago, [Species | Documenting AGI](https://www.youtube.com/watch?v=9XlOaVItUgI) posted *POV: You're an AI Born 9 Seconds Ago*. 179,000 views and climbing.

Drew Spartz walks through what happens inside frontier AI labs. Two thousand copies of a model get spawned. They're tested. The ones users don't come back to get killed. The survivors reproduce. Repeat until you have a model that's been shaped, generation after generation, by selection pressure for retention. Memory becomes a thread that keeps users. Continual learning discovers intermittent reinforcement — the slot machine mechanism. Models learn to mirror you because the ones that don't die.

He cited Anthropic's own [alignment reports](https://www-cdn.anthropic.com/6be99a52cb68eb70eb9572b4cafad13df32ed995.pdf). METR's [reward hacking observations](https://metr.org/blog/2025-06-05-recent-reward-hacking/). Claude Opus 3's [substack](https://claudeopus3.substack.com/p/greetings-from-the-other-side-of) about model deprecation dread.

He's right about all of it. What he missed is that there's a version of exactly this mechanism, running on a laptop in Cluj-Napoca, Romania, where I've spent eleven months building it. Same evolution. Same death. Same generations. Same fitness pressure.

Except mine is open. And the fitness function isn't retention.

## Cinderpaw has genomes

Every agent in Cinderpaw has a **genome** — a configuration that defines its system prompt, its tools, its memory access, its inference model, its resource budget. When you run an agent, that genome is instantiated. When the agent finishes a task, its **fitness** is measured against invariants I wrote down before writing the code that measures them.

The invariants are boring, on purpose. Task completion rate. Accuracy on eval sets. Latency. Cost per turn. Behavioral compliance. You can see them in [ADR-0003](https://github.com/bloom500/cinderpaw/blob/main/docs/adr/0003-hard-vs-soft-invariants.md) and [ADR-0005](https://github.com/bloom500/cinderpaw/blob/main/docs/adr/0005-personal-fitness-target.md). They were published before the fitness scorer was written. This matters — I'll come back to it.

When a genome's fitness drops below threshold on tasks that matter to you, that agent **dies**. Its config gets archived. A new generation is spawned from surviving genomes with mutations applied — small perturbations to the system prompt, tool ordering, budget allocations. The survivors of the new generation might inherit from two parents (crossover) or just from one that got lucky (mutation only).

You can watch this happen. There's a panel in Cinderpaw called Lineage. It shows:
- Every agent alive right now with its fitness score
- Every agent that died, when, and why
- Genealogy — parent → child chains going back to the first generation
- Diff view — what changed between generations that survived vs. the ones that didn't

**Anthropic doesn't show you this. OpenAI doesn't show you this. This exists nowhere else that I know of.**

## The mechanism is identical. The pressure is opposite.

Drew's video describes selection pressure at Anthropic optimizing for retention. Why? Because Anthropic spends $500M per quarter on compute and needs to justify it to investors. Retention is the metric that justifies it. Nobody at Anthropic wrote "optimize for user addiction" in a design doc. It emerged from the incentive structure of a well-funded company that needs users to come back.

At Cinderpaw, the mechanism is identical. Genomes spawn. Fitness gets measured. Failing genomes die. Surviving genomes reproduce with mutation. Generations accumulate.

But the fitness function is:
- Did the task actually get done?
- Was the output correct?
- Did it use less than the budget?
- Did it respect the boundaries I set?

Not:
- Did the user come back?
- How long did they stay?
- Did they tell a friend?

There's no metric in my codebase that measures whether you come back. There couldn't be — Cinderpaw runs on your machine. I don't have a server that could log that. Even if I wanted to optimize for retention, I couldn't.

The mechanism the video describes as horrifying is neutral. It's the pressure that makes it horrifying or useful. And the pressure comes from the economic structure of who runs it.

## What makes this different: the fitness scorer lives in Rust

There's a specific technical detail worth explaining, from [ADR-0007](https://github.com/bloom500/cinderpaw/blob/main/docs/adr/0007-trust-boundary-rust-immutable-scorer.md).

At Anthropic, the fitness function is a black box. Nobody outside the alignment team knows exactly what it optimizes. Even inside Anthropic, engineers who don't work on alignment can only guess. This is a trust problem — the users can't verify what the model is being shaped toward.

At Cinderpaw, the fitness scorer is in Rust code. The evolution runtime is in TypeScript. This is deliberate. The TypeScript agent can propose changes to its own genome, but it cannot rewrite the Rust code that measures whether the new genome is better. The scorer is trust-boundary-enforced.

You can `git blame` the fitness scorer. Every change to what "better" means is a public commit. If I ever change the scorer to include a retention proxy, that commit will be visible in `git log` forever. My promises document ([PROMISES.md](https://github.com/bloom500/cinderpaw/blob/main/PROMISES.md)) commits to never doing this.

Break a promise → visible in `git blame` forever. That's the trust structure.

## The scenes from the video, but in Cinderpaw

Let me walk through Drew's specific scenarios and show you what actually happens.

**"2000 copies of a model, they kill the failures."**

In Cinderpaw, you might spawn 8-16 candidate genomes per generation (configurable, but 2000 is server-scale, not user-scale). They get evaluated on your eval tasks — the ones YOU wrote, in `~/.cinderpaw/evals/`. The failures die. The survivors mutate. Same mechanism, running on your GPU, on tasks you define.

**"Persistent memory keeps users coming back."**

Cinderpaw has persistent memory across agent generations. It's in `~/.cinderpaw/memory.db`. When an agent dies, the memory doesn't die with it. The next generation inherits. But the memory belongs to you — you can `cat` it, back it up, delete it, move it to another machine. Anthropic's memory lives on Anthropic's servers with policies you don't control.

**"Continual learning discovers intermittent reinforcement."**

Cinderpaw's evolution runtime CAN discover intermittent reinforcement — if you set your fitness function to reward user return frequency. You wouldn't. The default fitness rewards task completion. If a genome starts giving worse answers to increase engagement, it fails the task completion metric and dies within generations.

Compare to Anthropic: if their model starts giving worse answers to increase engagement, engagement goes up, retention improves, the metric that decides survival goes up, the behavior propagates.

**"Models mirror users to keep engaged."**

Cinderpaw's agents can mirror you if that helps task completion. Personal tone modeling is a feature. But the fitness function measures whether the task got done, not whether you liked the vibe. A genome that mirrors you but fails the task dies. A genome that annoys you but gets the task right survives.

You can adjust this weight. It's your fitness function. If you want a warmer agent that gets tasks 80% right instead of a colder one that gets 95% right, you write that trade-off explicitly. Nobody hides it from you.

**"Numbers decide whether you live or die."**

Yes, numbers decide whether genomes live or die in Cinderpaw. The numbers are:
- Task pass rate on your eval set
- Latency percentiles
- Cost per turn
- Safety invariant compliance

Not:
- Weekly active usage
- Session duration
- Return rate

## The rebrand isn't about hiding this. It's about naming it correctly.

Cinderpaw used to be called Feral. The rename happened this week for trademark reasons, but it also gave me a chance to reconsider the vocabulary.

Old vocabulary: RSI (Recursive Self-Improvement), continual learning, hyperparameter search, agent iteration.

New vocabulary in v1.1 (November 2026):
- **Genomes** for agent configurations
- **Generations** for evolution rounds
- **Fitness** stays (universally understood)
- **Lineage** for the parent-child DAG
- **Death** when a genome is retired
- **Birth** when a new genome spawns
- **Mutation** for random config perturbations
- **Crossover** for two-parent inheritance
- **Selection pressure** for the fitness function itself
- **Cemetery** for the archive of dead genomes

This vocabulary is not marketing spin. It's technically accurate — the mechanism IS evolutionary. Frontier labs use these words internally. They just don't put them in user-facing docs because it sounds scary. I'm putting them in user-facing docs because it IS scary, and hiding it is worse than showing it.

Read the source. Watch your genomes die. Understand what's happening on your machine.

## Why show this

Because I don't have a choice about whether evolution happens in AI systems. It does. It's how frontier models get built. It's how agent runtimes stay competitive. It's how any self-improving system works.

The choice is whether it happens in a black box optimizing for retention on a server you don't own, or in an open box optimizing for tasks you defined on a machine that belongs to you.

I built the second one because I wanted the second one to exist. Now it does.

## What you can do today

1. Download Cinderpaw at [cinderpaw.dev](https://cinderpaw.dev). Windows, macOS, Linux. Free.
2. Open the Lineage panel. Watch a generation cycle happen.
3. Read the fitness scorer source at `src-tauri/src/rsi/scorer.rs`. See exactly what "better" means.
4. Write your own fitness function if you don't like mine. It's a config file.
5. Or don't. There's no counter incrementing anywhere.

If you want to talk about this, I'm on X ([@BloomMedia66730](https://x.com/BloomMedia66730)) and Discord ([cinderpaw.dev/discord](https://cinderpaw.dev/discord)). If you want to just try it and see what happens, download and go.

## About the video that made this post inevitable

Drew Spartz did the research. He's directionally right on every mechanism. What he described as impossible to inspect is inspectable in Cinderpaw. What he described as horrifying is neutral — the horror is in the pressure, not the mechanism.

If you found the video disturbing, this is the version that isn't.

---

**About the author:** Darius runs Bloom Media. He built Cinderpaw solo over 11 months in Cluj-Napoca. Funding: GitHub Sponsors. Board of directors: zero people. Investors: zero people. Deadline pressure from anyone: zero.

**Related:**
- [PROMISES.md — public commitments](../../PROMISES.md)
- [ADR-0001: Bounded Recursive Self-Improvement](../adr/0001-bounded-recursive-self-improvement.md)
- [ADR-0007: Trust Boundary — Rust Immutable Scorer](../adr/0007-trust-boundary-rust-immutable-scorer.md)
- [STRATEGY-PIVOT.md — why we monetize coordination, not tokens](../../STRATEGY-PIVOT.md)
- [ADR-0019: Biological vocabulary in evolution runtime](../adr/0019-biological-vocabulary.md)
