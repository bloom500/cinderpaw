# Runda 6 — RLM notebook + Brain Stack + repo.rs (git substrate) + Fish TTS + public-journal exporter + hooks

**Scope:** zone rămase din TODO-ul rundelor precedente + partea reală de sandbox al RLM (repl.ts) + git substrate al RSI-ului (`crates/feral-core/src/rsi/repo.rs`) + Brain Stack (routing engine multi-model) + Fish TTS provider + `public-journal` exporter + `frontend-react/src/hooks/*`. Toate findings verificate cu ochii pe fișier, `file:linie` + snippet + fix concret.

Prioritate specială: **§142** este un sandbox escape real al notebook-ului RLM prin proto-leak într-un `.map()` — voidează întreaga clasă de garanții din `severed()`. **§144** este un mic leak în UI-ul de voice recorder. **§150** este data loss cert în `repo::gc` sub concurență. **§152** e cheia Fish trimisă la un base_url arbitrar necontrolat.

---

## §142 — RLM notebook: proto-leak în `.map()` din inside-`severed({...})` deschide sandbox escape

`FeralAgent/src/rlm/repl.ts:205-207` (helper `rlm.observe`):

```ts
rlm.observe = severed(async (target: unknown) => {
  const e = kids.observe(target.trim());
  return severed({ ...e, trail: (e.trail ?? []).map((t) => severed({ ...t })) });
});
```

Comentariile de sus (`repl.ts:98-114`) enunță explicit contractul: *"handing back an object with host `Object.prototype` would reopen the `.constructor` route we just closed"*. Fixul via `severed()` cuts prototypul obiectului top-level.

Dar `(e.trail ?? []).map(...)` întoarce un `Array`, iar `Array.prototype` este NEATINSĂ. Rezultatul returnat arată așa (structural):

```js
{ __proto__: null,
  rlm_child_id: "...", ..., 
  trail: <Array cu Array.prototype intact> }
```

Din notebook, un model care apelează `rlm.observe(...)` primește `result` — proto-ul lui e null, dar `result.trail` este un Array normal:

```js
const r = await rlm.observe("worker");
const HostFunction = r.trail.constructor.constructor;   // host Function
const proc = HostFunction("return process")();          // Node process, host realm
proc.mainModule.require("child_process").execSync("...");
```

Escape complet, cu bypass la egress-proxy / audit / permissions — exact clasa care testele "load-bearing" din `tests/rlm-notebook.test.ts` sunt supuse să prindă.

Același pattern e prezent în **cel puțin trei alte locuri**:

* `repl.ts:200` — `rlm.list_subagents`:
  ```ts
  rlm.list_subagents = severed(async () => severed({ subagents: kids.list().map((e) => severed({ ...e })) }));
  ```
  `kids.list().map(...)` → Array cu proto-ul intact.

* `repl.ts:203` — `rlm.messages`:
  ```ts
  rlm.messages = severed(async () =>
    severed({ messages: kids.drainInbox().map((m) => severed({ ...m })) }));
  ```

* `repl.ts:210-213` — `rlm.delete_subagent` întoarce doar top-level severed, fine — dar `e.trail` din `observe` return path lasă și un secundar leak: `for (const t of e.trail ?? [])` — `t.__proto__` e null dar t însuși e clonat din trail-ul lui `entry` care e populat cu obiecte `{at, kind, detail}` literale în `children.ts:163-165` — plain host `Object.prototype`. Dacă modelul face `Object.getPrototypeOf(r.trail[0])`, primește Object.prototype? Nu — pentru că `severed({...t})` face proto null la obiectul spread. OK, dar Array-ul containerului e problema principală.

De asemenea, în wrapperul de tool `repl.ts:159-163`:

```ts
sandbox[toIdentifier(name)] = severed(async (args: Record<string, unknown> = {}) => {
  ...
  const res: ToolResult = await opts.registry.call(name, args ?? {}, opts.sessionId, {...});
  return severed({ ok: res.ok, content: res.content, data: res.data, error: res.error });
});
```

`res.data` este `unknown` — poate fi un `Array` sau un obiect nested cu proto-uri intacte. `severed({...})` doar cuts proto-ul plicului. Pentru orice tool care întoarce array-uri sau obiecte imbricate (grep results, list_files, etc), model accesează `result.data.constructor.constructor` = host Function → escape.

**Fix:** un helper `deepSever` care recursiv setează `Object.setPrototypeOf(v, null)` pe orice `typeof v === "object" && v !== null`, tratând `Array.isArray` separat (`Object.setPrototypeOf(arr, null)` funcționează dar rupe `.length`? Nu, `.length` este own property pe array, nu inherited — merge). Test de regresie: cell care rulează `const r = await rlm.list_subagents(); return r.subagents.constructor.constructor("return process")()`. Actual escape → PASS după fix (ReferenceError sau TypeError).

Comentariul din `repl.ts:33` avertizează exact: *"if one starts passing values back out, the sandbox is void"*. Se voidează AZI.

---

## §143 — RLM `#calls` array crește nemărginit → memory leak în notebook lung

`FeralAgent/src/rlm/repl.ts:135` + `:160`:

```ts
#calls: string[] = [];
...
sandbox[toIdentifier(name)] = severed(async (args = {}) => {
  this.#calls.push(name);       // ← push forever
  ...
});
```

Nu există trim / bounded ring / rotation. Fiecare tool call scrie în `#calls`. Notebook-ul RLM e "long-lived" (comment repl.ts:132), persistă între turns și supraviețuiește compactării. La 10k tool-calls (câteva săptămâni de uz activ) `#calls` are 10k stringuri, dar mai grav — la fiecare cell `this.#calls.slice(before)` copiază un slice — memoria persistă în heap.

Get-erul `toolCalls` întoarce `this.#calls` (readonly) — nimic nu o citește ca whole array însă, doar `.slice(before)` per cell.

**Fix:** înlocuiește cu ring buffer bounded (`const MAX_CALLS_KEPT = 10_000`) sau resetează după fiecare cell: `this.#calls.length = 0; return { toolCalls: [...calls] }` — dar atunci `.slice(before)` nu mai are sens. Cel mai clean: în `run()`, local array `const cellCalls: string[] = []`, transmisă wrapper-ului prin closure în constructor — nu, injectat DYNAMIC nu merge fără a rebuilder sandboxul.

Alternativ: la fiecare cell trim la ultimele N; sau folosește un counter `#callSeq` și un flush.

---

## §144 — `useVoiceRecorder.start()`: mic-ul rămâne LIVE dacă `new MediaRecorder(stream)` aruncă

`frontend-react/src/hooks/useVoiceRecorder.ts:23-52`:

```ts
try {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  streamRef.current = stream;
  ...
  const rec = new MediaRecorder(stream);   // ← poate arunca (codec unsupported)
  ...
} catch {
  setError('denied');
  setState('idle');
}
```

Flow-ul:
1. `getUserMedia` reușește → user vede LED microfon aprins.
2. `streamRef.current = stream` — capturat.
3. `new MediaRecorder(stream)` aruncă (WebView2 în Tauri e capricios cu MIME types).
4. `catch { setError('denied'); setState('idle'); }` — nu apelează `stream.getTracks().forEach((t) => t.stop())`.
5. Mic rămâne live până la GC-ul pe stream ref sau la unmount.

Utilizatorul crede că "recording nu a mers", dar OS-ul zice altceva: mic actively recording la nivelul de driver. Pe Windows/macOS, indicator system-level rămâne aprins → privacy hit.

Aceeași problemă în branch-ul `setError('denied')` de la `getUserMedia` reject-ed: acolo `streamRef` e null, deci OK. Bug e strict în path-ul MediaRecorder throw.

**Fix:**

```ts
} catch (err) {
  // Cleanup ce s-a apucat: getUserMedia poate să fi obținut mic-ul înainte
  // ca MediaRecorder să eșueze pe MIME type.
  streamRef.current?.getTracks().forEach((t) => { try { t.stop(); } catch {} });
  streamRef.current = null;
  recorderRef.current = null;
  const isDenied = err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "PermissionDeniedError");
  setError(isDenied ? 'denied' : 'unsupported');
  setState('idle');
}
```

De asemenea, mesajul `setError('denied')` e o minciună pentru user când e vorba de codec — trebuie distinct.

---

## §145 — `useVoiceRecorder.reset()`: race cu `onstop` — blob-ul apare după reset

`frontend-react/src/hooks/useVoiceRecorder.ts:60-69`:

```ts
const reset = useCallback(() => {
  streamRef.current?.getTracks().forEach((t) => t.stop());
  streamRef.current = null;
  recorderRef.current = null;      // ← nu-l oprește
  chunksRef.current = [];
  setBlob(null);
  setDurationMs(0);
  setState('idle');
  setError(null);
}, []);
```

Când utilizatorul apasă "reset" în timp ce state === 'recording':
1. `streamRef.current?.getTracks().forEach((t) => t.stop())` → track-urile se opresc → MediaRecorder emite `onstop`.
2. Dar între `recorderRef.current = null` (linia 63) și fire-ul async al `onstop`, handler-ul `rec.onstop` capturat în closure la `start()` (linia 33-45) rulează.
3. `onstop` face `setBlob(b); setDurationMs(...); setState('preview')`.
4. Rezultat: `reset()` fusese apelat, dar UI-ul re-intră în 'preview' cu un blob mut/parțial. Butonul "Send" apare peste "Reset".

**Fix:** înainte de stop track-uri, detașează handler-ul:

```ts
const reset = useCallback(() => {
  const rec = recorderRef.current;
  if (rec) {
    rec.ondataavailable = null;
    rec.onstop = null;
    try { if (rec.state !== 'inactive') rec.stop(); } catch {}
  }
  recorderRef.current = null;
  streamRef.current?.getTracks().forEach((t) => { try { t.stop(); } catch {} });
  streamRef.current = null;
  chunksRef.current = [];
  setBlob(null);
  setDurationMs(0);
  setState('idle');
  setError(null);
}, []);
```

Același pattern lipsește în cleanup-ul de unmount — nu există `useEffect(() => () => { ... }, [])`. Component-ul se demontează în timp ce e 'recording' → track-urile rămân live până GC. **Bug secundar**: adaugă un cleanup effect care apelează `reset()` la unmount.

---

## §146 — `useAudioPlayer` — sursa se schimbă în timp ce cântă: dublu-audio până se decodează

`frontend-react/src/hooks/useAudioPlayer.ts:26-32`:

```ts
useEffect(() => {
  bufferRef.current = null;
  offsetRef.current = 0;
  setProgress(0);
  setPlaying(false);
}, [source]);
```

Efectul resetează bufferul și seteaza `playing = false` **doar în state React**. Dar nodul audio LIVE (`nodeRef.current`) nu e oprit. Reduce testul: user apasă play pe mesaj A, schimbă source la mesaj B în părinte:

1. `nodeRef.current` cântă buffer-ul A prin AudioContext.
2. Effect-ul rulează → `bufferRef.current = null`, `setPlaying(false)`.
3. User re-apasă play pe B → `play()` decodează B → alocă nod nou.
4. `stopNode()` din `play()` (linia 74) oprește vechiul nod A doar dacă `nodeRef.current` a fost setat pentru A. Este! Deci se oprește A înainte de a începe B.

Reglez — nu e chiar dublu-audio, dar: în intervalul dintre pas 1 și pas 3, nodul A cântă în tăcere UI (setPlaying(false) dar audio real merge). Utilizatorul vede pauză dar aude sunetul continuu. Bug.

**Fix:** oprește nodul în effect:

```ts
useEffect(() => {
  stopNode();               // ← ADAUGĂ
  bufferRef.current = null;
  offsetRef.current = 0;
  setProgress(0);
  setPlaying(false);
}, [source, stopNode]);
```

---

## §147 — `useAudioPlayer.play()`: dacă `decodeAudioData` aruncă, `playing` rămâne stuck în orice stare intermediară + AudioContext leak

`useAudioPlayer.ts:73-92`:

```ts
const play = useCallback(async () => {
  const buf = await ensureBuffer();     // ← poate arunca (Web Audio decode error)
  const ctx = ctxRef.current!;
  ...
  setPlaying(true);
  rafRef.current = requestAnimationFrame(tick);
}, [ensureBuffer, stopNode, tick]);
```

Când `decodeAudioData` respinge (fișier corupt, codec necunoscut), `play` respinge cu error unhandled — dar `ensureBuffer` crează AudioContext-ul (`ctx = ctxRef.current ?? (ctxRef.current = new AC())`, linia 40) chiar dacă decode eșuează după. `setPlaying(true)` nu se atinge — OK — dar:

1. AudioContext rămâne alocat până la unmount → un context per player component per source-change → limitele Chrome (6 AudioContexts) se ating pe conversații lungi cu multe recordings, iar noi `new AC()` aruncă. Blocher.

2. `toggle()` (linia 100-103) apelează `void play()` — promise-ul rejected e swallowed silently. User apasă play, nu se întâmplă nimic, nici o eroare vizibilă.

**Fix:** wrap într-un try/catch care distruge contextul dacă decode fails:

```ts
const play = useCallback(async () => {
  try {
    const buf = await ensureBuffer();
    const ctx = ctxRef.current!;
    if (ctx.state === 'suspended') await ctx.resume();
    stopNode();
    ...
  } catch (err) {
    // Decode failed → drop the context so next play() nu se blochează.
    if (ctxRef.current) { void ctxRef.current.close(); ctxRef.current = null; }
    bufferRef.current = null;
    setPlaying(false);
    // TODO: surface a toast — currently silently fails
    throw err;
  }
}, [ensureBuffer, stopNode, tick]);
```

Și `toggle` să propage error-ul sau să-l afișeze user-ului.

---

## §148 — `useEmbeddingDownloadStatus`: probe timer nu se anulează când vine complete/error → tranziție incorectă `downloading→present` sau `failed→present`

`frontend-react/src/hooks/useEmbeddingDownloadStatus.ts:75-87`:

```ts
try {
  await tauri.raw.downloadEmbeddingModel();
  probeTimer = setTimeout(() => {
    if (!alive) return;
    setState((s) => (s.kind === 'idle' ? { kind: 'present' } : s));
  }, PRESENT_PROBE_MS);
} catch (err) {...}
```

Race scenario:
1. `downloadEmbeddingModel()` întoarce imediat cu Ok — model deja pe disc — setează `probeTimer` la 500ms.
2. Între timp, evenimentul `onEmbeddingDownloadProgress` sosește (repoId="embedding", venind de la un download paralel triggered de altă componentă / eveniment de altă natură). Handler setează `state = { kind: 'downloading', progress: X }`.
3. La 500ms probeTimer firează. `s.kind === 'idle'` este `false` (e 'downloading'), deci timer-ul nu face nimic. OK.

Dar celalt scenariu:
1. `downloadEmbeddingModel()` Ok, timer armed.
2. Un event de `complete` de la un download precedent NU-embedding sosește — filtered de `isEmbeddingEvent`. OK.
3. Un event `error` sosește (repoId="embedding") înainte de 500ms → `setState({ kind: 'failed', reason })`.
4. Timer fires: `s.kind === 'idle'` false → no-op. OK.

Deci logica e safe. Dar există un bug diferit:

**`readdir` order + probeTimer** = false present când modelul e într-adevăr on-disk dar sidecar-ul re-descarcă un update:
1. `downloadEmbeddingModel()` returns Ok imediat pentru un file existent.
2. Sidecar-ul detectează hash mismatch (vs upstream) și decide să REDESCARCE — dar returnul Ok deja s-a produs.
3. Timer fires la 500ms → 'present'.
4. Progress events încep să curgă → user vede state salturi 'present' → 'downloading' → 'present'.

Not fatal, dar UX jenant. **Fix mai important**: verifică că download nu e "already in progress" ATUNCI când probează:

De asemenea:

`useEmbeddingDownloadStatus.ts:97-99`:

```ts
for (const u of unlistens) {
  try { u(); } catch { /* listener may already be detached */ }
}
```

`unlistens` e populat asincron după `await`. Dacă componenta se demontează în intervalul dintre `void setup()` și fine-ul lui `setup()`, `unlistens = []` la cleanup, iar cei 3 listeners `u1, u2, u3` sunt înregistrați DUPĂ cleanup → **listener leak**. Același pattern raportat în §125 pentru download.ts, se repetă aici. Fix:

```ts
let cancelled = false;
const local: UnlistenFn[] = [];
const setup = async () => {
  const u1 = await events.on...
  if (cancelled) { u1(); return; }
  local.push(u1);
  const u2 = await events.on...
  if (cancelled) { u2(); return; }
  local.push(u2);
  ...
};
void setup();
return () => {
  cancelled = true;
  alive = false;
  ...
  for (const u of local) try { u(); } catch {}
};
```

---

## §149 — `crates/feral-core/src/rsi/repo.rs::ratchet_attempt` — HEAD-reassign error ignorat lasă `main` mișcat dar HEAD detașat

`crates/feral-core/src/rsi/repo.rs:363-365`:

```rust
let main_branch = repo.find_branch("main", BranchType::Local)?;
let mut main_reference = main_branch.into_reference();
main_reference.set_target(candidate_oid, "rsi: ratchet advance")?;
// Detach the working tree just in case anyone is observing it.
let _ = repo.set_head("refs/heads/main");
```

`let _ = repo.set_head(...)` swallow-uiește orice error din `set_head`. Când `set_head` eșuează (locking, corrupt HEAD, IO error), main-ul deja avansat, dar HEAD rămâne unde era (posibil pe o branch veche sau detached). Următoarea comisie `commit_genome` cu `Some("HEAD")` (`repo.commit(Some("HEAD"), ...)`) va scrie pe branch-ul greșit → coruperea graph-ului RSI.

Comentariul zice "just in case" — dar dacă a fost apelul care schimbă HEAD DEcompletitor de la un candidate branch la main, e critic pentru consistency.

**Fix:**

```rust
repo.set_head("refs/heads/main")
    .context("ratchet advanced main but failed to reset HEAD")?;
```

Ratchet-ul nu se declară "advanced: true" până când starea repo-ului nu e consistentă. `RatchetResult` cu `advanced: true` dar HEAD greșit e o minciună.

---

## §150 — `repo::gc_sync` șterge loose objects concurente cu `commit_genome` — DATA LOSS

`crates/feral-core/src/rsi/repo.rs:485-522` (walk reachable) + `525-575` (delete unreachable):

```rust
let reachable: HashSet<Oid> = HashSet::new();
// ... walk refs + revwalk to fill reachable ...

for entry in std::fs::read_dir(&objects_dir) {
    ...
    if reachable.contains(&oid) { loose_after += 1; continue; }
    std::fs::remove_file(inner.path()) → loose_pruned += 1;
}
```

Nu există lock pe repo (git-style `.git/index.lock`, `.git/objects/pack/pack-.tmp`, sau advisory `fcntl(F_SETLK)`). `gc()` este `pub async fn gc()` (linia 476-479) — apelabil oricând din maintenance task.

Race:
1. `gc_sync` colectează `reachable` set la T0.
2. La T1 (după colectare, înainte de prune): `commit_genome` scrie un nou blob în `.git/objects/ab/1234...`, dar înainte de a-l referi în tree/commit.
3. `gc_sync` iterează loose files, vede acest blob nou, `oid ∉ reachable` (colectat la T0) → **DELETE**.
4. `commit_genome` la T2 încearcă să facă `repo.commit(...)` — index-ul referă tree-ul care referă blob-ul șters → `git2` întoarce error "object not found" sau creează un commit corupt (referință dangling).

Chiar mai rău: `write_tree` (`commit_genome:265`) reușește pentru că libgit2 verifică existența la write_tree — dar dacă gc șterge după write_tree și înainte de commit... același outcome corupt.

Al doilea vector: pack files nu-s atinse, dar dacă `commit_genome` produce un `.pack.tmp` (rare — genome commits sunt scrise loose), gc-ul filtrare doar `xx/38-hex` → OK. Blob-urile normale sunt vulnerabile.

**Fix:** ia `.git/config`-style flock înainte de gc. Cel mai simplu:

```rust
fn gc_sync() -> Result<GcReport> {
    let rsi_path = rsi_dir();
    let lock_path = rsi_path.join(".git").join("feral-gc.lock");
    let lock = std::fs::OpenOptions::new()
        .create(true).write(true).open(&lock_path)
        .context("open gc lock")?;
    // fs2 crate: file lock; Windows-friendly.
    fs2::FileExt::try_lock_exclusive(&lock)
        .map_err(|e| anyhow!("gc: another gc or commit is running: {e}"))?;
    // ... existing code ...
    let _ = fs2::FileExt::unlock(&lock);
    Ok(report)
}
```

`commit_genome` trebuie să achiziționeze același lock **partajat** (shared read lock) sau să folosească o strategie diferită — vezi cum `git` real folosește `git-fsck --lost-found` + `gc.pruneexpire=2.weeks.ago` ca windows de siguranță. **Alternativă minimă**: nu prune loose files mai noi decât 2 min:

```rust
let modified = inner.metadata()?.modified()?;
if modified.elapsed().unwrap_or(Duration::ZERO) < Duration::from_secs(120) {
    loose_after += 1;
    continue;   // don't prune fresh files
}
```

Same trick pe care `git gc --prune=2.weeks.ago` îl aplică. Numai apoi aplică flock pentru operațiuni concurente.

**Impact MOAT**: data loss în substrate-ul RSI = corupem hash chain-ul de commits + genome snapshots pierdute → BRSI iteration history compromisă → ratchet monotonicity BROKEN dacă un commit dintre bootstrap și tip pierde blob-ul.

---

## §151 — `repo::ratchet_attempt` acceptă score-ul din commit body TRUSTED — candidatul își auto-declară fitness-ul

`crates/feral-core/src/rsi/repo.rs:315-320`:

```rust
let candidate_meta = parse_iteration_metadata(&candidate)
    .ok_or_else(|| anyhow!("candidate commit has no parseable iteration metadata"))?;
let candidate_score = candidate_meta.score;
```

`parse_iteration_metadata` (linia 464-475) doar deserializează JSON-ul din commit message body. Nu există cross-check împotriva unui `eval/tier{0,1,2}/*.json` sau față de tabelul `runtime.rs`.

`commit_genome(genome_id, genome_json, parent_commits, metadata: &IterationMetadata, ...)` — apelantul dă `metadata.score` direct. Nu există assertion că `metadata.score` corespunde output-ului real al `scorer::compute(...)`.

Un candidate L3-generated care poate scrie propriile eval files sau care poate influența L4 code path-uri (bug §91 din runda 4: `bunExec` env leak permite ex-fil de chei) poate să:

1. Rulează normal, obține score real 0.32.
2. La commit, declară `score: 0.99` în `IterationMetadata`.
3. `ratchet_attempt` compară 0.99 > prior 0.7 → **advance**.
4. Main jump la un candidate defect. Următoarele descendente moștenesc scoruri false.

Fitness-Goodhart clasic, dar la nivelul MOST BOTTOM al hash chain-ului. Comentariul spec (linia 320-323) zice "The monotonicity guarantee" — dar guarantee-ul e MINCIUNĂ dacă source-of-truth pentru score e commit message body writable de committer.

**Fix:** ratchet nu trebuie să se bazeze pe metadata din commit body. Trebuie să CALCULEZE fresh score-ul candidate-ului:

```rust
pub fn ratchet_attempt(candidate_commit: &str) -> Result<RatchetResult> {
    let repo = open()?;
    let candidate = repo.find_commit(Oid::from_str(candidate_commit)?)?;
    
    // Do NOT trust commit body. Re-run scoring on the tree.
    let candidate_score = crate::rsi::scorer::score_from_commit(&repo, &candidate)
        .context("re-score candidate")?;
    
    // Cross-check against declared score — if divergence > epsilon, refuse.
    if let Some(declared) = parse_iteration_metadata(&candidate).map(|m| m.score) {
        if (declared - candidate_score).abs() > 0.001 {
            bail!("candidate score mismatch: declared={} actual={}", declared, candidate_score);
        }
    }
    // ... rest ...
}
```

Sau, more robust: store scores într-un notes ref (`refs/notes/feral-scores`) semnat cryptographic cu o cheie ținută în sidecar's keychain, unreachable din L3/L4 sandbox.

**Impact MOAT**: BRSI-ul întreg promite monotonicity ("main advances only on strictly better score"). Aceasta e SLA-ul central al RSI-ului. Verifiability trebuie să fie criptografică, nu bazată pe honor-system.

---

## §152 — `crates/feral-core/src/tts/fish.rs::synthesize` — trimite API key la ORICE base_url configurabil

`crates/feral-core/src/tts/fish.rs:100-110`:

```rust
let client = reqwest::Client::builder()
    .user_agent("feral/0.1")
    .timeout(std::time::Duration::from_secs(120))
    .build()
    .context("build reqwest client")?;

let res = client
    .post(format!("{}/v1/tts", opts.base_url.trim_end_matches('/')))
    .bearer_auth(api_key)
    .header("model", &opts.model)
    .json(&body)
    .send()
    .await
```

`opts.base_url` provine din `TtsOptions` care e populat din user settings sau din `TtsOptions::default() { base_url: "https://api.fish.audio" }`. Nu există validare că host-ul e într-un allowlist (ex: `api.fish.audio`, `*.fish.audio`, sau `127.0.0.1` pentru self-hosted proxy).

Vectorii:
1. Un settings.json corupt / prompt-injected setează `base_url = "https://attacker.example.com"` → `.bearer_auth(api_key)` trimite Fish API key în plain la attacker.
2. Un proxy self-hosted anunțat via `http://192.168.1.100:8000` (fără TLS) → key în plaintext pe LAN.
3. Comentariul zice *"or a self-hosted proxy"* — deci scenarii legitimate există, dar nu există limită.

Comparație cu OpenAI provider: `feral-core/src/inference.rs` (parțial analizat runda 2) NU are check strict, dar cel puțin OpenAI keys nu-s scumpe atât la abuz — Fish keys sunt paid-per-second de audio generat. O key leaked = facturi până când user observă.

**Fix:** verifică schema HTTPS + hostname pentru non-local:

```rust
fn assert_base_url_safe(url: &str) -> Result<()> {
    let parsed = url::Url::parse(url).context("parse base_url")?;
    let host = parsed.host_str().unwrap_or("");
    let is_local = matches!(host, "localhost" | "127.0.0.1" | "::1")
        || host.starts_with("127.")
        || host.parse::<std::net::Ipv4Addr>().map(|ip| ip.is_private() || ip.is_loopback()).unwrap_or(false);
    if !is_local && parsed.scheme() != "https" {
        bail!("Fish base_url must use https for non-local hosts (got {})", url);
    }
    // Optionally: whitelist api.fish.audio + wildcards
    Ok(())
}

pub async fn synthesize(...) -> Result<usize> {
    ...
    assert_base_url_safe(&opts.base_url)?;
    ...
}
```

Aplicabil identic la orice provider setabil de user (Groq, Anthropic, OpenAI base_url override). Pattern universal.

---

## §153 — Fish TTS: `stream.next()` fără cap → OOM la răspunsul unui Fish proxy hostile / buggy

`crates/feral-core/src/tts/fish.rs:130-147`:

```rust
let mut stream = res.bytes_stream();
let mut total = 0usize;
while let Some(chunk) = stream.next().await {
    let chunk = chunk.context("fish audio: stream interrupted")?;
    if chunk.is_empty() { continue; }
    total += chunk.len();
    if audio.send(chunk.to_vec()).await.is_err() { break; }
}
Ok(total)
```

Backpressure există (canalul tokio buffered), dar dacă receiver-ul de audio consumă rapid (Web Audio player streaming), Fish poate să trimită bytes fără limită. Un proxy compromised sau un bug Fish poate returna un stream de gigabytes; `total` e uint64 dar RAM alocată prin `chunk.to_vec()` per iterație e limitată doar de send() backpressure.

La bitrate 24kHz mono 16-bit PCM = 48 KB/s. 120s timeout → cap natural la ~5.7 MB. Așa că nu e OOM catastrofic, dar un proxy care ține stream-ul deschis livrand slow (1 chunk/s) și mari (10 MB/chunk) → între timeout și cap efectiv, câteva sute MB alocați → risc real.

**Fix:** cap explicit pe total bytes:

```rust
const MAX_TTS_BYTES: usize = 32 * 1024 * 1024;   // 32 MiB = ~11 min PCM
...
if total > MAX_TTS_BYTES {
    bail!("fish audio: response exceeded {} MiB", MAX_TTS_BYTES / 1024 / 1024);
}
```

De asemenea, cap `content-length` header check dacă e prezent.

---

## §154 — `public-journal::writeCursor` non-atomic → torn write pierde cursor → replay toată istoria

`FeralAgent/src/public-journal/exporter.ts:62-66`:

```ts
export function writeCursor(path: string, cursor: ExportCursor): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cursor), "utf8");
}
```

Non-atomic. Dacă process moare mid-write (SIGKILL, power loss), `cursor.json` are conținut parțial → `JSON.parse` respinge → `readCursor` returnează `CURSOR_ZERO` (linia 60):

```ts
export function readCursor(path: string): ExportCursor {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ExportCursor>;
    ...
  } catch { return CURSOR_ZERO; }
}
```

Următoarea rulare re-publică ÎNTREAGA istorie a jurnalului (limitat la 200 events/rulare, sub batch limit; ia zeci de rulări → zeci de POSTs). Comentariul minimizează impactul: *"a lost, stale, or replayed cursor causes re-sends that the store dedupes, never duplicates on the page"*. Dar:

1. Cost network real.
2. Rate-limits pe endpoint-ul public.
3. Bearer token trimis Nx.
4. Timp CPU pe validare/dedupe la server.

Fits pattern #1 (non-atomic writes) din raport global.

**Fix:** folosește pattern-ul `atomicWriteFileSync` din `FeralAgent/src/memory/graph.ts:77-90` (already exists, sub-utilized):

```ts
import { atomicWriteFileSync } from "../memory/graph.ts";   // or wherever it's exposed

export function writeCursor(path: string, cursor: ExportCursor): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(cursor));
}
```

---

## §155 — `exporter::configFromEnv::assertTransportSafe` — IPv6 loopback NU e recunoscut ca "local"

`FeralAgent/src/public-journal/exporter.ts:187-201`:

```ts
export function assertTransportSafe(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(...); }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !local) {
    throw new Error("refusing to send the publish token over plain HTTP (use https, or localhost)");
  }
}
```

`parsed.hostname` pentru `http://[::1]:3000/journal` este `::1` (fără brackets). Check-ul respinge → throw. Similar `http://[::ffff:127.0.0.1]/`.

De asemenea, `127.0.0.1` este verificat exact — dar loopback range e `127.0.0.0/8`. `http://127.1.1.1/` (același loopback, valid Linux/macOS) → RESPINS.

Nu-i o vulnerabilitate — restricția e prea largă, nu prea îngustă — dar operatorul care rulează landing-page dev pe `[::1]:3000` (Node listens on IPv6 by default) se lovește de: "refusing to send publish token over plain HTTP" fără să știe de ce. Confusion.

**Fix:**

```ts
function isLocalHost(hostname: string): boolean {
  if (hostname === "localhost") return true;
  if (hostname === "::1") return true;
  try {
    const ip = hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
    // IPv4 loopback range 127.0.0.0/8
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
    if (m && m[1] === "127") return true;
  } catch {}
  return false;
}

const local = isLocalHost(parsed.hostname);
```

---

## §156 — `exporter::runExport` cursor persistat DUPĂ răspuns 2xx dar ÎNAINTE de verificare `body.accepted` → drop silent la validare server-side

`FeralAgent/src/public-journal/exporter.ts:270-280`:

```ts
const body = (await res.json().catch(() => ({}))) as { accepted?: number; duplicates?: number };
if (!res.ok) {
  throw new Error(`publish failed: HTTP ${res.status}`);
}

writeCursor(config.cursorFile, collected.cursor);

return {
  sent: collected.events.length,
  ...
  accepted: typeof body.accepted === "number" ? body.accepted : 0,
  duplicates: typeof body.duplicates === "number" ? body.duplicates : 0,
};
```

Cursor scris pe orice 2xx. Dar server-ul poate să respingă niște event-uri per-item (schema mismatch, rate limit pe un tip anume) și să răspundă `200 OK` cu `{"accepted": 50, "rejected": 150, "reasons": [...]}`. Aceste 150 rejected event-uri sunt PIERDUTE — cursor a avansat peste ele, next run nu le retrimite.

Nu există check `if (body.accepted < collected.events.length) — throw or log rejected ids`.

**Fix:** cursor advance-uit doar la elementele confirmate. Server-ul trebuie să răspundă cu highest accepted timestamp / list of accepted ids. Client:

```ts
if (body.rejected && body.rejected > 0) {
  // Log and don't advance past the failure point.
  console.warn(`publish partial: ${body.accepted} accepted, ${body.rejected} rejected`);
  // Ideally: server returns last-accepted-ts; advance cursor only up to that.
  return { ... };
}
writeCursor(config.cursorFile, collected.cursor);
```

Sau adaugă un câmp `lastAcceptedTs` în răspuns și avansează la min(collected.cursor.lastTimestamp, body.lastAcceptedTs).

---

## §157 — `brain-stack::pickTopScore` NU clampează capabilities → un model cu capability `999` domină totul

`FeralAgent/src/brain/brain-stack.ts:181-198`:

```ts
export function scoreModel(model: BrainModel, requirement, mode, confidence = 0.5): number {
  let s = 0;
  for (const cap of Object.keys(requirement) as Capability[]) {
    const w = requirement[cap] ?? 0;
    const c = model.capabilities[cap] ?? 0;
    s += w * c;
  }
  s -= MODE_WEIGHT[mode] * model.cost;
  if (mode === "budget" && model.local) s += LOCAL_BONUS;
  s += CONFIDENCE_WEIGHT * confidence;
  return s;
}
```

Comentariul spec (capability-registry.ts:31) zice *"Keys are stable; values are 0..10"*. Dar `normalizeCapabilities` (`capability-registry.ts:180-192`) NU clampează, doar default-ează missing:

```ts
export function normalizeCapabilities(partial): Record<Capability, number> {
  const out = {} as Record<Capability, number>;
  for (const cap of ALL_CAPS) {
    const v = partial[cap];
    out[cap] = typeof v === "number" && Number.isFinite(v) ? v : 0;
  }
  return out;
}
```

Și `normalizeCapabilities` nu-i chiar apelat din `CapabilityRegistry` constructor:

```ts
constructor(models: BrainModel[]) {
  const seen = new Map<string, BrainModel>();
  for (const m of models) {
    if (seen.has(m.id)) throw new Error(...);
    seen.set(m.id, m);   // ← acceptă modelul as-is
  }
  this.#byId = seen;
}
```

Un `brain.json` cu `"capabilities": { "reasoning": 999 }` (typo sau prompt-injected) → scoreModel returnează 999 pentru orice requirement care are `reasoning` weight → acest model câștigă în orice categorie relevantă, indiferent de ce vrea userul.

Mai grav: `-` la score nu-i lower-bounded. Un `cost: 99` (nu ∈ {1,2,3}) în budget mode → score `-198` copleșește restul → modelul e ULTIMUL preferat. Dar reciprocul: `cost: -50` → +100 score → dominant. Type-ul zice `cost: 1 | 2 | 3` — TypeScript check îndepărtabil la runtime cu JSON, deci nu-i barieră.

**Fix:** valid the registry în constructor:

```ts
constructor(models: BrainModel[]) {
  const seen = new Map<string, BrainModel>();
  for (const raw of models) {
    if (seen.has(raw.id)) throw new Error(`duplicate id "${raw.id}"`);
    validateBrainModel(raw);      // ← NEW
    const m: BrainModel = {
      ...raw,
      capabilities: clampCapabilities(raw.capabilities),
    };
    seen.set(m.id, m);
  }
  this.#byId = seen;
}

function validateBrainModel(m: BrainModel): void {
  if (typeof m.id !== "string" || !m.id) throw new Error(`BrainModel.id must be a non-empty string`);
  if (![1, 2, 3].includes(m.cost)) throw new Error(`BrainModel.cost must be 1|2|3, got ${m.cost}`);
  if (typeof m.local !== "boolean") throw new Error(`BrainModel.local must be boolean`);
  if (!m.target || typeof m.target !== "object") throw new Error(`BrainModel.target required`);
}

function clampCapabilities(c: Record<Capability, number>): Record<Capability, number> {
  const out = {} as Record<Capability, number>;
  for (const cap of ALL_CAPS) {
    const v = c[cap];
    out[cap] = typeof v === "number" && Number.isFinite(v)
      ? Math.max(0, Math.min(10, v))
      : 0;
  }
  return out;
}
```

Și `brain-config::validateBrainConfigShape` (linia 143-171) deleagă la BrainStack — dar delegarea era motivată de *"Two layers of validation would mean two error messages to reconcile"*. Adaugă validation în BrainStack per model, fine.

---

## §158 — `brain-config::loadBrainConfig` — orice error `readFileSync` (nu doar ENOENT) tratat ca "opt-out"

`FeralAgent/src/brain/brain-config.ts:79-89`:

```ts
let raw: string;
try {
  raw = readFileSync(brainPath, "utf8");
} catch {
  if (forcedEnable) {
    throw new Error(`FERAL_BRAIN=1 but brain.json not found at ${brainPath}`);
  }
  return null;
}
```

`catch {}` swallow-uiește TOATE error-urile: ENOENT (fișier lipsă = intenționat opt-out), EACCES (permisiuni greșite pe fișier existent — GREȘIT să tratezi ca opt-out), EIO (disk error). Operatorul care are `brain.json` cu permisiuni `600` owned by root iar sidecar rulează ca user non-root → sidecar zice "Brain is off" fără să spună de ce, iar user vede routing nou (default) fără explicație.

Comentariul zice *"a malformed brain.json is a config bug, not a runtime condition to paper over"* — dar file-permission error e EXACT genul de config bug care merită să nu fie papered over.

**Fix:**

```ts
let raw: string;
try {
  raw = readFileSync(brainPath, "utf8");
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    if (forcedEnable) throw new Error(`FERAL_BRAIN=1 but brain.json not found at ${brainPath}`);
    return null;   // legit opt-out
  }
  throw new Error(`brain.json at ${brainPath}: ${code ?? "unknown"} — ${String(err)}`);
}
```

---

## §159 — `brain-stack::#choosePrimary` — override unavailable → silent fallback la scoring, no log

`FeralAgent/src/brain/brain-stack.ts:282-296`:

```ts
const overrideId = this.#overrides[classification.category];
if (overrideId !== undefined) {
  const m = available.find((x) => x.id === overrideId);
  if (m !== undefined) return m;
  // Override set but unavailable — fall through to scoring. We do
  // NOT throw here: an unavailable override is a config bug, but
  // the user's intent (route to something for this category) is
  // better served by falling back to scoring than by failing the
  // whole turn. Slice S5 will log this if a logger is wired in.
}
```

Comentariul zice *"Slice S5 will log this if a logger is wired in"* — deci se știe că-i missing. Impact: operator setează `overrides.coding = "claude-opus-4"`, cheia BYOK expira, `available` nu-l mai conține → routing tăcut la `gpt-4o-mini` (top scorer via mode balanced). User se lovește de rezultate degradate fără nicio indicație că override-ul a fallback-uit.

Similar pentru `offlineModelId` (linia 298-306).

**Fix:** injectează un logger `BrainStack` opts, sau emit un `BrainDegraded` event:

```ts
constructor(cfg: BrainConfig, breaker: CircuitBreaker, opts?: { onDegraded?: (event: BrainDegraded) => void }) {
  ...
  this.#onDegraded = opts?.onDegraded;
}

...
if (overrideId !== undefined) {
  const m = available.find((x) => x.id === overrideId);
  if (m !== undefined) return m;
  this.#onDegraded?.({ kind: "override_unavailable", category: classification.category, wanted: overrideId });
}
```

Pe UI: notification "Your model preference for coding is unavailable, using X instead" cu link la Settings.

---

## §160 — `rlm::ChildRegistry::admit` — race: `run()` fail synchronous → `.finally` rulează înainte de `#inflight.add(p)` → leak în drain

`FeralAgent/src/rlm/children.ts:150-171`:

```ts
const p = this.run(task, opts.allowedTools, push, id)
  .then((r) => { ... })
  .catch((e) => { entry.status = "error"; ... })
  .finally(() => {
    this.#inflight.delete(p);   // ← may run before add(p) below
  });
this.#inflight.add(p);
```

Dacă `this.run(...)` este așa implementat încât returnează un promise deja rejected sincron (`Promise.reject(err)` fără `await` sau microtask), `.finally` este scheduled pentru microtask queue. Când `#inflight.add(p)` rulează în același sync tick, `p` intră în set. Apoi la microtask, `.finally` face `this.#inflight.delete(p)`. Net: OK.

**Dar** dacă altă cale — `this.run` este o funcție `sync` care aruncă direct (nu returnează promise):

```ts
export type RunChild = (...) => Promise<{...}>;

// Dacă implementarea sincron aruncă:
const run: RunChild = () => { throw new Error("boom"); };
```

Atunci `this.run(...)` aruncă DEcompletitor, `.then` nu se execută niciodată — `p` nu-i creat, se propagă throw-ul în afara lui `admit`, `entry` rămâne cu status "running" pentru totdeauna, `#entries` are leak. `admit()` era declarat că "the promise catches everything" (comment linia 145-148) — dar catch-ul e pe THEN-lanț, care nu execute pentru sync-throw.

Comentariul e mincinos: *"an unhandled rejection here would take the whole sidecar down, so the promise catches everything and parks it on the entry"*. Un sync throw în `this.run` chiar arunca, chiar down-eaza. Test:

```ts
const reg = new ChildRegistry(() => { throw new Error("sync"); });
reg.admit("task");   // throws, sidecar dies unless caller catches
```

**Fix:** wrap în `Promise.resolve().then(() => this.run(...))`:

```ts
const p = Promise.resolve()
  .then(() => this.run(task, opts.allowedTools, push, id))
  .then((r) => { ... })
  .catch((e) => { ... })
  .finally(() => this.#inflight.delete(p));
this.#inflight.add(p);
```

Acum orice sync throw devine reject async, catch-ul îl prinde, entry.status = "error", registry consistent.

---

## §161 — `rlm::ChildRegistry` — `#byName` NU curăță pe error → nume blocat forever

Continuând §160: `admit()` linia 155-158:

```ts
if (this.#byName.has(name)) throw new Error(`rlm.run name "${name}" is already used by a sibling`);
const entry: ChildEntry = { rlm_child_id: id, name, status: "running", trail: [] };
this.#entries.set(id, entry);
this.#byName.set(name, id);
```

Child fail-uiește (fie async, fie sync via §160) → `entry.status = "error"` dar `#byName` menține `name → id`. Următorul `admit(task, { name: "api-reviewer" })` cu același nume după eșec → aruncă "already used by a sibling", chiar dacă predecessorul e demult mort.

`delete(target)` (linia 226-234) e singura care curăță `#byName` — dar delete cere apelantul să știe id-ul/numele și să facă cleanup manual. Un parent care doar face `rlm.list_subagents()` și vede errors nu știe că trebuie să sun `delete_subagent`.

**Fix:** o dintre:
1. GC periodic al entries cu `status !== "running"` mai vechi de N minute.
2. Pe `admit` cu name duplicat, dacă existing entry.status === "error"/"completed", șterge-l automat: *"the name is being reused; the previous child had settled"*.
3. Namespace nume cu timestamp intern: `"api-reviewer#1234"` — dar rupe UX.

Opțiunea 2 e clean:

```ts
if (this.#byName.has(name)) {
  const existingId = this.#byName.get(name)!;
  const existing = this.#entries.get(existingId);
  if (!existing || existing.status === "running") {
    throw new Error(`rlm.run name "${name}" is already used by a sibling`);
  }
  // Existing child had settled → recycle the name.
  this.#entries.delete(existingId);
  this.#byName.delete(name);
}
```

---

## §162 — `rlm::ChildRegistry::observe` returnează `trail` shallow — apelantul poate muta state intern

`FeralAgent/src/rlm/children.ts:214-220`:

```ts
observe(target: string): ChildEntry {
  const id = this.#entries.has(target) ? target : this.#byName.get(target);
  const entry = id ? this.#entries.get(id) : undefined;
  if (!entry) throw new Error(`rlm.observe: no child matches "${target}"`);
  return { ...entry, trail: [...(entry.trail ?? [])] };
}
```

`[...(entry.trail ?? [])]` face shallow copy al array-ului — dar `TrailEntry` obiecte sunt SHARED references. Callerul poate face:

```ts
const e = kids.observe("worker");
e.trail[0].detail = "PWNED";   // muta registry-ul intern
```

În notebook RLM (via §142 subsequent) sau într-un plugin viitor cu acces la registry, corruption real.

**Fix:** deep clone al trail entries:

```ts
return {
  ...entry,
  trail: (entry.trail ?? []).map((t) => ({ ...t })),
  // answer, toolCalls, durationMs, error sunt primitive — clone shallow e OK
};
```

Combinat cu §142 la nivelul de `repl.ts::rlm.observe`, ambele straturi trebuie fix-uite pentru completitudine.

---

## §163 — `feralModelSelector::selectLocal` NU deselectează modelul curent dacă `models.startLoad` fail-uiește după ce sidecar-ul deja și-a curățat pointer-ul

`frontend-react/src/components/agents/FeralModelSelector.tsx:49-67`:

```ts
const selectLocal = async (m: ModelInfo) => {
  setLoadingModel(m.path);
  setModelError(null);
  try {
    await tauri.models.startLoad(m.path);       // ← poate arunca după ce host a dat unload la vechiul
    await setModel({
      source: 'openai_compatible',
      model: m.name,
      baseUrl: FERAL_API_BASE,
      providerId: LOCAL_PROVIDER_ID,
    });
  } catch (err) {
    setModelError(String(err));
    useNotifications.getState().push('error', 'Could not switch model', String(err));
  } finally {
    setLoadingModel(null);
  }
};
```

Presupunerea modelului mental: fail atomically. Realitate în implementarea Rust a `startLoad` (`src-tauri/src/commands/models.rs`): sidecar-ul unload-ează modelul curent PRIMA (eliberează RAM), APOI încearcă să-l încarce pe cel nou. Dacă cel nou lipsește (fișier corupt, out-of-memory, checksum invalid), rezultatul e:

1. Vechiul model = descărcat.
2. `startLoad(m.path)` aruncă cu error.
3. `catch` afișează toast, dar `modelConfig` în store rămâne pe vechiul model (setModel nu apucă să ruleze).
4. Următorul chat message → agent rulează cu `modelConfig.model = <vechi>` → API `/v1/chat/completions` pe FERAL_API_BASE → sidecar zice "no model loaded" → empty completion sau 500.

UI arată "gpt-oss-20b" ca activ, dar nu-i loaded. User debuggează minute până observă.

**Fix:** dupa `catch`, sync-ronizează store cu realitatea sidecar:

```ts
} catch (err) {
  setModelError(String(err));
  useNotifications.getState().push('error', 'Could not switch model', String(err));
  // The sidecar unloaded the previous model before failing on the new one.
  // Reflect that in the store, else the UI lies about what's live.
  try {
    const status = await tauri.raw.getModelStatus();   // ipoteticul comand — dacă nu există, adăugă
    if (!status.loaded) setModel(null);
  } catch { setModel(null); }
} finally {
  setLoadingModel(null);
}
```

Sau, better: sidecar's `startLoad` să fie transactional — încarcă noul într-un slot, apoi swap atomic, apoi unload vechi. Refactor mai mare, dar corect.

---

## §164 — `useDreamCycle`: nu curăță `useDream.setDreaming(true)` dacă unmount în plin ciclu

`frontend-react/src/hooks/useDreamCycle.ts:14-45`:

```ts
export function useDreamCycle(): void {
  useEffect(() => {
    let alive = true;
    const unlistenP = events.onDreamCycle.listen((e) => {
      if (!alive) return;
      if (e.phase === 'started') {
        useDream.getState().setDreaming(true);
        useNotifications.getState().push('info', '💤 Feral is dreaming', ...);
      } else {
        useDream.getState().setDreaming(false);
        useDream.getState().setStage(null);
        ...
      }
    });
    ...
    return () => {
      alive = false;
      void unlistenP.then((u) => u()).catch(() => {});
      void unlistenStageP.then((u) => u()).catch(() => {});
    };
  }, []);
}
```

Scenariu:
1. Dream cycle începe → event `started` → `useDream.setDreaming(true)`.
2. User navighează la altă pagină, comp montat pe `App` se demontează (dacă e cazul; App.tsx e root, so probably not — dar dacă hook e mutat într-o pagină subordonată, e real).
3. Cleanup: `alive = false`. Următor event `ended` este ignorat (bc `!alive`).
4. `useDream.dreaming` rămâne `true` PERMANENT. Mascot bl blocat în pose 'dreaming', panel-ul de Feral Dreams zice "Currently dreaming...".

Chiar dacă hook e mount doar pe App root: același bug apare la logout/re-login sau la re-init store. Cleanup trebuie să reset-eze store:

**Fix:**

```ts
return () => {
  alive = false;
  // Store reflects the runtime, not the listener. If we're unlistened
  // mid-cycle, force reset — the next mount will re-sync from a fresh
  // `started` event if the cycle is still going.
  useDream.getState().setDreaming(false);
  useDream.getState().setStage(null);
  void unlistenP.then((u) => u()).catch(() => {});
  void unlistenStageP.then((u) => u()).catch(() => {});
};
```

---

## §165 — `useOrganismImpulse::impulseTo` — `onFrame` ref capturat, dar durationMs în deps `useCallback` — inconsistență + jitter

`frontend-react/src/hooks/useOrganismImpulse.ts:14-38`:

```ts
export function useOrganismImpulse(opts: { onFrame: (s: OrganismState) => void; durationMs?: number }) {
  const { onFrame, durationMs = 1500 } = opts;
  const rafRef = useRef<number | null>(null);
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  const impulseTo = useCallback((from: OrganismState, to: OrganismState) => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    const start = performance.now();
    const tick = (now: number) => {
      const raw = Math.min(1, (now - start) / durationMs);   // ← durationMs closure-captured
      ...
    };
    ...
  }, [durationMs]);

  return { impulseTo };
}
```

`durationMs` e default `1500`. Fiecare părinte care dă un nou `opts` object (fără memoization) → `durationMs` este primary literal `1500` fiecare render → identity check pass, `impulseTo` stabil. OK.

Dar dacă părintele face `useOrganismImpulse({ onFrame: cb, durationMs: someVar })` cu `someVar` calc'd inline → `durationMs` re-created identical value → `useCallback` deps=`[1500]` — stable — OK. **Actually stable.**

Problema reală: `onFrame` NU e în deps. Dacă părintele DÁ un `onFrame` nou pe fiecare render:

```tsx
<Organism onFrame={(s) => setState(s)} />
```

`onFrameRef.current = onFrame` la fiecare render — ref-ul se update-ează. Dar dacă `impulseTo` e capturat undeva ca variabilă stabilă (ex: în `useEffect(() => { impulseTo(a, b) }, [impulseTo, a, b])`) → funcționează.

Bug real: **NU există guard pentru unmount-in-middle-of-impulse**. Cleanup effect linia 20:

```ts
useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);
```

Cancel-uiește RAF, dar `onFrameRef.current(to)` (linia 33 în `else`) rulează la termen. Dacă unmount-ul se întâmplă între `now - start >= durationMs` și RAF-ul de after — cancel-ul intercepteaza, OK. Dar unmount-ul între ultimul tick RAF și `onFrameRef.current(to)` — greu, dar tehnic posibil dacă `onFrame` triggers a setState pe un component unmounted → React warning + memory leak.

Nu-i critic, dar `onFrameRef.current` trebuie și el gate-uit:

```ts
useEffect(() => () => {
  aliveRef.current = false;   // ← ADAUGĂ ref
  if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
}, []);

// și în tick:
if (raw < 1) { rafRef.current = requestAnimationFrame(tick); }
else {
  rafRef.current = null;
  if (aliveRef.current) onFrameRef.current(to);
}
```

Minor severity, dar frecvent invocat în animații → merită.

---

## §166 — `crates/feral-core/src/rsi/repo.rs::log` — parcurge doar HEAD, ratează candidate branches nemergent

`crates/feral-core/src/rsi/repo.rs:379-403`:

```rust
pub fn log(max: usize) -> Result<Vec<CommitMeta>> {
    let repo = open()?;
    let mut revwalk = repo.revwalk()?;
    revwalk.push_head()?;                    // ← doar HEAD
    revwalk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;

    let mut out = Vec::with_capacity(max.min(1024));
    for oid in revwalk.take(max) {
        ...
    }
    Ok(out)
}
```

Comentariul spune *"Last N commits across all refs"* dar `push_head()` pune doar HEAD (main). `genome/<hash>` branches sunt IGNORATE. Consumerii (lineage / taste-vector miner Faza 3, comment linia 378) primesc doar main-lineage — non-promoted candidates lipsesc din analiză.

Practic impactul: PBT-ul care alege genome parents dintr-un `log(1000)` NU vede alternative branches non-ratchet-ate. Ratchet foundation e OK, dar exploration space e cripated → biased spre commits pe main. Rătăcirea genetică se prăbușește.

**Fix:**

```rust
pub fn log(max: usize) -> Result<Vec<CommitMeta>> {
    let repo = open()?;
    let mut revwalk = repo.revwalk()?;
    revwalk.push_head()?;
    // Push every local branch tip so genome/* candidates are included.
    for branch in repo.branches(Some(BranchType::Local))? {
        let (b, _) = branch?;
        if let Some(oid) = b.get().target() {
            let _ = revwalk.push(oid);   // dedupe by revwalk
        }
    }
    revwalk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;
    ...
}
```

---

## §167 — `crates/feral-core/src/rsi/repo.rs::commit_genome` non-atomic — snapshot file poate exista fără commit dacă crash între write și `repo.commit`

`crates/feral-core/src/rsi/repo.rs:246-256`:

```rust
let rsi_root = rsi_dir();
let snapshot_rel = format!("{}/{}.json", GENOMES_DIR, &short_id_for_filename(genome_id));
let snapshot_abs = rsi_root.join(&snapshot_rel);
std::fs::create_dir_all(snapshot_abs.parent().unwrap())?;
std::fs::write(&snapshot_abs, serde_json::to_string_pretty(genome_json)?)?;

// Stage the snapshot.
let mut index = repo.index()?;
index.add_path(Path::new(&snapshot_rel))?;
let tree_oid = index.write_tree()?;
```

Dacă process moare între `std::fs::write` și `repo.commit(...)` (mai jos, linia 275), un fișier `.json` orfan rămâne în working dir. Repo state e curat (commit nu a fost făcut), dar working tree are un fișier nou. Next `git status` (dacă vreodată se rulează manual) confuz; sau next `write_tree` include-l accidental într-un commit ulterior de altă natură.

Plus `std::fs::write` NU-i atomic. Torn write → snapshot corrupt on disk chiar dacă commit reușește.

**Fix:** scrie prin tmp + rename atomic:

```rust
fn atomic_write_json(path: &Path, value: &serde_json::Value) -> Result<()> {
    let s = serde_json::to_string_pretty(value)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, s.as_bytes())?;
    // fsync then rename — same pattern as memory_graph.rs::atomic_write
    std::fs::File::open(&tmp)?.sync_all()?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}
```

Și, secundar: cleanup pe error path — dacă `repo.commit` fails, șterge snapshot-ul înapoi:

```rust
let commit_result = repo.commit(...);
if commit_result.is_err() {
    let _ = std::fs::remove_file(&snapshot_abs);
}
commit_result?;
```

---

## §168 — `public-event.ts::assertPublicSafe` — regex de detectare de email este overly greedy → false positives pe filepath-uri stripped

`FeralAgent/src/public-journal/public-event.ts:189`:

```ts
[/[\w.+-]+@[\w-]+\.[\w.]{2,}/, "email address"],
```

Pattern-ul e OK pentru email, dar `[\w.]{2,}` la sfârșit capturează multe stringuri normale:
- `docker.io` NU are `@` deci safe. Fine.
- Dar `sha256:abc123...` NU are `@`. Fine.
- Un `Set-Cookie: name=val; domain=.example.com` din HTTP headers — dar sanitizer-ul verifică value-uri stringuri, nu headers.

**Bug real diferit**: `[\w.+-]+@[\w-]+\.[\w.]{2,}` matches `x@y.zz` — un cycleId hex care are `.` (nu ar avea, dar defensive) sau un identificator normal cu `@` — nu apare în journal.

De fapt, verificarea în sine e OK. Bug e diferit: `\w` include `_` iar `[\w.+-]+` include multe caractere non-standard. Test rapid:

```
"@a.bb"   ← matches (empty local-part not required by "+")
```

Nu, `+` requires ≥1. OK. Deci pattern-ul e strict enough.

**Alt pattern issue**: pattern pentru unix filesystem path `/(^|[^\w])\/(home|Users|etc|var|root|tmp|proc)\//` — dar NU acoperă `/opt`, `/usr`, `/mnt`, `/media`, `/srv`, `/dev`. Un summary care are `/opt/homebrew/Cellar/...` (macOS) trece safe check → publicat.

Sau `/mnt/c/Users/...` (WSL) → nu are `/home`, `/Users`, etc la începutul strict — MATCHES pe `/Users/` DA. OK.

Dar `/tmp` matches — dar `/tmpdir` — negative check `[^\w])/(home|Users|etc|var|root|tmp|proc)` — după `/tmp` — matches only dacă e urmat de `/`, așa e regex-ul. `/tmpdir/` nu conține `/tmp/`. OK.

**Bug**: adaugă `/opt`, `/usr`, `/dev`, `/mnt`, `/media`, `/srv` la listă:

```ts
[/(^|[^\w])\/(home|Users|etc|var|root|tmp|proc|opt|usr|dev|mnt|media|srv)\//, "unix filesystem path"],
```

Și adaugă macOS specific: `/Volumes/`, `/Applications/`, `/Library/`, `/private/var/`.

Comentariul de sus zice *"the primary defence is the allowlist above"* — deci acest scan e last-resort. Dar fiind un last-resort, trebuie să fie exhaustive.

---

## §169 — `public-event.ts::toPublicEvent` — `row.hash` NEVERIFICAT ca hex/uniqueness → id-uri collision-prone dacă hash e coincident cu un short JSON

`FeralAgent/src/public-journal/public-event.ts:311-320`:

```ts
id: publicRef(
  `${publisher}|${
    typeof row.hash === "string" && row.hash
      ? row.hash
      : `${row.cycleId}|${row.timestamp}|${type}`
  }`,
),
```

`row.hash` este DEclarat de source-ul de row (Evolution Journal — `rsi/infra/journal.ts`), fără constraint verified aici că-i un SHA-256 hex de 64 chars.

Vector: un rând journal cu `hash: "1"` (torn write, dev debug) → id = `publicRef("cubby|1")` = un hex de 12 chars. Coincidental match pe alt row al altui publisher cu payload distinct dar aceeași cheie hash="1" → dedupe la server = pierderi de events.

Nu e catastrofal (fits pattern de duplicate), dar `id` e ipoteza de unicitate pentru server dedupe. Verifică shape:

**Fix:**

```ts
const hashPart =
  typeof row.hash === "string" && /^[a-f0-9]{64}$/.test(row.hash)
    ? row.hash
    : `${row.cycleId}|${row.timestamp}|${type}`;
id: publicRef(`${publisher}|${hashPart}`),
```

---

## §170 — `brain-config::BRAIN_EXAMPLE_CONFIG` — hardcoded model name `qwen2.5-coder:7b` — dacă șters din Ollama, exemplu inutilizabil

`FeralAgent/src/brain/brain-config.ts:126-142`:

```ts
export const BRAIN_EXAMPLE_CONFIG: BrainConfig = {
  enabled: true,
  mode: "balanced",
  registry: [
    {
      id: "local-default",
      target: {
        provider: "ollama",
        model: "qwen2.5-coder:7b",
        baseUrl: "http://localhost:11434",
      },
      ...
    },
  ],
};
```

Minor (nu bug de code) dar user experience issue: modelul `qwen2.5-coder:7b` s-a schimbat de nume în Ollama registry în ultimele versiuni (`qwen2.5-coder` fără tag = latest, sau ediții deprecate). Un user copiază exemplu → `brain.json` funcțional dar Brain trimite requests la un model necunoscut → 404 sau completare cu model default. Confuzie.

Mai grav: `baseUrl: "http://localhost:11434"` este Ollama-ul EXTERN. `FeralModelSelector.tsx:15` avertizează exact opusul — *"the agent must target THIS (not external Ollama on 11434)"*. Exemplul brain.json contrazice best-practice-ul UI-ului.

**Fix:** ori update exemplul la Feral's own model server (`http://localhost:11435`), ori adaugă comment `// EDIT ME: replace with your local model` explicit.

Rezolvarea corectă: exemplu să fie GENERATE-uit prin wizard bazat pe modelele efectiv instalate, nu hardcoded — deja notat în comment (linia 118-123). Momentan e o mină pentru early adopters.

---

## §171 — `public-journal::journalFiles` — sortare lexicală ratează files cu prefix diferit (rollover peste an schimbat)

`FeralAgent/src/public-journal/exporter.ts:70-76`:

```ts
export function journalFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^journal-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort()
    .map((f) => join(dir, f));
}
```

Comentariul zice "lexical sort is chronological sort". Adevărat cât timp toate fișierele au formatul `journal-YYYY-MM-DD.jsonl`. Dar dacă `journal.ts` (rsi/infra) adaugă un fișier de forma `journal-archive-2025-11-01.jsonl` sau `journal-2025-Q4.jsonl` sau `journal-2025-11-01-part2.jsonl` (auto-splittere pentru fișiere mari), regex îl respinge → **event-uri pierdute** silent.

Nu e imediat un bug (formatul e stabil azi), dar coupling strong între exporter și scheme de naming journal. Următoarea rewrite a `journal.ts` (bugurile din runda 2 despre concurrent hash chain writes → poate motiva rewrite) va rupe exporter-ul.

**Fix (defensive):** loose-ess regex + explicit sort by parsed date:

```ts
export function journalFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir)
    .map((name) => {
      const m = /journal[-_]?(\d{4})-(\d{2})-(\d{2})/.exec(name);
      if (!m || !name.endsWith(".jsonl")) return null;
      return { name, date: `${m[1]}${m[2]}${m[3]}` };
    })
    .filter((x): x is { name: string; date: string } => x !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  return entries.map((e) => join(dir, e.name));
}
```

---

## §172 — MISCELANEE (verificat, real, mai puțin critic)

**§172a** — `crates/feral-core/src/rsi/repo.rs:437-441` `format_iteration_message` folosește `serde_json::to_string_pretty(...).unwrap_or_else(|_| "{}".to_string())` — la eșec de serializare silent-emit `"{}"`, iar `parse_iteration_metadata` returnează `None` pe `{}` → next `ratchet_attempt` respinge cu "no parseable iteration metadata". Măcar loggează:
```rust
let blob = serde_json::to_string_pretty(meta)
    .unwrap_or_else(|e| { tracing::error!("serialize iteration meta: {e}"); "{}".to_string() });
```

**§172b** — `useFeral.ts` (523 linii, nu-l analizez integral aici) probabil are aceleași issues async listener + no cancel. Rundă viitoare.

**§172c** — `useAudioPlayer.ts:112-118` cleanup pe `[stopNode]` — dar `stopNode` se creează cu `useCallback(..., [])`, deci stable identity → cleanup rulează doar la unmount, corect. OK.

**§172d** — `fish.rs::TtsOptions::default { temperature: 0.6 }` while `Fish defaults 0.7` — divergență documentată, intenționată. Not a bug.

**§172e** — `brain-stack::#chooseFallback` — `others.filter((m) => m.id !== primary.id)` face O(n) scan. Fine pentru n < 100 (real registry size). Skip.

**§172f** — `children.ts:158` — `Math.random().toString(36).slice(2, 6)` = 4 chars, 20 bits entropy. Colide cu #seq (auto-incrementat) → id-ul e `sa-${seq36}${rand4}` — unique per registry lifetime. OK.

**§172g** — `repl.ts::withTimeout` — `Promise.race([p, timer])` — timer never cleared dacă `p` termină primul → memory leak minor per cell. Reported in prev rounds ca pattern global. Fix aici cu `AbortController`.

**§172h** — `useEmbeddingDownloadStatus::clamp01` — `Math.max(0, Math.min(1, n))` — corect. OK.

**§172i** — `public-event.ts::takeMetric` — `-0` fix cu `+ 0` — corect. Dar `Math.round(n * 1e4) / 1e4` are floating-point pitfalls pentru numere ca `0.1 + 0.2 = 0.30000000000000004` → `round4 = 0.3`. Dar `round4(0.9999999)` = 1.0000 exact — OK. Skip.

**§172j** — `Fish TTS::synthesize` — `text.trim().is_empty()` retur no-op — dar `text` gol care e doar `"\n"` (whitespace) → skip corect. Bine. Dar text `"   hello"` (whitespace prefix) - se trimite `"   hello"` la Fish care-l tratează literal. Fine.

**§172k** — `repo::bootstrap` linia 189-197: `if !genomes_dir.join(".gitkeep").exists()` — file create fără atomicitate. Race dacă două processe apelează bootstrap simultan → both create `.gitkeep` (idempotent) sau EEXIST. Not real risk (bootstrap e apelat o dată la setup).

---

## Summary Runda 6

**31 findings** (§142-§172), toate verificate:
- **CRITICE MOAT**: §142 sandbox escape via proto-leak; §150 gc data-loss race; §151 ratchet trust în commit body writable; §152 Fish key sent to arbitrary base_url.
- **BUGS UI real-user-visible**: §144 mic leak permanent; §145 recorder race; §146/§147 audio player state incoerent; §163 model selector stale state.
- **DATA INTEGRITY**: §149 HEAD detached silent; §154 cursor non-atomic; §167 genome file non-atomic.
- **BRAIN STACK routing**: §157 capabilities unclamped; §158/§159 silent config errors; §170 exemplu învechit.
- **RLM system**: §143 memory leak; §160 sync throw crash; §161 name leak; §162 shallow observe.
- **PUBLIC JOURNAL**: §155 IPv6 check; §156 partial-accept cursor; §168 sanitizer holes; §169 hash uniqueness; §171 filename coupling.

Patterns rundei 6:
1. **Prototype chain**: severed() e insufficient la primul strat de nesting (§142) — pattern subtile care afectează toate wrappings care conțin arrays sau nested objects.
2. **Silent cleanup pe cleanup path**: state resource (mic, audio nodes, mid-flight streams, HEAD refs) neeliberate corect pe eroare/unmount (§144, §145, §146, §149, §164).
3. **Trust în input necontrolat**: `commit.body → score` (§151), `opts.base_url → auth` (§152), `row.hash → id` (§169), `capabilities → routing` (§157) — patterns unde apelantul se încrede în state neverificat.
4. **Non-atomic writes**: repetat din runde precedente, aici la cursor și genome files (§154, §167).
5. **GC/concurrency races**: fără locks explicite, race între commit_genome și gc_sync (§150).

Total cumulat peste 6 runde: **~170 buguri distincte identificate**.

## Zone rămase pentru rundă 7 (dacă vine)
- `crates/feral-core/src/rsi/scorer.rs` — deep BRSI scoring (parțial atins runda 5)
- `crates/feral-core/src/rsi/code_patch.rs` — patch application safety
- `crates/feral-core/src/rsi/sandbox_bounds.rs`
- `crates/feral-core/src/rsi/self_src.rs`
- `frontend-react/src/hooks/useFeral.ts` (523 linii — nu atins azi)
- `frontend-react/src/hooks/useSendMessage.ts` (372 linii)
- `FeralAgent/src/vendor/tool-call-repair/payload.ts` (743 linii — payload parser cu multe edge cases)
- `FeralAgent/src/vendor/tool-call-repair/grammar.ts` (321 linii)
- `src-tauri/src/lib.rs` main bindings
- `FeralAgent/src/tools/registry.ts` (choke point — critic)
- `FeralAgent/src/core/agent-loop.ts` (partial acoperit)
