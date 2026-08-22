# Cinderpaw.dev — Full Landing Copy

**Voice:** direct, non-technical, edgy without being cringe. Assume the reader has heard „AI is a scam / AI will kill us / AI is amazing" and is tired of all three.

**Length target:** scrollable in ~90 seconds. Every section earns its place.

**Structure:** Hero → intent split → Problem → Reveal → Product → Proof → Shared Projects research → Community → Footer

**Nuxt/Vue notes:** each section is a self-contained `<section>` block. Copy is HTML-agnostic — paste into components as needed. Placeholder tokens `[[X]]` mark spots where dynamic data lives (version, download link, verified counts).

---

## SECTION 1 — HERO (above the fold)

**Headline (h1, ~72px on desktop, 42px on mobile):**

> Their business model rewards another prompt.
>
> Cinderpaw is built to finish the job.

**Sub-headline (~22px, muted color):**

> A desktop AI that runs on your machine, uses your local models or your API keys, and gets better against the work you actually care about. Built by one person in Cluj-Napoca.

**Primary CTA button (warm orange, 18px, prominent):**

> Download Cinderpaw

**Secondary CTA (smaller, deliberately separate):**

> Working with someone else? Join the Shared Projects research list →

**Micro-copy under buttons (12px, muted):**

> No account · No telemetry · Source-available under BSL 1.1 · Windows, macOS, Linux

**Hero visual (background/right side):**
Screenshot or short auto-playing muted video of the current Cinderpaw UI. Show the local model/provider boundary and mascot on the composer. If Lineage is not shipped, mark it **Design preview — not available in this build**.

---

## THE ONLY DECISION WE ASK

**Header:**

> Alone? Start now. Working together? Get in the first beta.

**Solo card:**

> **No waitlist. No account. No cloud dependency.** Download the app and decide whether it deserves a place on your machine.
>
> [Download for [[detected OS]] →]

**Teams card:**

> **Shared Projects · early research · timing to be announced**
>
> Join if you want to help shape shared projects and talk directly to the founder. Research cohorts stay small because one person is going to read the bug reports.
>
> [Join the research list →]

**FOMO guardrail:**

> Do not show a countdown or an invented seat count. Show a live number only when it comes from the invite ledger and includes a timestamp. If you want zero setup and don't care where the memory lives, use hosted AI. If you want control, this is your door.

---

## SECTION 2 — PROBLEM (dark, honest)

**Header (h2):**

> When the business rewards attention, attention becomes the product.

**Body (single column, ~600px max width, 18px):**

Hosted AI products have an economic reason to keep usage high: inference costs money, growth has to be justified, and engagement is easy to measure. That is an incentive analysis, not an accusation about individual engineers.

Cinderpaw removes the middleman for solo use. Local inference has no Cinderpaw usage meter to optimise; BYOK sends your request directly to the provider you chose. The product can be opinionated about finishing the task without pretending it owns the intelligence.

The alternative used to be: don't use AI at all.

Not anymore.

**Optional visual:** small embed of the Species | Documenting AGI video thumbnail, with a dated, verified view count only if it is still current. Otherwise use: „A public argument about what frontier AI hides."

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

Cinderpaw borrows the evolutionary pattern — birth, mutation, selection, death — to make agents better at your tasks. Every candidate has a genome: instructions, tools, and budget. A candidate that performs poorly can be rejected; a survivor can produce a mutated candidate.

**This is not a claim that a laptop runs a frontier lab's training pipeline.** The controversial part is simpler: Cinderpaw makes the selection pressure visible instead of hiding it behind a product update.

When the Lineage panel is available, see alive agents with their scores, the Cemetery of failed candidates, and the family tree behind a survivor. See exactly what changed. Until then, label the panel a design preview and link to the source and ADRs.

**The difference isn't the word „evolution." It's what „better" means.**

Hosted products can be pulled toward engagement because engagement supports the business. Cinderpaw evaluates against the task and the bounds you define. The scorer is readable, the changes are in git, and the claim is testable.

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

> Show the receipts.

**Before launch:** use a proof strip with the current release, GitHub activity, test status, real product screenshots, and a link to the source.

**After launch:** replace the proof strip with 3–4 permissioned quote cards (screenshots from HN / Reddit / X) and direct links to the original posts. Never render placeholder quotes as if they were testimonials.

**Placeholder examples — do not publish these; replace them with real, permissioned quotes after launch:**

> „Finally an AI tool that gives me control instead of another dashboard."
> — HN user, [[link]]

> „The Lineage panel is what I wish every AI product would ship."
> — Reddit r/LocalLLaMA, [[link]]

> „Cinderpaw is what OpenAI would build if OpenAI weren't OpenAI."
> — X @[[handle]], [[link]]

**Below quotes, small trust bar:**

> [[GitHub stars badge]] · [[Downloads counter]] · [[Discord member count]]

---

## SECTION 7 — SHARED PROJECTS RESEARCH

**Header (h2):**

> Solo works now. Shared projects are next.

**Body:**

Cinderpaw is focused on the local, single-user experience first. We are researching how two people can work on the same project while each keeps their own agent, model, memory, and permissions.

The early list is for people who want to test identity, encrypted relay, permissions, conflict recovery, and export with real projects.

**Early-access card:**

- Small research cohorts
- Direct access to the founder
- Early product notes and test invitations
- No countdown or fake seat counter

[ Email input ] [ Join the Shared Projects research list ]

**Micro-copy:**

> [[current research-list count, only when real and timestamped]] people are following the build. Otherwise show: **Research invites open later.**

---

## SECTION 8 — WHY BSL, NOT MIT

**Header (h3, smaller than main sections):**

> Cinderpaw is source-available, not fully open source.

**Body:**

Source code is on GitHub. You can read it, patch it, fork it for personal use, self-host it. That's the software-freedom part.

You can't quietly repackage it as a hosted service and call that the original project. That's the anti-parasite part.

Every version becomes Apache 2.0 automatically four years after its release. That's in the license, it's not negotiable.

**Track the commitment:**
> Read [PROMISES.md](https://github.com/bloom500/cinderpaw/blob/main/PROMISES.md) and the git history.

---

## SECTION 9 — PROOF BEFORE PROMISES

**Header (h2):**

> Show the receipts.

**Body:**

Before launch, show the current release, GitHub activity, test status, real product screenshots, and a link to the source. After launch, add permissioned quotes with direct links.

Do not publish placeholder testimonials, unverifiable metrics, or a feature screenshot that is not labeled **Available now**, **Design preview**, or **Planned**.

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

> Download Cinderpaw. Free for solo. Works offline. Source-available. No account.

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
- Shared Projects
- Early access
- Contact

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
<title>Cinderpaw — The AI that finishes the job</title>
<meta name="description" content="A source-available desktop AI that runs on your machine. Use local models or your own API keys, keep memory on disk, and inspect how agents evolve. Shared Projects are in research." />
<meta property="og:title" content="Cinderpaw — The AI that finishes the job" />
<meta property="og:description" content="Their business model rewards another prompt. Cinderpaw runs locally, keeps your memory yours, and makes agent evolution inspectable. Shared Projects are in research." />
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

## 10/10 CONVERSION GUARDRAILS

- **Use one primary CTA per viewport.** Download is for solo visitors; the research-list signup is for Shared Projects. Do not make both look like the same action.
- **Use real scarcity only.** The constraint is founder attention, so research invites stay small. No fake countdown, fake seat counter, or unverifiable list total.
- **Put status beside every ambitious feature.** Label features **Available now**, **Design preview**, or **Planned for [version/date]**. Especially Lineage, Cemetery, autonomous evolution, and any screenshot that is not in the released build.
- **Put evidence beside controversy.** Link the source, relevant ADRs, a reproducible demo, and the dated comparison snapshot. Say „incentive pressure can" instead of claiming to know a company's private objective function.
- **Never say open source for BSL 1.1.** Use **source-available** until the documented Apache 2.0 conversion.
- **Replace social-proof placeholders with real proof.** GitHub activity, release version, test status, real screenshots, and permissioned user quotes beat invented testimonials every time.

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

1. **A/B test headline:** current is „Their business model rewards another prompt. Cinderpaw is built to finish the job." vs alternative „Your AI. Your machine. Your rules." — see which converts better on Download.
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
> **Hosted AI keeps you coming back. Cinderpaw helps finish the job.**

If you have 20 words:
> **Local-first desktop AI with your models, your memory, and inspectable agent evolution. Shared Projects are in research.**

If you have 40 words:
> **Cinderpaw is a source-available desktop AI that runs on your machine. Use local models or your own cloud keys. Keep memory on disk, evaluate agents against your work, and inspect the mutations that survive. Shared Projects are in research.**
