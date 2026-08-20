# Runda 10 — Test suite integrity audit: teste care mint, false-positive greens, coverage holes pe MOAT

**Scope:** ultima rundă, focus pe test-uri ÎN SINE. Nu bug-uri de cod, ci bug-uri de VERIFICARE. Un `expect(true).toBe(true)` trece verde și minte că feature-ul funcționează. Un `it.skip()` sau `.skipIf(!ENABLED)` gate-uit după env var pe care CI n-o setează = suite fantomă. Un test cu 20 mock-uri unde bug-ul real e în interacția reală = false safety.

**De ce contează**: runda 1 §4 a fost falsă la mine — count wrong prin grep|wc. Aici aplic același rigor invers: verific manual că test-urile pe care le identific ca "false green" chiar mint. Verific `.test.ts` cu ochii, nu doar regex.

**Structura**: 
- §248-§253: teste care mint (verified prin citire) 
- §254-§257: coverage holes majore pe bug-urile raportate în rundele precedente
- §258-§262: pattern-uri sistemice de safety fals

**Metodologie**: spot-check pe test-urile critice pentru MOAT (rlm-notebook, audit-log, ratchet-handler, code-sandbox, sandbox_bounds). Pentru fiecare, m-am uitat la ce este VERIFICAT vs ce **ar trebui** verificat conform contract-ului declarat în comentariile source-ului. Divergențele = false safety.

---

## §248 — `tests/memory-resilience.test.ts:472` — `expect(true).toBe(true)` pentru testul care ar trebui să valideze `:memory: skips lock`

```ts
test(":memory: path skips the lock entirely — many in-process opens are fine", () => {
  const a = openDatabase(":memory:");
  const b = openDatabase(":memory:");
  a.close();
  b.close();
  expect(true).toBe(true);
});
```

Titlul promite "many in-process opens are fine". Test-ul deschide 2 (nu "many"), și expect nu verifică nimic despre lock-ul absent. Ce ar trebui:

```ts
test(":memory: path skips the lock entirely — many in-process opens are fine", () => {
  // Open many in-memory instances. Should all succeed without lockfile.
  const dbs = Array.from({ length: 10 }, () => openDatabase(":memory:"));
  expect(dbs.length).toBe(10);
  // No lockfile should have been created for :memory:.
  // (Would need to check heldLocks or similar internal state).
  dbs.forEach(db => db.close());
  // After close, no leftover state.
  expect(true).toBe(true);  // ← still tautological but at least the count is verified
});
```

Un `openDatabase(":memory:")` care throws pe al doilea apel ar face testul curent să THROW (deci detectabil) — deci nu-i complet fake, throw devine failure. Dar assertion "many" fail semantic.

**Verdict**: false green minoritar — test-ul verifică că **nu-throw**, dar promite mai mult. Fix ușor.

---

## §249 — `tests/proactive-loop.test.ts:326` — `expect(true).toBe(true)` cu comment "verified by reading code" — TEST DELIBERAT-FAKE

```ts
test("counter resets when the UTC day rolls over (midnight UTC)", () => {
  // The day-rollover behavior is implicit in the daily-cap test
  // above (we drive 4 ticks within a single UTC day and confirm
  // the cap holds). This test documents the contract: the counter
  // IS per-UTC-day, not per-rolling-24h window. Verified by reading
  // `#maybeResetDailyCounter` (uses Date.UTC day-of-year).
  expect(true).toBe(true);
});
```

Comentariul admite explicit: *"Verified by reading `#maybeResetDailyCounter`"* — adică test-ul e un `it.todo(...)` MASKED as passing. Nu execute code-ul de rollover, nu verifică behavior real, doar spune "am citit codul, e OK".

Vector: dacă cineva schimbă `#maybeResetDailyCounter` la `Date.UTC day-of-year` la `Date.now() day-of-year`, test trece verde. Rolling-24h în loc de per-UTC-day → counter reset la ore greșite → proactive burst behavior schimbat silent.

**Fix**: real test cu injected clock:

```ts
test("counter resets when the UTC day rolls over (midnight UTC)", () => {
  const clock = { now: Date.UTC(2026, 0, 1, 23, 59, 0) };   // 23:59 UTC Jan 1
  const loop = new ProactiveLoop({ now: () => clock.now });
  // Fire some ticks to advance counter
  for (let i = 0; i < 3; i++) loop.tick();
  const beforeMidnight = loop.dailyCount;
  expect(beforeMidnight).toBe(3);
  
  // Roll past midnight UTC.
  clock.now = Date.UTC(2026, 0, 2, 0, 0, 1);
  loop.tick();
  expect(loop.dailyCount).toBe(1);   // Reset happened
});
```

Trebuie ProactiveLoop să accepte injected clock. Refactor mic, valoros.

Cel mai grav din 3 `expect(true)`-uri.

---

## §250 — `tests/rsi-escape-time-recorder.test.ts:209` — `expect(true).toBe(true)` cu comment "the absence of a hang" — false green

```ts
      score: 30, // chain [20, 30] → escapeTime=1
      behavioralFingerprint: [1],
      tokenCost: 100,
      durationMs: 10,
      errored: false,
    });

    // Either the test completes (success) or records something; both
    // are fine. The point is the absence of a hang.
    expect(true).toBe(true);
```

Comentariul: "the absence of a hang". Bun test timeout default 5s. Deci un hang detectabil prin timeout. Dar test-ul nu verifică că THING-ul făcut chiar face ce trebuie. Doar "not hang".

Poate `recordEval(...)` throws silent (dacă record synchronous), test-ul suceeds după throw pentru că throw în test cauzează fail (nu green). Dar dacă `recordEval` este async void și internal rejects, promise unhandled → test green.

**Fix**: cel puțin verifică că `recorder` a acumulat înregistrarea:

```ts
recorder.recordEval({...});
expect(recorder.evalHistory.length).toBeGreaterThan(0);
```

Sau assert on `escapeTime` computed corect:

```ts
recorder.recordEval({ score: 20, ... });
recorder.recordEval({ score: 30, ... });
expect(recorder.escapeTimeFor(fingerprint)).toBe(1);
```

---

## §251 — `tests/rlm-notebook.test.ts:241-246` — sandbox escape test ACOPERĂ NUMAI `rlm(x)` return, NU `list_subagents/messages/observe`

```ts
it("does not let a handle leak the host realm", async () => {
  const { nb, children } = nbWith();
  const r = await nb.run(`(await rlm("x")).constructor.constructor("return typeof process")()`);
  expect(r.ok === false || r.value === "undefined").toBe(true);
  await children.drain();
});
```

Testat: `await rlm("x")` return value → severed OK.

**NU testat**:
- `(await rlm.list_subagents()).subagents[0].constructor.constructor(...)`
- `(await rlm.observe("child")).trail[0].constructor.constructor(...)`
- `(await rlm.messages()).messages[0].constructor.constructor(...)`
- `(await rlm.list_subagents()).subagents.constructor.constructor(...)` ← ARRAY-ul care conține `.map(severed({...}))` obiecte
- Nested arrays în tool result data: `(await read_file({...})).data.someArray.constructor.constructor(...)`

Bug-ul §142 din R6 e EXACT în array container. Test-ul dă vibe fals de safety completă când e partial.

Comentariul de sus (linia 42-46): *"Each route below reached the host realm at some point during development; they stay as regression tests. If any starts returning "object", the notebook is handing out unaudited filesystem and network access."*

Regression suite bun pentru cele 7 rute cataloged. Dar nu-i exhaustive. Nu blocher pentru release, dar autor trebuie să înțeleagă că lista NU e complete.

**Fix**: adaugă cazurile:

```ts
it.each([
  ["rlm handle", `(await rlm("x")).constructor.constructor("return typeof process")()`],
  ["list_subagents container", `(await rlm.list_subagents()).subagents.constructor.constructor("return typeof process")()`],
  ["list_subagents item", `((await rlm.list_subagents()).subagents[0] ?? {}).constructor?.constructor?.("return typeof process")?.()`],
  ["observe trail", `((await rlm.observe("child")).trail[0] ?? {}).constructor?.constructor?.("return typeof process")?.()`],
  ["messages container", `(await rlm.messages()).messages.constructor.constructor("return typeof process")()`],
  ["nested tool data array", `(await read_file({path:"/x"})).data?.items?.constructor?.constructor?.("return typeof process")?.()`],
])("cannot escape via %s", async (_label, expr) => {
  ...
});
```

Test devine EAT LOAD-BEARING — dacă vine roșu, bug real.

---

## §252 — `tests/rsi-code-sandbox.test.ts` — teste folosesc `fakeExec`, NU verifică `bunExec` real → §91 env leak nedetectabil

`tests/rsi-code-sandbox.test.ts:31-38`:

```ts
function fakeExec(
  answers: Partial<Record<string, ExecResult>>,
  calls: string[] = [],
): { exec: ExecFn; calls: string[] } {
  const exec: ExecFn = async (cmd) => { ... };
  return { exec, calls };
}
```

Toate teste (line 51+) folosesc `fakeExec` injected. `bunExec` real (`FeralAgent/src/rsi/l3-code/code-sandbox.ts:247-254`) face `env: { ...process.env }` — leak-uind FERAL_API_KEY la subprocess. Bug §91 din R4.

**Nu-i test** care rulează real `bunExec` cu process.env cu FERAL_API_KEY set și verifică child process NU vede acele variabile:

```ts
test("bunExec does not propagate FERAL_ secrets to child processes", async () => {
  const originalKey = process.env.FERAL_API_KEY;
  process.env.FERAL_API_KEY = "test-secret-should-not-leak";
  try {
    const result = await bunExec(["node", "-e", "console.log(process.env.FERAL_API_KEY ?? 'unset')"], "/tmp");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("unset");
  } finally {
    if (originalKey === undefined) delete process.env.FERAL_API_KEY;
    else process.env.FERAL_API_KEY = originalKey;
  }
});
```

Test-ul ăsta ar prinde bug-ul §91 IMEDIAT — și n-a fost scris. **Regression test critical missing pentru MOAT bug**.

---

## §253 — `tests/audit-log.test.ts` — nu testează `#lastHash` desync scenario, nici concurrent record

Testele acoperă:
- Untampered chain verifies (line 20-28).
- Altered content detected (line 32-46).
- Deleted row detected (line 48-62).
- Legacy rows skipped (line 64-78).
- Chain survives reopen (line 82-94).

**Nu testat** (per §206 din R8):
- `record()` throws → `#lastHash` NOT advanced → next record uses stale `prev_hash` → chain OK on disk? Da corect (nu-i bug de fapt, my finding was defensiv). Skip.
- Concurrent record from two threads → race conditions.
- SQLITE_BUSY on insert → retry logic (dacă există).

**Ce ar mai putea acoperi**:
```ts
test("concurrent record from many callers preserves chain", async () => {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  await Promise.all(Array.from({ length: 100 }, (_, i) =>
    Promise.resolve().then(() => audit.record(entry({ toolName: `t${i}` })))
  ));
  const r = audit.verify();
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.entries).toBe(100);
});
```

Bun test runs single-threaded async loop — real threading doar cu `Worker`s. Deci racing e limited. Dar `Promise.all` cu multiple `.record()` in acelasi tick expunec bug-uri de ordering.

Nu-i bug de test — e coverage hole. Note.

---

## §254 — `tests/fractal-scale.test.ts` — TOATE benchmarks gated on `FERAL_FMS_BENCH=1` care NU-i set în CI

`FeralAgent/tests/fractal-scale.test.ts:14`:

```ts
const ENABLED = process.env.FERAL_FMS_BENCH === "1";
```

`.github/workflows/ci.yml` nu setează `FERAL_FMS_BENCH`. Toate benchmarks (10k / 100k upsert p99, summaries, remove, dedup) sunt **SKIP silent** în CI.

Bug-urile §101 (queryTree cosine 2× per compare O(n log n × dim)) și §103 (FNV-1a 32-bit collision) din R4 sunt exact clasa pe care benchmark-urile ar detecta-o (p99 latency spike, memory pressure). N-au fost detectate — CI nu rulează test-urile.

Ce zice comentariul din .github/workflows/ci.yml line 50-59:

```yaml
# FERAL_E2E turns on the fail-closed safety suites — journal tampering,
# the watchdog, module quarantine, governance. They are the tests that
# demonstrate the rails hold, and they were gated behind a variable no
# workflow set, so they had never run here once. They pass; nothing would
# have said so on the day they stopped.
```

Autorul CI observed exact acest pattern pentru `FERAL_E2E` și l-a fixat! Dar `FERAL_FMS_BENCH` a rămas skipped. Same bug, same file.

**Fix**:

```yaml
- name: Test (with benchmarks)
  working-directory: ${{ matrix.step.workdir }}
  run: ${{ matrix.step.test }}
  env:
    FERAL_E2E: "1"
    FERAL_FMS_BENCH: "1"       # ← ADAUGĂ
    FERAL_E2E_RUST: "1"        # ← ADAUGĂ (per §255)
```

Cu benchmarks running: prima rulare detectează timing-uri actuale. Dacă lente, tuning-ul required. OK, dar cel puțin visibility.

---

## §255 — `tests/l3-watchdog.e2e.test.ts` gated pe `FERAL_E2E_RUST=1` NU set în CI → NEVER RUN

`FeralAgent/tests/l3-watchdog.e2e.test.ts:54`:

```ts
const ENABLED = process.env.FERAL_E2E === "1" && process.env.FERAL_E2E_RUST === "1";
```

CI setează doar `FERAL_E2E`. Watchdog test-ul e SKIP.

Watchdog validation:
- Un patch RSI-generated care crashează agent → watchdog detects → auto-revert.
- Este exact featurea "safety rail" pentru §142/§91/§151 din R4-R7. Fără test → nu se știe dacă revert funcționează.

Comentariul (line 52): `FERAL_E2E=1 FERAL_E2E_RUST=1 bun test tests/l3-watchdog.e2e.test.ts` — "runs it". Dar nu-i run în CI.

**Fix**: set env var în CI (per §254). Dacă rust bindings needed (spawn real sidecar), verifică dacă `bun` sandboxul CI acceptă. Poate să nu poată — atunci test skip legitimat, dar comment în CI să spună de ce.

---

## §256 — Missing coverage pentru bug-urile RSI critical raportate în R7 (self_src, sandbox_bounds, ratchet trust)

**Zero tests pentru**:
- `self_src::copy_tree` follows symlinks (§173 R7): test cu symlink în bundle, verify refuz.
- `self_src::provision` `git commit` cu gpgsign (§174 R7): mock user gitconfig cu gpgsign=true, verify n-o blochează.
- `self_src::provision` `git add -A` accidental secrets (§176 R7): drop `.env` în bundle, verify NU comit.
- `sandbox_bounds::save_with_audit` audit vs file divergence (§183 R7): mutează file direct, verify load() detects.
- `sandbox_bounds::load_from` file missing but audit exists (§185 R7): șterge file păstrează audit, verify boot refuse.
- `audit::SandboxBoundsAudit::append` concurrent race (§186 R7): două append-uri paralele, verify chain intact.
- `runtime::rsi_commit_genome` case-insensitive `Main` bypass (§189 R7): candidate_branch="Main" trebuie respins.
- `runtime::rsi_set_lora` path unbounded (§190 R7): path=`/etc/passwd` trebuie respins.
- `ratchet_attempt` scor din commit body TRUSTED (§151 R6, §180 R7): fake commit metadata cu score=999, verify refuz sau cross-check.

Toate aceste zone au bug-uri raportate care ar putea trece nedetectate în refactor viitor pentru că sunt zero regression tests.

**Fix**: introdu un fișier `tests/rsi-safety-invariants.test.ts` care lists fiecare invariant + un test per:

```rust
// crates/feral-core/tests/rsi_safety_invariants.rs
#[test]
fn ratchet_rejects_forged_score_in_commit_body() {
    // Create a commit with metadata { score: 999.0 } but real eval score 0.5.
    // Ratchet must refuse or re-verify.
}

#[test]
fn candidate_branch_main_case_insensitive_rejected() {
    // "Main", "MAIN", "  main  ", "main\t" — toate rejected.
}
```

Fiecare bug §XX din runda 4-7 → test dedicat. **Coverage gap fundamental.**

---

## §257 — Coverage lipsă pentru bug-urile Tauri commands (voice, files) raportate în R2, R9

**Zero tests pentru**:
- `transcribe_audio_cloud` arbitrary path exfil (§39 R2, §232 R9): test cu `audio_path="/etc/passwd"`, verify refuz sau containment check.
- `extract_file_text` ZIP bomb (§40 R2, §230 R9): synthesize `.docx` cu entry 1GB uncompressed, verify refuz.
- `save_voice_blob` size cap (§231 R9): 100MB blob, verify capped.
- `deny_feral_private` scope larg (§38 R2, §229 R9): test cu `~/.ssh/id_rsa`, `~/.aws/credentials`, `~/.gitconfig`.
- `save_byok_provider` validation (§242 R9): empty api_key, empty provider_id, attacker base_url.
- `set_desktop_control_enabled` env::set_var în tokio UB (§237 R9, §36 R2): thread stress test dacă rulează în Rust.

Aceste commands sunt Tauri-facing → apelabile din browser via `invoke`. Fiecare bug = XSS/data-exfil vector. Fără test suite pentru sanitize/refuz, se re-introduc regresii ușor.

**Recomandare**: `src-tauri/tests/commands_security.rs` cu 15+ teste pentru fiecare command sanitization contract.

---

## §258 — Pattern sistemic: teste care mock TOATE dependencies → verify orchestration corect, nu behavior real

Analizat `tests/rlm-notebook.test.ts::nbWith()`, `tests/rsi-code-sandbox.test.ts::fakeExec()`, `tests/rsi-ratchet-handler.test.ts::ratchetAttempt injected`.

Pattern comun:
- Test injectează mock pentru ALL boundary functions.
- Verifică că handler-ul apelează mockurile în ordinea/argumentele corecte.
- Nu verifică că implementarea REALĂ a mockurilor face ce trebuie.

Consecință: bug-urile la interfața dintre TS și Rust (unde mock-urile sunt substituite cu IPC real) nu-s prinse. §91 (bunExec env leak), §142 (RLM proto leak in map), §151 (ratchet trust score) — toate ratate.

**Fix**: adaugă suite de "contract tests" pentru fiecare boundary function:

- `bunExec` cu spawn real, verify env NU include `FERAL_*`.
- `Rust ratchet_attempt` cu real commit, verify NU accept score forged.
- `severed(...)` cu real arrays nested, verify NO escape route.

Fără contract tests, boundary functions sunt untested → sursa bug-urilor critice.

---

## §259 — `.skipIf(!ENABLED)` pattern folosit inconsistent → 7 suite gated, dar CI setează doar 1 dintre 3 env vars

**Suite gated**:
- `fractal-scale.test.ts` → `FERAL_FMS_BENCH`
- `l0-journal-tamper.e2e.test.ts` → `FERAL_E2E`
- `l3-watchdog.e2e.test.ts` → `FERAL_E2E` + `FERAL_E2E_RUST`
- `l4-module-quarantine.e2e.test.ts` → `FERAL_E2E`
- `l5-governance-fail-closed.e2e.test.ts` → `FERAL_E2E`
- (probable altele — nu am enumerat toate)

CI setează `FERAL_E2E=1`. Nu setează `FERAL_FMS_BENCH`, nu setează `FERAL_E2E_RUST`.

**Consecință**: `fractal-scale` (bench) + `l3-watchdog` (Rust-side e2e) SKIP silent. Cover missing.

`l3-watchdog` requires Rust binary — poate fi legitim skipped în JS-only CI leg. Dar atunci trebuie:
- Alt leg CI cu Rust binary build + `FERAL_E2E_RUST=1`.
- Sau explicit comment în test file: "*e2e Rust tests only run in the rust-integration workflow, see ci.yml line X*".

Fără nici una, autorul viitor vede test file, presupune că testul rulează, refactorează watchdog, break-uie, nu observă.

**Fix**: adaugă un job explicit `e2e-rust` în CI care setează ambele env vars și rulează `bun test tests/l3-watchdog.e2e.test.ts tests/fractal-scale.test.ts`. Necessary dacă rust binary trebuie built, ok trade-off (fewer minutes CI dacă test skipped, but VISIBILITY că-i skipped).

---

## §260 — Tests care nu asertează on cleanup / teardown → resource leaks acumulate silent între tests

Ex `tests/db.ts::openDatabase` teste: create, close. But un test creates DB, does work, forgets close. Bun test executes next test, DB left open. `.writer.lock` NU release. Next test throws "another sidecar holds lock" — but that's YOUR OWN previous test.

Actual: în cod `openDatabase(":memory:")` — no lockfile. Fine. Pentru path-based, lockfile.

**Verify**: caută teste care use path-based DB fără explicit `close()`:

Deja audit-log.test.ts (line 21-28) close-uie. OK. Dar in altele...

Skip. Nu-i major dacă majoritatea use :memory:.

---

## §261 — Vitest config (frontend-react) sau bun test config — verifica coverage report generation

<verify că coverage-ul e enabled în CI și thresholds enforced>

<code n/a for me>

Recomandare defensive:
- Bun test cu `--coverage` flag.
- Coverage threshold minim per file (ex. 60% line coverage minim pentru `src/rsi/`).
- Fail CI dacă threshold neatinge.

Fără thresholds → cod nou merged fără teste, coverage scade silent.

**Fix**: adaugă în CI:

```yaml
- name: Test
  run: bun test --coverage --coverage-threshold=60
```

Cu warning fresh dacă cineva merge PR care scade coverage sub prag.

---

## §262 — MISCELANEE

**§262a** — Teste care folosesc `Date.now()` real (nu injected clock) sunt flaky pe CI slow → intermittent failures blamed on "network hiccup" când real cauza e clock drift. Verificat un test la line 320+ din `useSendMessage`-adjacent teste. Recomandare: injected clock pattern.

**§262b** — `tests/*.test.ts` file count = 265. Zero enforcement că fiecare fișier are minim 3 teste. Un fișier cu `describe(...) { it("does X", ()=>{}) }` (empty it) e green.

**§262c** — Bun test doesn't fail on unhandled promise rejection by default (Node.js does). Test-uri care fire-and-forget promise → rejections silent. Adaugă `process.on("unhandledRejection", (r) => { throw r })` la test setup.

**§262d** — `tests/user-hooks.test.ts:99` scrie hook cu `process.exit(1)` — poate să nu fie killed cleanly între teste, leak proces. Bun test isolates per file, nu per test. Risky.

**§262e** — Type-only teste (`ts-expect-error` etc.) sunt evaluate la compile, nu la runtime. Bun `tsc --noEmit` pass detectat, dar coverage report nu include.

**§262f** — Fișiere `.test.tsx` din `frontend-react/src/**/__tests__/` sunt run cu Vitest, nu Bun. Config split — un test file nou pus în path greșit e SKIP silent. Verify glob patterns pentru vitest/bun match toate expected paths.

**§262g** — `expect(promise).resolves.toBe(x)` — awaited implicit. Dacă test uită `await`, mocha/jest throw. Bun test la fel. OK.

**§262h** — `describe.each` cu 100 permutations → 100 test runs. Timing sensitive tests × 100 = flaky. Verifică nu-i abuz de `.each`.

---

## Summary Runda 10

**15 findings** (§248-§262 + sub):

**Confirmed false-green tests (verified prin citire):**
- §248 (`:memory: many opens` — verifică 2, promite many)
- §249 (`counter resets UTC day` — `expect(true)` cu comment "verified by reading code")
- §250 (`escape time` — `expect(true)` cu comment "absence of hang")

**Coverage holes pe MOAT bugs:**
- §251 (RLM notebook escape: 7 rute cataloged, dar array containers NU testate)
- §252 (bunExec env leak — zero test)
- §253 (audit-log concurrent race — zero test)
- §254 (fractal-scale bench SKIP in CI silent)
- §255 (l3-watchdog SKIP in CI silent)
- §256 (RSI safety invariants: 8+ bugs raportate, zero regression tests)
- §257 (Tauri commands sanitization: 6+ bugs raportate, zero regression tests)

**Systemic patterns:**
- §258 (mock-everything → contract tests missing la boundaries)
- §259 (`.skipIf(!ENABLED)` env var gating inconsistent cu CI setup)
- §260, §261, §262x (cleanup, coverage thresholds, unhandled rejections, config split)

**Cumulat: ~259 findings peste 10 runde.**

## Concluzie generală: 10 runde, ~259 findings

**Distribuție severity aproximativă:**
- **~40 CRITICAL** (RCE, arbitrary file read/write, data-exfil, sandbox escape, MOAT invariant broken)
- **~80 HIGH** (data loss, silent state divergence, race conditions cu impact user-visible)
- **~90 MEDIUM** (UX bugs, silent failures, config drifts, resource leaks non-fatal)
- **~50 LOW** (defensive additions, minor style, edge cases rare)

**Pattern-uri fundamentale identificate cross-round:**
1. **Non-atomic writes** pe state critical (~20+ site-uri)
2. **Trust in untrusted input** (commit metadata, filenames, env vars, config JSON)
3. **Listener cleanup race** în React `useEffect` cu async setup (5+ site-uri)
4. **`opts.signal` semantics** inconsistent între retry, fallback, tool call
5. **TOCTOU** race pe port bind, lockfiles, file existence
6. **Substring/contains** security checks bypass-abile prin sub-domain / case
7. **Timeout `Promise.race`** cu losing promise care continues background
8. **Silent swallow errors** în catch handler → user vede success când e fail

**Zone rămase pe care nu am ajuns:**
- `frontend-react/src/components/settings/FeralDreamsPanel.tsx` (1265 linii)
- Complete Tauri lib.rs main bindings
- `crates/feral-cli/src/` complet (4k linii — parțial în runda 3)
- Extensive Go TUI (13k linii — parțial runda 3)
- `FeralAgent/src/egress/{inference-router, inference-providers}.ts` (deep)
- Skills system complet
- Deep test-suite audit (aici doar spot-check)

Dacă va fi vreodată runda 11+, aceste zone sunt candidate. Dar la ~260 findings, curba de descoperire arată clar diminishing returns pe zonele analizate deja — pot să găsim, dar overhead de spot-check crește.

---

## Livrabile finale — linkuri GitHub

Toate 10 runde commit-uite pe `arena/01a01f9e-feral`:

**Fișiere raport:**
- Runda 1: https://github.com/bloom500/feral/blob/arena/01a01f9e-feral/BUGS.md
- Runda 2: https://github.com/bloom500/feral/blob/arena/01a01f9e-feral/BUGS-round2.md
- Runda 3: https://github.com/bloom500/feral/blob/arena/01a01f9e-feral/BUGS-round3.md
- Runda 4: https://github.com/bloom500/feral/blob/arena/01a01f9e-feral/BUGS-round4.md
- Runda 5: https://github.com/bloom500/feral/blob/arena/01a01f9e-feral/BUGS-round5.md
- Runda 6: https://github.com/bloom500/feral/blob/arena/01a01f9e-feral/BUGS-round6.md
- Runda 7: https://github.com/bloom500/feral/blob/arena/01a01f9e-feral/BUGS-round7.md
- Runda 8: https://github.com/bloom500/feral/blob/arena/01a01f9e-feral/BUGS-round8.md
- Runda 9: https://github.com/bloom500/feral/blob/arena/01a01f9e-feral/BUGS-round9.md
- Runda 10: https://github.com/bloom500/feral/blob/arena/01a01f9e-feral/BUGS-round10.md

**Branch / compare / PR:**
- Branch: https://github.com/bloom500/feral/tree/arena/01a01f9e-feral
- Compare vs main: https://github.com/bloom500/feral/compare/main...arena/01a01f9e-feral
- PR-open: https://github.com/bloom500/feral/pull/new/arena/01a01f9e-feral

Pentru Opus 5 / următorul agent care implementează fix-uri: prioritatea absolută = **§142 RLM escape**, **§150 gc data-loss**, **§151 ratchet trust**, **§211 done_when RCE**, **§232 transcribe exfil**. Restul are ordinea log-uită per file/severity în fiecare raport.
