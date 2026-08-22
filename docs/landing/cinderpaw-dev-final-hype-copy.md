# Cinderpaw — Final Landing Copy

**Status:** Canonical marketing copy for the next landing-page replacement.
**Audience:** developers, local-AI users, privacy-conscious builders, and people who want to shape an AI instead of renting the same assistant as everyone else.
**Language:** English.
**Tone:** short, sharp, controversial, high-energy, founder-led. Never fake.
**Scope:** local single-user product now; Shared Projects are research-only. No pricing, subscription, checkout, discount, or commercial offer appears anywhere on this page.

---

## 0. Non-negotiable messaging rules

- Say **source-available under BSL 1.1**, never “open source”.
- Say **self-improving agent** only where the feature is actually available; label roadmap and design-preview features.
- The controversy attacks opaque incentives and product design, not individual engineers.
- FOMO comes from being early to Generation Zero, shaping the product, and accumulating a personal lineage — never from fake counters or fake scarcity.
- All counters, testimonials, view counts, screenshots, and “live” states must be real.
- The primary action is always **Download Cinderpaw**. The secondary action is **Shared Projects research**.
- Keep the download button and run commands in both the Hero and Quick Start. The Hero is the fast path; Quick Start is the complete path.

---

## 1. Hero — above the fold

**Eyebrow:**

> GENERATION ZERO STARTS HERE.

**H1:**

> **AI that works on itself.**
>
> **Not on you.**

**Subheadline:**

> Start with your models, your memory, and your work — then watch an AI become yours.

**Primary CTA:**

> **Download Cinderpaw →**

**Secondary CTA:**

> **See the lineage →**

**Hero install panel:**

Tabs: **Desktop · CLI · Server**

**Desktop:**

```bash
$ curl -fsSL https://raw.githubusercontent.com/bloom500/cinderpaw/main/scripts/install.sh | bash
```

> macOS and Linux desktop. Windows users: use the download button above.

**CLI:**

```bash
$ npm i -g cinderpaw-agent
$ cinderpaw setup
$ cinderpaw chat
```

**Server:**

```bash
$ cinderpaw gateway start
```

**Hero proof bar:**

> Local-first · No account · No telemetry · Your models · Source-available

**Hero microcopy:**

> Everyone else is waiting for the next model. You can start building the next version of yours.

**Hero visual:**

Use the real current Cinderpaw UI. Show local model selection, the model/provider boundary, and the mascot. If Lineage is not in the current release, show a visible badge:

> **Design preview — not available in this build.**

Do not use a cinematic fake dashboard as if it were the product.

---

## 2. The first scroll — early-adopter identity

**Kicker:**

> YOU ARE EARLY. THAT IS THE ADVANTAGE.

**H2:**

> **The first version is the one you can still shape.**

**Body:**

> Most AI arrives as a finished product. You get the same brain, the same defaults, and the same update schedule as everyone else.
>
> Cinderpaw starts at Generation Zero. You choose the model. You decide what enters memory. You define what “better” means for your work.
>
> The people who start now will not just use Cinderpaw. They will leave fingerprints on what it becomes.

**CTA:**

> **Start at Generation Zero →**

**Honesty line:**

> No fake countdown. No invented seat counter. Just an early product whose rules can still change.

---

## 3. Problem — the sharp thesis

**Kicker:**

> THE AI INDUSTRY HAS A STRANGE DEFINITION OF “BETTER.”

**H2:**

> **When attention is the product, attention becomes the objective.**

**Body:**

> Hosted AI products live inside businesses that measure usage, engagement, and return visits. That does not require a villain in a boardroom. It is what happens when the product is rewarded for keeping you around.
>
> Cinderpaw takes a different route. Your runtime is on your machine. Your local model is yours. If you bring a cloud key, the request goes to the provider you chose — not through a Cinderpaw proxy.
>
> The goal is not another conversation. The goal is finished work.

**Pull quote:**

> **Your AI should get better at your work — not better at keeping you online.**

**CTA:**

> **See what runs locally →**

---

## 4. Ownership reveal

**H2:**

> **Stop renting the same brain as everyone else.**

**Body:**

> Cinderpaw is a desktop AI workspace that runs where you work. Use local GGUF models. Bring your own API key when you need frontier quality. Keep memory, agent state, and the history of what changed on your machine.
>
> No account to unlock the solo experience. No telemetry by default. No cloud dashboard pretending to be ownership.

**Three cards:**

### Your machine

> Local by default. Pull the WiFi and the local path keeps working.

### Your models

> Choose the model that fits the task, the hardware, and the level of trust you want.

### Your memory

> Read it. Back it up. Delete it. Move it. It is not a mysterious profile trapped in someone else’s database.

**Microcopy:**

> The cloud is a provider option. It is not the owner of your workspace.

---

## 5. The part everyone else hides — evolution

**Kicker:**

> THE PART EVERYONE ELSE HIDES

**H2:**

> **Frontier AI has selection pressure. You see the result, not the process.**

**Body:**

> Cinderpaw brings the evolutionary pattern down to the agent level: birth, mutation, selection, and death.
>
> Every candidate has a genome — instructions, tools, and budget. A candidate that fails your evaluation can be rejected. A survivor can produce a mutated candidate. Generations accumulate in a local journal.
>
> This is not a claim that a laptop runs a frontier lab’s training pipeline. It is a sharper claim: Cinderpaw makes the pressure visible instead of hiding it behind a product update.

**Short pull quote:**

> **Watch one survive. Watch another die.**

**Two-column comparison:**

| Hosted AI | Cinderpaw |
|---|---|
| Product pressure can include keeping users engaged | Your evaluations say what “better” means |
| Selection happens on systems you do not own | Selection runs locally, inside stated bounds |
| The scorer may be opaque | The scorer and its changes are readable in source |
| Failed candidates disappear from the product UI | Failed candidates can remain inspectable in a Cemetery |
| You see the output | You can inspect ancestry, mutations, and failures |

**Evidence links:**

> Inspect the scorer → `crates/feral-core/src/rsi/scorer.rs`
>
> Read the evolution ADRs → `/docs/adr/`
>
> Open a real journal entry → `/cubby`

**CTA:**

> **See the Lineage preview →**

**Status badge:**

> Available now · Design preview · Planned — show the correct status beside each visual and feature.

---

## 6. Lineage / Cemetery feature marquee

**H2:**

> **Don’t wait for the finished cub. You’ll miss the interesting part.**

**Body:**

> Generation Zero is when every decision is still visible. Every skill, failed mutation, useful constraint, and unexpected breakthrough becomes part of a lineage nobody else can copy.
>
> The polished version will be easier to explain. The origin story is what makes it yours.

**UI labels:**

- **Alive** — candidates currently in the population
- **Cemetery** — candidates that failed, with a cause of death
- **Genealogy** — parent, child, survivor, mutation
- **Diff** — exactly what changed

**Preview caption if not shipped:**

> **Design preview. Values illustrative. This interface is not available in the current build.**

**CTA:**

> **Watch the lineage take shape →**

---

## 7. “Not another chatbot” section

**Kicker:**

> NOT A CHATBOT WITH A DARK MODE

**H2:**

> **It talks when talking helps. It acts when acting matters.**

**Body:**

> Give it files, shell access, web research, MCP servers, and a real task. It can plan, use tools, ask when it reaches a genuine fork, and return with the work — not just a paragraph about the work.
>
> Big job? Wake the den. Sub-agents split the task, work in parallel, and report back.

**Feature cards:**

### Chat

> Local or cloud. One interface. Streaming, formatting, code, and model switching.

### Agents

> Files, web, shell, MCP, permissions, and tool-use behind explicit boundaries.

### Deep research

> Ask once. It searches, reads, compares, and returns a cited report.

### Sub-agents

> Let several focused workers attack a large task in parallel.

### Hardware fit

> Know whether a model will run before you download it.

### Secret scanner

> Find credentials and dangerous patterns before they escape.

**CTA:**

> **Give it a real task →**

---

## 8. Fractal Memory

**Kicker:**

> MEMORY THAT DOESN’T RESET WHEN THE TAB CLOSES

**H2:**

> **Four kinds of remembering. One workspace that stays yours.**

**Body:**

> Most assistants have a context window and call it memory. When it fills, you are a stranger again.
>
> Cinderpaw keeps working, episodic, semantic, and fractal memory. The fractal layer summarises summaries so old work stays reachable without stuffing your entire history into every prompt.
>
> All four layers live on your disk. You can inspect them, back them up, and delete them.

**Cards:**

- **Working** — what is in play right now.
- **Episodic** — what happened, searchable to the exact word.
- **Semantic** — what it means, even when the question is phrased differently.
- **Fractal** — the shape of old work, not just a keyword match.

**Pull quote:**

> **When the context window closes, your history should not disappear with it.**

---

## 9. How it evolves

**Kicker:**

> IT CAN CHANGE. IT CANNOT CHANGE QUIETLY.

**H2:**

> **Every ambitious capability has a boundary. Every boundary is visible.**

**Body:**

> Low layers can reshape memory and settings. Layers that touch source code or governance stop and wait for a human. Promotion requires beating the current best on a fixed evaluation suite.
>
> Some layers are available now. Some are experimental. Some are planned. The page shows the status instead of pretending the roadmap is a release.

**Evolution ladder:**

### L0 · Memory

> Reshape how memory is organised. No weights touched. **Available now.**

### L1 · Genome

> Evolve instructions, tools, and budgets within a schema. **Available now.**

### L2 · Continual

> Train a LoRA on your signal while the base model remains immutable. **Planned.**

### L3 · Code

> The first layer that touches the source. Human-gated. **Planned.**

### L4 · Architecture

> Hot-plug subsystems inside hard sandbox bounds. **Planned.**

### L5 · Governance

> Tune thresholds and budgets only inside explicit limits. **Planned.**

### L6 · Meta

> Improve the algorithm that produces the parameters. Human-gated. **Planned.**

**CTA:**

> **Open the evolution map →**

---

## 10. Quick Start — complete install section

**Kicker:**

> QUICK START

**H2:**

> **Five minutes from download to awake.**

**Intro:**

> The Hero has the fast path. This is the full path. Pick your mode, copy the command, and start with a real task.

### Desktop

```bash
$ curl -fsSL https://raw.githubusercontent.com/bloom500/cinderpaw/main/scripts/install.sh | bash
```

> macOS and Linux. On Windows, download the current installer from the Hero or Releases.

### CLI

```bash
$ npm i -g cinderpaw-agent
$ cinderpaw setup
$ cinderpaw chat
```

### Server

```bash
$ cinderpaw gateway start
```

### Step 1 — Download it

> Open the app. The setup asks your name and what to call your cub.

### Step 2 — Pick a brain

> Open Models → Browse. Cinderpaw scores models against your exact machine before you commit to a download.

### Step 3 — Bring your own key

> Need a cloud model? Add your key in Settings → Cloud Keys. The request goes to the provider you chose.

### Step 4 — Talk to it

> Start a normal chat. It remembers across sessions and projects.

### Step 5 — Let it off the leash

> Turn on Agent mode. Give it a real task. Watch it use tools, ask questions, and return with evidence.

**CTA:**

> **Start your first task →**

---

## 11. Meet Cubby

**Kicker:**

> MEET CUBBY

**H2:**

> **The cub nobody picked.**

**Body:**

> He shows up wild, knows nothing about you, and occasionally chews something he should not.
>
> Feed him your work. Give him boundaries. Let him learn your way of doing things. One day you realise he is not the same cub you downloaded.
>
> That is the point. Not a universal assistant. Yours.

**CTA:**

> **Adopt a cub →**

---

## 12. Cubby’s journal

**Kicker:**

> ONE INSTANCE RUNS IN THE OPEN

**H2:**

> **See what happens when the cub keeps receipts.**

**Body:**

> Cubby publishes what he tries: successful mutations, dead genomes, strange failures, and the decisions that survived.
>
> No polished success story without the failures underneath it.

**Empty state:**

> **No published entries yet.** The journal appears when a real runtime publishes a real event.

**CTA:**

> **Open Cubby’s journal →**

---

## 13. Shared Projects research

**Kicker:**

> THE NEXT QUESTION

**H2:**

> **Solo works now. Shared projects are next.**

**Body:**

> What happens when two people work on one project but keep their own agents, models, memory, and permissions?
>
> We are researching that in public: encrypted relay, identity, handoffs, file conflicts, and the moment another person’s agent touches your work.
>
> The rules are still being written. Early participants can still change them. Later users will inherit the decisions.

**Research CTA:**

> **Join the Shared Projects research list →**

**Form reassurance:**

> Occasional research updates. No spam. No fake countdown.

**Fallback state:**

> **Research invites open later.**

---

## 14. Proof before promises

**Kicker:**

> NO CELEBRITY WALL. NO INVENTED TESTIMONIALS.

**H2:**

> **The receipts are the product.**

**Before launch proof bar:**

- Current release version
- GitHub source
- Real screenshots
- Test status
- Public ADRs
- Cubby journal, when live

**After launch social proof:**

> Replace this section with permissioned quotes from real users and direct links to the original posts. Never publish the examples below as if they were real.

**Example quote shapes only:**

> “I expected another wrapper. I got a runtime I can actually inspect.”
>
> “The useful part is not that it remembers. It shows me what changed.”
>
> “I started with a blank cub. Three weeks later it fits my workflow better than a generic assistant ever did.”

**Trust line:**

> If a claim cannot be linked to source, a release, a test, or a real user, it does not belong on the page.

---

## 15. One guy made this

**Kicker:**

> FAIR WARNING

**H2:**

> **One person made this. That is both the risk and the advantage.**

**Body:**

> There is no giant marketing department smoothing the edges. Cinderpaw is early. You will find bugs. Cubby will chew the furniture.
>
> You also get a direct line to the person building the runtime, reading the issues, and deciding what changes next.
>
> If you want a local AI that can become strange, personal, and genuinely yours, this is the moment to get involved.

**CTAs:**

> **Read the source →**
>
> **Report an issue →**
>
> **Follow the build →**

**Signature:**

> — Darius · Bloom Media · Cluj-Napoca, Romania

---

## 16. Final CTA

**Full-width heading:**

> **Don’t wait for the finished version.**
>
> **Start with the one that can still become yours.**

**Body:**

> Download Cinderpaw. Start at Generation Zero. Give it one real task.

**Primary CTA:**

> **Download Cinderpaw →**

**Secondary CTA:**

> **Read the source →**

**Final microcopy:**

> Local-first · No account · No telemetry · Your models · Source-available

---

## 17. Footer copy

**Product:**

- Download
- Quick Start
- Docs
- Roadmap
- Changelog

**Research:**

- Shared Projects
- Cubby’s journal
- Evolution / Lineage

**Community:**

- GitHub
- Discord
- X / Twitter
- Report an issue

**Legal:**

- PROMISES.md
- License — BSL 1.1
- Privacy
- Contact

**Footer line:**

> Cinderpaw — AI that works on itself. Not on you.
>
> Built by Darius in Cluj-Napoca, Romania.

---

## 18. SEO / social metadata

```html
<title>Cinderpaw — AI that works on itself. Not on you.</title>
<meta name="description" content="A local-first AI workspace with your models, your memory, and an agent that improves against your work — not your attention. Start at Generation Zero." />
<meta property="og:title" content="Cinderpaw — AI that works on itself. Not on you." />
<meta property="og:description" content="Start at Generation Zero. Use your models, keep your memory, and watch an AI become yours." />
<meta property="og:image" content="https://cinderpaw.dev/og-image.png" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:site" content="@cinderpaw_ai" />
```

**Social preview text:**

> Everyone else is waiting for the next model. You can start building the next version of yours.

---

## 19. Implementation acceptance checklist

- [ ] Replace the entire old landing; do not merge old Feral copy into this page.
- [ ] Hero H1 is exactly: **AI that works on itself. Not on you.**
- [ ] Hero has a prominent Download button.
- [ ] Hero has Desktop / CLI / Server command tabs.
- [ ] Quick Start repeats the same commands exactly.
- [ ] Shared Projects is labeled research-only with no commercial offer.
- [ ] No price, discount, subscription, checkout, billing, or paid tier appears anywhere.
- [ ] No fake counters, testimonials, countdowns, or “spots left” claims.
- [ ] Lineage/Cemetery visuals carry the correct status badge.
- [ ] BSL 1.1 is called source-available.
- [ ] All screenshots show the real current app or say Design preview.
- [ ] Fix whitespace and list-rendering artifacts: `you come`, `You can cat`, and duplicate list numbers.
- [ ] Desktop, CLI, and Server commands are copyable on mobile.
- [ ] `prefers-reduced-motion` is respected.
- [ ] Download CTA remains visible on mobile without scrolling past the Hero.
