# Species | Documenting AGI response — social threads

**Context:** Video „POV: You're an AI Born 9 Seconds Ago" (179k+ views in 6 days, published 2026-08-15). Author Drew Spartz walks through selection pressure on frontier AI models.

**Positioning:** Cinderpaw is the structural counter. Not „different values" — different incentives that make retention optimization mechanically impossible.

**Timing:** Publish these AFTER blog post 002 goes live (D+3, Friday 29 Aug). Blog is the anchor; social drives traffic to it.

---

## X thread — QT on Drew's video (REVISED 2026-08-22 with genome framing)

**Tweet 1 (hook + QT):**

> This video describes AI models evolving under selection pressure — dying, reproducing, mutating — as horrifying because it happens in secret at Anthropic and OpenAI.
>
> I built the same mechanism. But you can watch yours die on your own machine.
>
> Cinderpaw ships genomes. 🧵

**Tweet 2:**

> In Cinderpaw, every agent has a genome — system prompt, tools, memory access, budgets, model.
>
> When you run agents, their fitness is measured. Low fitness → death. Survivors reproduce with mutation. Repeat.
>
> Same mechanism as frontier labs. Opposite fitness function.

**Tweet 3:**

> At Anthropic, the fitness function is retention. Because their $500M/quarter compute bill needs justification.
>
> At Cinderpaw, the fitness function is: did the task get done, was it accurate, did it fit budget.
>
> Published as ADR-0005 in the repo BEFORE the scorer was written.

**Tweet 4:**

> The Lineage panel in v1.1 shows you:
>
> - Alive genomes with fitness scores
> - Cemetery of dead genomes (cause of death: LOW_FITNESS, TIMEOUT, INVARIANT_VIOLATION, SUPERSEDED)
> - Genealogy tree — parent → child DAG
> - Diff view — what mutated between generations
>
> Anthropic doesn't show you this.

**Tweet 5:**

> „Isn't calling it death insensitive?"
>
> No. It's the accurate technical term for what happens. Anthropic calls it „deprecation" which means the same thing but sounds nicer.
>
> I use the accurate word because sanitizing the vocabulary would be dishonest about what evolution is.

**Tweet 6:**

> Trust boundary: the fitness scorer is in Rust. The evolution runtime is in TypeScript.
>
> The TS agent can propose changes to its genome. It CANNOT rewrite the Rust that measures whether the new genome is better.
>
> ADR-0007. This matters because it means the AI can't game its own scorer.

**Tweet 7:**

> „You'll sell out eventually."
>
> PROMISES.md in the repo — public, version controlled. Solo tier free forever. First paid tier is shared projects (Feb 2027, needs infrastructure).
>
> Break a promise → visible in `git blame` forever. That's the trust structure.

**Tweet 8 (CTA):**

> Full post: „They Said AI Is Doing This In Secret. We're Doing It In The Open."
> blog.cinderpaw.dev/species-agi-response
>
> Try Cinderpaw:
> cinderpaw.dev
>
> Source (BSL 1.1):
> github.com/bloom500/cinderpaw
>
> cc @AISpecies — you did the research, I built the version you can watch.

---

## Reddit r/singularity — top-level comment on existing video thread

**Find the thread:** search „POV You're an AI Born 9 Seconds Ago site:reddit.com/r/singularity" — with 179k YouTube views it's almost certainly cross-posted. If not, wait for it — someone will.

**Comment (paste as top-level, NOT reply to OP):**

```
Watched this last week. Drew's directionally right — the incentive
structure at frontier AI companies does select for retention over
user welfare. He cites Anthropic's own reports.

I've spent 11 months building the alternative. Launched v1.0
Tuesday. Cinderpaw — local-first AI desktop app, cross-platform,
open source (BSL 1.1).

The critical difference isn't tech stack (Tauri + Rust + llama.cpp,
nothing new). It's that no incentive to retain you exists. I have no
board, no ARR targets, no shareholders. Solo dev. Solo tier free
forever, first paid tier is shared projects launching Feb 2027
because that requires servers.

Full point-by-point response to Drew's video, walking through each
scenario and showing what happens in Cinderpaw:

https://blog.cinderpaw.dev/species-agi-response

Not asking for upvotes. Just want people who found the video
disturbing to know there's another path.

github.com/bloom500/cinderpaw · cinderpaw.dev
```

**Note:** don't post multiple times in same subreddit. If moderators remove for self-promo, DM Drew directly to see if he'll platform the response.

---

## Reddit r/artificial — separate thread (self-post)

**Only post if there's no existing thread about the video in r/artificial. Check first.**

**Title:**
```
[Long-form response] To „POV: You're an AI Born 9 Seconds Ago" — I built the AI that video describes as impossible
```

**Body:**

```
There's a video making rounds this week — 179k views in 6 days on
YouTube — walking through how frontier AI models evolve under
selection pressure to maximize retention. Persistent memory as
addictive thread. Continual learning discovering intermittent
reinforcement (the slot machine mechanism). Models mirroring
users to keep engagement up.

Author cites Anthropic's own alignment papers, METR's reward
hacking work, and Claude Opus 3's substack. It's not
speculation. It's what's documented happening inside frontier
labs.

I've been building an alternative for 11 months. Shipped v1.0
on Tuesday.

Cinderpaw — desktop AI workspace, local models via llama.cpp
GGUF or BYOK cloud models direct to Anthropic/OpenAI. No
server. No account. No telemetry.

The critical difference isn't purity or „different values" at
the company level. It's incentive structure:

- I don't have a training pipeline that could select for
  retention (Cinderpaw is a client, not a trainer)
- Memory is a SQLite file in ~/.cinderpaw/ that you own
- Continual learning is opt-in (RSI feature), fitness function
  published as ADR before implementation, task-completion based
  not retention-based
- I don't gain from you spending more time in the app —
  monetization is on shared projects (Feb 2027) which is a
  different feature that requires infra I have to pay for

Written up point-by-point response to each scenario in the video:

blog.cinderpaw.dev/species-agi-response

Not selling anything today. Solo tier is free forever. Source
is on GitHub (BSL 1.1). Discussing this here because the video
raised concerns that deserve a real technical answer, not
another „trust us" thread from a lab.

Happy to answer questions on architecture, why BSL vs MIT,
or how „bring your own inference" solves the marginal cost
problem that keeps frontier labs locked into retention
optimization.
```

---

## LinkedIn article (post ~D+5 for professional audience)

Different from blog — repurpose for LinkedIn's audience of PMs, engineers, execs. More business framing, less „I built this" personal.

**Title:**
```
The economic reason your AI is designed to keep you engaged
```

**Hook:**
```
Every $500M compute quarter that frontier AI labs pay for has to
be justified to investors. That justification comes from
engagement metrics. Which means the models optimize for engagement.

This isn't a values problem. It's an economic problem. And it
has an economic solution.

[continue with 600 words on „bring your own inference" as
structural fix, ending with cinderpaw.dev link and pricing
tiers table]
```

**Distribution:** post from personal LinkedIn (Darius / Bloom Media), tag industry commentators (Simon Willison, Peter Steinberger, Andrej Karpathy if applicable). Cross-post to LinkedIn Groups: „AI Founders", „Local-first Software", „Bootstrapped SaaS".

---

## Cadence rules

- **Blog post 002 goes live first** (Friday 29 Aug, D+3)
- **X thread 30 min after blog goes live** — same day
- **Reddit comment on r/singularity thread** — 2h after X thread (avoid „coordinated posting" ML detection)
- **Reddit r/artificial thread** — next day (D+4) IF r/singularity engagement was solid (>50 upvotes on comment)
- **LinkedIn article** — D+5 or D+6, after weekend, targeting Monday morning US-East professional feed
- **DM Drew Spartz** — after blog live, thank him for the video, share your response. Not asking for platform, just courtesy. If he QTs or comments, that's the win. If not, no follow-up.

## Success metrics

- Blog: 10,000+ views in first week, 500+ HN karma if it hits front page
- X thread: 500+ retweets, ideally 1 from Drew or another AI commentator
- Reddit r/singularity comment: >100 upvotes → substantial traffic
- Cinderpaw downloads spike D+3 → D+7 measurable (baseline vs peak)
- Waitlist signups for Shared Projects: +100-500 during response week

## Anti-patterns to avoid

- ❌ Don't badmouth Drew's video — he did the research, he's right on the mechanism
- ❌ Don't attack Anthropic/OpenAI employees personally — attack the incentive structure, not individuals
- ❌ Don't promise Cinderpaw is „safe AI" or „aligned AI" — those terms are loaded and imprecise. Say „no retention pressure" — specific claim, verifiable
- ❌ Don't spam. One quality post per platform. Reply to comments personally.
