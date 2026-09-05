# Voice, Coworker, telemetrie — 5 septembrie 2026

Pre-release hardening. E1 rula separat si nu a fost atins; nimic din BRSI,
ratchet sau evolution gates nu a fost modificat.

Fiecare fix de mai jos are un test care **pica inainte** si trece dupa.
Nimic nu e commit-uit: totul e in working tree, pe `feat/browser-app-foundation`.

---

## Tabel

| # | sistem | problema | dovada | cauza reala | fix | test | inainte | dupa | status |
|---|--------|----------|--------|-------------|-----|------|---------|------|--------|
| V1 | `commands/livekit.rs` | Butonul apasat in timpul warmup-ului **pornea un al doilea lant complet**. Warmup-ul nu era vizibil pentru `start_livekit_call`. | harness real, lant real: apasare la 2s in warmup = 3920 ms si "booted a second chain" | `WARMING` era un `AtomicBool` privat warmup-ului; `start` verifica doar slotul, care era inca gol | `livekit::join_or_boot` + `BOOT_GATE`: butonul asteapta boot-ul deja pornit, warmup-ul renunta daca poarta e ocupata | `without_a_gate_a_warmup_and_a_pressed_button_both_boot` (reproducere) + 3 teste ale portii | 3920 ms, doua servere | **1649 ms**, un lant | REPARAT |
| V2 | `useLiveKitCallSession` | Apasarea pe Call nu schimba **nimic** pe ecran pana la conectare. Acelasi buton, acelasi titlu, 15-20s. | test: `phase` ramanea `ready` dupa `begin()` | nu exista stare `connecting`; `setPhase('listening')` doar dupa `connect` | faze `connecting` / `reconnecting`, plus `stage` (`starting` / `joining` / `mic`) cu text in EN si RO | `leaves the pre-call state the moment the button is pressed`, `says which stage...` | 0 feedback | feedback sub un frame | REPARAT |
| V3 | `useLiveKitCallSession` | **Buton mort.** Anulezi in timpul boot-ului, reintri, apesi Call: nu se intampla nimic pana se termina boot-ul abandonat. | test: a doua apasare lasa `phase === 'ready'`, `startLivekitCall` chemat o singura data | garda `starting` era un boolean detinut de incercarea abandonata | garda devine generatia care o detine, nu un boolean | `leaves the button usable instead of dead...` | buton mort 4-15s | reactiv imediat | REPARAT |
| V4 | `useLiveKitCallSession` | Cand transportul cadea, ecranul **continua sa spuna "listening"**. LiveKit raporteaza `Disconnected` abia dupa ce renunta. | test: `phase` ramanea `listening` la `RoomEvent.Reconnecting` | `Reconnecting` / `Reconnected` nu erau ascultate; iar evenimentele `state` de la agent puteau suprascrie starea locala | ambele ascultate; `state` nu mai calca peste `connecting` / `reconnecting` | `says it is reconnecting instead of continuing to claim it is listening` | minciuna pe ecran | stare reala | REPARAT |
| V5 | `livekit_agent.mjs` + `api.rs` | **Modul on-device (pipeline) nu functiona deloc.** Agentul posta `{messages, system, stream}`; `/runtime/chat` cere `content` si nu are camp `messages`. Fiecare tura = 422. | test de contract care citeste `livekit_agent.mjs` prin `include_str!` si il verifica fata de `RuntimeChatReq` | doua limbaje, un contract, nimic care sa-l verifice | agentul trimite `content` + `session_id` + `surface`; sidecar-ul detine istoricul si il compacteaza | `the_voice_agent_posts_a_body_this_endpoint_can_read` | 422 la fiecare tura | tura ajunge la model | REPARAT |
| V6 | `api.rs` | `/runtime/chat` nu trimitea niciodata `surface`, desi sidecar-ul il asteapta. Un raspuns vocal era markdown-ul complet citit cu voce tare. | `dispatch.ts:1335` citeste `msg.surface`; `RuntimeChatReq` nu avea campul | endpoint-ul nu a fost actualizat cand `setSessionSurface` a aparut | camp `surface` optional, forward-uit | asertiune in acelasi test de contract | 1382 caractere citite cu voce tare | brief vocal | REPARAT |
| C1 | `CoworkTranscriptPanel` | **Aprobare pierduta fara urma.** Verdictul nu ajunge la sidecar, panoul ramane pe "sending..." fara butoane si fara eroare, pentru totdeauna. Bula mascotei isi revenea; panoul nu. | test: `coworkApprovalResolve` respins, panoul nu mai oferea `Approve` | `resolveCoworkApproval` isi inghitea eroarea si repara doar `toolCallStream` | actiunea din store **arunca** dupa ce repara bula; ambele suprafete decid ce fac | `a verdict that never reached the sidecar can be given again` | tura blocata definitiv | se poate raspunde din nou | REPARAT |
| C2 | `CoworkTranscriptPanel` | Butonul **Stop** inghitea eroarea. Un stop esuat arata exact ca un stop reusit, in timp ce tura continua si cheltuie. | test: `coworkStop` respins, nimic pe ecran | `.catch(() => {})` fara stare | stari `stopping` / `stopFailed`, motivul pe ecran | `the stop button says so when the teammate did not stop` | eroare invizibila | motivul pe ecran | REPARAT |
| C3 | `CoworkTranscriptPanel` | Istoricul thread-ului esua tacut. Un transcript caruia ii lipseste tot ce s-a intamplat inainte de pornirea aplicatiei arata identic cu unul complet. | test: `coworkHistory` respins, niciun indiciu | `.catch(() => {})` | nota vizibila, **doar cand panoul e oricum pe ecran** | `says so when the thread history could not be loaded` | date partiale tacute | spune de unde incepe | REPARAT |
| T1 | tot stack-ul vocal | **Zero instrumentare de timp** pe calea apelului. "Dureaza 15 secunde" nu avea nicaieri un raspuns la "care 15 secunde". | `grep performance.now` pe voice: 0 in LiveKit; niciun `tracing` cu durata | nu exista | `lib/callTiming.ts` peste User Timing API (ceas monotonic, apare in timeline-ul browserului), cele 9 etape cerute in §5, plus masura per-tura | `callTiming.test.ts`, 8 teste | oarba | 9 etape + 3 span-uri pe tura | REPARAT |

---

## Voice latency, cifre masurate

Harness real, server LiveKit real, worker Node real, pe masina asta:

```
cargo test -p cinderpaw-core --lib livekit_entry_latency -- --ignored --nocapture
```

```
cold boot                       3772 ms
warm join                          0 ms
press 2s into a warmup, gated   1649 ms
press 2s into a warmup, before  3920 ms  (booted a second chain)
```

Al doilea lant nu era doar de doua ori mai lent. Intr-o rulare intermediara al
doilea boot a **omorat serverul primului**: `reap_orphan_server()` citeste
pid-ul pe care primul boot tocmai il scrisese si il ucide. Rezultatul era
`the voice agent never started` dupa 15 secunde de asteptare.

### Ce NU pot inca sa atribui, si spun asta explicit

Boot-ul lantului pe masina asta e **3.8 secunde, nu 15-20**. Fixul V1 elimina o
dublare reala si masurata, dar **nu explica singur cifra raportata**. Nu am
reprodus 15-20s intr-un harness si nu inventez o cauza pentru diferenta.

Suspectii ramasi, in ordinea probabilitatii:

1. **`start` se declara gata prea devreme.** Asteapta ca *worker-ul* sa se
   inregistreze (endpoint de health). Copilul forked care ruleaza efectiv
   apelul e prewarmed *dupa* aceea (`numIdleProcesses: 1`,
   `initializeProcessTimeout: 60_000`). Daca omul apasa Call inainte ca acel
   copil sa termine prewarm-ul, plateste incarcarea pluginului si a modelului
   VAD *dupa* ce a intrat in camera, unde nimic nu o masoara.
2. **`ensure_agent` inseamna `npm install`** la prima rulare *per vendor*. O
   schimbare de vendor e din nou o prima rulare.
3. **Modul pipeline nu raspundea niciodata** (V5). Un apel care se conecteaza
   si nu zice nimic se citeste ca "apelul dureaza o vesnicie".

Instrumentarea T1 raspunde la asta pe masina omului, fara debugger:
**Settings → Voice call → Test** arata acum defalcarea in milisecunde
(`call_requested` → `room_joined` → `microphone_ready` → `agent_session_started`)
si daca motorul era deja pornit sau a fost pornit pentru apelul asta.

---

## Long-horizon, 1 / 10 / 25 / 50 / 100 turi

```
npx vitest run src/hooks/__tests__/callLongHorizon.bench.test.tsx
```

```
transcript path,      turn 1: 2.85 ms   10: 0.32   25: 0.26   50: 0.19   100: 0.17
conversation render,  turn 1: 3.38 ms   10: 1.06   25: 1.51   50: 1.69   100: 3.05
```

**Frontend-ul nu e cauza.** Calea transcriptului e plata (0.17 ms la tura 100).
Randarea creste liniar cu numarul de mesaje, dar 3 ms la 100 de turi nu e ce
simte cineva ca "raspunde tot mai tarziu".

Am verificat si acumulatoarele pe care le cerea brief-ul: `useLiveToolActivity`
plafonat la 6, `callArtifacts` la 40, intervalul de sweep curatat, listener-ul
`liveKitEvent` inregistrat o singura data pe viata hook-ului, `stderr_tail` din
Rust plafonat la 8 KB, ambele pipe-uri ale copilului drenate. Niciunul nu creste.

Cauza pe care **am** gasit-o e sub frontend si e V5: modul pipeline trimitea
intreaga conversatie la fiecare tura. Acum trimite doar tura noua si un
`session_id`; istoricul si compactarea sunt ale sidecar-ului, exact contractul
scris in doc-comment-ul lui `RuntimeChatReq`.

Pentru caile cloud: Google are `contextWindowCompression: { slidingWindow: {} }`,
OpenAI se bazeaza pe trunchierea serverului. **Nu am masurat niciuna** si nu
pretind ca sunt in regula.

Instrumentarea per-tura scrie o linie pe tura:
`[call] turn 42: transcript 310ms, answer started 890ms, complete 2100ms`.
Asta e masuratoarea 1/10/25/50/100 pe un apel real, cand exista unul.

---

## Coworker, controale verificate

| control | idle | loading | success | failure | retry | rezultat |
|---|---|---|---|---|---|---|
| Send message | da | `sending`, buton dezactivat | input golit | eroare pe ecran, curatata la tastare | reapasa | era deja corect |
| Approve / Deny | da | "sending..." | bula se inchide pe eveniment terminal | **lipsea** | **lipsea** | REPARAT (C1) |
| Stop | da | **lipsea** | — | **lipsea** | — | REPARAT (C2) |
| Deschidere / schimbare thread | da | fara loading | randeaza | **lipsea** | — | REPARAT (C3); loading NU adaugat, vezi Refuzat |
| Pin / unpin, copy, expand | da | n/a | n/a | n/a | n/a | local, corect |
| Resize / drag / collapse | — | — | persistat in localStorage | — | — | corect |

Accesibilitate: `aria-expanded` pe expand, `aria-label` pe copy/pin/select,
`role="group"` cu subiectul pe randul de aprobare, `role="status"` pe nota
noua. Minimap-ul de 1px fusese deja sters pentru tab-order. Nu am gasit buton
fara nume accesibil.

---

## Telemetrie, ce se poate observa acum

| sistem | metrici | logs | erori prinse | id de corelare | timing |
|---|---|---|---|---|---|
| voice / LiveKit (client) | — | — | pe ecran, ca text | — | **9 etape + 3 span-uri pe tura (nou)** |
| voice / LiveKit (Rust) | — | 12 `tracing` | da, cu prima linie reala din stderr | — | **cald/rece raportat catre UI (nou)** |
| agent Node | — | stdout drenat, stderr plafonat la 8 KB | da | — | — |
| sidecar / runtime | — | prin bus | da | `sessionId`, 17 locuri in `api.rs` | — |
| React lifecycle | — | `ErrorBoundary` → `console.error` | doar erori de randare | — | — |
| coworker | — | — | da, dupa C1-C3 | `threadId`, `cowork:<agentId>` | `Elapsed` pe randuri active |
| startup / shutdown | — | `tracing` | partial | — | — |

Telemetria nu introduce latenta: zero `console.*` pe calea fierbinte a apelului
(verificat), o singura linie pe tura, marcajele sunt `performance.mark`. Nimic
nu logheaza chei, audio sau continut de transcript; persona e logata ca
**lungime**, nu ca text.

### Gap-uri ramase

1. **Niciun `unhandledrejection` / `window.onerror`.** `ErrorBoundary` prinde
   doar erori de randare. O promisiune respinsa oriunde in aplicatie dispare.
2. **Niciun id de corelare care sa lege fereastra de Rust de sidecar.** Un apel
   are `room`, o tura are `sessionId`, dar nimic nu le uneste intr-un fir.
3. **Zero metrici, doar log-uri.** Niciun contor pentru "cate apeluri au esuat"
   sau "cat dureaza in mod tipic un boot".
4. **Nimic din timing nu ajunge in Rust.** Defalcarea traieste in fereastra si
   in panoul de self-test; nu exista un fisier pe care sa-l trimita cineva.

---

## Refuzat / amanat

- **Paralelizarea microfonului cu boot-ul.** Ar castiga sub o secunda pe un
  lant rece si zero pe unul cald, si ar introduce un al doilea stream de
  captura. Instrumentarea va spune daca merita.
- **Virtualizarea listei de mesaje.** 3 ms la 100 de turi. Brief-ul interzice
  rescrieri fara profiling; profiling-ul spune nu.
- **Stare de loading pentru panoul coworker.** Panoul e ascuns cand e gol; un
  panou care apare doar ca sa arate un spinner pentru ceva ce omul n-a folosit
  niciodata e mai rau decat tacerea.
- **`IDLE_SHUTDOWN` de 180s omoara lantul cald** daca cineva sta 4 minute pe
  ecranul pre-apel, iar urmatorul Call plateste boot-ul intreg. Real, dar rar.
  Notat, nereparat.
- **F54 / F24** (responsive, actiuni doar la hover): alt scope, raman din
  auditul de ieri.

---

## Ce ramane rosu

1. **Cele 15-20 de secunde nu sunt inca explicate integral.** Am eliminat o
   dublare masurata (3920 → 1649 ms) si am reparat un mod care nu raspundea
   deloc, dar boot-ul masurat aici e 3.8s. Diferenta e neatribuita. Primul pas:
   Settings → Voice call → Test, pe masina unde se vede intarzierea.
2. **`start` se declara gata inainte ca job-ul copil sa fie prewarmed.** Cel
   mai probabil suspect ramas, si nu am o solutie: SDK-ul nu expune "copilul
   idle e gata" pe endpoint-ul de health.
3. **Nicio masuratoare pe un apel real, live.** Toate cifrele de mai sus vin
   din harness-uri. Long-horizon-ul pe cloud (Google, OpenAI) e complet
   nemasurat.
4. **`tests/config.test.ts`** si **`rust / ubuntu-22.04`** raman rosii din
   checkpoint-ul de ieri. Neatinse.

---

## Suite rulate

```
npx vitest run                    77 fisiere, 669 teste, verde
cargo test -p cinderpaw-core      370 teste, verde
npx tsc --noEmit                  curat
```
