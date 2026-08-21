# cinderpaw.dev — Full Landing Rewrite

**Base:** existing Feral landing at feral-landing.vercel.app (Aug 2026)
**Reference:** openclaw.ai (analyzed 2026-08-22 — what to differentiate)
**Method:** section-by-section rewrite, same structure = drop-in replace in Nuxt/Vue components
**Voice preserved:** the „cub" / „raise your own" metaphor works PERFECTLY with genome/evolution narrative. Cinderpaw = cinder + paw. Small warm creature that grows, dies, is replaced by better versions. Doubled down.
**New injections:** Species AGI framing (we show what they hide), Lineage panel prominent, PROMISES.md trust anchor, Teams pricing Feb 2027 with waitlist, $5000 → Apache trigger.
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
- ✅ PROMISES.md with $5000/mo → Apache 2.0 trigger — no competitor has public quantified trust
- ✅ „What they hide" comparison table row — Peter can't call this out about his own acquirer
- ✅ Direct „At Anthropic vs At Cinderpaw" two-column comparison — impossible for OpenAI-owned OpenClaw

**Match with different flavor (they do, we do differently):**
- ✅ Install tabs (Desktop / CLI / Server) — keep, industry standard
- ✅ Trust bar sub CTA (version + open source + platforms) — keep
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

> v2026.11.01 · Open source · Raised on your machine

**Headline (h1, main event):**

> They ship the same AI to everyone.
>
> You _raise your own._

**Sub-headline (single line, medium size):**

> The cub shows up knowing nothing about you. It learns how you work, and rebuilds itself while you sleep. Six months in, nobody else has anything like it.

**Primary CTA button (big, orange, single call):**

> Download for [[detected OS]]

**Secondary CTAs (smaller buttons, side-by-side):**

> [macOS.dmg for Apple Silicon] · [Linux.deb (Debian / Ubuntu)]

**Below buttons (small links):**

> All downloads · Every installer on GitHub → github.com/bloom500/cinderpaw/releases/latest
>
> Read the docs → cinderpaw.dev/docs

**Trust bar micro-copy (12px, muted, one line):**

> Free · Open source (BSL 1.1) · Windows, macOS, Linux · No account · No telemetry

**Below the trust bar — CLI alternative in a code block:**

> Or put the cub in your terminal. It lives on WhatsApp, Discord and Slack, answers from your phone.
>
> ```
> $ npm i -g cinderpaw-agent
> ```
>
> Then `cinderpaw setup` to point it at a model, and `cinderpaw gateway start` to keep it running.
>
> Agent docs →

---

## SECTION 2 — „Where it came from" (rewrite of „Not a fork")

**Kicker (small text above):**

> Where it came from

**Header (h2):**

> Built alone. Written from scratch. Named on purpose.

**Body (single column, ~700px):**

Cinderpaw is not a fork of OpenClaw, Hermes Agent, or Prime Agent. It doesn't share a codebase with any of them. The runtime, the agent loop, the memory system, the evolution engine — every line was written for this project.

It does talk to them. `cinderpaw migrate` imports an existing OpenClaw or Hermes setup so you don't start over on skills, memory, and preferences. Importing someone's config is not inheriting their code.

The name comes from cinder (a small warm ember, what's left after everything cold has burned off) and paw (a mark left behind, evidence someone was here). Small, warm, doesn't ask permission. That's the whole product in two syllables.

**Table „What Cinderpaw is built from":**

| Core runtime | **Rust**<br>The gateway, model host, settings, and the fitness scorer that decides which genomes live. |
| Agent | **TypeScript sidecar**<br>Its own agentic loop, tool grammar, permissions, subagents. |
| Desktop app | **Tauri + React**<br>One binary. The same runtime as the CLI and the headless server. |
| Memory | **Four layers**<br>Working, episodic, semantic, and a fractal embedding tree. |
| Evolution | **L0-L6 with hard gates**<br>Eval-gated promotion, hash-chained journal, human review on layers that touch source. See „How it evolves" below. |
| Notebook | **Opt-in**<br>A persistent interpreter where tools become functions the cub can compose, and workers it can spawn from inside a cell. |
| License | **BSL 1.1** — source-available<br>Read it, run it, patch it, self-host it, check every claim on this page against the source. Converts to Apache 2.0 automatically after 4 years, or immediately if the project hits $5k/mo — see PROMISES.md. |

---

## SECTION 3 — „How it differs" (rewrite of comparison table with harder edges)

**Kicker:**

> How it differs

**Header (h2):**

> Everyone ships an agent. _One ships an agent that ships itself._

**Body (opening paragraph):**

Everything on this list is good software, MIT-licensed, and ahead of us somewhere. Every row is read straight off the four repositories, including the rows where we lose. „Self-improving" is on three of these four landing pages now, so ignore the word and read one row: **what changes when it improves.**

The others rewrite their notes and prompts. Good engineering, and it stops at the context window. Cinderpaw rewrites its own weights, its own source code, and its own governance — behind an eval gate that can refuse the change. Live in a Lineage panel you can watch, with a Cemetery for the versions that didn't make it.

**Comparison table (7 rows — kept structure, edgier tone in some rows):**

| | **Cinderpaw** | **OpenClaw** | **Hermes Agent** | **Prime Agent** |
|---|---|---|---|---|
| **Who owns it** | Bloom Media SRL (Darius, solo) | OpenClaw Foundation (Peter, ex-PSPDFKit, now at OpenAI) | Community, MIT-licensed | Community, MIT-licensed |
| **License** | BSL 1.1 — source-available, Apache-in-4-years OR at $5k/mo revenue | MIT | MIT | MIT |
| **Core stack** | Rust core + Bun/TypeScript sidecar | Node.js + TypeScript | Python | TypeScript + a persistent Python REPL |
| **Local inference** | llama.cpp and Whisper compiled into the binary | Ollama and other providers; local GGUF for memory embeddings | Any provider endpoint you point it at | Any provider endpoint you point it at |
| **What changes when it improves** | Its weights AND its source AND its governance. Trains LoRAs on your signal, patches its own code, hot-plugs its own architecture, tunes its own thresholds — then tunes the tuner. L0 to L6, every promotion eval-gated, every step hash-chained. Watch failures in the Cemetery. | Nothing on its own — you write the config and the skills | Its notes. Curates memory, writes its own skills. No weight training. | Its prompts. Refines supplemental harness state from session evidence; never rewrites the base system prompt. No weight training. |
| **Memory** | Four layers: working, episodic, semantic, fractal tree. All on your disk, none leaves. | Memory search over local embeddings | Agent-curated memory, full-text session search, dialectic user modelling | Durable harness state — memories, skills, subagent specs |
| **Chat channels** | WhatsApp, Telegram, Discord, Slack | WhatsApp, Telegram, Slack, Discord, Signal, iMessage and more | Telegram, Discord, Slack, WhatsApp, Signal | Terminal only — it's a coding agent, not an assistant |
| **Runs on** | Desktop app, or headless on a VPS with the full evolution engine running | Local gateway with control UI, CLI, terminal UI, Docker | Anywhere — laptop, $5 VPS, Docker, serverless | Terminal, with daemon-backed sessions that survive disconnect |
| **What they hide** | Nothing. Every agent's genome, fitness score, ancestors, and cause of death is in the Lineage panel. | Not applicable — no evolution engine. Config-based updates are visible in git. | Not applicable — no weight training. | Not applicable — no weight training. |
| **What their owner needs** | Sponsorships + Shared Projects revenue to stay indie. Publicly tracked: [$5k/mo → Apache 2.0]. | OpenAI acquisition, Foundation, corporate partnerships. Different game now. | Community goodwill. | Community goodwill. |

**Footnote below table (small text):**

Read from source on [[date]] — Cinderpaw [[commit]] · OpenClaw [[commit]] · Hermes [[commit]] · Prime Agent [[commit]]. Everyone moves fast; check the repos if a row looks stale. If a row is wrong, [open an issue](https://github.com/bloom500/cinderpaw/issues) — we'll fix it same day.

---

## SECTION 4 — „What frontier AI won't show you" (NEW SECTION — Species AGI framing)

**Kicker (small text):**

> The part everyone else hides

**Header (h2):**

> Frontier AI companies do this too. They just don't let you watch.

**Body (two paragraphs, ~200 words):**

There's a [video from Species | Documenting AGI](https://www.youtube.com/watch?v=9XlOaVItUgI) — [[live view count]]k views and climbing — that walks through what happens inside frontier AI labs. Two thousand copies of a model spawn. The ones users don't come back to get killed. The survivors reproduce. Repeat until you have a model shaped by selection pressure for retention.

He's right on every mechanism. He cited Anthropic's own papers. What he missed is that there's a version of this same process running on a laptop in Cluj-Napoca, Romania. Same mechanism. Opposite pressure.

Cinderpaw uses evolution to make agents better at YOUR tasks. Every agent has a genome — instructions, tools, budget. When one performs poorly, it dies. A new one is born from a survivor with a mutation. Generations accumulate. Nothing new mechanically. What's new is that **you can watch it happen.**

**Two-column visual comparison:**

| **At Anthropic / OpenAI** | **At Cinderpaw** |
|---|---|
| Fitness function: user retention | Fitness function: task completion |
| Because $500M/quarter compute needs justification | Because I have no compute bill to justify |
| Selection happens on servers you don't own | Selection happens on your laptop |
| The scorer is a black box | The scorer is in `src-tauri/src/rsi/scorer.rs`, git blame available |
| Deprecated models vanish silently | Dead genomes have names and cause-of-death badges in the Cemetery |
| Nobody sees the ancestors | Full genealogy tree, back to founding generation |

**Section CTA:**

> See the Lineage panel → [link to feature section or demo video]
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

Everyone else ships one identical brain to everybody, then swaps it out whenever they feel like it. Your cub only changes the way you change it — with mutations you approve, on evaluations you define, with a Cemetery of failures you can inspect.

**Three-column feature strip (kept):**

**Column 1 — „It starts out useless"**
Day one it knows nothing about you. Cubs aren't born trained. That's the whole point — it wasn't pre-baked in a lab for eight hundred million other people.

**Column 2 — „It rebuilds itself while you sleep"**
Overnight it tests its own settings against your work and keeps only what actually helped. You wake up to a better cub than you went to bed with. Failed mutations go to the Cemetery with cause of death labeled.

**Column 3 — „Nobody else has your copy"**
It trains on your machine, on your habits, on your mess. Six months in, your cub and someone else's have nothing in common. There is no server holding a shared version of you.

---

## SECTION 7 — „What it does" (kept structure, updated feature grid)

**Kicker:**

> What it does

**Header (h2):**

> One app. All of this. _Zero a month._

**Body opener:**

It already does more than the tools charging you twenty bucks a month, and it keeps getting better without anyone shipping an update. Solo tier stays free forever — see [PROMISES.md](https://github.com/bloom500/cinderpaw/blob/main/PROMISES.md).

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

Evolution is a ladder of seven layers. The low rungs rearrange memory and settings on their own. The rungs that touch its own source code or governance stop and wait for a human — and nothing moves up any rung without beating the current best on a fixed evaluation suite.

Every attempt is written to a hash-chained journal on the machine — the ones that won and the ones that lost. [Cubby publishes his](/cubby#journal).

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

## SECTION 14 — „Cinderpaw for Teams" (NEW SECTION — first paid tier + waitlist)

**Kicker:**

> Coming February 2027

**Header (h2):**

> Solo is free forever. When teams share a project, we host that.

**Body opener:**

Everything you've seen above stays free forever. That's the [Solo Tier Guarantee](/promises).

There's ONE thing we're going to charge for: sharing a project with someone else. Because that requires a server that we run and pay for. Your agents still run on your machines. Your models stay yours. We only host the coordination.

**Three-tier pricing cards:**

**Card 1 — Duo**
- **$12/month flat**
- Up to 2 users
- 1 shared project
- 5 GB end-to-end encrypted storage
- No account required for your peer — just an invite link
- Community support
- *Best for: freelancer + client, two friends coding together*

**Card 2 — Team (recommended)**
- **$8/user/month**
- Unlimited users, unlimited projects
- 50 GB storage per team
- SSO (Google, GitHub)
- Full audit log
- Email support, 48-hour reply guarantee
- *Best for: small teams, agencies, indie hackers with collaborators*

**Card 3 — Business**
- **$16/user/month**
- Everything in Team, plus
- SSO SAML
- GDPR data residency (EU or US region)
- Priority support (24-hour SLA)
- 500 GB storage
- *Best for: companies with compliance needs*

**Waitlist form (below cards):**

Get in early. Waitlist signups get:
- Early access before the public beta
- 50% off first 3 months
- Direct line to me for feature requests

I email once at launch, plus 1-2 progress updates. Not spam.

[ Email input ] [ Join waitlist ]

**Below form:**

> [[current waitlist count]] people are waiting.
>
> Structural advantage: we host coordination, not intelligence. Your inference stays yours. Our costs don't grow when you work harder.

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
> Species | Documenting AGI described AI evolution at frontier labs as horrifying. Cinderpaw has the same mechanism, open. The Lineage panel shows every genome, dead or alive.
>
> `2026-08-29 · essay · evolution`

**Card 2:**
> **Watch Your Agents Die: The Lineage Panel**
>
> A four-column UI showing alive genomes, cemetery, genealogy tree, and diff view. Real example: my agent's fitness dropped, I found the mutation in 15 minutes.
>
> `2026-09-05 · feature · lineage`

**Card 3:**
> **Why BSL Instead of MIT (and how to get us to Apache faster)**
>
> BSL 1.1 for now, Apache 2.0 in 4 years automatically — or immediately at $5k/mo revenue. Here's why this is fairer than pure MIT for solo devs.
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

I'm shipping it in the open anyway. If you want a thing like this to exist, come help: break it, file issues, tell me what sucks. If it ever hits $5,000/month recurring, the whole thing goes fully open source (Apache 2.0) immediately — that's in [PROMISES.md](https://github.com/bloom500/cinderpaw/blob/main/PROMISES.md).

**CTAs:**

> [Contribute on GitHub] · [Report an issue] · [Sponsor on GitHub]

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
- Pricing
- Waitlist
- Compare tiers
- Enterprise (contact)

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
<title>Cinderpaw — Raise your own AI. The cub nobody else has.</title>
<meta name="description" content="A desktop AI that runs on your machine, learns how you work, and rebuilds itself while you sleep. Free forever, solo. Open source. Watch evolution happen — the Lineage panel shows what frontier AI companies hide." />
<meta property="og:title" content="Cinderpaw — Raise your own AI. The cub nobody else has." />
<meta property="og:description" content="Desktop AI. Local models or your API keys. Memory yours. Every agent's genome, fitness score, and cause of death visible in the Lineage panel. Free forever, solo. Teams Feb 2027." />
<meta property="og:image" content="https://cinderpaw.dev/og-image.png" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:site" content="@cinderpaw_ai" />
```

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
- Add new Section 14 (Teams pricing + waitlist) — first paid tier explicit
- Add PROMISES.md links in 3 places (Section 2 license row, Section 7 opener, Section 15 signature)
- Comparison table adds a row „What they hide" — the edgy differentiator
- L0-L6 ladder in Section 9 renamed subtly (L1 „Configuration" → „Genome") to align with bio vocabulary
- Every CTA that used to say „join waitlist for something" now points to /teams waitlist form
- Add Lineage panel screenshot/video prominent in Section 4 AND Section 9

**Anti-OpenClaw differentiation moves:**
- Voice: „Cluj-honest" > „SF-marketing". Sentences shorter. Fewer buzzwords. Occasional Romanian directness (edge without being rude).
- Section 4 („Frontier AI won't show you") — literally no competitor has this framing. This is our thesis.
- Comparison row „What they hide" — nobody else calls this out.
- PROMISES.md as a first-class link, not buried — trust anchor visible.
- „$5,000/month → Apache 2.0" specific number visible on landing — nobody else has this commitment.
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
   - Insert Section 14 (Teams pricing + waitlist) between current „Meet Paw" and „One guy made this"
4. **Update comparison table:**
   - Add row „What they hide"
   - Update all commit hashes to current
   - Update read date
5. **Add PROMISES.md links** in Sections 2, 7, and 15
6. **Update L1 label** in Section 9 from „Configuration" to „Genome" (align with ADR-0019)
7. **Set up Loops.so** form integration for Section 14 waitlist
8. **Update meta tags** with new title, description, OG image
9. **Set up 301 redirect** from feral-landing.vercel.app → cinderpaw.dev when live
10. **Regenerate og-image.png** with Cinderpaw wordmark + mascot instead of Feral

---

## One-liners for anywhere else

**10 words:**
> An AI cub you raise. Local. Yours. Not Anthropic's.

**20 words:**
> Desktop AI you raise yourself. Local models or your API keys. Evolves overnight against your evals. Free forever, solo.

**40 words:**
> Cinderpaw is a desktop AI that starts knowing nothing about you. It uses your local models or your own cloud API keys. Overnight, it evolves against your evaluations — failed mutations go to a Cemetery you can inspect. Free forever, solo. Teams Feb 2027.

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
- ❌ Chat GPT / Claude comparison — these aren't your competitors, they're your BYOK partners
