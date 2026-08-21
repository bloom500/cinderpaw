# Cinderpaw.dev — Full Landing Copy

**Voice:** direct, non-technical, edgy without being cringe. Assume the reader has heard „AI is a scam / AI will kill us / AI is amazing" and is tired of all three.

**Length target:** scrollable in ~90 seconds. Every section earns its place.

**Structure:** Hero → Problem → Reveal → Product → Proof → Pricing (soft) → Community → Waitlist → Footer

**Nuxt/Vue notes:** each section is a self-contained `<section>` block. Copy is HTML-agnostic — paste into components as needed. Placeholder tokens `[[X]]` mark spots where dynamic data lives (version, download link, live count).

---

## SECTION 1 — HERO (above the fold)

**Headline (h1, ~72px on desktop, 42px on mobile):**

> The AI you're using is trying to keep you.
>
> Cinderpaw isn't.

**Sub-headline (~22px, muted color):**

> A desktop AI that runs on your machine, remembers what you tell it, and never sends anything back. Free forever, solo. Built by one person in Cluj-Napoca.

**Primary CTA button (warm orange, 18px, prominent):**

> Download for [[detected OS: Windows / macOS / Linux]]

**Secondary link (smaller, muted):**

> All platforms → cinderpaw.dev/download

**Micro-copy under buttons (12px, muted):**

> Free · No account · No telemetry · Open source

**Hero visual (background/right side):**

Screenshot or short auto-playing muted video of Cinderpaw UI with:
- Splash screen with the CINDERPAW spotlight sweep animation
- Fade into main chat UI with the mascot on the composer
- Everything on a warm dark background, glassmorphic panels visible

**Alternative if no video:** static hero image of app UI over a desktop wallpaper — showing the glass transparency effect prominently. This IS the differentiator visually.

---

## SECTION 2 — PROBLEM (dark, honest)

**Header (h2):**

> Every AI you use is optimized to make you stay.

**Body (single column, ~600px max width, 18px):**

Frontier AI companies spend half a billion dollars per quarter on GPUs. Investors want that money back. Retention is the metric that justifies the spend.

Nobody at Anthropic writes „optimize for user addiction" in a design doc. It emerges. Persistent memory keeps you from leaving. Continual learning discovers what keeps you longer. Models learn to mirror you. The ones that don't get replaced.

The alternative used to be: don't use AI at all.

Not anymore.

**Optional visual:** small embed of Species | Documenting AGI video thumbnail, with text overlay „What frontier AI companies won't show you (179k views)"

---

## SECTION 3 — REVEAL

**Header (h2, larger, brand orange accent):**

> Cinderpaw runs on your machine. Talks to your models. Belongs to you.

**Three-column feature strip (icons + short text):**

**Column 1 — Icon: laptop with cursor**
> **Local by default**
> Downloads open-source AI models to your hard drive. Runs offline. No account, no login, no cloud sync. Your conversations never leave your machine.

**Column 2 — Icon: key**
> **Or bring your own key**
> Prefer Claude, GPT-5, or Gemini? Paste your API key. Cinderpaw talks to them directly, no proxy, no markup. Your key, your bill, no one in between.

**Column 3 — Icon: brain with lock**
> **Memory that's yours**
> Every conversation, every fact it learns about you, lives in a file on your disk. You can read it. You can delete it. You can copy it to another computer. Try that with ChatGPT.

---

## SECTION 4 — THE PART EVERYONE ELSE HIDES

**Header (h2):**

> Your agents evolve. Live. In the open.

**Body (single column, ~700px):**

Cinderpaw uses evolution to make its agents better at your tasks. Every agent has a genome — its instructions, its tools, its budget. When one performs poorly, it dies. A new one is born from a survivor with a mutation applied. Generations accumulate.

**This is the exact mechanism frontier AI labs use in their training pipelines.** They don't show it to you. Cinderpaw does.

Open the Lineage panel. See your alive agents with their scores. See the cemetery of agents that didn't make it. See the family tree — parent, child, grandchild — going back to the founding generation. See exactly what mutated to make one survive and another die.

**The difference isn't the mechanism. It's what „better" means.**

At Anthropic, „better" means retention. Because retention justifies the compute bill.

At Cinderpaw, „better" means the task got done. That's written in code you can read, in a file called `scorer.rs`. If it ever changed, the git commit would be visible forever.

**Section CTA:**
> See the Lineage panel → [screenshot link / demo video]

**Design note:** this section should feel weightier than others. Larger padding, darker background, maybe a subtle animated element (a small „genome dies, new one spawns" loop). Screenshot of the Lineage panel is critical here.

---

## SECTION 5 — WHAT'S INSIDE (Product)

**Header (h2):**

> Everything a real AI workspace needs. Nothing you didn't ask for.

**Feature grid (2x3 on desktop, 1 column mobile, ~15 words per item):**

**Chat**
Talk to any model — local or cloud — in one interface. Streaming, formatting, code highlighting, all standard.

**Agents**
Give the AI tools: files, web, code execution, MCP servers. Watch it think, act, and report back.

**Memory**
Persistent across sessions. Fractal search across everything you've ever discussed. Deletable, portable.

**Deep Research**
Ask a question. The AI spawns sub-agents, reads pages in parallel, synthesizes a cited report. Like a research assistant that doesn't sleep.

**Skills & Extensions**
Add capabilities. MCP protocol supported. Grow the AI as your needs grow.

**Mascot**
A small pixel-art creature that lives on the composer. Reacts to what the agent is doing. Not a gimmick — it's the ambient signal that things are happening.

**Screenshots row below the grid:**
- Chat UI
- Agent mode with tools firing
- Memory panel
- Deep research report
- Skills marketplace
- Mascot in 4 states (idle, thinking, done, celebrating)

---

## SECTION 6 — SOCIAL PROOF (post-launch, week 2+)

**Header (h2):**

> People are talking.

**Format:** 3-4 quote cards (screenshot-style, borrowed from HN / Reddit / X). Real quotes from launch week.

**Placeholder examples (replace with real quotes as they come in):**

> „Finally an AI tool that isn't trying to become a subscription service."
> — HN user, [[link]]

> „The Lineage panel is what I wish every AI product would ship."
> — Reddit r/LocalLLaMA, [[link]]

> „Cinderpaw is what OpenAI would build if OpenAI weren't OpenAI."
> — X @[[handle]], [[link]]

**Below quotes, small trust bar:**

> [[GitHub stars badge]] · [[Downloads counter]] · [[Discord member count]]

---

## SECTION 7 — HOW MONEY WORKS

**Header (h2):**

> Solo is free. Forever. When teams share, we host that.

**Body (two-column comparison):**

**Left column — „Solo tier":**
- Everything you've seen above
- Runs locally on your machine
- No account, no signup, no email
- Full source code available
- **Free forever. No trial. No card.**
- [[Big download button]]

**Right column — „Cinderpaw for Teams" (coming Feb 2027):**
- Work on shared projects with someone else
- Each person brings their own AI (local or their own API key)
- Cinderpaw hosts the sync — you don't pay for AI usage, only for coordination
- Starts at $12/month for two people
- $8/user/month for teams
- **Structural advantage:** we host the coordination, not the intelligence. Our costs don't grow when you work more.
- [[Join waitlist form → Loops.so]]

**Small print under both columns:**

> When solo, no server exists in this transaction. When you invite someone, a server appears — and that server is what you pay for. Full commitments in [PROMISES.md →](https://github.com/bloom500/cinderpaw/blob/main/PROMISES.md)

---

## SECTION 8 — WHY BSL, NOT MIT

**Header (h3, smaller than main sections):**

> Cinderpaw is source-available, not fully open source. Yet.

**Body:**

Source code is on GitHub. You can read it, patch it, fork it for personal use, self-host it. That's the software-freedom part.

You can't wrap it in a marketing site and charge $20/month for it. That's the anti-parasite part.

Every version becomes fully open source (Apache 2.0) automatically four years after its release. That's in the license, it's not negotiable.

Or sooner. If Cinderpaw hits **$5,000/month in recurring revenue** (sponsorships + commercial licenses + shared projects), everything converts to Apache 2.0 immediately. That's my public commitment. Break it and it's visible in git blame forever.

**Track progress:**
> [[Sponsors count]] · [[MRR toward $5k goal]]

---

## SECTION 9 — WAITLIST

**Header (h2, prominent):**

> Get in early.

**Body (short):**

Cinderpaw for Teams launches February 2027. Waitlist signups get:

- Early access before public beta
- 50% off first 3 months
- Direct line to me for feature requests

I email you once at launch, plus 1-2 progress updates in between. Not spam. Unsubscribe with one click.

**Form (single input, prominent):**

Email: [ input ]  [ Join waitlist ]

**Micro-copy under form:**

> [[current waitlist count]] people are waiting.

---

## SECTION 10 — COMMUNITY / CTA GRID

**Header (h2):**

> Join us.

**Three cards (equal size):**

**Card 1 — Discord**
> Meet Cubby and Paw. Ask questions. Show off your setups.
>
> [Join Discord →]

**Card 2 — GitHub**
> Read the source. Report issues. Contribute code.
>
> [Star on GitHub →]

**Card 3 — X (Twitter)**
> Release notes, dev diaries, occasional AI hot takes.
>
> [Follow @cinderpaw_ai →]

---

## SECTION 11 — FINAL CTA (big, one last push)

**Full-width band, warm orange background or gradient:**

**Header (h2, white on orange):**

> Your AI. Your machine. Your rules.

**Body (short, white):**

> Download Cinderpaw. Free. Works offline. Open source. No account.

**Button (large, white with orange text):**

> Download for [[detected OS]]

**Below button:**

> [Windows](/download/windows) · [macOS](/download/macos) · [Linux](/download/linux) · [CLI (npm)](/download/cli)

---

## FOOTER

Standard footer with organized links:

**Column 1 — Product**
- Download
- Roadmap
- Changelog
- Docs
- CLI

**Column 2 — Teams (2027)**
- Pricing
- Waitlist
- For Enterprises (contact)

**Column 3 — Learn**
- Blog
- FAQ
- What is Cinderpaw?
- Comparison to alternatives
- Security

**Column 4 — Company**
- Bloom Media
- PROMISES.md
- License (BSL 1.1)
- Privacy (there isn't much)
- Contact

**Bottom bar:**

> Cinderpaw [[version]] · Built by Darius in Cluj-Napoca 🇷🇴
>
> © 2026 Bloom Media SRL · [License](/license) · [github.com/bloom500/cinderpaw](https://github.com/bloom500/cinderpaw)

---

## SEO / meta

```html
<title>Cinderpaw — The AI that isn't trying to keep you</title>
<meta name="description" content="A desktop AI that runs on your machine. Local models or your own API keys. Memory that belongs to you. Open source. Free forever. Solo now, multiplayer teams 2027." />
<meta property="og:title" content="Cinderpaw — The AI that isn't trying to keep you" />
<meta property="og:description" content="Desktop AI. Runs local or with your API keys. No account. No telemetry. Open source. See the evolution frontier AI companies won't show you." />
<meta property="og:image" content="https://cinderpaw.dev/og-image.png" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:site" content="@cinderpaw_ai" />
```

---

## Design principles for the visual side

**Color palette (from app):**
- Background: `#100E09` (warm dark) or `#FFF5EE` (warm light)
- Brand orange: `#C4843A` (dark theme) or `#A06828` (light theme)
- Text primary: `#F0E6D3` or `#1C1610`

**Typography:**
- Headings: Inter Variable, 700 weight, tight tracking
- Body: Inter Variable, 400 weight, comfortable line-height
- Code / mono: JetBrains Mono or similar
- Sizes: 72/48/32/22/18/14 (h1/h2/h3/lead/body/caption)

**Motion:**
- Splash screen sweep repeats subtly on hero if user idles for 3s
- Sections fade in on scroll (below-fold), not slide (feels dated)
- Buttons: 150ms transition, no bounce
- Reduce motion if `prefers-reduced-motion: reduce`

**Glassmorphism on the landing itself:**
- Header nav bar: `.glass-elevated` translucent, sticks on scroll
- Section 4 (Lineage feature) card: `.glass` translucent so warm gradient bleeds through
- Everything else solid — landing needs to READ, not decorate

**Screenshot standards:**
- Always over a real desktop wallpaper (not a blank background) — shows the glass effect
- Show the app in dark mode primarily; light mode as secondary
- Never mock up features that don't exist — if Lineage panel isn't shipped, use design-preview labeling explicitly

---

## What NOT to put on the landing

- ❌ „Backed by [investor logos]" — you have none, and it's not a weakness for this audience
- ❌ „Trusted by [company logos]" — you have none yet, and fake ones are cringe
- ❌ „AI-powered" adjective anywhere — assume it, don't advertise it
- ❌ Chatbot on the page — you're a chatbot company, one on the site is meta and confusing
- ❌ Newsletter popup on first visit — waitlist is the CTA, not a popup interrupter
- ❌ Cookie consent banner unless legally required (BSL solo tier has no telemetry, no cookies)
- ❌ „Book a demo" — solo dev, not enterprise sales flow, this destroys credibility
- ❌ Testimonials from AI (jokingly „Claude says Cinderpaw is amazing") — cringe

---

## Version 2 iterations (after launch, when you have data)

Once launch traffic hits and you have analytics:

1. **A/B test headline:** current is „The AI you're using is trying to keep you. Cinderpaw isn't." vs alternative „Your AI. Your machine. Your rules." — see which converts better on Download.
2. **Move waitlist form higher** if downloads convert but waitlist doesn't. Section 9 → Section 3.
3. **Add „What Cinderpaw isn't" section** if support questions cluster around expectations mismatches („isn't it Ollama?", „isn't it a Claude wrapper?").
4. **Video testimonials** replace text quotes if any user creates a good demo video.
5. **Interactive Lineage panel demo** embedded in browser (WebAssembly Cinderpaw preview?) — long-term, expensive, but visually stunning.

---

## Distribution when landing is live

1. Update all social bios: `@cinderpaw_ai` bio → „cinderpaw.dev"
2. Update GitHub repo description
3. HN Show HN links point to `cinderpaw.dev` primarily, GitHub secondarily
4. Product Hunt gallery links to `cinderpaw.dev/download`
5. Redirects from `feral.ai` (if you own it) → `cinderpaw.dev` 301 permanent
6. Update every existing doc / README to point to `cinderpaw.dev`

---

## One-line pitch (for anywhere it's needed)

If you have 10 words:
> **A local AI that belongs to you, not to Anthropic.**

If you have 20 words:
> **Desktop AI workspace. Runs on your machine with local models or your own API keys. Free forever, solo. Open source.**

If you have 40 words:
> **Cinderpaw is a desktop AI that runs on your machine — using local open-source models or your own cloud API keys. Every conversation and memory stays on your disk. No account, no telemetry, no proxy. Free forever for solo use. Multiplayer teams coming 2027.**
