# Bug hunt & hardening — 5 septembrie 2026

A doua trecere de pre-release din aceeasi zi. Punct de plecare: `68d186b`.
Punct de sosire: `5e0c987`. Cinci commit-uri, fiecare cu test care pica inainte
si trece dupa.

Concluzia care conteaza nu e lista de bug-uri. E ca **patru din cele cinci
defecte sunt acelasi defect**: cod care compara siruri de cai sau de
identificatori exact, pe doua sisteme de fisiere care nu fac diferenta intre
majuscule si minuscule. Windows si macOS. Adica exact platformele pe care
livram.

---

## Tabelul

| # | Zona | Problema | Dovada / reproducere | Cauza | Fix | Test | Status |
|---|---|---|---|---|---|---|---|
| 1 | `egress/tool-permissions.ts` | Zidul de refuz la apel comparaba caile ca siruri exacte. `~/.Cinderpaw/byok.json` deschide exact acelasi fisier ca `~/.cinderpaw/byok.json` pe NTFS si APFS — deci uneltele proprii ale agentului citeau cheile API, token-urile OAuth si repo-ul RSI schimband o litera. | Rulat pe masina asta: `.cinderpaw`, `.Cinderpaw`, `.CINDERPAW` intorc toate **acelasi fisier de 1226 bytes**. `resolveAllowedPath` refuza prima varianta si le permite pe celelalte doua. | Un `startsWith` pe siruri, intr-un mediu unde sistemul de fisiere nu e case-sensitive. Oglinda defectului era si ea vie: o litera de disc mica scotea o radacina legitima *in afara* `allowedPaths`. | Un singur predicat de continere, `pathWithin`, pliat pe minuscule pe win32/darwin. Folosit de zid, de exceptia `workspace` si de potrivirea radacinilor, ca sa nu poata fi in dezacord. `shell-exec` avea jumatatea win32 si ii lipsea darwin. | `tests/sandbox.test.ts` — 4 teste noi (4 picau) | **REPARAT** |
| 2 | `tools/builtin/cowork-create.ts` | `cowork_create_teammate` deriva id-ul randului din nume, dar refuza duplicatele comparand **numele**. "Atlas" si "Atlas!" dau acelasi id. Al doilea cadea in `upsert` → `ON CONFLICT DO UPDATE`: primul coleg era suprascris (rol, instructiuni, scope de unelte, model pin), noul venit mostenea **inbox-ul lui**, iar unealta raporta o creare reusita. | `tests/cowork-identity-collision.test.ts` cu store real: 4 din 5 perechi picau. Mesajul propriu al uneltei promite "this tool will not overwrite them". | Garda pe nume, cheia pe id. Testul de cap existent falsifica `upsert`, deci coliziunea nu putea fi vazuta acolo. | Garda e pe id acum, si refuzul spune de ce doua nume diferite dau acelasi id. | `tests/cowork-identity-collision.test.ts` (nou, 5 teste) | **REPARAT** |
| 3 | `rsi/infra/journal.ts` + `l6-meta/meta-evolution.ts` | INVARIANT I4 spune ca un rand corupt e semnalat, **niciodata aruncat in tacere**. `readJournal` arunca eroare pe JSON invalid, dar sarea in tacere peste orice rand care se parsa si pica type guard-ul. Un test existent fixa comportamentul gresit. | `verifyJournal` verifica doar lantul de hash, deci un rand scris stricat trece verificarea; `collectJournal` raporta apoi `excludedRows: 0` pentru un fisier din care tocmai pierduse randuri. Test nou, verificat picand fara fix. | Doua straturi cu definitii diferite pentru "corupt": lantul si schema. | Citirea arunca eroare si numeste randul (numerotare 1-based, aceeasi ca `verifyJournal`). `catch {}` din L6 raporteaza prin acelasi `onBadFile` pe care ramura vecina, la sase randuri distanta, il folosea deja. | `tests/rsi-journal.test.ts` (2, unul inlocuind asertia inversa), `tests/rsi-journal-chain.test.ts` (1) | **REPARAT** |
| 4 | `memory/privacy.ts` + `rsi/secret_redact.rs` | Doua din cele cinci prefixe de cheie pe care `byok.rs` le **anunta** (`gsk_` Groq, `nvapi-` NVIDIA) nu erau recunoscute de niciunul dintre cele doua redactoare. Fluxul de setup ii spune omului sa lipeasca cheia in chat; transcriptul se scrie pe disc. | Fixture-ul partajat, cu cele doua cazuri adaugate primele: TS pica, Rust pica. | Ambele liste de tipare crescusera "dupa cine si-a amintit", nu dupa catalog. | Prefixele adaugate pe ambele parti. Fixul real e testul: `byok_key_formats_are_redacted` parcurge catalogul BYOK si cere ca fiecare `key_format` declarat sa fie redactat. | `crates/.../tests/secret_redaction_parity.rs` + `tests/pii-redaction.test.ts` | **REPARAT** |
| 5 | `core/run-id.ts` | INVARIANT I13 promite ca doua rulari de benchmark nu impart niciodata un profile dir — testul o spune in cuvintele alea. `run-1` si `RUN-1` sunt doua id-uri si **un singur director** pe NTFS/APFS. | Masurat: `mkdir run1` apoi `mkdir RUN1` lasa UN director, iar fisierul scris al doilea e ce citesc ambele grafii. Fara traversare si fara rescriere — de aia testul `../escape` existent nu putea sa-l vada. | `[A-Za-z0-9._-]` intr-un sir care devine nume de director. | Id-urile trebuie sa fie minuscule. Refuz, nu pliere — `run-id.ts` argumenteaza deja ca plierea a doua rulari peste un director *e* scurgerea, nu leacul. O definitie, deci toate cele cinci apeluri sunt acoperite. | `tests/benchmark-mode.test.ts` (2 noi) | **REPARAT** |
| 6 | `egress/egress-proxy.ts` | `hostMatchesWhitelist` plia pe minuscule **intrarea** din allowlist si avea incredere in apelant pentru **host**. | Latent, nu viu: toate cele trei apeluri trec `parsed.hostname`, deja pliat de WHATWG URL. | Precondiție nescrisa pe un predicat de securitate — forma care a produs celelalte trei bug-uri. | Ambele parti pliate. | acoperit de suita egress existenta | **REPARAT (latent)** |

---

## Release Verdict

### CONDITIONAL

Nu NO-SHIP: nu a ramas niciun sistem deconectat, nicio pierdere de stare, niciun
esec tacut intr-un flux critic si nicio violare de invariant HARD nereparata.
Toate cele patru suite sunt verzi.

Nu SHIP: doua lucruri raman neverificate de **mine**, si nu vreau sa fie
descoperite de un strain.

**Conditiile:**

1. ~~Linux nu a fost construit.~~ **REZOLVAT** — vezi addendumul de mai jos.
   `rust / ubuntu-22.04` e verde, si intreaga suita ruleaza acum pe ubuntu si
   macOS.
2. **~50 de findings de frontend raman neverificate** (mascota, onboarding) —
   sunt judecati vizuale, cu aplicatia pornita. Erau primul lucru pe lista de
   ieri si tot nu s-au facut.

---

## Critical Findings

**Zidul de fisiere nu tinea, si PROMISES.md spunea ca tine.**

Sectiunea "What we do not promise" din `PROMISES.md` scrie, ca fapt verificabil
de utilizator:

> Its own file tools refuse `~/.cinderpaw` and `~/.ssh` outright.

Propozitia aia era **falsa pe Windows si pe macOS** — adica pe fiecare platforma
pe care livram — pentru oricine scria o litera mare. Nu e o scurgere teoretica:
`byok.json` (chei API), `connectors.json` (token-uri OAuth) si repo-ul RSI erau
toate lizibile si scriibile de uneltele proprii ale agentului.

Asta e singurul finding din trecerea asta pe care il numesc release-critical, si
motivul e ca era o promisiune scrisa, nu o presupunere interna.

Doua note care conteaza pentru cat de mult sa te sperii:

- Nu am dovada ca s-a intamplat vreodata. E o cale deschisa, nu un incident.
- Codul **stia** deja lectia in alta parte: `commit_genome_inner` refuza
  `refs/heads/Main` case-insensitive, si ambele denylists de patch-uri
  (I14) compara basename-urile case-insensitive, cu comentariul care explica
  exact de ce. Zidul de fisiere era locul unde doctrina nu ajunsese.

---

## Fixed

Cele sase din tabel. Cele care ar fi jenat cel mai tare la lansare, in ordine:

1. Zidul de refuz ocolit cu o majuscula (chei, token-uri, creierul agentului).
2. Doua din cinci prefixe de cheie pe care noi le anuntam salvate in clar.
3. Crearea unui coleg stergea alt coleg si ii mostenea inbox-ul, raportand succes.
4. Randuri de jurnal pierdute in tacere, cu contabilitatea raportand zero pierderi.
5. Doua rulari de benchmark care impart un profile dir.

---

## Refused / Deferred

**Garda de config drift, notata ieri drept blocaj de release.**
Nu se reproduce. 3 rulari izolate (150-156 ms fiecare) si **doua rulari de suita
completa** (3721 si 3735 de teste), zero esecuri. Esecul de ieri se coreleaza cu
D: la 0 bytes liberi; acum sunt 549 GB. Nu repar ce nu pot reproduce, si nu
maresc un timeout ca sa ascund o cauza de mediu. **De urmarit, nu blocaj.**
Ce ramane adevarat: un buget de 5000 ms pe o garda care scaneaza tot `src/` e
subtire. Daca reapare, fixul e s-o faci mai rapida.

**Agentul cowork sters si recreat isi mosteneste inbox-ul.**
`remove()` sterge randul agentului si lasa `cowork_messages` adresate id-ului.
Un agent recreat cu acelasi nume primeste id-ul si posta veche. **Nu am reparat:
nu exista nicio suprafata de stergere** — `agents.remove` nu are niciun apelant
in `src/`. Cale neatinsa. Ziua in care apare butonul "sterge coleg" e ziua in
care asta trebuie reparat in aceeasi diza.

**`parseTools` citeste o coloana corupta drept "unrestricted".**
Un coleg limitat la `[]` unelte devine nelimitat daca coloana se corupe.
Comentariul argumenteaza ca a-l amuti in tacere e mai rau. Pentru un *scope de
securitate* directia e gresita, dar coloana e scrisa doar de
`JSON.stringify(string[])` si intreaga baza de date e inaccesibila agentului.
**Risc arhitectural, nu blocaj.**

**Worker-ul Node nu e inregistrat in pid file.**
`reap_orphan_server` recupereaza doar `livekit-server.exe`. Un crash pe Windows
lasa si worker-ul Node in viata. Nu produce doua voci (serverul lui e mort), dar
e o scurgere de proces per crash. Nu l-am atins: nu am reprodus un crash.

**I5 — bugetul nu se aduna, deci nu se depaseste, deci nu opreste.**
Reverificat independent, si e exact ce spune documentatia:
`assertBudget(phase, null)` (cale fail-open), `zeroSpend()`, si `applySpend`
fara niciun apelant in productie. **Nu e o violare de invariant**: enuntul I5 e
"cand `assertCanSpend` intoarce `allow:false`, apelantul TREBUIE sa opreasca" —
si nu intoarce niciodata false. E functionalitate neterminata, marcata
`PENDING (consumer)` in doc, spusa in trei locuri in cod, si jurnalul scrie
`unmeasured` in loc sa pretinda ca a masurat. `PROMISES.md` nu promite nicio
limita de buget utilizatorului. **Nu se repara in trecerea asta** — are nevoie
de un estimator per etapa, adica de o functionalitate, iar brief-ul interzice.

---

## Remaining Red

**Nimic rosu in teste.** Toate cele patru suite trec.

Neverificat, si spun asta ca atare in loc sa-l numar ca verde:

- **`rust / ubuntu-22.04`** — fixul `rfd` e in arbore, build-ul Linux n-a rulat.
- **Frontend, ~50 de findings vizuale** — mascota si onboarding.
- **I1, I2, I6, I7, I8, I10, I11, I12** — nu le-am atacat pe fiecare pana la
  capat. Ce am verificat pe calea I1: `candidate_score > prior_score_value` e
  strict, NaN cade pe refuz (fail-closed), scorul declarat trebuie sa fie unul
  pe care procesul asta l-a calculat (`was_scored_here`), si ambele grafii ale
  lui `main` sunt refuzate ca nume de ramura candidat.

---

## Architectural Risks

**1. Sistemele de fisiere case-insensitive sunt un punct orb sistemic, nu trei
coincidente.**
Patru din cinci defecte, in patru module fara nicio legatura intre ele. Regula
pentru orice cod nou: daca un sir devine cale sau nume de director, comparatia
se pliaza pe win32 si darwin. Codul stia deja asta in trei locuri
(`code_patch.rs`, `code-genome.ts`, `commit_genome_inner`) si nu in celelalte
patru — doctrina exista, difuzarea ei nu.

**2. `check-invariant-coverage` masoara etichetare, nu aplicare.**
Un pilon e creditat cand un fisier **numeste** id-ul invariantului. Atat poate
sti un grep. Nu poate deosebi o aplicare de un comentariu despre una, iar
marcajele care fac un rand verde se scriu de mana. **14/15 inseamna "etichetat
unde ar trebui sa traiasca", niciodata "aplicat"** — iar pilonii care conteaza
cel mai mult (consumatorul lui I5, impartirea per-tenant a lui I13) sunt exact
cei pe care un grep nu-i poate vedea. Am pus propozitia asta in raportul insusi,
acolo unde se citeste cifra.

**3. Portita din `--strict`.**
Modul strict sare peste orice invariant al carui Status incepe cu "PENDING".
Corect ca mecanism pentru munca amanata deliberat — si totodata un buton prin
care oricine poate face un invariant care pica sa treaca, editand documentul pe
care garda il pazeste.

**4. Contractul de siguranta numea saptesprezece fisiere care se mutasera.**
Reparat. Merita numit ca risc pentru ca e exact cum a ratacit auditul de ieri:
a raportat I9 si I14 drept aproape neaplicate cand erau complet aplicate si
testate, pentru ca uneltele si caile aratau spre arborele vechi.

**5. `progress.ts` deseneaza o zi corupta ca zi goala.**
Un fisier de jurnal corupt da `cycles: 0`, ceea ce arata identic cu o zi in care
agentul n-a facut nimic. Utilizatorul vede o linie plata si trage concluzia
gresita. Nu l-am atins — schimba un tip si frontend-ul, adica depaseste trecerea
asta — dar e aceeasi familie cu I4 si ar trebui sa fie urmatorul.

---

## Test Baseline

Rulat local, dupa fixuri, pe checkout-ul curent:

```
CinderpawAgent   3735 pass   14 skip   1 todo   0 fail   (3750 in 326 fisiere)
                 baseline la inceputul sesiunii: 3721 pass, 0 fail
TypeScript       tsc --noEmit curat
frontend-react    683 pass   79 fisiere   0 fail
                 (checkpoint-ul de ieri spunea 652 — era stale)
TUI (go)          toate pachetele ok
Rust              659 passed   0 failed   3 ignored
                   cinderpaw-core 466, cinderpaw 164, cinderpaw-cli 29
```

Teste noi in trecerea asta: **14** (4 zid de refuz, 5 identitate cowork,
3 jurnal I4, 2 run-id) plus `byok_key_formats_are_redacted` pe partea Rust si
2 cazuri in fixture-ul partajat de redactare.

Fiecare a fost rulat in starea stricata inainte de fix. Doua verificate explicit
prin `git stash` al fisierului de sursa, cu iesirea pastrata:

```
provider 'groq' advertises key_format 'gsk_' but the redactor does not
recognise it — a key of that shape is written to the transcript in plaintext
```

Linterul de invarianti: `--strict` exit 0, 14/15, I13 Audit ramas si documentat
ca `claimed, not implemented`. Ruleaza in CI (`ci.yml:275`) — nota de ieri ca nu
rula era stale.

---

## Ce am incercat sa sparg si a tinut

Brief-ul cere si asta, nu doar lista de gauri.

- **I1, scor inventat.** Un scor declarat trebuie sa fie unul pe care procesul
  asta l-a produs (`was_scored_here`). NaN nu poate castiga niciodata un ratchet
  (`NaN > x` e fals). Un candidat nu poate ateriza direct pe linia promovata:
  `Main`, `main `, `master` si `MASTER` sunt toate refuzate ca nume de ramura
  candidat, case-insensitive si dupa trim.
- **I1/I2, rand de audit pierdut.** Randul se scrie **inainte** ca ref-ul sa se
  miste, si un esec la scriere abandoneaza avansarea. Un `main` mutat fara
  inregistrare nu poate exista.
- **I15, ocolirea garzii prin coada de evenimente.** Handler-ele care emit in
  timpul pompei trec tot prin `emit`, deci prin garda. Nu am gasit nicio cale.
  (Nu exista inca niciun emitent de `EvalHalted` — asta e `PENDING (emitter)` in
  doc, si e adevarat.)
- **I13, traversare prin run id.** `..`, `.`, slash-uri si backslash-uri erau
  deja refuzate. Am gasit doar coliziunea de majuscule, si am reparat-o.
- **I14, denylist-ul de patch-uri.** Ambele parti (TS si Rust) compara deja
  basename-urile case-insensitive, cu comentariul care spune de ce. A tinut.
- **Allowlist de domenii.** Toate cele trei apeluri pliau deja host-ul; am
  inchis precondiția nescrisa oricum.
- **Manifest de unelte.** Un manifest nu poate declara `fs:*` fara
  `allowedPaths`, nici `process:spawn` fara `allowedExecutables`, nici retea
  fara domenii. Un `mode: "read"` nu poate satisface un `fs:write`.
  Traversarea si evadarea prin symlink sunt acoperite de `realpathBestEffort`.

---

## Maine

1. Un job Linux verde. E singurul lucru care transforma "pare reparat" in
   "reparat" pentru `rfd`.
2. Cele ~50 de findings de frontend, cu aplicatia pornita. A doua zi la rand pe
   lista.
3. `progress.ts`: o zi corupta nu trebuie sa arate ca o zi linistita.
4. Restul invariantilor HARD, atacati pana la capat, nu doar cititi.

---

# ADDENDUM — CI, dupa trecerea principala

Darius a intrebat daca macOS si Linux primesc aceleasi lucruri ca Windows, si a
aratat ca ultimul CI picase pe mac si pe ubuntu. Raspunsul a schimbat verdictul
in doua locuri.

## Al saptelea bug, si cel mai rau dintre toate

**Toate cele 325 de fisiere de test ale agentului picau pe Linux si macOS.**

`0a8d761` (de azi) a facut `CINDERPAW_HOME` nesters cu:

```
Object.defineProperty(process.env, "CINDERPAW_HOME", { configurable: false })
```

Node specifica `process.env` sa accepte doar descriptori de date configurable,
writable si enumerable, si refuza orice altceva cu
`ERR_INVALID_OBJECT_DEFINE_PROPERTY`. Bun 1.3.14 — ce are masina asta — il
accepta. Bun-ul `latest` pe care runnerele si-l instaleaza, nu. Apelul arunca
eroare **in preload**, care ruleaza inainte ca vreun fisier de test sa fie
importat:

```
0 pass, 325 fail, 325 errors. Ran 325 tests across 325 files. [34.00ms]
```

Nimic nu a rulat. `ubuntu-latest` si `macos-latest` sunt singurele doua
platforme pe care suita agentului ruleaza in CI, deci **suita nu a avut nicio
acoperire de CI nicaieri**, in timp ce trecea 3735/0 local pe Windows — care nu
e in acea matrice. Baseline-ul din tabelul de mai sus era Windows-only si nu
stiam asta cand l-am scris.

O protectie care depinde de o permisiune pe care runtime-ul are dreptul sa o
refuze nu e o protectie. Inlocuita cu un `afterEach` global inregistrat din
acelasi preload: nu cere nicio permisiune, pastreaza atribuirea (un test isi
poate alege propriul home), si pica **testul care a sters variabila**, nu unul
nevinovat de mai tarziu. Restaurarea se face inainte de aruncarea erorii.

Dovedit cu o sonda de doua teste: A sterge si e picat pe nume, B de dupa are in
continuare home-ul temporar.

## Baseline pe trei platforme

PR #19, toate cele 10 job-uri verzi:

```
ubuntu-latest  / cinderpaw-agent   3744 pass  0 fail   3750 in 326 fisiere
macos-latest   / cinderpaw-agent   3748 pass  0 fail   3750 in 326 fisiere
windows (local)                    3735 pass  0 fail   3750 in 326 fisiere
rust / ubuntu-22.04                verde  ← blocajul rfd chiar s-a dus
rust / windows-latest              verde  (--features piper,kokoro)
frontend-react (ubuntu + macos)    verde
tui (go), docs, security-audit, headless-cli   verde
```

Doua lucruri de citit din cifrele alea:

1. **macOS a rulat testele mele de case-insensitivity si le-a trecut.** Local nu
   puteam verifica decat jumatatea win32; APFS a confirmat-o pe cealalta pe
   hardware real. Pe Linux se sar corect (`test.if(caseInsensitiveFs)`).
2. **Windows trece cele mai PUTINE teste dintre cele trei** (3735 vs 3744 vs
   3748). Diferenta e in skip-uri, nu in esecuri — dar platforma pe care scrie
   ca o testam cel mai mult e cea pe care ruleaza cel mai putin.

## Paritate — raspunsul la intrebare

Toate cele patru build-uri pleaca din acelasi commit si acelasi cod. Nu sunt
insa identice, si diferenta e deliberata:

| Build | Features |
|---|---|
| Windows x64 | `inference-vulkan, piper, kokoro` |
| macOS Apple Silicon | `inference-metal, piper, kokoro` |
| macOS Intel | `inference, piper, kokoro` |
| **Linux x64** | `inference-vulkan` — **fara piper, fara kokoro** |

**Utilizatorul de Linux nu primeste TTS on-device.** Ambele motoare merg pe
acelasi ONNX Runtime, al carui prebuilt de Linux cere glibc 2.38, iar 22.04 are
2.35. E documentat in `ci.yml` si in `src-tauri/Cargo.toml`, si e o alegere, nu
o scapare. Restul — agentul, memoria, RSI, cowork, uneltele, voice prin
provider — e acelasi cod pe toate patru.

`PROMISES.md` spune deja "The Mac and Linux builds are still beta. Windows is
the version we test most." Prima jumatate e onesta. A doua a fost, pentru o zi
intreaga, exact pe dos: Windows era singura platforma **fara** CI pentru suita
agentului, si celelalte doua erau moarte.

## De rezolvat

**Matricea `cinderpaw-agent` nu are Windows.** `os: [ubuntu-latest,
macos-latest]`. O regresie care apare doar pe Windows nu ar fi prinsa de nimic
in afara de o rulare locala — si o regresie care apare doar pe Linux/macOS, cum
a fost asta, nu e prinsa de rularea locala. Ambele directii sunt oarbe.
Adaugarea lui `windows-latest` acolo e o linie; costul e timp de runner. Decizie
de proces, nu am luat-o singur.

---

# ADDENDUM 2 — matricea de CI, si a patra granita de paritate

Din cele trei lucruri ramase, Darius a intrebat pe care il atac cu bugetul care
mai era. Am ales unul si am refuzat doua, cu motive.

## Ce am refuzat, si de ce

**I5 (bugetul).** Nu e o datorie de reparat, e o functie nescrisa. Ca s-o
inchizi trebuie construit un estimator per etapa — functionalitate noua, pe care
brief-ul o interzice explicit intr-o trecere de hardening. Ramane declarat
onest: `PENDING (consumer)` in doc, spus in trei locuri in cod, `unmeasured` in
jurnal.

**Cele ~50 de findings de frontend.** Au nevoie de mai mult buget decat mai
era, cu aplicatia pornita, si sunt judecati vizuale. Le-as fi facut superficial
exact pe cele care au fost amanate trei zile pentru ca sunt greu de facut bine.
Mai bine neatinse decat atinse prost.

## Ce am facut

### `windows-latest` in matricea `check`

Rula pe ubuntu si macos. Windows — platforma pe care `PROMISES.md` o numeste
"the version we test most" — nu era in matrice, deci suita agentului si cea de
frontend erau verificate acolo de nimic, in afara de cineva care isi aduce
aminte sa le ruleze de mana.

Ambele directii ale gaurii sunt reale si ambele s-au platit in aceeasi zi: o
garda de preload pe care Bun 1.3.14 o accepta si Bun-ul `latest` al runnerelor
o refuza a omorat toate cele 325 de fisiere de test pe ubuntu si macos, in timp
ce acelasi commit trecea local pe Windows, unde CI-ul nu se uita. Oglinda — o
regresie doar-pe-Windows care ajunge intr-un release — avea acelasi singur punct
de esec si pur si simplu nu se declansase inca.

Verificat local INAINTE de a plati timpul de runner, cu acelasi mediu pe care il
seteaza pasul de Test:

```
windows  3748 pass  1 skip  1 todo  0 fail   (local, CINDERPAW_E2E=1 CINDERPAW_FMS_BENCH=1)
macos    3748 pass                  0 fail   (CI)
ubuntu   3744 pass                  0 fail   (CI)
```

**Corectie la Addendumul 1.** Acolo scrie ca "Windows trece cele mai PUTINE
teste dintre cele trei (3735)". Gresit, si concluzia trasa din cifra era gresita
cu ea. 3735 era artefactul rularilor mele locale fara cele doua porti
(`CINDERPAW_E2E`, `CINDERPAW_FMS_BENCH`) pe care CI-ul le seteaza si eu nu.
Cu acelasi mediu, Windows face 3748 — identic cu macOS. Ubuntu e cel cu 3744,
si diferenta sunt exact testele mele de case-insensitivity, care se sar corect
acolo. Nicio platforma nu ramane in urma.

CI-ul de pe main dupa schimbare: **12 job-uri, toate verzi**, inclusiv cele doua
noi (`windows-latest / cinderpaw-agent`, `windows-latest / frontend-react`).

### A patra granita de paritate

`cowork_event.eventType` e declarat de doua ori — de sidecar-ul care il emite
(`CinderpawAgent/src/types.ts`) si de frontend-ul care il deseneaza
(`frontend-react/src/lib/tauri/index.ts`) — in doua pachete care nu-si vad
tipurile unul altuia. Nimic nu le tinea de acord.

Driftul aici nu iese ca eroare de tip. `stores/coworkTranscript.ts` deriva
statusul cu un lant ternar care enumera felurile `running`, apoi felurile
`error`, si trateaza **tot restul ca `done`**; nici switch-ul reducer-ului n-are
caz pentru unul necunoscut. Deci un fel de care frontend-ul n-a auzit se
deseneaza ca **schimb INCHEIAT, fara text**. Un esec al unui coleg ar aparea pe
ecran ca un succes al lui — exact clasa pe care `eebc4b5` a reparat-o ieri
("three failures the panel showed as success"), venind pe alt drum.

Cele doua uniuni sunt sincrone azi (10 si 10). Testul e ce le tine asa.
Verificat adaugand `handoff_abandoned` in uniunea sidecar-ului si urmarindu-l sa
pice cu fisierul de deschis in mesaj.

**Al doilea test din fisier isi merita locul.** Primul parser pe care l-am scris
se oprea la un `;` dinauntrul unui comentariu si citea 6 din cele 10 feluri.
Doua multimi trunchiate se compara egal, deci testul de paritate ar fi trecut la
nesfarsit pazind nimic. Self-check-ul l-a prins.

A patra granita din repo care primeste tratamentul asta, dupa
`protocol_drift.rs`, `secret-redaction-cases.json` si
`rsi-code-patch-denylist-parity.test.ts`.

Traieste in suita sidecar-ului, nu in cea de frontend: e un test de contract
intre pachete, nu unul de UI, iar tsconfig-ul frontend-ului n-are tipuri de
Node — l-as fi platit fie cu o dependenta noua, fie cu globale Node in cod de
browser, ca sa verific un fisier pe care niciuna dintre parti nu-l deseneaza.

## Ce am mai atacat si a tinut

**Ciclul de viata al apelului voice.** `Session::drop` opreste ambii copii;
ambele procese sunt pornite cu `kill_on_drop(true)`, deci o anulare la mijlocul
boot-ului nu lasa copii orfani. `reap_orphan_server` verifica NUMELE procesului
inainte sa semnaleze ceva, deci un pid reciclat nu duce la omorarea altui
program de pe masina omului. `join_or_boot` recitasteste slotul sub poarta.
N-am gasit nimic de reparat.

Ramane, ne-reparat si ne-reprodus: worker-ul Node nu e inregistrat in pid file,
deci un crash pe Windows il lasa in viata. Nu produce doua voci — serverul lui e
mort — dar e o scurgere de proces per crash.

## Starea la inchidere

```
main  6779c4c  CI success  —  12/12 job-uri verzi
CinderpawAgent   3750 pass  0 fail   (327 fisiere)
frontend-react    685 pass  0 fail   (80 fisiere)
Rust              659 pass  0 fail
TUI               toate pachetele ok
ambele typecheck-uri curate
```

Verdictul ramane **CONDITIONAL**, si acum cu o singura conditie: cele ~50 de
findings vizuale de frontend. Prima conditie (Linux nedovedit) a cazut ieri;
gaura de CI care le ascundea pe amandoua s-a inchis azi.
