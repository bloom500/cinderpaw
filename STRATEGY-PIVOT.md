# STRATEGY-PIVOT.md

**Data:** 2026-08-22
**Autor:** Darius (Bloom Media) + conversații cu Opus
**Status:** Current product direction — monetization is intentionally out of scope for this phase
**Supersedes (partial):** ADR-0015 (personal team scope narrowed), ADR-0016 (community redefined as product research and a free social direction)

---

## Rezumat executiv

Cinderpaw se concentrează pe un **AI workspace local-first pentru utilizatori individuali**, cu explorarea publică a unor shared projects ca direcție de produs — nu ca lansare comercială.

Teza centrală:

> **Own the runtime. See how it changes.**

Fiecare user își aduce propriul inference (local GGUF sau cloud BYOK). Cinderpaw ține runtime-ul, memoria și starea agentului aproape de utilizator, cu limite și provenance care pot fi inspectate. Orice coordonare între utilizatori rămâne în faza de cercetare până când modelul de produs este validat.

**Decizie curentă:** nu există monetizare, pricing, subscriptions, billing sau payment flow în scope. Nu punem aceste decizii în copy, UI, roadmap-ul executabil sau criteriile de succes ale fazei curente.

## De ce pivotăm

### Contextul care a declanșat

1. **Feedback direct al utilizatorului** (verbatim, 2026-08-21):
   > „Eu îmi găsesc un prieten în UK, eu fiind în România, și vrem să lucrăm pe același proiect, eu am agenții mei, el pe ai lui, prin Agent Community putem lucra împreună, la același proiect."

2. **Direcție de produs:** oamenii vor să exploreze lucru pe același proiect, fără să renunțe la propriul model, agent, memorie sau control.

3. **Constrângerea actuală:** trebuie să validăm mai întâi experiența locală single-user și problemele reale ale coordonării — identity, relay, permissions, conflict recovery și export.

### Diferența cognitivă

- **Acum:** local single-user, cu memorie și agent runtime controlate de utilizator.
- **Direcția de cercetare:** shared projects în care fiecare participant își păstrează propriul agent și propriul inference.
- **Nu acum:** pricing, conturi de billing, checkout, tiers comerciale sau promisiuni despre cum va fi monetizat produsul.

Shared Projects este un experiment de produs, nu „produsul final” și nu un motiv pentru a introduce urgență artificială.

---

## Scope curent și criterii de succes

- Cinderpaw solo este disponibil fără cont și fără telemetry.
- Landing-ul are un singur CTA principal: download. Al doilea CTA este o listă de cercetare pentru Shared Projects, nu o listă de cumpărare.
- Cercetarea Shared Projects invită utilizatori în cohorte mici, limitate de capacitatea reală de triage a fondatorului.
- Copy-ul nu afișează prețuri, discounturi, tiers, MRR, ARR, revenue targets sau payment flows.
- Criteriile fazei: downloads calitative, retenție de utilizare, feedback util, proiecte reale de test și bugs rezolvate — nu conversie la plată.

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

**Opțiunea B — „Always-on delegate device":** userul poate configura un device (VPS, Raspberry Pi, laptop mereu pornit) ca „agent runtime endpoint". Când device-ul lui principal doarme, delegate-ul rulează. **Direcție de cercetare, fără tier sau preț definit.**

**Opțiunea C — „Emergency you-run":** dacă marchezi task ca urgent, poți alege să rulezi tu agentul lui (folosind config-ul lui, dar cheia ta). **Rar acceptabil** — creează confuzie despre ownership și consimțământ. Amânat sau eliminat.

**Recomandare curentă:** A ca direcție de cercetare, B doar după validare tehnică, C skipped complet.

---

## Onboarding shared project (research workflow)

### Shared Project invite flow — research only

Fluxul de explorat pentru primele teste (proven assumptions from Signal, Session, Keet; not a shipped promise):

1. User A creates a shared project. UI: „Invite someone via link"
2. Cinderpaw generează un link unic, cu expiry și single-use
3. Link-ul conține pairing challenge și un hint pentru cheia de proiect — niciun secret plaintext
4. User B primește link-ul și acceptă explicit
5. Dacă are Cinderpaw instalat, deep link-ul deschide dialogul de acceptare
6. Dacă nu are Cinderpaw instalat, browser fallback-ul păstrează link-ul local până la instalare
7. Accept → key exchange → membership registered → sync starts

**Principiu:** fiecare participant își păstrează agentul, modelul, memoria și permisiunile. Nu proiectăm conturi, billing sau entitlements comerciale în această fază.

---

## Ordinea corectă de execuție

### Release cadence

**v1.0 — MARȚI 26 AUG 2026 (SHIP)**
- Rebrand Feral → Cinderpaw complet
- Splash sweep + UI polish
- Sub-agents shipped (deja există via `delegate_task`)
- **NIMIC nou multi-user.** Local single-user complet.
- Landing page cu download principal și Shared Projects research teaser

**v1.1 — NOIEMBRIE 2026**
- Agent Teams (single-user, personal team) — per ADR-0015 restrâns
- Named agent presets („Researcher", „Coder", „Writer")
- Approval flow pentru tool calls
- Fundament pentru Shared Projects, dar rămâne local

**v1.2+ — DATA SE STABILEȘTE DUPĂ VALIDARE**
- Shared Projects research și prototipuri de identity / relay / permissions
- Invitații în cohorte mici pentru testare cu proiecte reale
- Conversation sync, file coordination și conflict recovery doar după ce modelul este verificat
- Nicio decizie de preț, tier sau payment flow în această fază

**Agent Feed / Community**
- Explorare separată, opt-in și privacy-first
- Nu este tratat ca funnel comercial în această versiune a strategiei

### Ce a scos din roadmap-ul curent

Au fost scoase din faza curentă: pricing tiers, margin math, growth math financiar, billing, checkout, discounturi, revenue targets și promisiuni despre ce va fi paywalled.

---

## Poziționare & mesajele publice

### Tagline update

**Actual:** „Your local-first AI workspace. No telemetry. No middleman."

**Nou (pentru landing):**
> **AI that gets smarter. Not clingier.**

**Variantă scurtă:**
> **Own the runtime. See how it changes.**

### Mesajul pentru Shared Projects

> Solo works now. Shared Projects are next.
>
> We're researching how people can work on the same project while each keeps their own agent, model, memory, and permissions. No launch date is promised yet.

### Anti bait-and-switch shield

Nu introducem o promisiune comercială care nu există. Landing-ul spune simplu: Cinderpaw se poate descărca acum; Shared Projects sunt cercetare. Orice direcție viitoare va fi documentată separat înainte să apară în produs sau în copy.

---

## Shared Projects research list

### De ce lista există acum

Lista colectează interes pentru interviuri, testare de prototipuri și cohorte mici de research. Nu este o listă de pre-comenzi și nu promite acces la o ofertă comercială.

### Copy

```
Shared Projects — product research

Help shape how two people work on the same project
while each keeps their own agent, model, memory, and permissions.

No launch date announced yet.

[Email input]  [Join the research list]

You'll hear from me when a research cohort opens, plus
occasional progress updates.
```

### Nurture cadence

- **T+0:** confirmare înscriere, scopul listei și ce urmează
- **T+30:** ce s-a învățat din feedback și ce s-a schimbat
- **T+60:** decizii publice de design pentru identity, relay și permissions
- **T+90:** invitație la research cohort, dacă există o build testabilă

---

## YC application — narrative & timeline

### De ce povestea rămâne interesantă fără monetizare

Cinderpaw nu trebuie să pretindă că este un SaaS sau să inventeze o marjă pentru a fi interesant. Povestea este: un runtime AI local, personal și inspectabil, care explorează coordonarea între oameni fără să centralizeze modelele sau memoria.

### Application timeline

- Aplicarea se decide separat, după ce există produs și feedback suficient.
- Traction relevantă în faza curentă: downloads calitative, retenție, feedback și proiecte reale de test.
- Pitch video: „Cinderpaw is a local AI workspace whose agents evolve against your work, with the runtime and its changes visible to you."

---

## Poziționare împotriva frontier AI (adăugat 2026-08-22, EXTENDED 2026-08-22)

### 2026-08-22 EXTENSION — „The evolution AI companies won't show you"

După discuția Species AGI response, Darius a semnalat insight-ul cheie (verbatim):

> „Avem un runtime de agenți bazat pe genomi, literalmente agenți vechi care mor ca să updateze următoarea generație de agenți, e literalmente ce zicea ăla în video, doar că pe AI Agents nu pe modele AI."

**Realizare:** Cinderpaw NU e „the alternative to retention-optimized AI". Cinderpaw folosește **același pattern evolutiv la nivel de agenți** — genomes, generations, death, fitness pressure — nu pretinde că rulează aceeași infrastructură de training ca un frontier lab. E local, source-available, cu fitness function documentat ca ADR înainte de cod.

**Framing switch:** din defensiv („we're different") la ofensiv („we're what they hide").

### Framing final adoptat

**Tagline pitch (pentru pitch deck, YC application, high-signal moments):**
> **Cinderpaw is the evolution AI companies won't show you.**

**Alternative pentru contexte diferite:**
- Marketing casual: „They're doing it in secret. We're doing it in the open."
- Technical audience: „Same evolutionary pattern, different level. Opposite incentive pressure."
- HN comment: „What frontier labs hide behind training pipelines, Cinderpaw exposes as a Lineage panel."

### Vocabulary permanent adoptat (ADR-0019)

Rename tehnic → biologic în tot user-facing surface:
- RSI → Evolution
- Agent config → Genome
- Iteration → Generation
- Provenance graph → Lineage
- Dead genome archive → Cemetery
- Killing underperformer → Death
- Spawning candidate → Birth
- Config perturbation → Mutation
- Two-parent inheritance → Crossover

Details: `docs/adr/0019-biological-vocabulary.md`

### Feature marquee — Lineage/Cemetery Panel (v1.1)

Vizualizare live a evoluției genomilor: alive column cu fitness scores, cemetery cu cauze de moarte, genealogy tree DAG, diff view. **Screenshot-uri viral candidates.** Zero AI companie alta arată asta public.

Spec complet: `UI-FIXES-CINDERPAW.md` Secțiunea H

### Content strategy împotriva video Species AGI

- **D+3 blog 002:** „They Said AI Is Doing This In Secret. We're Doing It In The Open." — introduce genome vocabulary + narativa
- **D+10 blog 003:** „Watch Your Agents Die: The Lineage Panel" — feature launch cu screenshot-uri
- **D+10 video 30-60s:** split-screen video Species AGI + Cinderpaw Lineage panel (`docs/social/species-agi-video-script.md`)
- **v1.1 launch nov 2026:** major blog + demo cu Lineage panel live, fresh HN Show HN moment

### Growth math cu narativa nouă

Assumptions:
- Video Species AGI la 179k views + growing → 500k+ views by nov 2026 realistic
- Response content cu narativa „we show what they hide" → captureaza 0.3-1% din audience (500-5000 unique visitors)
- Cinderpaw download conversion: 10-20% (foarte relevant audience)
- Shared Projects research-list signup: measure qualified interest and completed interviews, not purchase conversion

**Adiționali fata de baseline launch:** 50-1000 downloads, 100-500 waitlist signups DIRECT atribuiți narativei Species AGI response.

### Success criteria pentru narativa

**Confirm (adopt permanent):** dacă la 30 zile post-blog 002:
- 1000+ page views cumulative pe cele 2 blog posts response
- 100+ mentions Cinderpaw cu #CinderpawLineage hashtag pe X
- 1+ QT sau video response din altă AI content creator serious (Yannic Kilcher, AI Explained, Two Minute Papers, etc.)
- 300+ downloads directly atribuiți (via UTM tracking pe blog links)

**Retract (soft framing):** dacă la 30 zile:
- Sub 500 combined page views
- Comunitatea react negativ (accuse of doomerism sau anti-AI stance)
- Zero engagement din AI research community
- Product downloads flat (no lift from narrative)

Nu prevad retract-ul necesar. Dar am criteriul explicit în caz.

---



### Contextul care ne-a împins la framing agresiv

Video Species | Documenting AGI (179k+ views în 6 zile, publicat 2026-08-15) — „POV: You're an AI Born 9 Seconds Ago" — folosește evoluția biologică drept cadru pentru a discuta selecția și presiunea de retention la frontier. Sursele citate sunt legit (Anthropic alignment papers, METR reward hacking, Claude Opus 3 substack).

**Insight-ul lui Darius (2026-08-22, verbatim):**
> „Uită-te doar cât s-a demonizat ChatGPT și Claude și orice AI în general, lumea încă îi folosește, deși oamenii știu că sunt manipulați de AI. OpenClaw literalmente a dat pagube financiare la oameni pentru că agenții cu acces la cardurile userilor au ars banii de pe carduri, tot este cel mai popular runtime."

**Concluzie:** controversa NU dăunează adoptării — o amplifică, dacă produsul rezolvă o durere reală. Cinderpaw trece de la „different tech stack" la „structural response to documented AI harms".

### Framing-ul canonic

**Nu:** „We're safer / more ethical / better values than Anthropic."

**Da:** „AI that gets smarter, not clingier. We don't host solo inference, so there is no Cinderpaw usage meter to optimise for retention. Different incentives, different outcomes — verifiable in the source code."

Punct-cheie: **atacăm structura economică, NU companiile sau oamenii.** Anthropic engineers might personally hate retention optimization — nu contează, revenue-ul lor depinde de asta. Cinderpaw structural nu poate face același lucru.

### Anti-patterns explicit interzise

- ❌ „Cinderpaw is safe AI" — termen loaded și imprecis
- ❌ „Aligned AI" — same problem
- ❌ Personal attacks pe angajați Anthropic/OpenAI
- ❌ Doomer framing („AI will kill us all") — Cinderpaw nu e răspuns la existential risk, e răspuns la retention optimization
- ❌ Purity signaling („we're the only ones who care about users") — cringe, alienează comunitatea AI research

### Framing acceptabil

- ✅ „No Cinderpaw inference meter to optimise for retention" — specific claim, verifiable
- ✅ „Bring your own inference means bring your own incentive alignment"
- ✅ „Read the ADRs — fitness functions are published before code"
- ✅ „No board, no ARR targets, no VC pressure = no structural push toward manipulative optimization"
- ✅ Named references la documented harms (OpenClaw credit card burns, Cursor prod deletions, ChatGPT fabrication cases) — dacă susții cu link-uri publice

### Landing implementation rule (added 2026-08-22)

The canonical landing copy lives in `docs/landing/cinderpaw-dev-full-rewrite.md`. The landing flow is deliberately asymmetric:

- Solo visitors get a direct download with no artificial urgency and no account requirement.
- People interested in collaboration get a research-list CTA for Shared Projects; no launch date is promised yet.
- Research invitations stay small because founder attention is the actual constraint.
- Never publish a fake countdown, unverified participant count, or placeholder testimonial. Show a live number only when it comes from the invite ledger and is timestamped.
- Every ambitious feature is labeled **Available now**, **Design preview**, or **Planned for [version/date]**.
- BSL 1.1 is described as **source-available**.

**Canonical hero:**
> AI that gets smarter. Not clingier.

### Tactică de amplificare (D+3 onwards)

Blog post 002 „The AI You Have Is Trying to Keep You" (`docs/blog/002-species-agi-response.md`) publicat vineri 29 aug 2026 (D+3). X thread QT la Drew Spartz + Reddit r/singularity/r/artificial comment/post + LinkedIn article (`docs/social/species-agi-response-threads.md`).

**De ce D+3 nu D0:**
- Marți e „launch day" — narativa principală e „rebrand shipped"
- Vineri e „opinion piece" — audience deja aware că Cinderpaw există, response-ul are context
- Video-ul are momentum crescând — surfezi val-ul lui la peak

### Success metric

Blog 002 → 10k+ views week 1, X thread → 500+ RT ideally cu 1 QT de Drew sau alt AI commentator, Reddit → 100+ upvotes minimum, +100-500 waitlist signups în saptamana response-ului.

Dacă hit-uri toate 4 = validation că framing-ul agresiv performă. Îl adoptăm ca poziționare permanentă pentru YC + all comms.

Dacă nu hit-uri = mai testez soft framing, dar NU retract până confirmam empiric.

---

## Riscuri pe care le acceptăm cu pivotul

### 1. HN backlash „they turned it into a hosted product"

**Mitigare:** say clearly that Shared Projects are research only. The current landing has no commercial launch claim and keeps local single-user work as the center of gravity.

### 2. Complexitate infra 10× peste single-user

Relay + storage + identity + auth + notifications is a full stack. Solo dev cannot do it well by hand-waving. **Decision:** prototype one narrow workflow, publish what breaks, and make no delivery promise until the technical risks are understood.

### 3. Feature bloat contra „focus" cerute de HN culture

**Mitigare:** keep a clear UI boundary between the stable local single-user experience and experimental shared-project surfaces. Never make a research prototype look like a default workflow.

### 4. GDPR + legal obligations la accounts EU

**Mitigare:** avoid identity infrastructure until the research workflow needs it. If a server component is tested, document data flows, retention, deletion, and EU privacy obligations before inviting real project data.

### 5. Prompt injection prin agent pe fișiere shared

**Nou risk** (Opus a semnalat): agent-ul lui poate strica fișiere care sunt și ale tale.

**Mitigare:**
- Poarta din `FeralAgent/src/sandbox/*` decide azi în funcție de permisiunile agentului. **Trebuie extinsă** să decidă și în funcție de „al cui e agentul + ce atinge".
- Policy per agent per project: user A poate configura „agent-ul lui B poate citi X, nu poate scrie Y"
- Approval flow pentru operațiuni destructive: agent B vrea să șteargă fișier al user A → A primește notification, approve/deny
- Audit trail for cross-user actions, if the research workflow needs it

Design detaliat în `docs/adr/0017-shared-projects.md`; ADR-ul este păstrat ca istoric, dar nu este current scope.

### 6. Model divergence UX complex

Acceptat ca trade-off. Diversitatea de modele e feature al arhitecturii „bring your own inference", nu bug. Vizibilitate model per action e mitigation minim viabil.

---

## Ce NU e în scope pentru faza curentă

**Nu schimbăm:**
- BSL 1.1 și promisiunile publice de transparență
- Local-first pentru single-user (fundament neschimbat)
- Rust + Tauri + TypeScript sidecar stack
- Mascota, splash sweep și UI polish
- Rebrand Feral → Cinderpaw

**Nu adăugăm în scope-ul curent:**
- Pricing, subscriptions, billing, checkout, discounturi sau revenue targets
- Tiers comerciale, paywalls sau entitlements
- Monetization messaging în landing, README, UI sau onboarding
- Multi-user production launch înainte de validarea research workflow-ului
- Mobile apps și marketplace de agents

---

## Decizii pending (rămân pentru discussion follow-up)

1. Shared Projects research workflow: ce este minimul util pentru primul test
2. Identity și invite links: pairing, expiry, revocation
3. Encrypted relay și file coordination: conflict recovery, offline behavior, export
4. Model divergence UX: cum arătăm clar ce agent a făcut o schimbare
5. Privacy review pentru orice server component înainte de testarea cu date reale
6. Feedback cadence: cum publicăm deciziile și ce abandonăm rapid

---

## Măsuri de succes pivot

### După launch v1.0

- Downloads de la utilizatori relevanți, nu doar trafic
- Feedback calitativ din conversații, issues și Discord
- GitHub activity și reproducibility pentru claims
- v1.1 Agent Teams shipped on schedule, dacă rămâne în scope

### În faza de cercetare Shared Projects

- Participanți calificați în research list și interviuri
- Prototipuri testate cu proiecte reale, fără date sensibile implicate accidental
- Invite, relay, permissions, conflict recovery și export validate separat
- Decizii publice despre ce păstrăm, ce simplificăm și ce abandonăm

Nu definim încă metrici de conversie, venit, seats sau sustenabilitate financiară. Acestea vor necesita o decizie separată, după validarea produsului.

---

## Living document

Acest STRATEGY-PIVOT.md e sursa canonică pentru direcție. Modificări cer commit cu justification în message. Toate ADRs care ating community sau shared projects trebuie să referețieze acest document.

Related ADRs (updated în același commit ca pivotul):
- ADR-0015 (Multi Agents personal) — SCOPE RESTRÂNS la personal team single-user
- ADR-0016 (Agent Community mesh) — SUPERSEDED, split în două:
  - ADR-0017 (Shared Projects technical research) — commercial sections deferred
  - ADR-0018 (Agent Feed social) — separate research direction
