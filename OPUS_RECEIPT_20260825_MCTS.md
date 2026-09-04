# RECEIPT pentru Opus — 2026-08-25 — MCTS + Active Verifier (spec Step 3)

**Branch:** `feat/arc-mcts-verifier` (stacked pe `ui/glass-black-matte`, deci
conține toată fundația ARC). **NOT committed încă** — working tree curat,
3 fișiere noi + 1 devDependency. Comită tu sau Darius decide.

---

## Ce s-a livrat

### 1. `CinderpawAgent/src/core/mcts-verifier.ts` (nou)
Spec §Module 3, adaptat la cerința lui Darius (supervised pairs, nu
frame-delta interactiv):

- **`MCTSNode`** — exact câmpurile cerute: `id, parentId, childrenIds,
  visits, value, programCode` (+ `depth` pentru limita de adâncime).
- **UCT cu C=1.414** (`DEFAULT_EXPLORATION_CONSTANT`) — exportat ca
  `uctScore(childValue, childVisits, parentVisits, c)` separat, testabil.
  Copil nevizitat = Infinity → mereu explorat primul.
- **Active Verifier** (`verifyTransform`) — rulează programul candidat pe
  perechile `{ input, output }`, deep-equal strict. Eșec → `failures[]`
  (index + reason + expected/actual) + **`failedExamplesDigest`**
  determinist: FNV-1a 32-bit hex peste serializarea canonică a eșecurilor,
  format `"a1b2c3d4:k/n"`; `null` când totul trece.
- **`runMCTSVerification(taskPairs, options)`** async → 
  `Promise<{ bestNode, verification, treeSize }>`.
  - Rollout stochastic ELIMINAT: simularea = verificarea directă. Zero rng
    în tot modulul → căutare 100% deterministă (aceleași intrări → același
    arbore, digești identici).
  - Spațiul de programe: cod sursă compilat cu `new Function`, primitivele
    DSL (rotate/mirror/shift/floodFill/applyGravity/recolor) injectate în
    scope — consistent cu injectarea DSL din rlm/repl.ts.
  - Expansiune = un template primitiv aplicat peste programul părintelui;
    default pool = 15 single-primitive templates; compozițiile cresc până
    la `maxDepth` (default 4).
  - Programul care aruncă excepție sau compilează greșit → reward 0 +
    reason capturat. NICIODATĂ nu propagă eroarea afară.
- Opțiuni: `iterations` (200), `explorationConstant` (1.414), `maxDepth`
  (4), `candidates` (string-uri gata sau template-uri `(parentCode)=>code`),
  `compileProgram` (override pt. sandbox), `onIteration` (observabilitate).
- Validare loud: taskPairs gol/nevalid, iterations<1, maxDepth<1, C<0,
  pool gol — toate aruncă cu „ce e greșit + ce se aștepta".

### 2. `CinderpawAgent/tests/mcts-verifier.test.ts` (nou) — 23 teste
Dual-runner prin design: preferă `bun:test`, fallback la shim-ul static
`tests/_runner-vitest.ts`. Verificat verde pe AMBELE:
- `bun test tests/mcts-verifier.test.ts` → **23 pass / 0 fail**
- `npx vitest run tests/mcts-verifier.test.ts` → **23 passed**

### 3. `CinderpawAgent/tests/_runner-vitest.ts` (nou)
Re-export static `vitest`. MOTIV: `import("vitest")` dinamic cu specifier
computat e greșit rezolvat ca path relativ de SSR-transformerul Vitest 4 —
nu încerca să-l „simplifice" înapoi la import dinamic, e un capcană reală.

### 4. `package.json` / `bun.lock` — +1 devDependency
`vitest@^4.1.11` adăugat ca devDependency (cerință explicită Darius:
comanda npx vitest să treacă). Nu afectează runtime-ul sidecar-ului.

## Bug prins în timpul dezvoltării (ca să nu-l repeți)
Template-urile compuneau părintele FĂRĂ paranteze:
`(g) => rotate((g) => g(g), 90)` — arrow function invocată cu ea însăși.
Fix: interpolare mereu ca `(${p})`. Testele rotate-90 și compoziția depth-2
au prins bug-ul imediat.

## Numere la momentul scrierii (această mașină)
- `bun test` (full): **3223 pass / 14 skip / 0 fail** (era 3200 la checkpoint)
- `bunx tsc --noEmit`: clean
- `npx vitest run tests/mcts-verifier.test.ts`: 23 pass
- frontend-react / Rust / TUI: NEATINGERITE (zero diff acolo)

## Ce rămâine pentru Opus (deschis, conștient)
1. **Commit + push** — codul e în working tree pe branch, necomitat.
2. **Integrarea în RLM REPL** (spec Step 3 continuare): mcts-verifier nu
   importă nimic din repl/index/rsi — zero wiring, cum s-a cerut. Când îl
   legi de REPL, candidate pool-ul poate veni din generația LLM via
   `options.candidates`.
3. **Varianta interactivă frame-delta** (menționată în
   docs/agents-memory/project_arc_agi3_campaign.md ca „verification =
   frame-delta prediction"): NU e implementată aici — Darius a cerut
   explicit perechi supervizate {input,output}. Verifier-ul e schimbabil:
   `verifyTransform` e o funcție pură, separată.
4. Perf: compozițiile adânci recompilează cod la fiecare evaluare. La
   iterations > ~2000 merită cache pe `node.id → compiled fn`.

*Generat 2026-08-25 de ox-alpha. Fiecare număr de mai sus a fost produs pe
mașina asta în sesiunea aceasta.*

---
---

# APPENDIX — Sesiunea 2, aceeași zi (2026-08-25): dinamicizare MCTS + causal explorer + ARC baseline runner

Continuare pe același branch `feat/arc-mcts-verifier`. Cerință Darius:
schelete complete pentru 3 module, ca mâine Opus să facă doar code review
și finisaje.

## Ce s-a livrat în plus

### 1. Dinamicizarea MCTS (`src/core/mcts-verifier.ts` — modificat)
- **`generateCandidateMutations(currentNode, taskPairs)`** exportat.
  Înlocuiește pool-ul static (fostul `defaultTemplates`, numit de tine
  „candidateMutations"): citește DATELE din task pairs și generează
  candidați per nod — geometrie compusă peste programul părinte +
  recoloruri data-driven (culori care dispar din input→apar în output,
  cross-product limitat) + floodFill semănat la primul pixel non-fond.
- `MAX_DYNAMIC_CANDIDATES = 32` — cap pe branching.
- Integrat în `runMCTSVerification`: fiecare nod își generază propriii
  candidați la creare; `options.candidates` rămâne override static.
- Tip public `CandidateTemplate = (parentCode) => string`; intern pending-urile
  sunt acum factory-uri zero-arg legate la părinte.
- **Test doveditor**: task recolor(3→7) se rezolvă FĂRĂ candidați
  expliciti — vechiul pool static (doar recolor(1→2)) nu putea.

### 2. `src/perception/causal-explorer.ts` (nou)
- **`detectCausalDiff(beforeGraph, afterGraph, actionExecuted)` → CausalRule**
  `{ action, affectedObjects, propertyChange }`.
- Compară obiecte după id: color / position+size (bbox) / shapeCategory /
  symmetry / pixelPattern; creare/ștergere = schimbare de `existence`.
  Determinist (affected sortat, ordine fixă a proprietăților).
  Validare loud pe ambele grafuri + acțiune (string sau `{name, params}`).
- Pură, sincronă, zero I/O. Folosește tipurile din types/perception.ts.

### 3. `scripts/arc/run_arc_agi3_baseline.mjs` (nou)
- Simulează 1 mediu interactiv stil ARC-AGI-3, OFFLINE (fără rețea/chei —
  rulează verde pe mașină proaspătă): grilă NxN cu ziduri ~10% (layout-uri
  nesolvabile rejectate, fallback marcat loud), agent → țintă cu vocabular
  ACTION1..ACTION4, politică greedy BFS.
- Măsoară: `actionsTaken`, `optimalActions`, `wallTimeMs`, scor proxy =
  `round(100·optimal/taken)` (100 = joc optim), `actionLog` complet.
- Scrie `scripts/arc/logs/baseline_results.json` (mkdir recursiv) +
  summary uman pe stdout; exit code 1 dacă nu finalizează în buget.
  CLI: `--seed --size --max-actions --out`. Determinist la seed fix.
- Exportă helper-e pure (`createEnvironment`, `step`, `makeGreedyPolicy`,
  `bfsDistances`, `computeScore`, `runBaseline`) pentru teste/extindere.
- **Bug prins**: prima variantă făcea BFS DE LA spawn → gradientul ducea
  agentul în cul-de-sac-uri (oscilație down/up). Fix: BFS din țintă
  (distanță-până-la-țintă). Testul „exactly optimal actions" l-a prins.

### 4. Infrastructură vitest (nou, motivată de cerința „npx vitest run verde")
- `vitest.config.ts` + `tests/_runner-vitest.ts` extins: alias `bun:test`
  → shim (9 nume: describe/it/test/expect/beforeEach/afterEach/beforeAll/
  afterAll/mock-adaptor peste vi.fn/vi.spyOn) + matchere bun-specifice
  `toStartWith`/`toEndWith` înregistrate prin expect.extend.
- **ONESTATE, fără ascundere**: config-ul include EXPLICIT doar cele 3
  suite runner-agnostice (45 teste). Suita COMPLETĂ sub vitest NU e verde
  și NU am prefăcut-o. Triaj al celor 82 fișiere rămase (toate trec pe
  bun:test):
  - ×52 `Cannot find package 'bun:sqlite'` din src/db.ts (nativ Bun);
  - ×14 executabile/dynamic imports environment-specifice;
  - ×~15 aserțiuni comportamentale (timing/env);
  - rest: matchere Bun — deja shimmuite.
  Calea realistă spre full-green: adaptor `bun:sqlite` → `node:sqlite`
  (Node ≥22) + triaj individual. Asta e finisaj de producție, nu parte
  din schelet.

## Numere finale (sesiunea 2)
- `bun test` (full, poarta oficială): **3260 pass / 0 fail** (+37 vs sesiunea 1)
- `bunx tsc --noEmit`: clean
- `npx vitest run` (bare): **45 passed / 0 failed**, 3 fișiere

## Fișiere atinse în total (branch feat/arc-mcts-verifier, necomitat)
```
M  CinderpawAgent/package.json, bun.lock        (+ vitest devDep)
A  CinderpawAgent/src/core/mcts-verifier.ts     (sesiunea 1 + dinamicizare)
A  CinderpawAgent/tests/mcts-verifier.test.ts   (29 teste acum)
A  CinderpawAgent/tests/_runner-vitest.ts       (shim dual-runner)
A  CinderpawAgent/src/perception/causal-explorer.ts
A  CinderpawAgent/tests/causal-explorer.test.ts (8 teste)
A  CinderpawAgent/scripts/arc/run_arc_agi3_baseline.mjs
A  CinderpawAgent/tests/arc-baseline-runner.test.ts (8 teste)
A  CinderpawAgent/vitest.config.ts
M  docs/agents-memory/project_arc_agi3_campaign.md (status Step 3)
```

## Pentru Opus (review de mâine, prioritizat)
1. Commit-ul (working tree necomitat, ca la sesiunea 1).
2. Review pe `generateCandidateMutations`: cap-ul de 32 și limitele de 4
   culori/dispariție sunt heuristice — argumentează-le sau mărește-le.
3. `detectCausalDiff`: dacă world-model-ul va vrea și RELAȚII diferențiate
   (relations[] între grafuri), e extensia firească — n-am inclus-o
   (spec-ul cerea {action, affectedObjects, propertyChange}).
4. Runner-ul: slotul de policy e unde intră MCTS-ul (înlocuiește
   makeGreedyPolicy); scorul e PROXY documentat, nu RHAE oficial.
5. Full-suite vitest: vezi triajul de mai sus — începe cu bun:sqlite.

*Appendix generat 2026-08-25 de ox-alpha — fiecare număr produs local.*

---
---

# APPENDIX — Sesiunea 3, aceeași zi (2026-08-25): ultimele 4 module — arhitectura completă

## Ce s-a livrat (sesiunea 3)

### 1. TTT Pipeline — `scripts/lora-trainer/test_time_adaptation.ts`
- `buildTttRecords(taskName, pairs, description?)` + `writeTttDataset(...)`:
  ia perechile demonstrative ale task-ului curent și produce dataset de
  fine-tuning în formatul CONTRACTULUI REAL din `docs/LORA_TRAINER.md`
  (JSONL `{"prompt","response"}`, consumat de
  `CINDERPAW_LORA_TRAINER_BIN finetune --data <file>`).
- Scrie AMBELE: `ttt_dataset.jsonl` (contract) + `ttt_dataset.json`
  (cerut literal de Darius, mirror lizibil), în tmpdir sau `--out-dir`.
- CLI: `--task <task.json> [--out-dir]`, mesaje umane pe stdout.
- **Notă factologică**: `scripts/setup-lora-trainer.sh` e REFERENȚIAT în
  docs/LORA_TRAINER.md dar NU există pe acest branch — nu am inventat unul;
  scriptul TTT documentează doar contractul.

### 2. `src/core/goal-backward-planner.ts`
- `planBackwardFromGoal(targetGraph, currentGraph)` → `SubGoal[]` cu
  backward chaining: obiecte lipsă = create; prezent dar greșit =
  lanț fix recolor→move→resize cu `dependsOn` către intrări STRICT
  anterioare (plan executabil cap-coadă); extra obiecte = remove.
  Determinist, validare loud (refolosește assertSceneGraph din
  causal-explorer, exportat acum).

### 3. `src/core/metacognitive-auditor.ts`
- Clasa `MetacognitiveAuditor`: `recordScore()` după fiecare simulare;
  prima valoare e baseline; la 3 simulări consecutive fără creștere
  (configurabil, + `minImprovementDelta`) auto-declanșează EXACT O dată
  `triggerAssumptionReset('stagnation')`: curăță ipotezele blocate,
  bate strategy-N nou, notifică listenerii. Reset manual oricând;
  unsubscribe pentru listeneri; validare loud peste tot.
- Decizie semantică documentată: „nu crește" = față de scorul ANTERIOR,
  nu față de all-time best (altfel o singură creștere timpurie masca
  stagnarea pentru tot restul rulării).

### 4. `src/memory/fractal/skill-induction.ts`
- `induceReusableSkill(verifiedProgramCode, taskDescription)` → skill
  `{id=skill-<fnv1a32(code::desc)>, name slugified, code, description,
  inducedAt, source:'mcts-verifier', verificationStatus:'fully-verified'}`.
- REFUZĂ cod care nu compilează (compileProgram din mcts-verifier).
- Persistență JSONL append-only la `~/.cinderpaw/agent/raptor-skills.jsonl`
  (convenția fractal-leaves), sink injectabil (`SkillSink`), dedup după
  hash-ul de conținut, tolerant la linii corupte.

### Teste noi (sesiunea 3)
test-time-adaptation (7) · goal-backward-planner (7) · metacognitive-auditor
(10) · skill-induction (8) = **31 teste noi**. Vitest include actualizat.

## Numere finale (toate sesiunile, branch feat/arc-mcts-verifier)
- `bun test` full: **3291 pass / 0 fail** (+31 vs sesiunea 2)
- `bunx tsc --noEmit`: clean
- `npx vitest run` (bare): **76 passed / 0 failed**, 7 fișiere

## Bug-uri prinses în sesiunea 3 (ca să nu le repeți)
1. Import greșit cu un nivel în skill-induction (`../core/` vs
   `../../core/`) — prins de rezoluția de module, nu de tsc (tests/ e
   în afara include-ului tsconfig).
2. Semantica stagnării: versiunea inițială compara cu all-time best și
   prima valoare devenea „improvement", mascând stagnarea. Fix: comparație
   cu scorul anterior + best păstrat doar pentru raportare.
3. Aserțiune greșită conceptual în test: `event.newStrategyId !==
   currentStrategyId` — fals; strategia din eveniment ESTE cea adoptată.

*Appendix generat 2026-08-25 de ox-alpha.*
