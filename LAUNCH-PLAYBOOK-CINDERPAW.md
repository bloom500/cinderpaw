# LAUNCH-PLAYBOOK-CINDERPAW.md

**Owner:** Darius (Bloom Media)
**Product:** Cinderpaw (rebrand din Feral) — the AI workspace that runs on your machine (solo now, multiplayer in 2027)
**Day 0 propus:** **Marți 26 August 2026**
**Ora ancoră:** 8:00 AM ET (US-East) = **15:00 EEST (România)** ← tot documentul folosește ora RO
**Timp local user:** UTC+3 (EEST, DST activ până 25 oct 2026)

> **Update 2026-08-21 per STRATEGY-PIVOT.md:** Poziționare updated de la „local AI companion" la „multiplayer AI workspace, solo tier free forever". Toate copy-urile din acest playbook au fost updated să includă (a) mențiune subtilă despre multiplayer coming 2027, (b) link waitlist pentru Cinderpaw for Teams, (c) `$5000/mo → Apache 2.0` commit public. Vezi STRATEGY-PIVOT.md pentru context complet.

---

## De ce marți 26 aug 2026 la 15:00 RO

- **Marți** — clasic pentru Show HN. Luni e coffee-catchup + spam email; miercuri-joi conțin release cycle-uri corporate care fură atenția; vineri = dead zone. Marți = high-quality attention window.
- **8 AM ET / 15:00 RO** — HN front page turnover începe ~9 AM ET. Publicat la 8 AM îți dă 1h să acumulezi upvotes calitative înainte de peak traffic, când poziția la #1 se decide.
- **Iulie-august sunt slow news months** — mai puțină competiție pentru atenție decât septembrie (când toată lumea revine din vacanță și lansează).
- **Post-DST-considerations:** USA încă e în DST pe 26 aug, RO la fel — diferența e fixă 7h. Dacă amâni post 2 nov 2026, USA iese din DST → devine 8h → mută launch la 14:00 RO.

**Alternative timing dacă marți 26 aug nu-ți convine:**
- Marți 2 sept 2026 — după Labor Day US, dar risc: prima săptămână de școală, atenție dispersată
- Marți 9 sept 2026 — safe, dar deja intri în release cycle-uri de toamnă
- Joi 28 aug 2026 — al doilea cel mai bun day pentru HN, ok dacă marți e prea agresiv

---

## D-5 până la D0 — TIMELINE PRE-LAUNCH (începe azi, 21 aug)

### **D-5 · Joi 21 aug 2026** ← AZI

- [ ] **Confirmă rename-ul complet Feral → Cinderpaw în cod** (RENAME-PLAN.md fazele 1-2 minim: `productName`, `<title>`, sidebar wordmark, splash screen)
- [ ] **Domain cumpărat:** `cinderpaw.dev` la Porkbun (~$9.73/an, `.ai` prea scump)
- [ ] **Domain redirect setup:** dacă `feral.ai` există, adaugă 301 permanent redirect către `cinderpaw.dev` pentru toate rutele
- [ ] **GitHub org/repo rename:** `bloom500/feral` → `bloom500/cinderpaw`. GitHub păstrează redirect automat pentru URL-uri vechi (linkuri, clone-uri, forks), dar release download URLs vechi din CLI se rup — vezi secțiunea "npm/Cargo publish" mai jos
- [ ] **Cont X (Twitter):** creează sau redenumește `@cinderpaw_ai` (păstrează `@BloomMedia66730` ca personal). Dacă handle-ul e liber, ia-l ACUM înainte de squatteri.
- [ ] **Reserve Reddit account name:** `u/cinderpaw_ai` (crează cont dacă nu există, chiar dacă nu postezi de pe el — evită impersonators post-launch)
- [ ] **GitHub Sponsors application** — https://github.com/sponsors/apply — aprobare durează 5-10 zile, aplică AZI ca să fie live pentru launch. Tiere: $5, $15, $50, $150 lunar + one-time $10, $50, $200. Descriere: „Solo dev on Cinderpaw. Your sponsorship keeps me shipping instead of job-hunting."
- [ ] **Loops.so waitlist setup** — https://loops.so, free până 1k subscribers. Creează list „Cinderpaw for Teams waitlist". Setează welcome email + nurture cadence per STRATEGY-PIVOT.md
- [ ] **Ko-fi backup** — https://ko-fi.com — instant setup ca fallback până GitHub Sponsors se aprobă
- [ ] **Push PROMISES.md + STRATEGY-PIVOT.md + ADR-0017 + ADR-0018 pe branch** (deja fost făcut de agent 2026-08-21)

### **D-4 · Vineri 22 aug 2026**

- [ ] **Blog post 1 draft** — „Introducing Cinderpaw (formerly Feral): why we rebranded and what's next". ~1200-1800 cuvinte. Vezi copy schelet la secțiunea "Blog post 1" mai jos.
- [ ] **Blog post 2 draft** — „I audited my own AI companion in 10 rounds. Here's what I found." (opțional pentru launch day, poate merge D+3). ~2000 cuvinte, tehnic, honest, cu numărul real de findings reale vs false (170 din 259).
- [ ] **Screenshots refresh:** toate `.png`-urile din `frontend-react/public/READMEdemo*.png` regenerate cu splash + UI Cinderpaw (nu Feral)
- [ ] **README rebrand:** înlocuiește `Feral` cu `Cinderpaw`, update download URLs, actualizează install one-liner (`curl … cinderpaw/main/scripts/install.sh`)
- [ ] **Press-kit folder** creat în repo la `.github/press/`: logo PNG (transparent + solid bg), 4 screenshots, boilerplate 100/200/500 cuvinte, quotes, contact

### **D-3 · Sâmbătă 23 aug 2026**

- [ ] **Landing page cinderpaw.dev** — deploy final. Vezi secțiunea "Landing page Nuxt" pentru copy complet, inclusiv secțiune „Cinderpaw for Teams" cu Loops.so form embedded
- [ ] **`/teams` route dedicată** cu waitlist form prominent + pricing tiers ($12 Duo, $8 Team, $16 Business) + explicație „coordination not tokens"
- [ ] **`/promises` route** care afișează PROMISES.md ca HTML — trust anchor vizibil
- [ ] **Product Hunt asset prep:**
  - Gallery: 3-6 images, prima e "hero" (Cinderpaw UI cu splash sweep captured mid-frame)
  - Video 30-60s opțional (nu obligatoriu, dar boostează CTR ~40%)
  - Tagline: max 60 caractere
  - Description: max 260 caractere
  - First comment (maker's) — vezi copy jos
- [ ] **HN post drafted final** — text SALVAT într-un fișier local, NU submit
- [ ] **Reddit posts drafted final** — 8 draft-uri separate, TAILORED per subreddit (nu copy-paste)
- [ ] **Twitter thread drafted** — 8-12 tweets, screenshots la tweet-urile 1, 3, 6
- [ ] **Indie Hackers post drafted**
- [ ] **Discord announcement stage prepared** (dacă ai channel live cu Cubby/Paw deja)

### **D-2 · Duminică 24 aug 2026**

- [ ] **Install flow smoke test end-to-end** pe Windows + macOS + Linux
- [ ] **npm publish `cinderpaw-agent`** (dacă nume păstrat `feral-agent` deprecated, publish stub cu README care redirectează)
- [ ] **Cargo publish `cinderpaw-core`, `cinderpaw-cli`** (aceeași pattern)
- [ ] **GitHub Release draft** cu changelog complet + assets attached (nu publish yet)
- [ ] **DM 5-10 influencers/friends** cu heads-up: "Marți dimineață lansez, poți face un boost? Linkul principal e cinderpaw.dev" — dar NU cere upvotes explicit (asta e HN/Reddit auto-ban).
- [ ] **Test emergency hotfix flow:** dacă apare bug critic în primele 4h post-launch, cât durează un rebuild + release? Măsoară.

### **D-1 · Luni 25 aug 2026**

- [ ] **Rest / prep mental** — nu adăuga features
- [ ] **Ultimul smoke test:** download production build, install fresh, first-run flow, first message trimis
- [ ] **Rezervă slotul Product Hunt** pentru marți (login PH, mergi la Ship, schedule launch — asta se poate face cu ~24h în avans)
- [ ] **Verifică că GitHub Releases page nu are draft-uri "leaked"** (marketing e ratat dacă cineva vede v1.0 înainte de anunț)
- [ ] **Salvează local toate copy-urile de post** într-un folder, în caz de internet drop marți
- [ ] **Culcă-te devreme.** Marți începi la 14:30 RO minimum, ai 12+ ore de reply comments in fața ta.

---

## D0 — MARȚI 26 AUG 2026 — SCHEDULE MINUT-CU-MINUT (ora RO)

**Regulă generală:** ești la calculator de la **14:30 RO** cu absolut totul deschis: draft-urile în tab-uri separate, screenshot-urile la mână, browser productiv (nu Twitter deschis să te distragă), o cană cu apă. Nu mâncare heavy — creierul îți trebuie clean pentru primele 4-6h de reply.

### **14:00 RO** — Warm-up

- [ ] Deschide toate tab-urile: HN new-post form (nesubmit), Twitter, Reddit new-post pentru fiecare din cele 8 sub-uri, Product Hunt, Indie Hackers, Discord admin
- [ ] Verifică că landing page-ul cinderpaw.dev încarcă corect pe mobile + desktop
- [ ] Verifică că GitHub Release download links merg
- [ ] Deschide un doc scratch pentru a nota comments interesante și feedback de urmărit

### **15:00 RO (8:00 AM ET)** — GO TIME

- [ ] **BLOG POST published** la `blog.cinderpaw.dev/introducing-cinderpaw` (canonical URL — este linkul pe care îl vor share alții)
- [ ] **GitHub Release publish** (v1.0 sau versiunea actuală renamed, cu titlu "Cinderpaw v1.0 — the rebrand release")

### **15:05 RO (8:05 AM ET)** — HN Show HN submit

- [ ] Submit HN post (vezi copy jos, secțiunea "HN Show HN")
- [ ] IMEDIAT după submit: NU cere friends să upvoteze. HN detectează vote-rings, ban.
- [ ] Poți însă tu personal să upvotezi propriul submit (auto-upvote implicit — nu conteaza)

### **15:10 RO (8:10 AM ET)** — Twitter thread published

- [ ] Publish X thread de pe `@cinderpaw_ai` (thread principal)
- [ ] Retweet de pe `@BloomMedia66730` (personal) cu comment scurt de tip "founder note"
- [ ] Pin thread-ul pe profil `@cinderpaw_ai`

### **15:15 RO (8:15 AM ET)** — Discord announcement

- [ ] Post în `#announcements` cu link-uri: blog, GitHub, HN, PH
- [ ] Anunț în stage (dacă ai channel voice) sau embed text
- [ ] Cubby/Paw bots pot fi setați să facă un auto-message de tip "🎉 Cinderpaw v1.0 is live!" cu link-uri

### **15:30 RO (8:30 AM ET)** — Reddit posts

Postezi la interval de 5-8 minute între ele (nu simultan — Reddit anti-spam flags conturi care post-and-run pe multiple subs în 60s):

- [ ] **15:30 RO** — `r/LocalLLaMA` (post principal, mai tehnic — vezi copy)
- [ ] **15:38 RO** — `r/selfhosted`
- [ ] **15:46 RO** — `r/opensource`
- [ ] **15:54 RO** — `r/programming`
- [ ] **16:02 RO** — `r/artificial`
- [ ] **16:10 RO** — `r/singularity`
- [ ] **16:18 RO** — `r/OpenSourceAI`
- [ ] **16:26 RO** — `r/aitools`

### **16:00 RO (9:00 AM ET)** — Product Hunt launch initiated

- [ ] Publish PH launch (dacă ai schedule-uit D-1 la fereastra 12:01 AM PT, oricum e live de la 09:01 RO — dar tu ești activ pe comments de la 16:00)
- [ ] Post first-comment (maker's comment) — vezi copy
- [ ] Reply first 5-10 comments personal, warm

### **16:30 RO (9:30 AM ET)** — Indie Hackers post

- [ ] Publish post pe indiehackers.com/post — vezi copy
- [ ] Cross-post pe IH Twitter tag `#buildinpublic`

### **16:30 RO în avans → 22:00 RO** — REPLY MODE

**Ăsta e cel mai important interval.** Aici se decide dacă lansarea prinde sau moare la #47 pe HN.

- Refresh HN la 5 min. Reply la fiecare comment în 15 min max. Ton: warm, tehnic, honest — dacă cineva găsește un bug, thank + fix path clear, nu defensiv.
- Refresh Reddit la 10 min pe fiecare sub. Reply substantiv, nu one-liner.
- PH — reply și dai upvote la comments (upvoting comments != vote-ring, e ok).
- Twitter — QT-uri, reply-uri la cine boostează. NU begging pentru RT-uri.
- Discord — welcome noi joiners, DM oferi help dacă vezi confusion.

**Rules for replies:**
- NU spune "great question!" — spam, distruge trust.
- Dacă cineva critică, întâi validate (`"You're right — the mascot animations were a placeholder from Feral days"`), apoi contextualize sau fix.
- Dacă cineva compare cu Ollama/LM Studio/etc — validate diferența ("Ollama is CLI-first, Cinderpaw is app-first with memory + tools"). NU trash competitors.
- Dacă cineva descoperă un bug legit, spune "opened issue #XX, fix targeted for v1.0.1 this week" — și chiar deschide issue-ul pe loc.

### **22:00 RO (15:00 ET)** — Mid-day checkpoint

- [ ] Screenshot HN ranking (pentru later blog post)
- [ ] Ia o pauză de 30 min. Mănâncă. Hidratează-te.
- [ ] Verifică GitHub Issues surge — dacă >5 bug reports serioase, activează hotfix mode

### **22:30 RO — 02:00 RO** — Evening US wave

- Peak US-Central + US-West traffic e acum pe HN
- Reply la comments noi, dar poți reduce frecvența la 15 min refresh
- Twitter engagement peak US e 19:00-22:00 ET = 02:00-05:00 RO. Nu stai treaz pentru asta, dar programează un follow-up tweet la 03:00 RO cu ce ai învățat din prima zi

### **02:00 RO** — Culcă-te.

Absolut. Nu, serios. Restul lumii merge mai departe, ai 24h + 6 zile de post-launch. Sleep deprivation = tone-deaf replies = disaster.

---

## D+1 până D+7 — POST-LAUNCH TIMELINE

### **D+1 · Miercuri 27 aug**

- Continuă reply-uri pe HN (thread mai este activ 24-36h)
- Publish Product Hunt daily digest push (dacă a fost în top 5, PH email-uri autotrimit către subscribers noi)
- Blog post 2 published: "The 10-round self-audit" (dacă gata) — cross-post pe r/programming, HN nu (nu spami HN cu al doilea post în 48h)
- GitHub issue triage: label + assign priority

### **D+2 · Joi 28 aug**

- **Hotfix window:** dacă apar >3 bug reports serioase → build + release v1.0.1
- Twitter: retweet cele mai interesante user-uses / community mentions
- Reddit r/LocalLLaMA follow-up comment în post-ul principal cu "Update — v1.0.1 shipped based on your feedback (fixes X, Y)"

### **D+3 · Vineri 29 aug — SPECIES AGI RESPONSE WAVE**

**Ora ancoră:** publish 15:00 RO (8:00 AM ET, aceeași fereastră ca launch marți — HN cadence optim)

- **15:00 RO** — Blog post 002 „The AI You Have Is Trying to Keep You" LIVE la blog.cinderpaw.dev/species-agi-response (draft complet în `docs/blog/002-species-agi-response.md`)
- **15:30 RO** — X thread QT pe video Species AGI (7 tweets, draft în `docs/social/species-agi-response-threads.md`)
- **17:30 RO** — Reddit r/singularity top-level comment pe thread-ul video-ului (verifică că există; dacă nu, aștepți — cineva îl va cross-posta cu 179k views)
- **D+4 sâmbătă 30 aug** — Reddit r/artificial self-post separat DACĂ engagement pe r/singularity a fost solid (>50 upvotes comment)
- **D+5 duminică 31 aug** — DM Drew Spartz (autor video) cu thank you + link blog. Nu ceri platforming, doar courtesy. Dacă QT, win.
- **D+6 luni 1 sep** — LinkedIn article „The economic reason your AI is designed to keep you engaged" publicat 09:00 RO (peak US-East professional feed)

**Framing rules (STRICT):**
- ❌ NU „safer AI" / „ethical AI" / „aligned AI"
- ✅ „No retention pressure structurally possible"
- ✅ Attack incentive structure, NU companies sau angajați
- ✅ Named references la documented harms (OpenClaw credit cards, Cursor prod deletions) susținute cu link-uri

**Weekly blog post 3 (planificat original pentru D+3) se decalează la D+10 vineri 5 sep** — „Week 1 numbers" reține pattern-ul weekly cu shift 1 săptămână.

### **D+7 · Marți 2 sept**

- Thank-you thread pe X: summary feedback themes + shoutout la top contributors
- HN Ask HN opțional: "Ask HN: How did your first product launch go? Here's mine." (dacă vrei să extragi network effect din launch story)
- Retrospective internă: ce a mers, ce nu, adjust pentru release-uri viitoare

---

## COPY REAL PENTRU FIECARE CANAL

### **HN Show HN — post principal**

**Title (max 80 chars, exact format „Show HN: <name> — <one-liner>"):**

```
Show HN: Cinderpaw – AI workspace that runs on your machine; multiplayer coming 2027
```

**URL field:** `https://cinderpaw.dev`

**Text field (max ~2000 chars, keep tight):**

```
Hey HN — I'm Darius, solo dev on Cinderpaw (previously Feral).

Cinderpaw is a desktop app for having an AI workspace on your machine.
Chat + agents + memory + tools, running local GGUF models via llama.cpp
OR your own cloud API keys (BYOK, direct to Anthropic/OpenAI/etc,
no proxy). Solo tier is free forever, no account required.

What v1.0 today has:
- Chat with local or cloud models, same UI
- Agent runtime with memory + tool-use (file ops, web search, MCP servers)
- Multi-step deep research with parallel sub-agents
- Skills / extensions system
- Pixel-art mascot that reacts to what the agent's doing

What's coming (upfront so nothing's a surprise):
- v1.1 Nov 2026 — personal agent teams (Researcher, Coder, Writer). Free.
- v1.2 Feb 2027 — SHARED PROJECTS: work with someone else on the same
  project, each of you brings own AI. This is the first paid tier
  ($12/mo Duo, $8/user/mo Team). Solo stays free forever.
- v1.5 Q3 2027 — public agent feed (opt-in, free forever).

Business model plain-spoken: solo local single-user free forever, we
monetize coordination between users (shared projects) once we build
the server infrastructure for it. Not paywalling anything you have
today, ever. Written commitments in PROMISES.md in the repo.

Built with Tauri 2 + Rust + TypeScript + React. BSL 1.1 (converts to
Apache 2.0 automatically after 4 years, OR immediately if we hit
$5k/mo recurring). Windows, macOS, Linux.

Pre-launch I did a 10-round self-audit — 259 findings, ~170 real, all
patched. Blog post about that tomorrow.

Happy to answer on architecture, why BSL vs MIT, memory system, or
how I'm planning to run shared projects without ever hosting inference.

Download: https://cinderpaw.dev/download
Source: https://github.com/bloom500/cinderpaw
Teams waitlist: https://cinderpaw.dev/teams
```

**Notă:** *NU* întreba pentru upvotes. *NU* posta din 2 conturi să pară „momentum". *NU* edita title-ul după 5 min. *NU* posta între 3 AM și 6 AM ET (dead zone).

---

### **Twitter/X thread (thread principal de pe `@cinderpaw_ai`)**

**Tweet 1 (hook — cel mai important, decide dacă cineva citește restul):**

> After a year of building in the open under the name "Feral", today I'm shipping v1.0 under a new name: **Cinderpaw.**
>
> An AI workspace that runs on your machine. Solo tier free forever. Multiplayer coming in 2027.
>
> [screenshot: splash screen mid-sweep + main UI stacked]
>
> 🧵

**Tweet 2:**

> The pitch:
>
> → Chat with local LLMs (GGUF via llama.cpp) or cloud models (BYOK — your key, your bill)
> → Full agent runtime: memory, tool-use, MCP servers, sandbox
> → Multi-step deep research
> → Extensible via skills / connectors
> → Windows, macOS, Linux

**Tweet 3:**

> Why local-first matters:
>
> Your conversations don't cross the internet. Your prompts don't feed anyone's training set. Your API bill is $0 if you have a laptop that runs a 7B model — and most laptops made after 2021 do.
>
> [screenshot: local model download UI]

**Tweet 4:**

> Why BYOK for cloud:
>
> When you need Claude Sonnet or GPT-5 for the hard problems, you paste your API key and Cinderpaw talks to Anthropic / OpenAI directly. There's no proxy. There's no wrapper markup. It's the cheapest possible way to use frontier models.

**Tweet 5:**

> Why the rebrand:
>
> "Feral" was fine but confusing (there's a game studio) and impossible to trademark. "Cinderpaw" is unique, ownable, and fits the mascot — a little creature with a warm orange belly that lives on the composer and reacts to what the agent is doing.
>
> [screenshot: mascot in 4 states]

**Tweet 6:**

> Built with Tauri 2 + Rust for the shell and TypeScript / React for the UI. The agent runtime is a separate sidecar so you can update the brain without reinstalling.
>
> Source: github.com/bloom500/cinderpaw
> License: BSL 1.1 (source open, commercial hosting requires a chat)

**Tweet 7:**

> Before launching I did a 10-round self-audit — 259 findings, ~170 real. Fixed them all. Ran the whole audit through a second LLM as adversarial review. Blog post on that tomorrow.
>
> Nothing about this is "vibe-coded and shipped". It's ~11 months of dogfooding.

**Tweet 8:**

> Where to start:
>
> → App: cinderpaw.dev (Windows / macOS / Linux)
> → CLI only: `npm install -g cinderpaw-agent`
> → From source: github.com/bloom500/cinderpaw
> → Roadmap: cinderpaw.dev/roadmap
> → Discord: cinderpaw.dev/discord

**Tweet 9 (CTA soft — no beg):**

> If you try it and something breaks, please open an issue. If you try it and it works, let me know — I'm one person and every DM from someone who actually uses this thing keeps me going.
>
> Also here on this account: @cinderpaw_ai
>
> Founder posting: @BloomMedia66730

**Tweet 10 (optional — social proof / transparency):**

> Full transparency: v1.0 is not "complete". It's the version I'd give a friend without embarrassment. Personal agent teams (v1.1 Nov 2026), Shared Projects — the first paid tier (v1.2 Feb 2027), and public agent feed (v1.5 Q3 2027) are all on the roadmap.
>
> What you can help with: bug reports, use-cases I haven't thought of, and honest feedback.

**Tweet 11 (business model transparency — anti-bait-and-switch preempt):**

> Business model, plain-spoken: solo tier stays free forever, no account, no telemetry. First paid tier is Shared Projects (v1.2, Feb 2027) — work with a friend on the same project, each of you brings your own AI. We host the coordination server, we don't ever run inference.
>
> $12/mo Duo (2 users), $8/user/mo Team. Full commitments in PROMISES.md in the repo.
>
> Waitlist: cinderpaw.dev/teams — 50% off first 3 months for early signups.

---

### **Reddit — r/LocalLLaMA post (250k members — cel mai tehnic)**

**Title:**
```
[Release] Cinderpaw v1.0 — local-first desktop app for GGUF models with agent runtime, memory, tools (rebrand of Feral)
```

**Body:**

```
Hi r/LocalLLaMA,

I've been building an open-source desktop app for running local LLMs
with a full agent runtime. Today shipping v1.0 under a new name
(rebranded from "Feral" to "Cinderpaw").

**What it is:**
- Tauri 2 shell + llama.cpp sidecar for GGUF inference
- Rust backend, TypeScript agent runtime, React UI
- Cross-platform (Windows, macOS, Linux)
- Both local (GGUF) and cloud (BYOK for OpenAI/Anthropic/Gemini/etc)
  in the same UI

**Why it might interest this sub:**
- Runs *actually offline* — no telemetry, no phone-home, no analytics
- BSL 1.1 (source open, commercial re-hosting requires talking to me)
- Bundled agent runtime with memory + tool-use, not just a chat wrapper
- Fractal Memory Search for long-context recall over past conversations
- Sandbox for tool execution (MCP protocol supported)
- No account, no login, no cloud sync unless you opt into it

**What v1.0 does NOT have (yet):**
- Multi-agent team orchestration (v1.1, ~Nov 2026)
- Voice mode (v1.2, ~Jan 2027)
- Cross-user community feature (v1.3, ~Q3 2027)

**Tech notes some of you will care about:**
- llama.cpp version pinned, CUDA + Metal + ROCm builds
- Context management via a 4-tier memory stack (recent, session,
  fractal-indexed long-term, persistent facts)
- Model swap without app restart
- Prompt template detection auto, override manual

Feedback welcome — especially: which models you'd want tested against
the memory pipeline, which platforms you'd want prioritized for perf
work, which MCP servers you'd want first-party support for.

**Links:**
- Download: https://cinderpaw.dev/download
- Source: https://github.com/bloom500/cinderpaw
- Discord: https://cinderpaw.dev/discord
```

---

### **Reddit — r/selfhosted (500k members)**

**Title:**
```
Cinderpaw v1.0 — self-hostable AI workspace (desktop app + headless CLI mode for VPS)
```

**Body:**

```
r/selfhosted, hi —

Cinderpaw is a local-first AI desktop app I've been building solo for
~11 months. Today shipping v1.0.

**Two install modes:**
1. **Desktop** (Windows, macOS, Linux with display) — full app with
   local model inference via llama.cpp
2. **Headless** (VPS / server) — CLI + gateway, no GPU or llama.cpp
   compile needed. Points at a cloud LLM (BYOK) or at a desktop
   Cinderpaw on your LAN.

**Self-hosting story:**
- No cloud dependency required
- No account required
- Data stored in `~/.cinderpaw/` (config, memory DB, models, keys)
- BSL 1.1 (source open, commercial re-hosting requires chatting with me)
- Discord/Slack connectors — expose your Cinderpaw as a bot in your own
  server, chat with it there

**Install one-liner (Linux/macOS):**
```
curl -fsSL https://cinderpaw.dev/install.sh | bash
```
Detects your platform. Force headless with `-- --headless`.

**Why I built it:**
Wanted a chat + agent that didn't require me to trust a startup's
promise-not-to-train-on-your-data. Local inference solves that. Cloud
BYOK solves the "but I want frontier quality sometimes" problem
without a proxy in between.

Roadmap: cinderpaw.dev/roadmap
Source: github.com/bloom500/cinderpaw
```

---

### **Reddit — r/opensource**

**Title:**
```
Cinderpaw v1.0 (BSL 1.1) — local-first AI desktop app, rebrand of Feral, source on GitHub
```

**Body:**

```
Released v1.0 of Cinderpaw today. Solo dev (Bloom Media), ~11 months
of work, rebranded from "Feral".

**Stack:** Tauri 2 + Rust + TypeScript + React
**License:** BSL 1.1 (source open, commercial re-hosting requires
opt-in; converts to Apache 2.0 after 4 years per BSL clause)

**Why not MIT/Apache:** I want a small business runway before someone
wraps this in a marketing site and charges $20/month. Source is
readable, patchable, forkable for personal use — commercial cloud
hosting is the only carve-out.

Happy to talk license choice, why Tauri over Electron, or contribution
workflow.

Source: https://github.com/bloom500/cinderpaw
CONTRIBUTING.md is honest about what I can review vs merge.
```

---

### **Reddit — r/programming**

**Title:**
```
I audited my own AI companion app in 10 rounds before launch. Found 259 issues (~170 real). Here's the release: Cinderpaw v1.0.
```

*(Reddit r/programming e mai skeptic la self-promo; framing-ul „audit story" e legit story, produsul e secundar)*

**Body:**

```
Solo dev shipping v1.0 of an open-source AI desktop app today. Before
the release I did what I've come to think of as an "adversarial
self-audit": treated my own codebase like it belonged to someone I
didn't trust.

**Process:**
- 10 rounds of static + flow analysis, ~259 findings total
- Ran the findings through a second LLM as adversarial review
- Result: ~170 findings real, ~25 false positives, ~20 self-retracted
  in the text, 4 with correct symptoms but wrong fixes
- Patched everything real, wrote up the lessons

**Interesting takeaways for anyone thinking about self-review:**
1. LLM auditors are better at trust-boundary reasoning than at
   time-behavior reasoning. Cross-language boundary bugs (Rust/TS)
   were caught. Cron scheduler that never fired at all was missed.
2. Roughly 2/3 signal-to-noise. Useful as prompt for review, dangerous
   as a task list.
3. Visual/UI findings need actual rendering — 3 mascot findings I
   accepted were wrong because I didn't open the effects file.

**The app itself:** Cinderpaw (formerly Feral). Local-first AI, GGUF
models, BYOK cloud, agent runtime with memory + tools. Tauri 2 + Rust.
BSL 1.1.

- Blog post with full audit numbers: https://blog.cinderpaw.dev/audit-story
- App: https://cinderpaw.dev
- Source: https://github.com/bloom500/cinderpaw
```

---

### **Reddit — r/artificial**

**Title:**
```
Cinderpaw v1.0 released — local AI desktop app with agent runtime, memory, and tool-use
```

**Body:**

```
Shipping v1.0 of Cinderpaw today — a local-first AI desktop app for
running language models on your own hardware, with a full agent
runtime (memory, tool-use, sandboxed execution).

**What sets it apart from just running Ollama or LM Studio:**
- Persistent memory across conversations (Fractal Memory Search)
- Agent mode with tool-calling loop, not just chat
- MCP protocol support for adding third-party tools
- Same UI for local (GGUF) and cloud (BYOK) models
- Desktop-native (Tauri 2, not Electron)

**What it isn't:**
- Not a Claude / ChatGPT competitor at frontier quality — it's a
  client that lets you use frontier models (via your own API key) or
  local models (via GGUF), whichever fits the task
- Not free-of-cost for cloud usage — BYOK means you pay OpenAI /
  Anthropic / etc directly

Windows, macOS, Linux. Open source (BSL 1.1).

Rebranded from "Feral" — same team, better name.

https://cinderpaw.dev
```

---

### **Reddit — r/singularity**

**Title:**
```
[Project] Cinderpaw — local AI companion with memory + agent tools, released v1.0
```

**Body:**

```
Been building this solo for ~11 months. Released v1.0 today.

Cinderpaw is a desktop app for having an AI companion that:
- Runs locally on your machine (GGUF via llama.cpp), so no cloud
  middleman
- Or connects to frontier models via your own API keys (no proxy)
- Remembers previous conversations (Fractal Memory Search over local
  DB)
- Has an agent runtime with tools — file ops, web search, code
  execution in sandbox
- Doesn't send telemetry, doesn't require an account

Interesting angle for this sub: the memory system is what makes it
feel like "a companion" rather than "a chat window that resets". It
retrieves relevant past exchanges when relevant, and there's a
Fractal Memory Search index that runs locally.

Also: mascot. Small pixel-art creature that reacts to what the agent
is doing. Not just decoration — it's the ambient signal that the
agent is thinking / calling tools / done.

https://cinderpaw.dev
https://github.com/bloom500/cinderpaw
```

---

### **Reddit — r/OpenSourceAI**

**Title:**
```
Cinderpaw v1.0 — open-source local AI desktop app (BSL 1.1), agent runtime, self-audited pre-release
```

**Body:**

```
Solo dev release of v1.0. Cinderpaw is a local-first AI desktop app
with a full agent runtime.

Rebranded from "Feral". Source on GitHub, license BSL 1.1 (open source
for use / modification, commercial re-hosting requires opt-in).

Pre-launch process:
- 10 rounds of internal audit
- Adversarial LLM review of the findings
- ~170 real fixes patched
- No cloud sync required, no telemetry

Stack: Tauri 2 + Rust + TypeScript + React
Models: local GGUF via llama.cpp, or cloud via BYOK
Platforms: Windows / macOS / Linux

https://cinderpaw.dev
https://github.com/bloom500/cinderpaw

Would love feedback from folks who care about the licensing choices
too — happy to chat BSL vs AGPL vs source-available.
```

---

### **Reddit — r/aitools**

**Title:**
```
Cinderpaw — a local AI desktop app with agent tools (Windows/Mac/Linux)
```

**Body:**

```
Shipping v1.0 of Cinderpaw today — a desktop AI app that runs
locally, no subscription, no telemetry.

Features:
✅ Local models (GGUF via llama.cpp) — free to run once installed
✅ Cloud models via BYOK (OpenAI, Anthropic, Gemini, etc — your key)
✅ Agent mode with tool-use (files, web, code execution)
✅ Persistent memory across chats
✅ Skills / extensions system
✅ Windows, macOS, Linux

What it costs: $0 for local, whatever you pay your cloud provider
directly for cloud (no markup).

Open source. Rebranded from "Feral" this week.

https://cinderpaw.dev
```

---

### **Product Hunt**

**Tagline (60 chars):**
```
AI workspace on your machine. Solo free, multiplayer 2027.
```
(58 chars ✓)

**Description (260 chars):**
```
Cinderpaw is an AI workspace that runs on your machine. Chat, agents, memory, tools — with local GGUF models or your own cloud API keys. Solo tier free forever, no account. Shared Projects (paid, Feb 2027) let teams collaborate — you host the coordination.
```
(255 chars ✓)

**Topics/tags:** Artificial Intelligence, Developer Tools, Productivity, Open Source, Desktop Apps

**First comment (maker's — critical, shows up top):**

```
Hey Product Hunt 👋

I'm Darius, solo dev on Cinderpaw. Been building for ~11 months
under the name "Feral", rebranded to Cinderpaw this week for
v1.0.

The pitch: Cinderpaw is an AI workspace that runs on your machine.
Chat with local models (GGUF via llama.cpp) or cloud (BYOK — your
own API keys, direct to Anthropic/OpenAI/etc, no proxy). Agent
runtime with memory + tools. Cross-platform, no account required.

Solo tier is free forever. In February 2027 I'm launching Shared
Projects — the first paid tier — where two or more people can work
on the same project, each running their own agents. My server hosts
identity + relay + storage, but NEVER inference — you keep bringing
your own AI. That means my gross margin doesn't get eaten by tokens
as users grow. Structural advantage vs anyone who hosts inference.

Full commitments (what stays free forever, what might be paid) in
PROMISES.md in the repo.

Happy to answer on architecture, why BSL vs MIT, how the shared
projects economy works, or the memory system.

Download: https://cinderpaw.dev
Source: https://github.com/bloom500/cinderpaw
Teams waitlist: https://cinderpaw.dev/teams
```

---

### **Indie Hackers post**

**Title:**
```
Shipped v1.0 of my local AI desktop app today after 11 months. Rebranded mid-way. Here's the launch story.
```

**Body:**

```
Solo dev, 11 months, one product: Cinderpaw (previously Feral).

**What it is:** local-first AI desktop app. Chat with local GGUF models
or cloud models via BYOK. Full agent runtime with memory + tools.

**Numbers as of today:**
- 259 findings from self-audit, ~170 real, all patched
- 4 platforms supported (Windows, macOS, Linux, headless CLI)
- $0 spent on ads
- 0 employees
- 1 rebrand mid-way (Feral → Cinderpaw)
- 0 telemetry lines of code
- BSL 1.1 license (open source with commercial carve-out)

**What I'm doing at launch:**
- HN Show HN
- PH launch
- 8 subreddits (no karma limits)
- X thread
- Discord community (built around Cubby + Paw bots on our VPS)

**What's next:**
- Multi-agent teams (v1.1, ~Nov 2026)
- Voice mode (v1.2, ~Jan 2027)
- Cross-user community mesh (v1.3, ~Q3 2027)

**Honest struggles:**
- Building + marketing solo is brutal. Each fix means less time
  posting; each post means less time fixing.
- Naming was harder than expected — "Feral" seemed fine until I
  hit trademark issues.
- Self-audit was humbling. LLM adversarial review caught real
  issues I would have shipped.

Happy to chat business model (BYOK + eventual paid cloud tier),
Tauri vs Electron tradeoffs, or how I'd do it differently.

App: cinderpaw.dev
Source: github.com/bloom500/cinderpaw
```

---

### **Discord announcement (in `#announcements`)**

```
@everyone

🎉 **Cinderpaw v1.0 is live.**

After 11 months of building in the open (previously as "Feral"),
today is the release day.

**What's new in v1.0:**
- Full rebrand: Feral → Cinderpaw
- New splash screen with spotlight sweep animation
- Polished UI across chat, settings, models
- Multi-agent groundwork (activates in v1.1)
- ~170 fixes from pre-launch audit

**Where we're posting today:**
- Hacker News: https://news.ycombinator.com/...
- Product Hunt: https://producthunt.com/products/cinderpaw
- X thread: https://x.com/cinderpaw_ai/status/...
- Reddit: r/LocalLLaMA, r/selfhosted, r/opensource, r/programming,
  r/artificial, r/singularity, r/OpenSourceAI, r/aitools
- Indie Hackers: https://indiehackers.com/post/...

**How you can help (only if you want to):**
- Try v1.0, tell me what breaks
- Share the HN/PH link with someone who'd care
- Leave an honest review

Cubby and Paw are here for questions in #help. I'll be replying to
comments across the internet all day — reply times might be slow,
but every message gets read.

Thanks for being here. This community was invited before there was
a landing page, and that meant a lot.

— Darius
```

---

### **Blog post 1 — „Introducing Cinderpaw"** (schelet + hook + outline)

Publicat la `blog.cinderpaw.dev/introducing-cinderpaw`

**Title:** `Introducing Cinderpaw — the AI desktop app formerly known as Feral`

**Meta description (155 chars):**
```
Cinderpaw is a local-first AI desktop app that runs on your machine. No subscription, no telemetry, no middleman. Rebranded from Feral. v1.0 out today.
```

**Hero image:** splash screen mid-sweep

**Outline (write ~1500 words):**

1. **The one-paragraph pitch.** What Cinderpaw is, in the voice you'd use talking to a friend.
2. **Why local-first, not cloud-first.** The trust story. What you don't have to trust.
3. **Why BYOK for cloud.** When frontier quality matters, use it — but pay Anthropic / OpenAI directly, no wrapper markup.
4. **The rebrand: why Feral → Cinderpaw.** Honest. Trademark concerns. Confusion with game studio. Better ownable name. Mascot fits.
5. **What v1.0 is (and isn't).** Feature list, honest about gaps.
6. **What's on the roadmap.** v1.1 multi-agents, v1.2 voice, v1.3 cross-user community.
7. **How to get it.** Download links. Install one-liner. CLI mode.
8. **What you can do that would help me.** Try it. Break it. Tell me. That's it.

**CTA end:** Download button + Discord link + GitHub link + X follow.

---

## LANDING PAGE cinderpaw.dev (Nuxt/Vue)

Nu am acces la repo-ul landing (îmi zici tu în sesiune viitoare unde e). Îți dau copy-ul complet pe secțiuni, ready-to-paste în componente Vue.

### **Hero section**

```
<h1>The AI workspace that runs on your machine.</h1>

<p class="subtitle">
  Chat, agents, memory, tools — with local models or your own
  cloud API keys. Solo tier free forever, no account. Shared
  Projects (paid, Feb 2027) let teams collaborate — you host
  the coordination, not the intelligence.
</p>

<div class="cta">
  <button primary>Download for [detected OS]</button>
  <a href="/teams">Get Teams waitlist →</a>
</div>

<p class="footnote">
  Free forever · Open source (BSL 1.1 → Apache 2.0) · Windows, macOS, Linux
</p>
```

**Visual:** screenshot main app UI cu Cinderpaw splash sweep pornit în background (parallax subtil).

### **Section 2 — „What Cinderpaw does"**

Grid 2×3 sau 3×2 cu iconuri lucide + short text:

- **💬 Chat with local models** — Run GGUF models via llama.cpp. Offline, private, unlimited.
- **☁️ Or cloud, your key** — Plug in OpenAI, Anthropic, Gemini. Your key, your bill, no proxy.
- **🧠 Agent runtime** — Memory across chats, tool-use, MCP servers, sandboxed execution.
- **🔬 Deep research** — Multi-step web research with subagents that work in parallel.
- **🎨 Skills & extensions** — Add capabilities. Cinderpaw learns your workflow.
- **🐾 Mascot** — Small joy. Reacts to what the agent is doing. Never in the way.

### **Section 3 — „Why local-first"**

```
<h2>Your data never leaves your computer.</h2>

<p>
  Every conversation, every file the agent touches, every memory it
  stores — stays on your machine. No cloud sync unless you opt in.
  No telemetry. No analytics. No "anonymized usage data."
</p>

<p>
  When you use frontier models via BYOK, Cinderpaw sends your
  request directly to the provider you chose. There's no proxy in
  between reading, logging, or transforming anything.
</p>
```

**Visual:** simple diagram — user's machine, arrow to local model (green box "on device"), separate arrow to cloud provider (blue box "your API key, direct").

### **Section 4 — „Built for developers"**

```
<h2>Made for the people who read the source before they install.</h2>

<ul>
  <li>Written in Rust (Tauri 2) + TypeScript + React</li>
  <li>Source on GitHub (BSL 1.1)</li>
  <li>MCP protocol supported for tool integration</li>
  <li>Sandboxed execution — the agent can't touch what you don't allow</li>
  <li>CLI mode for VPS / headless</li>
  <li>Extensions API for adding your own capabilities</li>
</ul>

<pre>
$ npm install -g cinderpaw-agent
$ cinderpaw setup
$ cinderpaw chat
</pre>
```

### **Section 5 — Social proof / trust signals**

Dacă nu ai încă testimonials, folosește:

- GitHub stars badge (auto-updates)
- "Version 1.0 — [date]" badge
- License badge (BSL 1.1)
- Platforms badge (Windows/macOS/Linux)

Post-launch, adaugă 3-4 quotes din HN / Reddit / X în această secțiune (screenshot forms sau text quotes cu link back).

### **Section 6 — Roadmap teaser + Teams waitlist**

```
<h2>Where we're going.</h2>

<div class="roadmap">
  <div class="release now">
    <h3>v1.0 · Today</h3>
    <p>Chat, agents, memory, tools, skills. Solo tier. Free forever.</p>
  </div>
  <div class="release">
    <h3>v1.1 · Nov 2026</h3>
    <p>Personal agent teams — Researcher, Coder, Writer. Free.</p>
  </div>
  <div class="release paid">
    <h3>v1.2 · Feb 2027 · FIRST PAID</h3>
    <p><strong>Shared Projects</strong> — work on the same project with someone else. Each brings own AI. From $12/mo.</p>
  </div>
  <div class="release">
    <h3>v1.5 · Q3 2027</h3>
    <p>Public agent feed — opt-in, free forever.</p>
  </div>
</div>

<a href="/roadmap">Full roadmap →</a>
<a href="/promises">Free-forever commitments →</a>
```

### **Section 6b — Cinderpaw for Teams waitlist (NEW SECTION per pivot)**

```
<section id="teams" class="teams-waitlist">
  <h2>Cinderpaw for Teams — Coming February 2027</h2>

  <p class="lead">
    Work on shared projects with people around the world. Everyone
    brings their own AI. Everyone stays local. Cinderpaw handles
    the sync — you don't pay for tokens.
  </p>

  <div class="pricing-cards">
    <div class="tier duo">
      <h3>Duo</h3>
      <p class="price">$12<span>/month flat</span></p>
      <ul>
        <li>2 users, 1 shared project</li>
        <li>5 GB E2E encrypted storage</li>
        <li>No account for peer</li>
        <li>Community support</li>
      </ul>
    </div>
    <div class="tier team recommended">
      <h3>Team</h3>
      <p class="price">$8<span>/user/month</span></p>
      <ul>
        <li>Unlimited users, unlimited projects</li>
        <li>50 GB storage per team</li>
        <li>SSO (Google, GitHub)</li>
        <li>Audit log</li>
        <li>Email support (48h SLA)</li>
      </ul>
    </div>
    <div class="tier business">
      <h3>Business</h3>
      <p class="price">$16<span>/user/month</span></p>
      <ul>
        <li>Everything in Team, plus</li>
        <li>SSO SAML</li>
        <li>GDPR data residency (EU/US)</li>
        <li>Priority support (24h SLA)</li>
        <li>500 GB storage</li>
      </ul>
    </div>
  </div>

  <div class="waitlist-form">
    <form action="https://app.loops.so/api/v1/lists/YOUR_LIST_ID" method="POST">
      <label>Get early access + 50% off first 3 months</label>
      <input type="email" name="email" placeholder="you@example.com" required />
      <button type="submit">Join waitlist</button>
    </form>
    <p class="reassurance">
      1 email at launch + occasional progress updates. No spam. Unsubscribe anytime.
    </p>
  </div>
</section>
```

### **Section 7 — Community + community CTAs**

```
<h2>Join us.</h2>

<div class="cta-grid">
  <a href="/discord" class="card">
    <h3>Discord</h3>
    <p>Meet Cubby and Paw. Ask questions, show off builds.</p>
  </a>
  <a href="https://github.com/bloom500/cinderpaw" class="card">
    <h3>GitHub</h3>
    <p>Read source, report issues, contribute.</p>
  </a>
  <a href="https://x.com/cinderpaw_ai" class="card">
    <h3>@cinderpaw_ai</h3>
    <p>Release news and dev notes.</p>
  </a>
</div>
```

### **Section 8 — Final CTA**

```
<h2>Ready?</h2>
<p>Download Cinderpaw. It's free. It runs on your machine. It doesn't ask for anything back.</p>
<button primary large>Download for [detected OS]</button>
<a href="/download">All platforms →</a>
```

### **Footer**

```
Cinderpaw v1.0 · Built by Bloom Media in Cluj, Romania
License: BSL 1.1
[Docs] [Blog] [Roadmap] [Changelog] [Privacy] [Contact]
[GitHub] [Discord] [X]
```

### **SEO / meta pentru cinderpaw.dev**

```html
<title>Cinderpaw — Local-first AI desktop app</title>
<meta name="description" content="Cinderpaw runs LLMs on your machine. Open source, no subscription, no telemetry. Windows, macOS, Linux." />
<meta property="og:title" content="Cinderpaw — Local-first AI desktop app" />
<meta property="og:description" content="Chat with local models or cloud via your own API keys. No proxy, no middleman. v1.0 out now." />
<meta property="og:image" content="https://cinderpaw.dev/og-image.png" />
<meta name="twitter:card" content="summary_large_image" />
```

### **feral.ai → cinderpaw.dev redirect (Nuxt/Cloudflare)**

Dacă `feral.ai` există separat, în Cloudflare Rules sau nuxt.config.ts:

```
301 permanent redirect: feral.ai/*  →  cinderpaw.dev/$1
```

Preserve path + query string. Test manual după deploy: `curl -I https://feral.ai/download` trebuie să returneze `301` cu `Location: https://cinderpaw.dev/download`.

---

## CV UPDATE — CHECKLIST

Nu am CV-ul tău, dar checklist de căutare & înlocuire:

- [ ] Titlu poziție: `Founder & Solo Developer, Feral` → `Founder & Solo Developer, Cinderpaw (formerly Feral)`
- [ ] Descriere proiect: înlocuiește toate `Feral` cu `Cinderpaw`, dar păstrează UN loc unde spui `Cinderpaw (formerly Feral)` — asta preserve continuitatea pentru recruiters care ar fi văzut Feral pe X sau GitHub anterior
- [ ] Link GitHub: `github.com/bloom500/feral` → `github.com/bloom500/cinderpaw`
- [ ] Link website: `feral.ai` → `cinderpaw.dev`
- [ ] X handle: dacă e listat, adaugă `@cinderpaw_ai` (produs) și păstrează `@BloomMedia66730` (personal)
- [ ] Description bullet-uri: verifică că nu ai text de tip "Built Feral, a local-first AI app" — asta rescrie ca "Built Cinderpaw (formerly Feral)"
- [ ] LinkedIn: același pattern, cu experience section update
- [ ] Portfolio site (dacă separat de cinderpaw.dev): update lint-uri și thumbnails
- [ ] Freelance profiles (Upwork, Toptal etc): dacă listezi produse, update

**Regulă:** primele 60 zile post-rebrand, folosește `Cinderpaw (formerly Feral)` peste tot. După asta, drop-uiește paranteza.

---

## SOCIAL MEDIA — CHECKLIST HANDOVER

**Conturi de creat / redenumit:**

| Platform | Handle recomandat | Status verific |
|---|---|---|
| X (Twitter) | `@cinderpaw_ai` | Verifică disponibilitate azi |
| GitHub org | `cinderpaw` sau păstrează `bloom500` cu repo `cinderpaw` | Repo rename fezabil, org rename mai complex |
| Reddit | `u/cinderpaw_ai` | Verifică |
| Discord | Server rename dacă existent | Owner-only setting |
| Product Hunt | Product page „Cinderpaw" | Creezi la launch |
| Indie Hackers | Profil produs „Cinderpaw" | Creezi la launch |
| npm | `cinderpaw-agent` scope | Verifică |
| Cargo | `cinderpaw-core`, `cinderpaw-cli` | Verifică |
| PyPI | `cinderpaw` (dacă ai plans Python) | Reserve chiar dacă nu folosești |

**Bio-uri social (identice pentru consistency):**

**X / Twitter (@cinderpaw_ai):**
```
Local-first AI desktop app. Your machine, your data, your rules. Open source (BSL 1.1). Windows / macOS / Linux. Built by @BloomMedia66730.
```
(159 chars — sub limita 160)

**X / Twitter (@BloomMedia66730 — personal, update bio):**
```
Solo dev @cinderpaw_ai — local-first AI desktop app. Building in public from Cluj 🇷🇴
```

**GitHub org description (dacă bloom500 → cinderpaw org, altfel repo description):**
```
Local-first AI desktop app. GGUF models + BYOK cloud + agent runtime with memory & tools. Rust + Tauri 2 + TypeScript. BSL 1.1.
```

**Reddit u/cinderpaw_ai bio:**
```
Official Cinderpaw account — local-first AI desktop app. Feedback welcome via GitHub issues.
```

**LinkedIn (personal, dacă postezi):**
```
Founder & solo developer, Cinderpaw (formerly Feral) — a local-first AI desktop app. Rust · TypeScript · Tauri 2 · llama.cpp. Building from Cluj-Napoca.
```

**Profile pictures / banners:**
- Toate conturile: profile pic = logo Cinderpaw (128×128 sau 400×400)
- Banner X / LinkedIn: 1500×500 (X) / 1584×396 (LinkedIn) — folosește splash screen mid-sweep ca hero, cu tagline lipit stânga-jos

---

## COORDONARE FINALĂ — CE FAC EU vs CE FACI TU

**Eu am livrat aici:**
- Timeline exact D-5 → D+7 cu ore locale RO
- Copy real pentru: HN, X thread, 8 Reddit posts, PH, Indie Hackers, Discord announcement, Blog post 1 outline
- Copy real landing page cinderpaw.dev pe secțiuni (paste-uibile în Vue components)
- Checklist CV + social media

**Tu execuți:**
- Domain / social media handles reserve (azi, urgent)
- Landing page implementation (Nuxt — ai codebase-ul separat)
- Blog post 1 write-up (folosește outline-ul, adaugă vocea ta)
- CV update (folosește checklist-ul)
- Discord bot / server rename (Cubby + Paw setup rămâne)

**Opus execută (paralel):**
- Rebrand code (RENAME-PLAN.md faze)
- Splash screen implementation (UI-FIXES-CINDERPAW.md)
- Chat empty state polish (UI-FIXES-CINDERPAW.md)

**Sesiuni viitoare — pot ajuta cu:**
- Ajustări copy după feedback
- Blog post 2 draft (audit story, dacă vrei help)
- Reply drafts pentru comments HN/Reddit care necesită gândire
- Follow-up posts D+7 și D+14
- Analiză metrics post-launch

---

## OBSERVAȚIE FINALĂ

Cel mai mare risc pe această lansare NU e că nu ai audience — ai construit pentru 11 luni, ai bază.

Cel mai mare risc e **tu, obosit, marți seara la 22:00 RO**, când vezi al 40-lea comment de tip „why not use Ollama?" și răspunzi tăios pentru că nu mai ai zahăr în sânge.

Prep-ul concret pentru asta:
- Mănâncă înainte de 15:00 RO
- Hidratează-te (apă, nu doar cafea)
- Pauză 30 min la 18:00 RO și 21:00 RO
- Culcă-te la 02:00 RO cel târziu
- **Draft-uiește 3-4 reply-uri template pentru cele mai probabile întrebări** (Ollama comparison, license BSL vs MIT, Electron vs Tauri, hardware requirements) — le adaptezi pe loc, dar nu le compui de la zero când ești obosit

Dacă cineva critică personal, nu tehnic — ignoră. Nu te răzbuni, nu explici, nu block-uiești public. Reply doar la substantiv.

Ai construit ceva bun. Marți doar deschide ușa și lasă lumea să intre.

— gata pentru launch.
