# PLAN — RSI + Fractal Memory Search (+ punctul strategic final)

> Document unic de orientare. Adună la un loc planul TEHNIC (fazele de
> implementare) și planul STRATEGIC (comparația cu concurența la final).
> Branch de lucru: `feat/rsi-fractal-memory` (worktree `wt-29286b1b`).
>
> Legendă: ✅ gata · 🟡 parțial · ⬜ neînceput
>
> Surse: `docs/superpowers/specs/2026-06-20-fractal-memory-search-pivot.md`
> (fazele), notele de memorie `project_feral_flagship_differentiator` +
> `project_openclaw_migration_wedge` (punctul strategic).

---

## Pe scurt — unde suntem

Tehnologia (Fractal Memory Search) e construită și testată până la **poarta de
decizie**. Urmează **să rulezi benchmark-ul cu model real** → verdictul decide
dacă fractalul se activează sau rămânem pe FTS5. Abia după ce stiva nouă e
solidă vine **punctul strategic**: comparația Feral vs OpenClaw/Hermes și
blocarea pitch-ului flagship.

---

## PARTEA A — Planul tehnic (Fractal Memory Search)

Principiu de bază: **augmentăm, nu înlocuim FTS5.** Căutarea exactă (FTS5)
rămâne stratul-frunză permanent; arborele RAPTOR + embeddings se adaugă deasupra.
Regresie imposibilă structural: hiturile FTS5 sunt un subset al inputurilor
hibridei.

### Faza 0 — Embeddings în Rust (infra) ✅ *(model lipsă pe disc)*
- ✅ `embed_text(texts) -> Vec<Vec<f32>>` în `inference.rs`, model embedding
  dedicat (lazy, CPU, separat de chat), mean-pooling + L2-norm.
- ✅ Coloană `embedding BLOB` în SQLite + write-back persistent
  (commit `eaf7df4`): al doilea rebuild embed-uiește 0 frunze.
- ✅ Downloader `bge-small` cablat (commit `f5b481f`).
- ⬜ **Fișierul GGUF pe disc** — se descarcă la primul run pe mașina ta. Fără
  el, totul cade frumos pe FTS5 (zero regres), dar partea semantică nu pornește.
  ⚠️ De verificat coordonatele HF ale modelului.

### Faza 1 — Cele 7 module TS ✅
`embed` · `cosine` · `kmeans` · `summarize` · `tree-builder` · `tree-query` ·
`fractal-recall` + `tree-store` (persistență) + `FractalMemory` (facade live cu
fallback la RecallEngine). Toate cu teste.

### Faza 2 — Benchmark gate + facade 🟡
- ✅ **Benchmark gate** (commit `fa175c5`, azi). Răspunde la întrebarea-poartă
  din spec: *are voie fractalul să înlocuiască FTS5?* Măsoară **recall@10**
  (cât de bine găsește) și **p99 latență** (<80ms). Regula de ship: fractal nu
  regresează recall **ȘI** rămâne sub buget. Rulează **în sidecar**
  (`FERAL_RUN_FRACTAL_BENCH=1`), scrie `data/fractal-bench-report.json`.
  46 teste noi, 908/908 verde, tsc curat. Vezi `FeralAgent/src/memory/fractal/bench/README.md`.
- ⬜ **Facade `memory_graph` / `memory_ops`** — uneltele de memorie ale
  agentului să treacă prin noul `fractalQuery`, păstrând forma de output.

### Faza 3 — Organism viz (frontend) ✅ ~gata
- ✅ Rescris „Memory Layers” ca organism pur Mandelbrot (fără text/noduri).
- ✅ Eliminat path-ul `FilamentText`.
- ✅ Renderer WebGL2 `z^d+c` + zoom ancorat pe cursor.

### Faza 4 — „Breathing” pe activitate 🟡
- ✅ Evoluție live pulsată de evenimente (idle = înghețat).
- 🟡 Morph/breathing localizat pe regiunile traversate de query — de rafinat.

### Faza 5 — Cuplare + decizie (ambele) ⬜
- ⬜ **RULEAZĂ benchmark-ul cu model real** pe memorii reale → **decizie
  ship/hold**. (Doar tu poți: cere GGUF pe disc + app live.)
- ⬜ Leagă evenimentele FractalMemorySearch → motorul de creștere al organismului
  (ingest → filament; query → breathing; cluster terminal → mini-brot).
- ⬜ Test pe ~10k memorii.

### Rămas tehnic (oricând, post-gate)
- API pe **TIERE T1/T2/T3** explicit (vezi-tot / scope-un-strat / snipe-exact) —
  rafinarea de viziune, în loc de hibrida implicită de acum.
- Attach incremental la ingest (acum doar full rebuild offline).
- tree-builder embed-uiește 1 frunză/call = N roundtrip-uri (optim pt corpus mare).

---

## PARTEA B — Punctul strategic final (după ce tech-ul e gata + testat)

> Acesta e „ultimul punct” pe care îl țineai minte. NU e cod — e poziționare.

**Obiectiv:** după ce funcționalitățile noi (Fractal Memory, RSI, organism)
sunt terminate și testate, **compară Feral cu OpenClaw și Hermes** și
blochează conceptul-flagship pe care Feral să-l DEȚINĂ.

Din analiza „Council” (15 iunie, changelog-uri integrale):
- OpenClaw + Hermes = **același produs**: gateway headless de messaging. Ambii au
  deja memory/skills/MCP/browser/voice/cron/multi-agent → nimic din astea nu e
  flagship.
- „Self-improving” la Hermes = **fum** (nudge text + skill, nu atinge greutățile).

**Flagshipul propus — „Feral devine al tău”:**
1. **① Workflow learning by demonstration** — agentul învață fluxurile tale prin
   UIA (record → replay parametrizat). Niciun concurent nu are.
2. **② Personalizare LoRA on-device** — agentul își fine-tunează modelul LOCAL,
   cu **eval-gate** obligatoriu înainte de promovare (altfel rollback auto).
   „grows with you” cu SUBSTANȚĂ, fix unde claim-ul Hermes e stub.
   ① produce semnalul de training pentru ②.

**De făcut la acest punct:** lock flagship (① + ② cuplate vs ② direct) → scris
spec de poziționare + arhitectura `PersonalizationBackend` + bucla
learn→eval-gate→promote/rollback. (Hard-gate: spec + approval înainte de cod.)

---

## Următorul pas imediat

1. **(Tu)** Pornește app-ul o dată → se descarcă `bge-small`. Apoi rulează cu
   `FERAL_RUN_FRACTAL_BENCH=1` → citește verdictul din raport.
2. **(Claude)** În paralel/după: facade `memory_graph`/`memory_ops` (Faza 2) sau
   API pe TIERE — la alegere.
3. Punctul strategic (Partea B) vine **după** ce gate-ul zice SHIP și stiva e
   testată end-to-end.
