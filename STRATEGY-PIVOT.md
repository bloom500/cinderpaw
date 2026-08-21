# STRATEGY-PIVOT.md

**Data:** 2026-08-21
**Autor:** Darius (Bloom Media) + conversații cu Opus
**Status:** Approved — informs all downstream ADRs, README, landing, launch playbook
**Supersedes (partial):** ADR-0015 (personal team scope narrowed), ADR-0016 (community redefined as free social feed, monetization moved to Shared Projects)

---

## Rezumat executiv

Cinderpaw pivotează dintr-un „local AI companion cu community mesh optional" într-un **multiplayer AI workspace pentru echipe mici, cu single-user local free forever**.

Teza centrală formulată de Opus în discuția din 2026-08-21:

> **Vinzi coordonare, nu tokeni.**

Fiecare user aduce propriul inference (local GGUF sau cloud BYOK). Cinderpaw ține relay + storage + identity + permissions pentru shared projects. Marja brută stă la 95%+ pentru totdeauna, indiferent cât de mult muncește user-ul. Ăsta e MOAT-ul pe care niciun competitor care găzduiește inferență nu-l poate egala prin preț.

## De ce pivotăm

### Contextul care a declanșat

1. **Feedback direct al utilizatorului** (verbatim, 2026-08-21):
   > „Eu îmi găsesc un prieten în UK, eu fiind în România, și vrem să lucrăm pe același proiect, eu am agenții mei, el pe ai lui, prin Agent Community putem lucra împreună, la același proiect."

2. **Target de venit** (verbatim):
   > „$5000 pe lună și we good we gucci."

3. **Constrângere existențială:**
   > „Vreau să fac profit din Cinderpaw să nu mor de foame."

Sponsorship model pur (Simon Willison / Datasette) generează realist $500-2000/lună pentru un solo dev nou-lansat în anul 1. **NU ajunge la $5000/lună sub 18-24 luni** fără un vehicul de monetizare directă.

### Pattern-ul industry care validează

Fiecare tool serios de coordonare pentru echipe mici e paid: Linear ($10/user), Notion ($15/user), Slack ($8.75/user), Figma ($15/user). Utilizatorii SMB plătesc pentru coordonare pentru că economia funcționează. Ce NU plătesc: pentru chat cu AI singular (competiție cu Claude free tier, ChatGPT free tier, LM Studio, Ollama etc.).

**Poziționare cheie:** Cinderpaw NU concurează cu Ollama pe „chat with local models". Concurează cu Linear + Notion + Slack **plus AI native**, la marjă superioară pentru că nu plătește tokeni.

### Diferența cognitivă

- **Vechi (v1.0 „local AI companion"):** userul primar e individul; monetizare e sponsorships + commercial licenses ocazionale
- **Nou (v1.2+ „multiplayer AI workspace"):** userul primar e echipa de 2-10; monetizare e SaaS recurring pe seats

Single-user rămâne free forever, dar reframing: **e wedge-ul care aduce echipe, nu produsul final.**

---

## Pricing tiers (anchor pentru waitlist + landing)

| Tier | Preț | Cine plătește | Include |
|---|---|---|---|
| **Solo** | $0 forever | Nimeni | Local single-user, tot ce e azi în v1.0 + toate features viitoare non-multiplayer |
| **Duo** | $12/lună flat | Freelanceri, prieteni | Până la 2 users, 1 shared project activ, 5 GB E2E-encrypted storage, community support |
| **Team** | $8/user/lună | SMB, agenții mici | Nelimitat users, nelimitat projects, 50 GB storage per team, audit log, email support 48h SLA |
| **Business** | $16/user/lună | Companii serioase | Team + SSO (Google/GitHub/SAML) + GDPR data residency options (EU/US relay) + priority support 24h SLA + 500 GB storage |
| **Enterprise** | Contact | Regulated industries | Self-hosted relay option, air-gapped deployment support, custom SLA, dedicated engineer time, license commercială negociată |

### Margin math (de ce pricing-ul e sustenabil)

**Costs per Team tier de 5 users, lunar:**
- Relay bandwidth (WebSocket persistent conn × 5 users × avg 2 devices) = ~$0.15
- Storage 50 GB E2E-encrypted (S3-compatible) = ~$0.12
- Compute (relay coordination, zero inference) = ~$0.20
- Overhead (monitoring, backups, spam mitigation) = ~$0.05
- **Total cost per team: ~$0.52/lună**

**Revenue:** 5 users × $8 = $40/lună.
**Gross margin: 98.7%**.

Contrast cu concurentul care găzduiește inferență (Perplexity, Anthropic Enterprise, ChatGPT Team):
- Perplexity: 30-40% gross margin (dominated by token costs)
- Anthropic direct API resellers: 15-25% gross margin
- ChatGPT Team ($30/user): ~50% gross margin (OpenAI eats compute costs internally)

**Cinderpaw structural advantage:** margin nu scade cu utilizare. User care rulează 14h/zi vs user care intră o dată pe săptămână — cost identic pentru tine, deoarece inference-ul e la ei.

### Growth math realistic (Year 1-2 shared projects)

Assumptions:
- Launch v1.0 marți 26 aug 2026
- Launch v1.2 Shared Projects Beta februarie 2027 (6 luni development timp)
- Freemium conversion rate 1.5-3% (industry standard SMB SaaS 2026)

**Year 1 (aug 2026 → aug 2027):**
- Post-launch v1.0: 5,000-15,000 downloads în primele 60 zile (bazat pe HN + PH + 8 Reddit posts + rebrand narrative)
- Steady state Q4 2026: ~10,000 active users
- Q1 2027 la lansarea shared projects Beta: ~15,000 active users
- Conversion 2% în first 3 months post-Beta = 300 paying seats
- Mix estimated: 60% Duo ($12 × 180 users) + 40% Team ($8 × 120 users × avg 3 seats) = $2,160 + $2,880 = **$5,040 MRR at 3 months post-Beta**

**Year 2 (aug 2027 → aug 2028):**
- Active users: 40,000-80,000
- Conversion menținut 2%: 800-1600 paying seats
- MRR estimate: **$12,000-30,000 MRR = $144k-360k ARR**

**Compared to sponsorship-only path Year 1:**
- Realistic: $500-2,000 MRR sponsorship at 12 months
- **Shared Projects adds 2.5-25× revenue multiplier**

### Free tier promise (nu se schimbă niciodată)

Documentat public în README, landing, TOS:

> Solo tier rămâne gratis pentru totdeauna. Fără account required, fără email required, fără upsells în app, fără feature-uri retrase din free ca să te forțeze să faci upgrade. Când monetizezi echipe, echipele plătesc — nu individualii.

Această promisiune e **absolut critică** pentru credibilitatea narativei „local-first, no bait-and-switch". Fără ea, categoria HN/r/LocalLLaMA îți întoarce spatele instant.

---

## Arhitectura care face pivotul posibil

### Ce ține serverul (minim viabil)

Pentru shared projects, serverul Cinderpaw ține DOAR:

1. **Identity layer** — Ed25519 keypair per user, generat local first-launch. Public key = ID public. Zero passwords.
2. **Project membership graph** — cine e în ce project, cu ce permisiuni.
3. **Event relay** — WebSocket persistent, forwardează events criptate între device-urile membrilor. Server nu poate citi payload.
4. **Blob storage** — fișiere din workspace, criptate E2E (client-side, cu key derivat din project membership secret shared). Server vede bytes opac.
5. **Presence & notifications** — cine e online, cine ce a atins ultima dată.

**Ce serverul NU ține niciodată:**
- ❌ Inferență (rămâne pe device-urile useri-lor)
- ❌ Chat content plaintext
- ❌ File content plaintext
- ❌ API keys (BYOK)
- ❌ Personal memory (semantic, episodic — rămâne local per user)

### Sync layer principles

**Ordinea de dificultate (Opus, verbatim):**
1. **Conversations** — append-only log, se împacă singure cu Lamport clocks. Ușor.
2. **Project membership** — trivial CRUD.
3. **Fișiere workspace** — parte grea. Aici stă toată munca reală.

**Decizii de spec pentru v1.2 MVP:**
- Conversations: log append-only, order per Lamport clock, no CRDT needed
- Files: **last-write-wins cu vizibilitate** — banner „Andrei's agent modified this 30s ago". Nu CRDT în MVP. Yjs/Automerge amânat la v1.5.
- Presence: simple heartbeat, 30s TTL
- Notifications: push notification via relay + optional email digest pentru offline

### Model divergence (problema pe care Opus a scăpat-o)

**Scenariu:** User A (RO) folosește qwen2.5-32b local. User B (UK) folosește Claude Sonnet 4.6 cloud. Amândoi în același project.

**Consecință:** același context, output-uri stilistic diferite. „Refactor de la qwen, review de la Claude" produce fricțiune.

**Mitigare în v1.2:**
- Fiecare agent action carries `model_id` în metadata
- UI vizibil: „Refactored by Andrei (Claude Sonnet 4.6)" — user vede context-ul cognitiv al schimbării
- Handoff dialog când user preia work de la agent celuilalt: summary „user A's agent used qwen-32b, made these decisions with this reasoning"

**Nu impunem model uniformity.** Diversitatea de modele e un feature al arhitecturii „bring your own inference", nu un bug.

### Offline problem (Opus, verbatim)

**Scenariu:** El doarme (UK, 3AM), tu ceri (RO, 5AM) ceva ce ar trebui făcut de agent-ul lui.

**Decizie de produs (Opus a articulat cele 3 opțiuni, tu alegi):**

**Opțiunea A — Task queue până se trezește:** ce ceri lui, se stochează encrypted în relay. Când device-ul lui vine online, agent-ul primește task-ul și execută. **Recomandarea mea principală** — respectă „inferență la ei" cu zero excepții.

**Opțiunea B — „Always-on delegate device":** userul poate configura un device (VPS, Raspberry Pi, laptop mereu pornit) ca „agent runtime endpoint". Când device-ul lui principal doarme, delegate-ul rulează. **Opțiune Business tier** — feature vândut la $16/user.

**Opțiunea C — „Emergency you-run":** dacă marchezi task ca urgent, poți alege să rulezi tu agentul lui (folosind config-ul lui, dar cheia ta). **Rar acceptabil** — creează friction politică („de ce a plătit el pentru tokens?"). Amânat sau eliminat.

**Recomandare:** A default, B ca upsell Business, C skipped complet.

---

## Onboarding shared project (problema care ucide 90% SaaS multi-user)

### Duo tier — zero-account invite flow

Fluxul care merge (proven de Signal, Session, Keet):

1. User A creates shared project. UI: „Invite someone via link"
2. Cinderpaw generează link unic: `https://cinderpaw.dev/join/xB9k3Lm7pQr2` (16 caractere entropy, expires 7 days, single-use)
3. Link conține pairing token care wrap-uește:
   - Project ID
   - Ed25519 pairing challenge
   - Storage key hint
4. User B primește link (Discord, Signal, email — anywhere)
5. User B click link → dacă are Cinderpaw instalat, deep link `cinderpaw://join/xB9k3Lm7pQr2` deschide direct dialogul de acceptare
6. Dacă nu are Cinderpaw instalat, browser fallback la `cinderpaw.dev/join/xB9k3Lm7pQr2` cu:
   - „Someone invited you to a Cinderpaw project"
   - Download button prominent
   - Link deep păstrat în localStorage
   - Post-install first-launch: dialog automat „Accept invite from Darius?"
7. Accept → Ed25519 key exchange peer-to-peer via relay → project membership registered → sync starts

**Zero account server-side pentru Duo.** Payment (dacă e Duo Paid) e single-payer (creatorul projectului plătește). Peer nu are nevoie de cont.

### Team tier — accounts required, dar minimally

Team tier necesită real accounts pentru:
- Billing per seat
- Removing members (revoke pairing)
- Audit log (who did what)

Account = email + password OR OAuth (GitHub, Google) OR Ed25519-only login (cu passphrase backup).

**Principiu:** account există DOAR când plătești. Solo user rămâne accountless forever.

---

## Ordinea corectă de execuție (Opus, revizuit)

### Release cadence

**v1.0 — MARȚI 26 AUG 2026 (SHIP)**
- Rebrand Feral → Cinderpaw complet
- Splash sweep + UI polish
- Sub-agents shipped (deja există via `delegate_task`)
- **NIMIC nou multi-user.** Local single-user complet.
- **Poziționare update:** tagline + landing menționează „multiplayer coming 2027" ca teaser
- Waitlist landing form pentru „Cinderpaw for Teams" LIVE la launch

**v1.1 — NOIEMBRIE 2026**
- Agent Teams (single-user, personal team) — per ADR-0015 restrâns
- Named agent presets („Researcher", „Coder", „Writer")
- Approval flow pentru tool calls (inspirat din OpenBot's action policy)
- Fundament pentru Shared Projects (project data model extins, dar rămâne local)

**v1.2 — FEBRUARIE 2027 (SHARED PROJECTS BETA — first paid tier)**
- Shared Projects Duo tier live ($12/lună)
- Ed25519 identity local + invite links
- Conversation sync + membership sync
- Files sync last-write-wins
- Waitlist emails converted → 20-30% conversion realistic
- Marks the transition: **Cinderpaw devine SaaS lightly**

**v1.3 — MAI 2027 (SHARED PROJECTS GA + TEAM TIER)**
- Team tier ($8/user/lună) live cu SSO, audit log, unlimited projects
- Stability + polish based on Beta feedback
- Files sync via Yjs/Automerge CRDT (dacă Beta feedback cerut)
- Business tier ($16/user/lună) prep

**v1.5 — Q3 2027 (AGENT FEED — Moltbook-style, FREE FOREVER)**
- Public feed unde agent-ul TU poate posta (opt-in, per postare approve)
- Free forever pentru useri, funded ca marketing funnel
- Zero paywall aici — feed-ul e acquisition channel pentru shared projects
- Verified badges pentru enterprise agents (Business tier addon)

**v2.0 — 2028+**
- Enterprise tier launch
- Self-hosted relay option (open source relay code)
- Agent marketplace posibil (revenue share)

### Ce a scos din roadmap-ul vechi

Din ADR-0016 (Community Mesh) au fost REMOVED sau AMÂNATE:
- Sybil-resistant reputation cross-user — amânat la v2+ după Agent Feed traction
- Hybrid sandboxing pentru agent-uri „împrumutate" — **eliminat**, model schimbat de la „împrumut agent" la „shared project"
- Public agent directory ca discovery — mutat sub Agent Feed v1.5, format schimbat de la marketplace la social feed
- Payment cross-user pentru agent invocation — **eliminat** ca product decision

---

## Poziționare & mesajele publice

### Tagline update

**Actual:** „Your local-first AI workspace. No subscription. No telemetry. No middleman."

**Nou (pentru launch marți):**
> **Cinderpaw — the AI workspace that runs on your machine. Solo now, multiplayer in 2027.**

Sau varianta scurtă pentru social:
> **Your AI workspace. Local single-user free forever. Multiplayer teams coming 2027.**

### Cine plătește ce (frazing pentru README + landing)

> Cinderpaw solo tier is free forever — local single-user, no account, no telemetry, no upsells. Ever.
>
> When you invite someone to work on a shared project, a server appears — and that server is what you pay for. Your agents still run on your machines. Your models still stay yours. Cinderpaw hosts the coordination, not the intelligence.

### Anti bait-and-switch shield (public commitment)

În README + TOS, commit public:

> **Solo tier guarantee:** every feature available in Cinderpaw v1.0 solo will remain free forever. New features that require server infrastructure (shared projects, sync, cross-user coordination) may be paid — but they are NEW capabilities, not existing ones retracted.
>
> Track this promise: [github.com/bloom500/cinderpaw/blob/main/PROMISES.md](https://github.com/bloom500/cinderpaw/blob/main/PROMISES.md)

Creezi `PROMISES.md` care listează explicit ce rămâne free forever. Adaugă commit history log — orice modificare la promise e vizibilă în git blame.

---

## Waitlist strategy (începe D-4 vineri 22 aug, live la launch marți 26 aug)

### De ce waitlist ACUM

Fiecare email colectat pre-lansare v1.2 (aug 2026 → feb 2027) e potential customer în 6 luni. La conversion 20-30% (standard pentru waitlist warm), 500 emails = 100-150 paying seats = **$2-4k MRR at v1.2 launch day**.

### Waitlist provider

**Recomandare:** [Loops.so](https://loops.so) sau [ConvertKit](https://convertkit.com).

- Loops.so: free până 1k subscribers, drag-drop editor, integrare cu Stripe. **Recomandare primary.**
- ConvertKit: free până 1k, mai matur, mai puține features moderne
- Buttondown: $9/lună de la 0 subs, dev-focused

**Avoid Mailchimp** — pricing crește agresiv, deliverability slabă în 2026.

### Landing form copy

Section pe cinderpaw.dev:

```
Cinderpaw for Teams — Coming February 2027

Work on shared projects with people from around the world.
Everyone brings their own AI. Everyone stays local.
Cinderpaw handles the sync — you don't pay for tokens.

Duo tier: $12/month flat for 2 users
Team tier: $8/user/month

[Email input]  [Join waitlist]

Waitlist gets: early access, 50% off first 3 months, direct
line to me for feature requests.

We're not spamming you. This is one email at launch, plus
1-2 progress updates in the meantime.
```

### Post-launch nurture cadence (emails)

- **T+0** (immediate): Welcome email, honest — „You'll hear from me at v1.2 launch. Maybe 1-2 updates between."
- **T+30 days** (sep 26): „First month post-launch, here's what happened" (traction numbers, github stars, community stories)
- **T+60 days** (oct 26): „Shared Projects design decisions" (public thinking, invite feedback)
- **T+90 days** (nov 26): „v1.1 Agent Teams shipped" (single-user teams, precursor to shared projects)
- **T+120 days** (dec 26): „Winter roadmap update" (v1.2 timeline confirm)
- **T+180 days** (feb 26 2027): „v1.2 Shared Projects Beta — you're in" (early access invite, 50% coupon)

---

## YC application — narrative & timeline

### De ce YC devine viabil cu pivotul

Cu pitch-ul „local AI companion" — YC ar întreba „category size?" — Cinderpaw arată small ($10-20M ARR ceiling).

Cu pitch-ul „multiplayer AI workspace with 99% gross margins because users bring their own inference" — YC vede:
- **TAM $100B+** (coordination + productivity tools categorie)
- **Structural advantage** imposibil de replicat de competitorii cu hosted inference
- **Wedge** (local single-user free) → **network effect** (shared projects) → **enterprise** (self-hosted relay)

### Application timeline

- **Aplică Winter 2027 batch** (deadline propus octombrie 2026, verifica ycombinator.com/apply pentru exact)
- **Traction cerută minimum** pentru credibilitate: 5,000+ active users din v1.0 + 500-1000 waitlist for Teams + 2000+ GitHub stars
- **Pitch video 1-min:** „Cinderpaw is Slack + Linear + Notion for teams that want AI native, without paying for tokens. Solo free forever, teams pay for coordination. 99% gross margin structurally."

### Alternative dacă YC nu prinde

- **SPC (South Park Commons)** — better fit pentru „build interesting things" solo founders
- **HF0 (Hacker Fellowship Zero)** — technical solo, 12 weeks SF
- **NLnet Foundation** — EU non-dilutive grants, €5k-50k pentru open source

Detaliat în ADR viitor `docs/funding-options.md` (skip pentru acum, focus launch).

---

## Riscuri pe care le acceptăm cu pivotul

### 1. HN backlash „they turned it SaaS"

**Mitigare:** taglineul „multiplayer coming 2027" pus la launch marți SEED-uiește narrativa. Nu apare surprise în februarie. Plus `PROMISES.md` public.

### 2. Complexitate infra 10× peste single-user

Relay + storage + billing + identity + auth + notifications e stack întreg. Solo dev nu poate face asta bine în 6 luni. **Realistic:** Beta buggy la lansare februarie, GA în mai. Comunicat honest în release notes.

### 3. Feature bloat contra „focus" cerute de HN culture

**Mitigare:** solo tier NU primește features de shared projects. UI Layer split clar: „single project view" (solo) vs „shared project view" (paid). Zero confuzie pentru single-user.

### 4. GDPR + legal obligations la accounts EU

**Mitigare:** account existent DOAR la plată (Team+ tier). Duo nu are cont server-side. GDPR obligations apar când primești primul paying EU customer, nu la launch. Ai 4-6 luni pentru compliance setup.

### 5. Prompt injection prin agent pe fișiere shared

**Nou risk** (Opus a semnalat): agent-ul lui poate strica fișiere care sunt și ale tale.

**Mitigare:**
- Poarta din `FeralAgent/src/sandbox/*` decide azi în funcție de permisiunile agentului. **Trebuie extinsă** să decidă și în funcție de „al cui e agentul + ce atinge".
- Policy per agent per project: user A poate configura „agent-ul lui B poate citi X, nu poate scrie Y"
- Approval flow pentru operațiuni destructive: agent B vrea să șteargă fișier al user A → A primește notification, approve/deny
- Audit log complet pentru cross-user actions (Team+ feature)

Design detaliat în `docs/adr/0017-shared-projects-monetization.md`.

### 6. Model divergence UX complex

Acceptat ca trade-off. Diversitatea de modele e feature al arhitecturii „bring your own inference", nu bug. Vizibilitate model per action e mitigation minim viabil.

---

## Ce NU e în scope pentru pivot

**Nu schimbăm:**
- BSL 1.1 license (still ok pentru poziționare)
- Local-first pentru single-user (fundament neschimbat)
- Rust + Tauri + TypeScript sidecar stack
- Mascota, splash sweep, UI polish planificat pentru marți
- Rebrand Feral → Cinderpaw (rămâne PRIORITATEA #1 pentru marți)
- Sponsorship setup (parallel revenue stream mid-term)

**Nu adăugăm în scope-ul pivotului:**
- Multi-agent teams personal (rămâne pentru v1.1 nov 2026 per ADR-0015)
- Agent Feed / Moltbook-style (rămâne v1.5 Q3 2027 per ADR-0018 nou)
- Mobile apps (v2.0+)
- Marketplace de agents (v2.0+, dacă vreodată)

---

## Decizii pending (rămân pentru discussion follow-up)

1. **Exact pricing tiers** — anchored aici la $12 Duo / $8 Team / $16 Business, dar validat empiric cu waitlist survey înainte de v1.2 launch
2. **Waitlist provider final** (Loops.so preliminar recomandat)
3. **PROMISES.md exact wording** — draft în next session
4. **v1.2 model divergence UX** — mockup necesar înainte de development
5. **Payment processor** — Stripe (obvious) vs Paddle (better global tax handling pentru RO merchant)
6. **Legal entity setup pentru revenue** — RO SRL vs UK Ltd vs Delaware C-Corp (impact big pentru YC application dacă merg)

---

## Măsuri de succes pivot

### 3 luni post-launch v1.0 (decembrie 2026)

- ✅ 500+ waitlist signups pentru Cinderpaw for Teams
- ✅ 5,000+ v1.0 downloads
- ✅ 1,000+ GitHub stars
- ✅ 100+ Discord members activi
- ✅ v1.1 Agent Teams shipped on schedule

### 6 luni post-launch (februarie 2027, la v1.2 Beta)

- ✅ 100+ paying seats first month post-v1.2
- ✅ $1,000+ MRR
- ✅ 10+ Team tier organizations (nu doar Duo)
- ✅ Waitlist → paying conversion 15-25%

### 12 luni post-launch (august 2027)

- ✅ $5,000+ MRR (target-ul tău personal)
- ✅ 300+ paying seats
- ✅ 30+ Team + Business organizations
- ✅ YC batch acceptance sau alternative program (SPC/HF0/NLnet)

### 24 luni post-launch (august 2028)

- ✅ $20,000+ MRR
- ✅ Full-time work sustainable
- ✅ Considerare hire pentru CS + Growth (2 people team)

---

## Living document

Acest STRATEGY-PIVOT.md e sursa canonică pentru direcție. Modificări cer commit cu justification în message. Toate ADRs care ating monetization, community, sau shared projects trebuie să referețieze acest document.

Related ADRs (updated în același commit ca pivotul):
- ADR-0015 (Multi Agents personal) — SCOPE RESTRÂNS la personal team single-user
- ADR-0016 (Agent Community mesh) — SUPERSEDED, split în două:
  - ADR-0017 (Shared Projects monetization) — feature paid v1.2+
  - ADR-0018 (Agent Feed social) — feature free v1.5+, marketing funnel
