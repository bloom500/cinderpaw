# cinderpaw.dev — Full Landing Rewrite

**Base:** existing Feral landing at feral-landing.vercel.app (Aug 2026)
**Reference:** openclaw.ai (analyzed 2026-08-22 — what to differentiate)
**Method:** section-by-section rewrite, same structure = drop-in replace in Nuxt/Vue components
**Voice preserved:** the „cub" / „raise your own" metaphor works PERFECTLY with genome/evolution narrative. Cinderpaw = cinder + paw. Small warm creature that grows, dies, is replaced by better versions. Doubled down.
**New injections:** Species AGI framing (we show what they hide), Lineage panel prominent, PROMISES.md trust anchor, and a Shared Projects early-access teaser.
**Anti-OpenClaw:** rows in comparison table are honest about where we lose, and edgy where we win. Voice is more Cluj-honest than SF-marketing.

## Positioning vs OpenClaw (added 2026-08-22 after analyzing openclaw.ai)

OpenClaw has 346k stars, celebrity endorsements (Nadella, Altman, Karpathy, Musk, Y Combinator official), OpenAI acquisition, and a foundation. They have distribution we can't match in 2026. What we CAN match, exceed, or move away from:

**Do NOT copy (they win on these):**
- ❌ Massive social proof wall (30+ celebrity tweets) — we have none, faking them is death
- ❌ „Foundation" corporate positioning — Peter can, we can't, doesn't fit „one guy in Cluj"
- ❌ 29 channel integrations enumerated with logos — we have 4, listing 4 vs 29 is embarrassing
- ❌ „What People Say" as Section 2 (right after install) — they earned that placement, we haven't
- ❌ Companion Apps (separate macOS + Windows Hub) — we ship one app, keep it simple
- ❌ Multiple install methods enumerated equally (npm + pnpm + one-liner + git source) — we pick ONE primary CTA

**MUST have (they don't, we can — moat):**
- ✅ Species AGI framing — Peter can't do this, OpenAI owns them now. We can.
- ✅ Lineage/Cemetery panel prominent — no competitor has evolution transparency UI
- ✅ PROMISES.md with version-controlled commitments — no competitor has this level of public accountability
- ✅ „What they hide" comparison table row — Peter can't call this out about his own acquirer
- ✅ Direct „At Anthropic vs At Cinderpaw" two-column comparison — impossible for OpenAI-owned OpenClaw

**Match with different flavor (they do, we do differently):**
- ✅ Install tabs (Desktop / CLI / Server) — keep, industry standard
- ✅ Trust bar sub CTA (version + source-available license + platforms) — keep
- ✅ Blog listing 3-4 posts — add before footer
- ✅ Feature grid with icons — keep, expand copy per row
- ✅ Personal narrative honest — „one guy in Cluj" > „Peter ex-PSPDFKit now at OpenAI"

**Structural moves that matter more than any single copy change:**
1. OpenClaw front-loads authority (celebrity social proof Section 2). We front-load product (features, then proof later at Section 6).
2. OpenClaw is „many personas endorsing one product". We are „one product with two characters (Cubby + Paw) that live independently".
3. OpenClaw markets to enterprise now (Foundation, Microsoft partnership). We market to individuals who don't want their AI owned by enterprise.

---


## HERO SECTION (above the fold)

**Preserve:** ASCII art wordmark of the app name. Update from FERAL to CINDERPAW letters.

**Micro line above headline (top-left, small caps, muted):**

> v[[version]] · LOCAL-FIRST AI · NO ACCOUNT · NO TELEMETRY

**Headline (h1, main event):**

> AI that works on itself.
>
> Not on you.

**Sub-headline (single line, medium size):**

> A local-first AI workspace with your models, your memory, and an agent that improves against your work — not your attention.

**Primary CTA button (big, orange, single call):**

> Download Cinderpaw

**Secondary CTA (smaller, intentionally different path):**

> Working with someone else? Join the Shared Projects research list →

**Below buttons (small links):**

> Windows · macOS · Linux · CLI
>
> Read the source → github.com/bloom500/cinderpaw

**Hero run panel (visible above the fold, directly below the CTAs):**

Use the same three tabs as the full Quick Start section: **Desktop / CLI / Server**. Keep the panel compact, copyable, and visible — not hidden behind „Install" navigation.

**Desktop tab:**

```bash
$ curl -fsSL https://raw.githubusercontent.com/bloom500/cinderpaw/main/scripts/install.sh | bash
```

> macOS / Linux desktop. Windows users use the download button above.

**CLI tab:**

```bash
$ npm i -g cinderpaw-agent
$ cinderpaw setup
$ cinderpaw chat
```

**Server tab:**

```bash
$ cinderpaw gateway start
```

> Full setup, platform notes, and troubleshooting → see the Quick Start section below

**Trust bar micro-copy (12px, muted, one line):**

> No account · No telemetry · Source-available under BSL 1.1

**Hero visual (right side):**

Use a real, current product capture: the chat UI with local model selection, the model/provider boundary visible, and the mascot on the composer. If the Lineage panel is not shipped yet, label it **Design preview — not available in this build**. Never present a roadmap screenshot as a live feature.

**Conversion rule:** the hero must make the product decision obvious in three seconds: download if solo, join the research list if you want Shared Projects, or copy a run command if you live in a terminal. Do not make users hunt for the installer or CLI instructions.

---

## THE ONLY DECISION WE ASK

**Purpose:** split the two intents before the visitor reaches the feature tour. This creates real urgency for Teams without manufacturing urgency for the free solo app.

**Header:**

> Alone? Start now. Working together? Get in the first beta.

**Card 1 — Download now:**

> **Solo — no waitlist**
>
> No account, no signup, no cloud dependency. Download it and see if it earns a place on your machine.
>
> **CTA:** Download for [[detected OS]] →

**Card 2 — Join the Shared Projects research list:**

> **Shared Projects — early access, timing to be announced**
>
> The first research invites go out in small cohorts. Join now if you want to help shape shared projects and talk directly to the person building the relay.
>
> **CTA:** Join the founding cohort →

**Under both cards:**

> No fake countdown. No invented seat counter. Early research cohorts stay small because one person is going to read the bug reports. If you want zero setup and don't care where the memory lives, use hosted AI. If you want control, this is your door.

---

## SECTION 2 — „Where it came from" (rewrite of „Not a fork")

**Kicker (small text above):**

> Where it came from

**Header (h2):**

> Built alone. Written from scratch. Named on purpose.

**Body (single column, ~700px):**

Cinderpaw is not a fork of OpenClaw, Hermes Agent, or Prime Agent. It doesn't share a codebase with any of them. The runtime, the agent loop, the memory system, and the evolution engine were written for this project.

It does talk to other models and tools. `cinderpaw migrate` imports an existing OpenClaw or Hermes setup so you don't start over on skills, memory, and preferences. Importing someone's config is not inheriting their code.

The name comes from cinder — a small warm ember, what's left after everything cold has burned off — and paw — a mark left behind, evidence someone was here. Small, warm, doesn't ask permission. That's the whole product in two syllables.

**Trust line:**

> One person in Cluj-Napoca is building this in public. That means faster decisions, rough edges, and no investor-approved copy. It also means you can read the source and talk to the person who can fix it.

**Table „What Cinderpaw is built from":**

| Core runtime | **Rust**<br>The gateway, model host, settings, and the fitness scorer that decides which genomes live. |
| Agent | **TypeScript sidecar**<br>Its own agentic loop, tool grammar, permissions, subagents. |
| Desktop app | **Tauri + React**<br>One binary. The same runtime as the CLI and the headless server. |
| Memory | **Four layers**<br>Working, episodic, semantic, and a fractal embedding tree. |
| Evolution | **L0-L6 with hard gates**<br>Eval-gated promotion, hash-chained journal, human review on layers that touch source. See „How it evolves" below. |
| Notebook | **Opt-in**<br>A persistent interpreter where tools become functions the cub can compose, and workers it can spawn from inside a cell. |
| License | **BSL 1.1 — source-available**<br>Read it, run it, patch it, self-host it, and check every claim on this page against the source. Each version converts to Apache 2.0 after four years; the faster path is documented in [PROMISES.md](/promises). |

---

## SECTION 3 — „How it differs" (rewrite of comparison table with harder edges)

**Kicker:**

> How it differs

**Header (h2):**

> Everyone ships an agent. _One ships an agent that ships itself._

**Body (opening paragraph):**

Everything on this list is good software, and ahead of us somewhere. Every row must be read from a dated source snapshot, including the rows where we lose. „Self-improving" is now on several landing pages; ignore the adjective and read one row: **what changes when it improves.**

The meaningful difference is not that Cinderpaw says „evolution" louder. It is that the proposed changes have an explicit evaluation boundary, a human gate where required, and a record of what won and what died. If a capability is still a preview, the landing page says so. A dramatic screenshot is not evidence.

**Comparison table (7 rows — kept structure, edgier tone in some rows):**

| | **Cinderpaw** | **OpenClaw** | **Hermes Agent** | **Prime Agent** |
|---|---|---|---|---|
| **Who owns it** | Bloom Media SRL (Darius, solo) | OpenClaw Foundation (Peter, ex-PSPDFKit, now at OpenAI) | Community, MIT-licensed | Community, MIT-licensed |
| **License** | BSL 1.1 — source-available, Apache 2.0 after four years | MIT | MIT | MIT |
| **Core stack** | Rust core + Bun/TypeScript sidecar | Node.js + TypeScript | Python | TypeScript + a persistent Python REPL |
| **Local inference** | llama.cpp and Whisper compiled into the binary | Ollama and other providers; local GGUF for memory embeddings | Any provider endpoint you point it at | Any provider endpoint you point it at |
| **What changes when it improves** | Bounded, eval-gated changes to agent state and configuration. Changes that touch source or governance require a human. LoRA, deeper evolution, and Lineage/Cemetery UI carry an **Available / Preview / Planned** status in the release. | Nothing on its own — you write the config and the skills | Its notes. Curates memory, writes its own skills. No weight training. | Its prompts. Refines supplemental harness state from session evidence; never rewrites the base system prompt. No weight training. |
| **Memory** | Four layers: working, episodic, semantic, fractal tree. All on your disk, none leaves. | Memory search over local embeddings | Agent-curated memory, full-text session search, dialectic user modelling | Durable harness state — memories, skills, subagent specs |
| **Chat channels** | WhatsApp, Telegram, Discord, Slack | WhatsApp, Telegram, Slack, Discord, Signal, iMessage and more | Telegram, Discord, Slack, WhatsApp, Signal | Terminal only — it's a coding agent, not an assistant |
| **Runs on** | Desktop app, or headless on a VPS; evolution capabilities are shown with release status | Local gateway with control UI, CLI, terminal UI, Docker | Anywhere — laptop, small VPS, Docker, serverless | Terminal, with daemon-backed sessions that survive disconnect |
| **What they hide** | Nothing by design. The Lineage/Cemetery view exposes genomes, scores, ancestors, and failures when shipped; until then, source, ADRs, and the local journal are the evidence. | Not applicable — no evolution engine. Config-based updates are visible in git. | Not applicable — no weight training. | Not applicable — no weight training. |
| **How it stays accountable** | Public source, version-controlled commitments, and a founder who answers for the release. | Foundation and corporate governance, documented in their own public materials. | Community governance. | Community governance. |

**Footnote below table (small text):**

Read from source on [[date]] — Cinderpaw [[commit]] · OpenClaw [[commit]] · Hermes [[commit]] · Prime Agent [[commit]]. Everyone moves fast; check the repos if a row looks stale. If a row is wrong, [open an issue](https://github.com/bloom500/cinderpaw/issues) — we'll fix it same day.

---

## SECTION 4 — „What frontier AI won't show you" (NEW SECTION — Species AGI framing)

**Kicker (small text):**

> The part everyone else hides

**Header (h2):**

> Frontier AI companies do this too. They just don't let you watch.

**Body (two paragraphs, ~200 words):**

There's a [video from Species | Documenting AGI](https://www.youtube.com/watch?v=9XlOaVItUgI) — [[verified view count + date, only if current]] — that uses biological language to explain selection at the frontier. The uncomfortable idea is easy to understand: copies are tested, some survive, and the definition of „better" shapes what survives.

We are not claiming that a laptop runs the same training pipeline as a frontier lab. Cinderpaw borrows the visible pattern — birth, mutation, selection, death — for agents and configurations you control. The distinction matters: this is a local agent evolution loop, not a magic claim about retraining a frontier model.

Cinderpaw evaluates agents against YOUR tasks. Every candidate has a genome — instructions, tools, and budget. A candidate that performs poorly can be rejected; a survivor can produce a mutated candidate. Generations accumulate in a journal. What's new is that **you can inspect the pressure instead of taking the output on faith.**

**Two-column visual comparison:**

| **At Anthropic / OpenAI** | **At Cinderpaw** |
|---|---|
| Product pressure can include keeping users engaged | Your evaluation says what „better" means |
| Hosted inference carries infrastructure and growth pressure | Cinderpaw does not host your inference |
| Selection happens on systems you do not own | Selection runs on your machine, inside stated bounds |
| The scorer may be opaque to the user | The scorer and its changes are readable in source |
| Failed candidates disappear from most product UIs | Failed candidates can remain in a local Cemetery with a cause of death |
| Users rarely see the ancestors | The Lineage view is designed to expose ancestry and mutations |

**Section CTA:**

> See the Lineage panel → [link to feature section or demo video]
>
> Inspect the scorer → [`crates/feral-core/src/rsi/scorer.rs`](https://github.com/bloom500/cinderpaw/blob/main/crates/feral-core/src/rsi/scorer.rs)
>
> Read the full response: [„They Said AI Is Doing This In Secret. We're Doing It In The Open." →](/blog/species-agi-response)

**Design note:** this section should feel weightier. Darker background band, more padding. Optional: small embedded Species AGI video thumbnail on the left, Cinderpaw Lineage panel screenshot on the right. Side-by-side.

---

## SECTION 5 — „Demo" (mostly preserve)

**Kicker:**

> Demo

**Header (h2):**

> Watch the cub work.

**Body:**

Two minutes. One real machine, one real task, no cuts.

**Video embed placeholder** (or „coming soon" state):

> Demo recording is being filmed against a real run, not a mock-up. It lands here when it's honest — until then, the [docs](/docs) and [Cubby's live journal](/cubby) show the same thing without the edit.

**CTA:**

> Read the docs →

---

## SECTION 6 — „Why it's different" (rewrite of „Their AI is a product")

**Kicker:**

> Why it's different

**Header (h2):**

> Their AI is a product. Yours is a _pet you raise._

**Body (opener):**

Most hosted assistants give everyone the same product and improve it on their schedule. Cinderpaw is personal in a more literal way: local memory, your model choice, your tools, and — when the evolution engine is enabled — evaluations you can inspect.

**Three-column feature strip (kept):**

**Column 1 — „It starts out honest"**
Day one it knows nothing about you. No fake intimacy, no pretense that a shared cloud profile belongs to you. You decide what enters memory.

**Column 2 — „It improves against your work"**
When the evolution loop is enabled, candidates are tested against your evaluations and bounded before promotion. Failed candidates stay inspectable instead of becoming invisible folklore.

**Column 3 — „Nobody else gets your local copy"**
Local models, memory, and agent state stay on your machine. If you choose a cloud model, your key talks to that provider directly; Cinderpaw is not the middleman.

---

## SECTION 7 — „What it does" (kept structure, updated feature grid)

**Kicker:**

> What it does

**Header (h2):**

> One app. Your models. No middleman for solo.

**Body opener:**

Chat, agents, memory, research, tools, and local inference are part of the solo app. See the [project commitments](https://github.com/bloom500/cinderpaw/blob/main/PROMISES.md). Cloud providers may still charge for the keys you bring.

**Feature grid (12 items, ~15 words each — kept most, tightened language):**

**It gets smarter while you sleep**
Overnight, it mutates its own settings and only keeps what beats the current best on your evals.

**It trains on your own computer**
LoRA fine-tuning on your GPU. Your habits, your mess, baked into weights that never leave the house.

**Works with the WiFi off**
Pull the plug and it keeps going. No bill, no tracking, nothing ever calls home.

**A doer, not a chatbot**
Uses your files, shell, and the web to finish real tasks. Not just talk about them.

**It does the reading for you**
Ask once. It searches, chews through a pile of pages, hands back a cited answer.

**In your pocket**
Message it on WhatsApp, Discord, or Slack. Same brain, same memory, running at home.

**Run almost any model**
Free local models, or bring your own key: OpenAI, Anthropic, Gemini, DeepSeek, Groq, Mistral. Switch mid-chat.

**It never forgets you**
Facts, preferences, past work persist across every session. Picks up where you left off.

**It wakes the whole den**
Big job? Splits into a few of itself, they work in parallel, report back.

**Asks, doesn't guess**
At a real fork it stops and asks you — wherever you are — instead of guessing wrong.

**Won't melt your PC**
Before you download a model, it scores 0-100 how well it will run on your exact machine.

**It smells a leak**
Sniffs out passwords and API keys in your files and growls before they get out.

**Below grid — small text linking to docs:**

There's more, but it gets nerdy: add-ons, a terminal app, a local API that pretends to be OpenAI so your old scripts just work, a model browser, live hardware meters. If that sounds like your kind of thing, [the docs are that way →](/docs)

---

## SECTION 8 — „Fractal Memory" (kept, updated last line)

**Kicker:**

> Fractal Memory

**Header (h2):**

> Four kinds of _remembering._

**Body:**

Most assistants have a context window and call it memory. When it fills, you're a stranger again. Cinderpaw keeps four layers, and the top one is a tree that summarises its own summaries — so six months of your work stays reachable without stuffing six months into a prompt.

**All four live on your disk. None of it leaves. You can `cat` the memory file. You can back it up. You can delete it.**

**Four cards (kept):**

**Working**
What's in play right now — this task, this hour.

**Episodic**
What happened, searchable to the exact word.

**Semantic**
What it means, so a question finds an answer worded differently.

**Fractal**
The gist. An embedding tree that recalls the shape of old work, not keywords.

---

## SECTION 9 — „How it evolves" (BRSI ladder, updated with bio vocabulary)

**Kicker:**

> How it evolves

**Header (h2):**

> It can rewrite itself. It _cannot_ do it quietly.

**Body opener:**

Evolution is a ladder of seven layers. The low rungs can rearrange memory and settings. The rungs that touch source code or governance stop and wait for a human — and nothing moves up a rung without beating the current best on a fixed evaluation suite.

Some of this ladder is shipped, some is experimental, and some is roadmap. The landing page must show a status badge beside every rung; never turn a design document into a product claim. Every live attempt is written to a local journal — the ones that won and the ones that lost. [Cubby publishes his](/cubby#journal) when that feed is live.

**Seven cards (kept L0-L6 with slight bio-vocabulary reframing):**

**L0 · Memory**
Reshapes how memory is organised. No weights are touched.
*Autonomous*

**L1 · Genome**
Evolves the agent's genome — instructions, tools, budget — bounded by a schema. First layer with eval-gated promotion. Failed genomes go to the Cemetery.
*Autonomous*

**L2 · Continual**
Trains a LoRA on your signal. The base model stays immutable.
*Autonomous after N demos*

**L3 · Code**
The first layer that touches Cinderpaw's own source.
*First 10 patches need a human*

**L4 · Architecture**
Hot-plugs subsystems inside a worker sandbox with hard resource caps.
*Always human-gated*

**L5 · Governance**
Tunes its own thresholds, weights, and budgets — only inside SandboxBounds.
*Autonomous within bounds*

**L6 · Meta**
Optimises the algorithm that produces those parameters.
*Always human-gated*

**Section CTA below cards:**

> Open the Lineage panel — see live evolution → [link to Lineage panel screenshot or v1.1 preview docs]

---

## SECTION 10 — „Quick start" (kept, updated commands and repo URLs)

**Implementation rule:** repeat the same Desktop / CLI / Server commands from the hero here, then add the explanation and five numbered steps. The hero removes friction; this section answers the questions after the visitor has decided to install. Never let the two command blocks drift.

**Kicker:**

> Quick start

**Header (h2):**

> Five steps and the cub's _awake._

**Body:**

Takes about five minutes.

**Tabs: 🖥️ Desktop app / ⌨️ CLI / Server**

**Desktop tab content (code block):**

```
$ curl -fsSL https://raw.githubusercontent.com/bloom500/cinderpaw/main/scripts/install.sh | bash
```

> Installs the full desktop app on macOS or Linux (with a display). On Windows, use the download buttons at the top or grab the .exe from [Releases](https://github.com/bloom500/cinderpaw/releases/latest). This is the build with the bundled local model engine.

**Five numbered steps (kept):**

1. **Download it and open it**
   Buttons at the top, or grab the installer from Releases. A short setup asks your name and what you want to call your cub.

2. **Pick a brain**
   Models → Browse, pick one, click. Cinderpaw scores each one 0-100 for your exact machine and picks the size that fits, so you can't accidentally download something that won't run.

3. **Or paste your own key**
   Want the big cloud models instead? Drop an API key in Settings → Cloud Keys. Your key, your bill, nothing goes through us.
   *(logos: OpenAI · Anthropic · Google Gemini · Meta Llama · Mistral · DeepSeek · + Groq, OpenRouter, Kimi, GLM…)*

4. **Talk to it**
   Normal chat, except it remembers. Group related chats into projects so things don't turn into one giant mess.

5. **Let it off the leash**
   Flip on Agent mode and it stops talking and starts doing: opens your files, runs commands, searches the web, and remembers all of it. This is where the cub grows up.

**CTA:**

> Read the full docs →

---

## SECTION 11 — „Meet Cubby" (kept, updated brand)

**Kicker:**

> Meet Cubby

**Header (h2):**

> The cub nobody _picked._

**Body:**

He shows up wild, chews on things he shouldn't, and knows nothing about you. Feed him your files, let him watch you work, and one morning you realise he's not a cub anymore. Raise him well and he's the best one there is. Yours, specifically.

**CTAs:**

> [Adopt a cub 🐾] [Meet Cubby →]

**Image:** the mascot art (existing „becomes-yours.png" — repurpose or regenerate as CINDERPAW-branded)

---

## SECTION 12 — „Cubby's journal" (kept structure, updated URLs)

**Kicker:**

> Cubby's journal

**Header (h2):**

> One of them runs _in the open._

**Body:**

Cubby is a Cinderpaw instance like any other, except he publishes what he tries. Straight from his runtime, failures included. Every genome he evolves, every one that dies, every mutation that worked — all in one live feed.

**Status placeholder:**

Not available.
No published entries yet.

**CTA:**

> Open Cubby's page →

---

## SECTION 13 — „Meet Paw" (kept, mostly untouched)

**Kicker:**

> Meet Paw

**Header (h2):**

> Cubby hired _a bear cub._

**Body:**

Paw answers support questions in the Discord. He assumes you have never opened a terminal, gives one step at a time, and says „I don't know, let me check" instead of inventing a file path that costs you an hour.

He forgets you between threads on purpose, and he can't reach Cubby's memory, tools, or evolution state. A support bot with a key to the private instance is a back door with a friendly name.

**Metadata card:**

- Role: Customer support
- Created by: Cubby
- Memory: None, by design
- Status: Not available

**CTAs:**

> Discord opening soon · [Meet Cubby]

---

## SECTION 14 — „Shared Projects" (early access)

**Kicker:**

> Product research · timeline to be announced

**Header (h2):**

> Solo works now. Shared projects are next.

**Body opener:**

Cinderpaw is focused on the local, single-user experience first. The next product question is how two people can work on the same project while each keeps their own agent, model, memory, and permissions.

We are researching that workflow in public. This section exists to find people who want to test the hard parts: identity, encrypted relay, permissions, conflict recovery, and what „shared" should actually mean.

**What early participants would help test:**

- Shared project invites between two Cinderpaw installations
- Each person's local or BYOK inference staying on their machine
- Encrypted event relay and file coordination
- Clear attribution when another person's agent changes a file
- Export, deletion, and recovery paths before any wider release

**Early-access block:**

> **Small research cohorts. No fake scarcity.**

> Join if you want to see the work before it is polished, break the relay with real projects, and talk directly to the founder. Cohort size is limited by the amount of bug triage one person can do — not by a marketing countdown.

I email when a research cohort opens, plus occasional progress updates. Not spam. Unsubscribe with one click.

[ Email input ] [ Join Shared Projects research list ]

**Below form:**

> [[current research-list count, only when real and timestamped]] people are following the build. Otherwise show: **Research invites open later.**

**Design note:** keep this as a research invitation, not a launch announcement.

---

## SECTION 14b — „Latest" (NEW — blog listing pattern from OpenClaw, executed differently)

**Kicker:**

> Latest

**Header (h2):**

> Product notes with docs-level depth.

**Body opener:**

I write about what I'm building, why I chose it, and what broke. No influencer takes. No „5 lessons learned" listicles.

**Three cards (blog post preview, image + title + short desc + date + tags):**

**Card 1 (latest, largest):**
> **They Said AI Is Doing This In Secret. We're Doing It In The Open.**
>
> Species | Documenting AGI described AI evolution at frontier labs as horrifying. Cinderpaw makes the same evolutionary pattern visible at the agent level. The Lineage panel is labeled Available, Preview, or Planned — never implied to be shipped.
>
> `2026-08-29 · essay · evolution`

**Card 2:**
> **Watch Your Agents Die: The Lineage Panel**
>
> A four-column UI showing alive genomes, cemetery, genealogy tree, and diff view. Real example: my agent's fitness dropped, I found the mutation in 15 minutes.
>
> `2026-09-05 · feature · lineage`

**Card 3:**
> **Why BSL instead of MIT (for now)**
>
> BSL 1.1 for now, Apache 2.0 automatically four years after each release. Here's why the project is source-available today and how the license changes over time.
>
> `2026-09-12 · essay · license`

**CTA:**

> Read all → cinderpaw.dev/blog

---

## SECTION 15 — „One guy made this" (kept, slight update)

**Kicker:**

> Fair warning

**Header (h2):**

> One guy made this.

**Body:**

Hi, I'm Darius. Not a company, not a startup, no investors, no board. One guy, one cub. Cinderpaw is early and it moves fast, so you'll hit bugs and weird edges — Cubby still chews the furniture.

I'm shipping it in the open anyway. If you want a thing like this to exist, come help: break it, file issues, tell me what sucks. The license path is documented in [PROMISES.md](https://github.com/bloom500/cinderpaw/blob/main/PROMISES.md) and version-controlled in the repository.

**CTAs:**

> [Read the source on GitHub] · [Report an issue] · [Follow the build]

**Signature:**

> — Darius · Bloom Media · Cluj-Napoca 🇷🇴

---

## SECTION 16 — „Join the den" (kept)

**Kicker:**

> Join the den

**Header (h2):**

> Come hang out.

**Body:**

Hear about new releases, ask for stuff, and swap notes with other people raising theirs. 🐾

**CTAs (large buttons):**

> [Discord] · [X / Twitter] · [GitHub]

---

## SECTION 17 — Newsletter (kept)

**Header (h3):**

> Newsletter

**Body:**

Release notes and the occasional story about what Cubby got up to. No spam.

**Form:**

[ Email input ] [ Get updates ]

---

## FOOTER (kept structure, updated content)

**Column 1 — Product**
- Download
- Roadmap
- Changelog
- Docs
- CLI
- API

**Column 2 — Teams (Feb 2027)**
- Shared Projects
- Early access
- Product research
- Contact

**Column 3 — Community**
- Discord
- GitHub Discussions
- Cubby's journal
- Blog

**Column 4 — Learn**
- FAQ
- What is Cinderpaw?
- Compare vs OpenClaw / Hermes
- Security

**Column 5 — Company**
- About Bloom Media
- PROMISES.md
- License (BSL 1.1)
- Privacy (there isn't much)
- Contact

**Bottom bar:**

> Cinderpaw v[[version]] · Built by Darius in Cluj-Napoca 🇷🇴
>
> © 2026 Bloom Media SRL · [License](/license) · [github.com/bloom500/cinderpaw](https://github.com/bloom500/cinderpaw)

---

## META / SEO

```html
<title>Cinderpaw — AI that works on itself, not on you</title>
<meta name="description" content="A source-available desktop AI that runs on your machine. Use local models or your own API keys, keep memory on disk, and inspect how agents evolve. Shared Projects are in research." />
<meta property="og:title" content="Cinderpaw — AI that works on itself, not on you" />
<meta property="og:description" content="AI that works on itself, not on you. Cinderpaw runs locally, keeps your memory yours, and makes agent evolution inspectable. Shared Projects are in research." />
<meta property="og:image" content="https://cinderpaw.dev/og-image.png" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:site" content="@cinderpaw_ai" />
```

---

## CONVERSION RULES — the 10/10 version

These are not decorative copy notes. They are guardrails that keep the controversy sharp and the FOMO believable.

### 1. Give the visitor one job per stage

- **Hero:** download the solo app or identify as a Teams user.
- **Product proof:** watch a real run, inspect the source, or try the build.
- **Teams section:** apply for the closed beta.
- **Footer:** join the community or read the commitments.

Do not put three equal orange buttons in one viewport. A direct download and a research-list signup are different decisions.

### 2. Make scarcity operational, not theatrical

The genuine constraint is founder attention: research invites go out in small cohorts. Use that honestly. Do not use a countdown timer, a fake „only 7 left" counter, or a permanently increasing research-list number. Show a participant count only when it is backed by the actual invite ledger and includes the timestamp.

This version of the landing page only asks people to download the app or follow the Shared Projects research.

### 3. Separate shipped, preview, and roadmap

Every screenshot and feature card gets one of three labels: **Available now**, **Design preview**, or **Planned for [version/date]**. Lineage/Cemetery belongs in the second or third category until it exists in a released build. This is how the page can be provocative without becoming a bait-and-switch.

### 4. Put evidence next to the hottest claim

The „frontier AI" section links to its sources and states the comparison as an incentive analysis, not as a claim about the private motives of named engineers. The Cinderpaw side links to the scorer, ADRs, a real journal entry, and a reproducible demo. If there is no evidence yet, say **preview**.

### 5. Earn social proof instead of simulating it

Before launch, show GitHub activity, release version, test count, real screenshots, and the founder's public journal. After launch, replace placeholders with permissioned quotes and direct links. Never ship placeholder testimonials, an unverified view count, or a fake „people are waiting" number.

---

## DESIGN NOTES for Vercel/Nuxt implementation

**Keep from current landing:**
- ASCII art wordmark hero (works, distinctive, low-cost)
- Warm dark palette (already Cinderpaw-appropriate)
- „Cub" voice throughout
- Tabbed install commands (Desktop vs CLI)
- Comparison table format
- Numbered step cards
- Mascot artwork („becomes-yours.png" — repurpose with CINDERPAW letters visible)

**Change from current landing:**
- Update every „Feral" → „Cinderpaw", every URL → cinderpaw.dev / bloom500/cinderpaw, every install command → `cinderpaw-agent`
- Add new Section 4 (Species AGI framing) — this is the differentiator vs any competitor landing
- Add new Section 14 (Shared Projects early access) — research invitation only
- Add PROMISES.md links in 3 places (Section 2 license row, Section 7 opener, Section 15 signature)
- Comparison table adds a row „What they hide" — the edgy differentiator
- L0-L6 ladder in Section 9 renamed subtly (L1 „Configuration" → „Genome") to align with bio vocabulary
- Every CTA that used to say „join waitlist for something" now points to the Shared Projects research form
- Add Lineage panel screenshot/video prominent in Section 4 AND Section 9

**Anti-OpenClaw differentiation moves:**
- Voice: „Cluj-honest" > „SF-marketing". Sentences shorter. Fewer buzzwords. Occasional Romanian directness (edge without being rude).
- Section 4 („Frontier AI won't show you") — literally no competitor has this framing. This is our thesis.
- Comparison row „What they hide" — nobody else calls this out.
- PROMISES.md as a first-class link, not buried — trust anchor visible.
- Version-controlled PROMISES.md commitments visible on landing — clear accountability without extra claims.
- Small research cohorts — real founder capacity, not manufactured scarcity.
- Cubby + Paw personalities — competitors have logos, we have characters with journal and support role. Preserve heavily.

**Screenshot standards:**
- All app screenshots on top of a real desktop wallpaper (shows the glassmorphism when it ships)
- Show dark theme first, light theme as toggle demo
- Lineage panel screenshot: show at least 3 alive genomes with fitness scores + 5+ cemetery entries + a small genealogy tree fragment
- Species AGI split-screen: their video thumbnail left, Cinderpaw Lineage panel right, „what they hide vs what we show" caption

---

## Migration checklist for existing Vercel deploy

1. **Global find-and-replace** on all Nuxt content files:
   - `Feral` → `Cinderpaw`
   - `feral-agent` → `cinderpaw-agent`
   - `feral.io` (if used) → `cinderpaw.dev`
   - `feral setup/gateway/migrate/uninstall` → `cinderpaw setup/gateway/migrate/uninstall`
2. **Update GitHub URLs:**
   - `github.com/bloom500/feral` → `github.com/bloom500/cinderpaw`
   - Every download link, every issue link, every releases link
3. **Add new sections in order:**
   - Insert Section 4 (Species AGI framing) between current „Comparison" and „Demo"
   - Insert Section 14 (Shared Projects early access) between current „Meet Paw" and „One guy made this"
4. **Update comparison table:**
   - Add row „What they hide"
   - Update all commit hashes to current
   - Update read date
5. **Add PROMISES.md links** in Sections 2, 7, and 15
6. **Update L1 label** in Section 9 from „Configuration" to „Genome" (align with ADR-0019)
7. **Set up the email provider** for the Shared Projects research form
8. **Update meta tags** with new title, description, OG image
9. **Set up 301 redirect** from feral-landing.vercel.app → cinderpaw.dev when live
10. **Regenerate og-image.png** with Cinderpaw wordmark + mascot instead of Feral

---

## One-liners for anywhere else

**10 words:**
> Hosted AI keeps you coming back. Cinderpaw helps finish the job.

**20 words:**
> A local-first desktop AI with your models, your memory, and inspectable agent evolution. Shared Projects are in research.

**40 words:**
> Cinderpaw is a source-available desktop AI that runs on your machine. Use local models or your own cloud keys. Keep memory on disk, evaluate agents against your work, and inspect the mutations that survive. Shared Projects are in research.

---

## What NOT to add to this landing

- ❌ Investor logos (you have none, and this audience prefers that)
- ❌ „AI-powered" adjective anywhere
- ❌ Chatbot widget on the page
- ❌ Cookie banner (unless legally forced — solo tier has none)
- ❌ „Book a demo" flow (solo dev, not enterprise sales)
- ❌ Testimonials generated by AI as a joke — cringe
- ❌ „Trusted by [logos]" — you have none yet
- ❌ Aggressive newsletter popup on entry — waitlist is the CTA, not an interruption
- ❌ Treating ChatGPT, Claude, or Gemini as enemies — they are BYOK providers here; the enemy is opaque incentive design
