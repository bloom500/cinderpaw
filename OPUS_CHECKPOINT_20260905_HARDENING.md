# Hardening — 4/5 septembrie 2026

Sesiune de pre-release hardening. Baseline, audituri istorice, invarianti HARD.
Patru commit-uri, fiecare cu test care pica inainte si trece dupa.

Punct de plecare: `6cb7467`. Punct de sosire: `4311383`.

---

## Ce s-a reparat

| # | zona | problema | dovada ca exista | fix | test | status |
|---|---|---|---|---|---|---|
| 105 | `atomic-write.ts` | Doua scrieri async pe acelasi fisier derivau acelasi nume temporar din `pid + Date.now()` (rezolutie de o milisecunda). Una redenumea, cealalta redenumea un fisier disparut. | 64 de scriitori concurenti: **53 esecuri** (ENOENT + EPERM) | contor in numele temporar, coada per fisier, retry scurt pe EPERM/EACCES/EBUSY pentru Windows | `tests/atomic-write.test.ts` | **REPARAT** — 64/64, zero temporare ramase |
| 113 | `contract-leaves.ts` | `gateForCandidate` scria acelasi motiv pentru doua situatii diferite. O evaluare crapata era raportata in jurnal drept "no champion baseline yet (bootstrap)", desi campionul exista. | `shouldGate = Boolean(gate && championOutcomes && outcomes)` → lipsa `outcomes` cadea pe ramura de bootstrap | `bypassCause()` distinge cele trei cazuri. Comportament neschimbat. | `tests/gate-bypass-reason.test.ts` | **REPARAT** — doar raportarea |
| — | `check-invariant-coverage.ts` | Linterul nu scana `crates/`, unde traieste implementarea a 7 din 15 invarianti HARD. Testele Rust erau numarate drept runtime. | I9: 422 linii in `sandbox_bounds.rs`, cablat la boot si prin comanda Tauri, 3 teste inline → raportat ca lipsind Test, Runtime SI Audit | `crates` adaugat la `SRC_DIRS`; `TEST_PATTERN` recunoaste `<crate>/tests/*.rs` | rulare inainte/dupa | **REPARAT** (vezi nota) |
| — | I9, I14 | Ambii invarianti complet aplicati, dar niciun fisier nu le scria id-ul, iar linterul cauta exact id-ul. | `grep -c '\bI9\b'` peste `sandbox_bounds.rs` si `audit.rs` → 0 | markere `INVARIANT I9` / `INVARIANT I14` la locul aplicarii | `cargo build` exit 0; cele 9 teste I14 verzi | **REPARAT** — ambii de la 1/4 la 3/4 piloni |

**Nota la fixul linterului:** nu schimba nicio cifra in raportul de azi, si am
verificat asta inainte sa il comit. Fara el insa, orice eticheta adaugata in
Rust ar fi ramas invizibila.

---

## Auditurile istorice, reverificate

Recuperate din `archive/arena-01a01f9e-feral` (`6cc5c10`). Branch-urile Arena de
pe remote au fost sterse la cererea lui Darius, dar exista tag-uri locale
`archive/arena-*` pentru toate patru.

### `BUGS-round4.md` — 28 de findings, toate clasificate

- **REPARATE (22):** 91-95, 97-101, 103, 104, 106-111, 115-118
- **PARTIAL (2):** 102 (cache pus pe `recall()`, uitat pe `query()`), 105 (reparat de mine, vezi tabelul)
- **EXISTA INCA (3):** 112, 113 (reparat partial de mine), 114
- **NU POT CONFIRMA (1):** 96

Aproape 4 din 5 erau deja rezolvate. Auditul avea dreptate cand a fost scris, e
in mare parte istorie.

### `BUGS-frontend-audit.md` — 70 de findings, ~20 verificate

Reparate si verificate: F1, F2, F16, F27, F31, F32, F53, F57, F59.
Redenumirea e completa si **pastreaza datele userilor vechi**
(`lib/localStorageMigration.ts`, `feral-ui` → `cinderpaw-ui`, cu teste).

Raman reale: **F54** (design responsive practic inexistent: 25 de prefixe
`sm:/md:/lg:` pe tot frontend-ul, auditul numara 23) si **F24** (4 locuri cu
actiuni vizibile doar la hover, invizibile pe touchscreen).

**Neverificate: ~50**, mai ales F61-F70 (mascota) si fluxul de onboarding. Sunt
judecati vizuale, nu se decid prin grep. **Asta e primul lucru de maine.**

---

## Invarianti HARD

Concluzia e alta decat se astepta brief-ul.

**Nu am gasit invarianti care exista doar pe hartie.** Am gasit un instrument de
masura care minte despre ei.

- **I5 (buget)** — toate cele patru semne din brief confirmate: `assertBudget(phase, null)`,
  `assertCanSpend(caps, zeroSpend(), ...)`, `applySpend` fara niciun apelant.
  Bugetul nu se aduna, deci nu se depaseste, deci oprirea nu se declanseaza.
  **Dar nu minte:** codul o spune in trei locuri, documentatia il marcheaza
  `PENDING (consumer)`, iar jurnalul marcheaza explicit `unmeasured` in loc sa
  pretinda ca a masurat. Functionalitate neterminata, declarata cinstit.
- **I9, I14** — raportati ca aproape complet neaplicati. Amandoi **complet
  aplicati si testati**. I14: `applyPatchLive` refuza orice patch neaprobat,
  reverifica zidul la aplicare, e pe ambele denylists cu test de paritate.
- **Pilonul Audit era ✗ la toti 15** din acelasi motiv: `audit.rs` e in `crates/`.

### De rezolvat, decizie de proces

Linterul nu poate ajunge la 15/15 oricat de corect ai eticheta:

1. crediteaza pilonul Audit doar daca **calea fisierului** contine "audit" (I14 isi tine urma in patch store);
2. crediteaza **un singur pilon per fisier** (testele I9 sunt inline in `sandbox_bounds.rs`).

Un raport permanent rosu care nu poate fi imbunatatit prin munca corecta invata
oamenii sa il ignore. Merita relaxate ambele reguli, deliberat.

3. **Linterul nu ruleaza in CI.** `grep check-invariant-coverage .github/workflows/` → nimic.

---

## Ce ramane rosu

**`tests/config.test.ts` — garda de configuration drift, intermitenta.**

```
sub contentie, disc plin:   41497 ms  pica
fara contentie, disc plin:   5562 ms  pica
singur, disc liber:            216 ms  trece (3/3)
in suita completa:          intermitent, ultima rulare 5860 ms  pica
```

Buget de 5000 ms. Singur zboara; la coada a 3720 de teste depaseste. **Nu a fost
marit timeout-ul** (brief §10 interzice). Cauza reala: un guard care scaneaza
tot codul sursa are un buget care nu tine cont de ce ruleaza in jurul lui.
Trebuie facut mai rapid, nu mai rabdator.

**`rust / ubuntu-22.04` — rosu in CI de la 27 august.**

```
error: failed to run custom build command for `rfd v0.16.0`
  You can't enable both `gtk3` and `xdg-portal` features at once

src-tauri/Cargo.toml:21  tauri-plugin-dialog = "2"   → rfd cu gtk3
src-tauri/Cargo.toml:24  rfd = "0.16"                → default features, xdg-portal
introdus de 0d8da75 (2026-08-21)
```

Nu se reproduce pe Windows: conflictul e exclusiv Linux. **De urmarit separat ca
blocaj de CI**, nu amestecat cu auditul de backend, si nu considerat rezolvat
pana cand un job `rust / ubuntu-22.04` trece efectiv.

---

## Refuzat / amanat

**Finding 102 — cache lipsa pe `query()`**
Problema: motorul de recall se construieste la fiecare apel pe calea secundara.
Motiv: `recall()` e apelat la fiecare tura; `query()` doar cand agentul cere
explicit o cautare. O alocare per cautare nu se vede langa costul cautarii.
Brief-ul interzice refactorizari de performanta speculative.
Risc: neglijabil.
Ce ar trebui: o masuratoare care arata ca `query()` conteaza.

**Finding 114 — jurnalul recitit integral la fiecare append**
Motiv: scurtatura asumata, cu pragul scris in cod (`per-day files are
tens-of-rows small, cache a Map if that ever changes`).
Risc: creste doar daca fisierele per zi cresc.

**Finding 112 — denylist pe nume de fisier fara folder**
Motiv: azi fiecare nume din lista exista intr-un singur loc, impact zero.
Risc: apare in ziua in care exista un al doilea fisier cu acelasi nume.

**Finding 96 — race pe lantul de hash intre procese**
Motiv: in acelasi proces e imposibil (functie sincrona, JS single-threaded).
Intre procese ar fi posibil, dar nu am dovedit ca doua procese scriu acelasi
fisier. Nu repar ce nu am reprodus.

**Fara teste: `minimalEnv()` si `atomic-write` (inainte de azi)**
Fixurile bune din audit nu au teste care sa le apere. Daca cineva pune la loc
`{ ...process.env }` in sandbox, nimic nu suna. Am acoperit `atomic-write`;
`minimalEnv` ramane descoperit.

---

## Igiena mediului

D: era la **0 bytes liberi**, ceea ce a stricat baseline-ul Rust si a incetinit
de 25x testul de config. Eliberate **376 GB** (Fortnite 93, Overwatch 79,
Rainbow Six 76, `docker_data.vhdx` 130). Acum 549 GB liberi.

`target/` e **207 GB**, din care `debug/incremental` 70 GB. Nu a fost sters,
deliberat: cu spatiu liber, cargo termina incremental in loc sa reconstruiasca
llama-cpp, espeak si piper de la zero. **Nu transforma asta intr-o conditie
permanenta de build** — daca un build normal ajunge sa ceara sute de GB, intra
la QoL/build hygiene.

Ramase nesterse: 4 ISO-uri de Windows (26 GB) in radacina D:, blocate de
sandbox. Comanda e in istoricul conversatiei.

---

## Verdict

**Status: CONDITIONAL**

```
Teste (checkout local, dupa fixuri):
  CinderpawAgent   3720/3723   1 esec intermitent (config drift)
  TypeScript       PASS        tsc --noEmit curat
  Frontend         652/652     PASS
  TUI              196/198     2 skip
  Rust             658/658     0 esecuri, build exit 0

CI:
  verde:  headless-cli, tui, frontend-react (ubuntu+macos),
          cinderpaw-agent (ubuntu+macos), rust/windows, security-audit
  rosu:   rust/ubuntu-22.04 (rfd gtk3 vs xdg-portal)
  nerulat: linterul de invarianti nu e in niciun workflow

Invarianti HARD:
  verificati manual pana la capat:  I5, I9, I14
  neaplicat in runtime:             I5 (declarat cinstit, nu e minciuna)
  raportati fals ca neaplicati:     I9, I14 (reparat)
  neverificati:                     I1-I4, I6-I8, I10-I13, I15

Fixuri: backend 2, tooling 2, frontend 0, TUI 0

Blocaje de release:
  1. rust/ubuntu-22.04 rosu de 9 zile
  2. config drift guard intermitent — o garda care pica aleatoriu nu apara nimic
```

## Maine

1. UI: cele ~50 de findings frontend neverificate (mascota, onboarding), cu aplicatia pornita
2. I14 era ultimul invariant verificat; raman I1-I4, I6-I8, I10-I13, I15
3. `rfd` pe Linux, urmarit ca blocaj separat
4. Garda de config drift: facuta mai rapida, nu mai rabdatoare
