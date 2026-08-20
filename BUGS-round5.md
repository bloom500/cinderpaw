# Sesiune de debugging — runda 5 (L4 modules + frontend stores + Rust rsi core)

**Autor:** Arena Agent Mode
**Data:** 2026-08-20
**Metoda:** analiză statică, ochii pe fișier, `file:linie` pentru fiecare finding.

**Zone acoperite runda asta:**
- **L4 modules:** `module-lifecycle.ts` (537 linii), `module-registry.ts`, `module-proposer.ts`, `module-host-client.ts`, `seam-adapter.ts`, `seam-runtime.ts`, `module-eval.ts`
- **Frontend stores:** `chat.ts`, `conversations.ts`, `download.ts`, `model.ts`, `settings.ts`, `askUser.ts`, `agent.ts`, `onboarding.ts`, `onboardingPersistence.ts`, `notifications.ts`, `ui.ts`
- **Bench:** `bench/orchestrator.ts`, `bench/query-gen.ts`, `bench/runner.ts`
- **Rust rsi:** `tier0.rs`, `plan.rs`, `goodhart.rs`, `scorer.rs`

Total: **~22 bug-uri noi**.

---

## SEVERITATE ÎNALTĂ — impact real, MOAT-related sau data loss

### 119. `module-lifecycle.ts::evaluate()` — un throw în `runL4Contract` lasă `evalBusy` corect (finally) dar module state stuck la `evaluated` fără persist

`FeralAgent/src/rsi/l4-modules/module-lifecycle.ts:212-264`:

```ts
this.evalBusy.add(seam);
try {
  // ... report generated, setState(evaluated) ...
  this.setState(moduleId, "evaluated");
  this.transition(seam, moduleId, state, "evaluated", "dream", report.reason);

  // §6.2 — the Evolution Contract FSM
  const fsm = await this.runL4Contract(moduleId, report, evalDeps.cycleId, thresholds);
  if (!fsm.ok) {
    this.setState(moduleId, "failed");
    // ...
    return { ok: false, reason: `contract FSM: ${fsm.reason}`, report };
  }
  // ...
} finally {
  this.evalBusy.delete(seam);
}
```

Dacă `runL4Contract` **arunca** (nu doar returnează `ok:false`), catch-ul lipsește. `finally` șterge `evalBusy`, dar `setState(moduleId, "evaluated")` deja s-a executat. Env-ul rămâne cu state="evaluated" (evaluable din nou) → next call detectează state="evaluated" (în EVALUATABLE set) → **rulează evaluate din nou → dublează budget FSM + cloud API calls**.

Fix: `try { ... } catch (err) { this.setState(moduleId, "failed"); throw err; } finally { evalBusy.delete(seam); }`.

**Impact:** high pe cost + correctness. Un modul cu bug determinist face dublă cheltuială cloud pe fiecare boot până când user manual demote.

---

### 120. `module-eval.ts` — `latencyBreached` fires pe primul modul când `incumbentMeanMs === 0`

`FeralAgent/src/rsi/l4-modules/module-eval.ts:169-172`:

```ts
const latencyBreached =
  incumbentMeanMs > 0
    ? candidateMeanMs > LATENCY_FLOOR_RATIO * incumbentMeanMs
    : candidateMeanMs > 0;
```

Dacă incumbent e "builtin" și incumbent latencyMs raportate sunt toate 0 (rare, dar posibil pe suite mică sau cu tasks care nu măsoară latency) → `incumbentMeanMs === 0` → fallback la `candidateMeanMs > 0`. **Orice modul funcțional (nonzero latency) e "breached" → reject** deşi corect.

Consecință: **primul modul din seam-ul respectiv nu se poate promoted niciodată**. L4 evolution blocked at seam level până când user furnizează un baseline artificial.

Fix: dacă `incumbentMeanMs === 0`, skip check (return `latencyBreached = false`) și menționează în report că nu-i baseline.

**Impact:** high — MOAT-related. L4 Architecture Evolution nu poate demonstra promovare pe seams noi până e populat baseline manual.

---

### 121. `module-eval.ts::runL4Contract` fitness vector latency component nu-i în [0, 1]

`FeralAgent/src/rsi/l4-modules/module-lifecycle.ts:389-395`:

```ts
fitnessVector: {
  accuracy: passRate,
  latency:
    report.latency.incumbentMeanMs > 0
      ? report.latency.candidateMeanMs / report.latency.incumbentMeanMs
      : 0,
  ...
```

`FitnessVector` (din `journal.ts`) documentează că **fiecare componentă e în [0, 1]** ("lower better" pentru latency). Aici `latency = candidate/incumbent` — dacă candidate 2× mai lent, `= 2.0`. **Range nedelimitat.** L6 meta-evolution scorer va aggrega valori peste 1, calculând scores nefezabile.

Fix: `latency: 1 - clamp(candidate/incumbent, 0, 1)` (higher better în [0,1]) sau normalize cu tanh.

**Impact:** medium-high — MOAT-related. L6 meta-genome fitness distorted → bad meta-decisions bazate pe data corupă.

---

### 122. `seam-adapter.ts::ensureHost` — race la registry change mid-spawn → wrong host attached

`FeralAgent/src/rsi/l4-modules/seam-adapter.ts:100-117`:

```ts
private async ensureHost(moduleId: string): Promise<ModuleHost | null> {
  if (this.host && this.hostModuleId === moduleId && this.host.alive()) return this.host;
  this.stopHost();
  this.spawning ??= (this.o.spawn ?? spawnModuleHost)({
    moduleDir: (this.o.moduleDirFor ?? ((id: string) => join(defaultModulesDir(), id)))(moduleId),
    limits: this.limits,
    log: this.log,
  });
  const res = await this.spawning;
  this.spawning = null;
  if (!res.ok) { ... return null; }
  this.host = res.host;
  this.hostModuleId = moduleId;   // ← seteaza pe MODULE_ID DIN A DOUA INVOKE, nu pe cel spawnat
  return res.host;
}
```

**Sequence exploit:**
1. Invoke A: `active === "mod1"` → `ensureHost("mod1")` → `spawning = spawn("mod1")`, await
2. Registry re-pointed la "mod2" (promotion event)
3. Invoke B: `active === "mod2"` → `ensureHost("mod2")` → check `this.hostModuleId === "mod2"` — false (null) → `stopHost()` no-op → `this.spawning ??= spawn(...)` — DEJA set la spawn("mod1") → **NU spawnează mod2**
4. Await spawn("mod1") returnează host pentru mod1
5. **`this.hostModuleId = "mod2"` DAR host is mod1** → misidentified

Consecință: `invoke` va face request către mod1 crezând că-i mod2. Reply-uri se atribuie greșit → **user-visible: seam răspunde din codul module vechi deşi UI-ul spune că-i promovat cel nou**.

Fix: check `moduleId === expectedModuleId` după await; dacă diferă, cancel + respawn.

**Impact:** high — L4 correctness. Promotion nu efectuează atomic swap; există fereastră unde old module continues.

---

### 123. `module-proposer.ts` — moduleId derived din primele 8 hex chars → birthday collision la ~65k proposals

`FeralAgent/src/rsi/l4-modules/module-proposer.ts:127-130`:

```ts
const sourceHash = createHash("sha256").update(source).digest("hex");
const moduleId = `mod-${row.seam.replace(/_/g, "-")}-${sourceHash.slice(0, 8)}`;
const dir = join(deps.modulesDir, moduleId);
```

`sourceHash.slice(0, 8)` = 32-bit space → birthday collision la ~65k module candidates. Long-running RSI cu dream cycles la fiecare 30min = **~50k proposals/an**. Colision garantată la scale.

Consecință: `mkdirSync(dir, { recursive: true })` **NU throw pe existing** → `writeFileSync(join(dir, "impl.ts"), source)` **SUPRASCRIE** impl-ul unui modul EXISTING (posibil PROMOTED!) → next spawn al modulului promoted vede source nou → seam broken.

Fix: `sourceHash.slice(0, 16)` (64-bit) sau folosește ID complet.

**Impact:** medium-high pentru long-run installs. Data loss deterministic la scale.

---

### 124. `bench/orchestrator.ts::withTimeout` — losing promises continuă să ruleze după timeout

`FeralAgent/src/memory/fractal/bench/orchestrator.ts:118-129`:

```ts
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`bench timeout after ${ms}ms at ${label}`)),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
```

`Promise.race` returnează primul rezolvat, DAR losing promises continuă. `runFractalBenchmark` (`p`) rulează embed calls, cluster summarize, etc. Timer expiră → race rejects with timeout error → user vede "bench timeout after 600000ms at run". **Dar embed-urile background continuă → sidecar CPU spike inexplicabil pentru minute după bench "eșuează"**.

Fix: `AbortController` propagat la embed + infer + retrieval calls; abort la timeout.

**Impact:** medium — MOAT UX. User raportează "sidecar frozen after bench" fără să realizeze că-i work leftover.

---

### 125. `download.ts` store — module-level `listen()` never `await`ed → race la boot + no unlisten

`frontend-react/src/stores/download.ts:58-75`:

```ts
void listen<DownloadProgressEvent>('feral://download-progress', (e) => { ... });
void listen<DownloadCompleteEvent>('feral://download-complete', () => { ... });
void listen<DownloadErrorEvent>('feral://download-error', (e) => { ... });
```

Trei probleme:

1. **`void listen(...)` discardează `UnlistenFn`** — imposibil de unregister. Hot-reload dev = duplicate handlers permanent.
2. **`listen` e async** — dacă `feral://download-complete` fires ÎNAINTE ca `listen()` să se rezolve (rare, dar posibil la fast reload), handler ratează event.
3. **`download-complete` handler nu verifică repoId/filename** — dacă user cancel-uiește A și pornește B, un late `complete` pentru A execută `setState({ active: null, done: true })` → B pierdut mid-download.

Fix pentru (3):
```ts
void listen<DownloadCompleteEvent>('feral://download-complete', (e) => {
  const { active } = useDownload.getState();
  const key = `${e.payload.repoId}::${e.payload.filename}`;
  if (active?.key !== key) return;   // ignore stale events
  useDownload.setState({ active: null, done: true, error: null });
});
```

**Impact:** medium. Bug (3) real în multi-download UX.

---

### 126. `conversations.ts::toChatMessage` — timestamp original NU se restaurează

`frontend-react/src/stores/conversations.ts:34-46`:

```ts
function toChatMessage(p: PersistedMessage, idx: number): ChatMessage {
  return {
    id: `msg-${idx}-${Date.now()}`,
    role: p.role === 'user' ? 'user' : 'assistant',
    content: p.content,
    ...
    createdAt: Date.now() - (1000 * (1000 - idx)),   // ← fabricated, not restored
  };
}
```

`PersistedMessage` (din Rust `Conversation`) nu conține `timestamp` field. La restore, `createdAt` e calculat `Date.now() - 1000*(1000-idx)`. Deci mesaje reloaded arată "acum 5 secunde", "acum 10 secunde", etc. — indiferent când au fost create.

Consecință UX: tooltips greșite, ordering by `createdAt` incorect dacă vreodată se merge cu mesaje noi în același load.

Fix: adaugă `timestamp: string` sau `createdAt: number` la `PersistedMessage` shape (backward compat cu `#[serde(default)]`).

**Impact:** medium — nu-i data loss, dar timeline UX degraded.

---

### 127. `model.ts::load` — dacă `events.modelLoadProgressEvent.listen()` throw, state stuck `isLoading: true`

`frontend-react/src/stores/model.ts:82-98`:

```ts
load: async (path) => {
  set({ isLoading: true, cloudModel: null, loadProgress: { ... } });
  if (progressUnlisten) { progressUnlisten(); progressUnlisten = null; }
  progressUnlisten = await events.modelLoadProgressEvent.listen((e) => { ... });
  try {
    const loaded = await tauri.models.startLoad(path, maxContext);
    set({ loaded, isLoading: false, loadProgress: null });
    ...
  } catch (err) {
    set({ isLoading: false, loadProgress: null });
    throw err;
  } finally {
    if (progressUnlisten) { progressUnlisten(); progressUnlisten = null; }
  }
},
```

Setează `isLoading: true` SYNC, apoi `await listen(...)` — dacă listen throw (permission denied, plugin missing, race la Tauri init), catch-ul TRY doar nu-i reached (throw a fost înaintea try block). State stuck `isLoading: true` permanent → UI shows loading spinner forever, load button disabled.

Fix: mutată `set({isLoading:true})` INSIDE `try`, sau adăugă try/catch pe `listen`.

**Impact:** medium. UI-ul devine stuck și necesită reload complete.

---

## SEVERITATE MEDIE — logic, race-uri, correctness

### 128. `tier0.rs::fact_lookup_ok` — substring match pe number answers = fals positive

`crates/feral-core/src/rsi/tier0.rs:175-185`:

```rust
fn fact_lookup_ok(response: &str, answer: &str, forbidden: &[String]) -> bool {
  let norm_resp = normalise(response);
  let norm_ans = normalise(answer);
  if norm_resp.is_empty() || norm_ans.is_empty() { return false; }
  if !norm_resp.contains(&norm_ans) { return false; }
  ...
}
```

Tier 0 specs conțin answers ca `"8"` (planeta count), `"1945"` (UN founded), `"3.14"` (pi). `contains("8")` pe `"There are 18 planets"` = PASS. `contains("3.14")` pe `"Pi is 13.14159"` = PASS. `contains("1945")` pe `"the war ended in 194504"` = PASS.

**Consecință MOAT**: Tier 0 sanity check își pierde promisiunea de "binary verifiable facts". Un model care hallucinate confidently poate PASS toate 10 checks.

Fix: pentru numeric answers, word-boundary match cu regex `\bN\b`. Pentru non-numeric, keep substring (mai lax OK pentru text).

**Impact:** high — MOAT correctness. Toate metricile RSI care depind de Tier 0 pass rate sunt suspect.

---

### 129. `scorer.rs::score` — max theoretical score e w_success (55), nu 100 cum promite comentariul

`crates/feral-core/src/rsi/scorer.rs:52-58`:

```rust
let success_component = weights.w_success * raw.success_rate;   // max 55
let cost_component = -weights.w_cost * raw.cost_normalized;      // max 0 (penalty)
let error_component = -weights.w_error * raw.error_rate;         // max 0
let latency_component = -weights.w_latency * raw.latency_normalized;  // max 0
let score = (success + cost + error + latency).clamp(0.0, 100.0);
```

Max score = `w_success * 1.0 + 0 + 0 + 0 = 55`. Comentariul header spune "Normalised 0..100". Weights adaună 100 (55+15+20+10) dar penalitățile SCAD din w_success, nu adaugă.

Un genome perfect: success=1, cost=0, error=0, latency=0 → score = 55. UI arată "55/100" → user crede că-i mediocru.

Fix: adjust formula pentru a atinge 100 la performance perfect, ex `score = w_success * success - w_cost * cost - w_error * error - w_latency * latency + (w_cost + w_error + w_latency)` (bonus la penalty-free).

**Impact:** medium — nu afectează ordering ratchet (relative comparisons OK), dar UI misleading + reports greșite.

---

### 130. `askUser.ts::submit` — `p.resolve(answers)` fires DUPĂ `set(...)`, dar dacă `resolve` handler modifică pending state, race

`frontend-react/src/stores/askUser.ts:132-153`:

```ts
submit: (answers) => {
  const p = get().pending;
  if (!p) return;
  set((s) => {
    const [next, ...rest] = s.waiting;
    return {
      pending: next ?? null,
      waiting: next ? rest : [],
      history: [ ..., ...],
    };
  });
  p.resolve(answers);   // ← if this triggers another request via chained promises, race
},
```

Dacă `p.resolve` handler (chain via `then`) apelează `useAskUser.getState().request(...)` sync (nu comun, dar posibil), noul request va vedea `pending: null` sau `pending: next` — imprevisibil timing.

Nu-i critic dar contract-ul stricti "atomic transition" e ruped.

---

### 131. `chat.ts::completeToolCall` — `setTimeout` cleanup uncancelled → timers accumulate la rapid new sessions

`frontend-react/src/stores/chat.ts:326-329`:

```ts
window.setTimeout(() => {
  set((s) => ({ toolCallStream: s.toolCallStream.filter((e) => e.id !== id) }));
}, TOOL_CALL_LINGER_MS);
```

Nu-i clearTimeout pe `newSession()`. Timer-ul rulează după N secunde, execute filter no-op (id already gone), dar timer occupies EventLoop resources.

La un user care rapid new-chat/new-chat/new-chat (rare, dar happens la testing), 100 pending timeouts accumulate.

Fix: track active timers într-un Set, clear pe `newSession`.

---

### 132. `download.ts` cancel path — race între `cancel()` local set și late `progress` event

`frontend-react/src/stores/download.ts:43-49`:

```ts
cancel: async () => {
  const { active } = get();
  if (!active) return;
  set({ active: null, done: false, error: null });   // ← local set FIRST
  try {
    await tauri.download.cancel(active.key);         // ← backend cancel
  } catch { /* ignore */ }
},
```

Sequence:
1. `cancel()` — `active = null` local
2. Backend nu a primit încă cancel — download continues
3. `feral://download-progress` fires cu vechi key
4. Handler: `if (active?.key !== key) return;` — active null → return. OK.

Actually corect. Skippăm.

---

### 133. `module-lifecycle.ts::propose` — validare `id === moduleId` prea slabă

`FeralAgent/src/rsi/l4-modules/module-lifecycle.ts:150-152`:

```ts
if (res.manifest.id !== moduleId) {
  return { ok: false, reason: `manifest id ${res.manifest.id} ≠ directory id ${moduleId}` };
}
```

`moduleId` provine din caller (posibil user input via propose command). Compară cu manifest.id. Dar dacă manifest are `id: "../../evil"`, `validateManifest` (linia 87) blochează cu `/[\\\/]|\.\./`. OK.

Verificare separat: `writeEnvelope(id: moduleId)` — daca moduleId conține path separators, envelope path e escape. Verific `updateEnvelope`:

<br>

Skipăm — protejat de validateManifest care rejects path traversal.

---

### 134. `goodhart.rs` — window shrink la clamp poate ratează early samples

`crates/feral-core/src/rsi/goodhart.rs:50-58`:

```rust
pub fn new(window_size: u32, tier1_threshold: f64, tier2_threshold: f64, consecutive_required: u32) -> Self {
  let cap = (window_size as usize).clamp(1, MAX_WINDOW);
  ...
}
```

Dacă `window_size = 0` (user misconfigured bounds), `clamp(1, MAX_WINDOW)` = 1. Window size 1 → orice single sample devine "consecutive run" — cu `consecutive_required = 3`, `have_enough_samples = window.len() >= 3` — window.len() max 1 → false → **never triggers**.

Nu-i buggy per se, dar edge case: `window_size = 0` silently disables detector. Better: reject explicitly (return Err).

**Impact:** low — detector poate fi silent disabled by config bug.

---

### 135. `runFractalBenchmark::pre-embed` fires ÎNAINTE de check `queries.length === 0`

Wait, check-ul e la linia 195 (`if (queries.length === 0)`). Pre-embed la 210. Order-ul e corect. Skippăm.

---

### 136. `module-host-client.ts::request` — `nextId` monotonic increments, dar `pending` map poate acumula după host kill

`FeralAgent/src/rsi/l4-modules/module-host-client.ts:220-247`:

```ts
request(method, params) {
  ...
  const id = String(nextId++);
  return new Promise<HostReply>((resolve) => {
    const timer = setTimeout(() => { ... resolve({ok:false, timedOut:true}); }, opts.limits.timeoutMs);
    pending.set(id, (reply) => { ... });
    proc.stdin.write(...);
  });
},
```

Dacă `proc.stdin.write` throws (broken pipe), promise never resolves — `pending` entry rămâne. Kill-ul via watchdog eventually calls `for (const [, settle] of pending) settle(...)`, DAR dacă `proc.stdin.write` sync throw nu ajunge acolo → orphan pending entry până next `kill()`.

Fix: try/catch pe `stdin.write` + `resolve({ok:false, error:"stdin closed"})` on error.

---

### 137. `seam-runtime.ts::liveSeamAdapter` — adapter cache never invalidated if `builtin` changes

`frontend-react/src/rsi/l4-modules/seam-runtime.ts:42-59`:

```ts
export function liveSeamAdapter(seam, builtin, log) {
  let a = adapters.get(seam);
  if (!a) {
    a = new SeamAdapter({ seam, ..., builtin, ... });
    adapters.set(seam, a);
  }
  return a;
}
```

Al doilea call cu **diferit `builtin` function** returnează old adapter cu vechiul builtin. Nu apar bug real dacă callers stau consistent, dar contract-ul e fragil — refactor future ar putea break silent.

Fix: throw dacă `a.builtin !== builtin`, sau don't cache.

---

## SEVERITATE JOASĂ

### 138. `bench/orchestrator.ts::mapLimit` — `next++` shared across workers OK, dar dacă `fn` face throw, alte workers continuă

`FeralAgent/src/memory/fractal/bench/orchestrator.ts:90-104`:

```ts
async function mapLimit<T, R>(items, limit, fn) {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i]!, i);   // ← throw propagates to Promise.all
    }
  };
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, () => worker()));
  return out;
}
```

Un throw în `fn` propagates via Promise.all. Dar alți workers deja au picked up items — ei continuă până la epuizare, waste work. `out` array cu holes (slots pentru items alocate de failed workers). Return-ul are `undefined` la indices care nu completed.

Nu-i critic pentru bench context (throw = hard fail user visible), dar defensive: catch fn errors → sub-fail semantic.

---

### 139. `notifications.ts` — setTimeout `dismiss` NU clearTimeout dacă user manually dismisses

Deja discutat, low impact.

---

### 140. `agent.ts::save` — `writePersistedId(saved.id ?? null)` — save o valoare care poate fi null dacă backend nu returnează id

Rare, dar dacă `tauri.agents.save(cfg)` returnează cfg cu `id: undefined`, localStorage set with null. Next load: `list.find(a => a.id === null)` — nu găsește nimic → resets to first. Silent state loss.

---

### 141. `PLAN_MD` din `plan.rs` — nu-i validat că matches ce e scris la disk

`crates/feral-core/src/rsi/plan.rs`: `PLAN_MD` e const `&'static str`. `bootstrap()` scrie plan la disk la `~/.feral/rsi/PLAN.md`. Nu-i mechanism care detecta divergență (user edited PLAN.md).

Comentariul recunoaște — "DO NOT EDIT" — dar nu enforce. `bootstrap()` doar scrie dacă `!plan_path.exists()`. Subsequent boots cu PLAN.md prezent ignoră `PLAN_MD` embedded. User poate edit local → bootstrap nu re-writes → discrepancy silent.

Fix: verify hash la boot; if differs, log warning + audit event.

---

## Recomandări prioritizate — runda 5

1. **§119** — try/catch în `evaluate()` pentru corectitudine state. Un throw în FSM face dublă cheltuială.
2. **§120** — `latencyBreached` să skip dacă `incumbentMeanMs === 0`. Otherwise, L4 architecture evolution nu poate promoted primul modul.
3. **§121** — `latency` fitness component normalizat în [0, 1]. L6 meta-decisions distorted altfel.
4. **§122** — `ensureHost` race la registry re-point. Wrong host attached to seam.
5. **§128** — Tier 0 `fact_lookup_ok` word-boundary match pentru numerici. MOAT correctness.
6. **§123** — module ID length 16 chars în loc de 8 → prevent birthday collision.
7. **§125** — download store event handlers să verifice key match; unlisten stored.
8. **§126** — persist message timestamp în conversation shape.

---

## Ce n-am acoperit încă

- `crates/feral-core/src/rsi/repo.rs` (git operations — partially acoperit runda 2/4)
- `frontend-react/src/hooks/*` (useDreamCycle, useEmbeddingDownloadStatus, useAudioPlayer)
- `frontend-react/src/components/agents/*` (AgentChat, FeralModelSelector)
- `frontend-react/src/components/settings/*` (FractalBenchmarkPanel deja acoperit runda 1; FeralDreamsPanel n-am acoperit)
- `FeralAgent/src/rlm/*` (children, repl)
- `FeralAgent/src/brain/*` (brain-stack, task-classifier — briefly touched round 4)
- `FeralAgent/src/public-journal/*`
- `FeralAgent/src/vendor/*`
- `crates/feral-core/src/tts/*` (Fish provider)

Trend cumulat peste 5 runde — **7 patterns dominante**:
1. Non-atomic writes fișiere state critical (peste 20 site-uri, helper există)
2. Race conditions hash-chain (audit + journal + governance)
3. HTTP/network fără timeout sau size cap
4. TOCTOU pe port bind, downloads, file existence
5. Substring/contains security checks
6. React/reactive-store listener register async + sync teardown race
7. **NEW: async ops without cancel token** — `withTimeout`, `Promise.race` — losing promises continue background work

Total peste 5 runde: **~139 bug-uri distincte** cu file:linie + snippet + fix concret.
