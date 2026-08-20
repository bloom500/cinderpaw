# Sesiune de debugging — runda 3

**Autor:** Arena Agent Mode
**Data:** 2026-08-20
**Metoda:** aceeași — analiză statică, ochii pe fișier, `file:linie` pentru fiecare finding.

**Zone acoperite runda asta:**
- `crates/feral-cli/src/admin.rs` (2100 linii, CLI subcommands)
- `crates/feral-core/src/rsi/watchdog.rs` (patch revert loop)
- `crates/feral-core/src/rsi/audit.rs` (hash-chained bounds audit)
- `tui/app/*.go` (bubbletea state machine, wizard, connectors)
- `frontend-react/src/pages/*.tsx` (Chat, Connectors, Extensions, MemoryLayers)
- `frontend-react/src/pages/rsiState.ts` (reactive store)
- `FeralAgent/src/tools/builtin/read-file.ts`, `grep.ts` (io tools ne-acoperite)
- `FeralAgent/src/memory/graph.ts` (helper atomic + lock)
- `FeralAgent/src/core/user-hooks.ts` (userland extension hooks)

Nu duplic cu BUGS.md / BUGS-round2.md — dacă un bug de aici pare familiar, e o instanță NOUĂ a aceluiași pattern în fișier neacoperit.

Total: **~25 bug-uri noi**.

---

## SEVERITATE ÎNALTĂ — impact real pe zi 1

### 65. `admin.rs` — 5 apeluri reqwest fără timeout → CLI freezes forever pe gateway hang

`crates/feral-cli/src/admin.rs:697, 1855, 1869, 1891, 1930` — toate folosesc `reqwest::Client::new()` care în reqwest are TIMEOUT DEFAULT INFINIT. Doar `post_json_slow` la linia 1912 setează explicit 31 min.

Consecință: `feral status`, `feral gateway status`, `feral connectors list`, `feral doctor`, `feral providers list`, `feral providers use` — **toate pot atârna infinit** dacă gateway-ul e într-un rare stuck state (deadlock intern, chained mutex etc.). User apasă Ctrl+C — dar toate șirurile de `for i in 0..40 { sleep(500ms); … }` din wait loops se bazează pe interruption cooperative.

Fix minim: helper `fn client() -> reqwest::Client { Client::builder().timeout(Duration::from_secs(30)).build().unwrap() }`, folosit peste tot.

**Impact:** un CLI care nu răspunde e cea mai proastă surface UX-wise (mai proastă decât o eroare rapidă). Rare, dar când se întâmplă zi 1 e paralizant.

Referință similar §9 runda 1 pe TUI Go.

---

### 66. `admin.rs::connectors_set` acceptă `--secret DISCORD_TOKEN=<value>` ca argument CLI

`crates/feral-cli/src/admin.rs:601-673` (`connectors_set`):

```rust
pub fn connectors_set(id: &str, secrets: Vec<String>, ...) -> i32 {
    ...
    for kv in &secrets {
        match kv.split_once('=') {
            Some((k, v)) => { secret_map.insert(k.to_string(), Value::String(v.to_string())); }
            ...
```

`secrets: Vec<String>` vine din clap `--secret KEY=VALUE`. Value-ul e vizibil în `ps aux` pentru orice user local pe timpul execuției procesului CLI. Plus shell history dacă e paste-uit direct fără `<(cat)` sau `HISTIGNORE`.

Contrast: `providers_set_key` la linia 2092 chiar face lucruri corect — cere key-ul prin stdin (`io::stdin().read_line`). Comentariul de la 2107 zice `plain echoed read, same as the wizard at guided.rs:353 - masked input needs a tty-secrets dependency this crate does not carry.` Deci echipa știe pattern-ul.

Fix pentru connectors_set: acceptă `--secret KEY` fără value → prompt-uiește prin stdin. Sau `@stdin` marker pentru value: `--secret DISCORD_TOKEN=@stdin`.

**Impact:** Discord/Slack/Telegram bot tokens leak-uiesc în `ps aux` și în shell history de fiecare dată când user rulează comanda. Direct exploatabil pe shared box, sau via ~/.bash_history.

---

### 67. `admin.rs::logs(follow: true)` — file handle stuck pe log-uri rotate; `read_to_string` cade la orice byte non-UTF-8

`crates/feral-cli/src/admin.rs:431-464`:

```rust
pub fn logs(follow: bool) -> i32 {
    ...
    let mut file = std::fs::File::open(&path)?;
    ...
    loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() > pos {
                let _ = file.seek(std::io::SeekFrom::Start(pos));
                let mut chunk = String::new();
                if file.read_to_string(&mut chunk).is_ok() {  // ← err = silent skip
                    print!("{chunk}");
                    ...
                    pos += chunk.len() as u64;
                }
            }
        }
    }
}
```

Trei bug-uri într-un singur bloc:

1. **Log rotation blindness**: `metadata(&path)` returnează info despre CURRENT path, dar `file` handle e pe INODE ORIGINAL. Dacă `gateway restart` recrează `gateway.log` (linia 273: `File::create(&log_path)`), file-ul vechi e drop-uit, `metadata` arată new size, `file.seek + read` acționează pe ORPHAN file → citește pentru totdeauna 0 bytes → pos nu avansează → tail hang.

2. **UTF-8 crash**: `file.read_to_string(&mut chunk).is_ok()` returnează Err pentru orice byte non-UTF-8 (rare, dar apar în panic backtraces sau raw memory addr). Loop skip silent, `pos` rămâne stuck, tail hang.

3. **`pos += chunk.len() as u64`** — `chunk.len()` numără BYTES ale String. Ok, dar dacă `read_to_string` a citit partial (până la primul non-UTF8), file cursor e ADVANCED but chunk.len() reflectă doar UTF-8 valid. Divergență between file cursor și `pos` care conduce la duplicated output.

Fix: `File::open(&path)` la fiecare iteration după ce `metadata` arată size change; sau folosește `tokio::fs::watcher` pentru rotation detection; sau `read` în `Vec<u8>` + `String::from_utf8_lossy`.

**Impact:** `feral logs -f` e trusted operațional command; când eșuează silent la log rotation user nu observă până devine urgent.

---

### 68. `audit.rs::append` — race intern între `last_hash` read și write; chain break la concurrent tokio tasks

`crates/feral-core/src/rsi/audit.rs:102-138`:

```rust
pub fn append(&self, field: &str, ...) -> Result<String> {
    let prev_hash = self.last_hash()?;  // ← reads all lines to find last hash
    // ...
    let mut f = OpenOptions::new().append(true).create(true).open(&self.path)?;
    f.write_all(line.as_bytes())?;  // ← writes with computed prev_hash
    ...
}
```

Comentariul spune "atomically with respect to other writers within the same process — but the file lock is a single-process lock". **Nu-i lock intern**. Două tokio tasks care apelează `append` concurent citesc AMBELE același `prev_hash`, calculează AMBELE `entry_hash` bazat pe același prev → primul scrie, al doilea scrie cu `prev_hash` care nu mai e corect chain-wise.

`verify()` la linia 172 va raporta `"prev_hash linkage broken"` la a doua entrare din fiecare grup concurent.

Fix: `#[derive]` un `Mutex<()>` intern la struct, `let _guard = self.write_lock.lock()`. Sau `flock()` fizic pentru cross-process (deși comentariul spune single-instance).

**Impact:** RSI dream cycles pot triggger multiple bounds updates concurent → chain broken la verify → user (sau viitor tool auditor) vede audit compromis fals.

---

### 69. `audit.rs::canonicalise` folosește `|` ca separator — colision hash cu conținut care conține `|`

`crates/feral-core/src/rsi/audit.rs:230-241`:

```rust
fn canonicalise(row: &BoundsAuditRow) -> String {
    format!("{}|{}|{}|{}|{}",
        row.timestamp, row.field, row.old_value..., row.new_value, row.reason
    )
}
```

Dacă `field = "a|b", reason = "c"` vs `field = "a", reason = "b|c"` → același string canonicalizat → same hash → colision. `verify()` NU va detecta rearrangement.

Contrast cu TS `FeralAgent/src/egress/audit-log.ts:33-43` care folosește `\u0001` (SOH — improbabil în text uman) + `\u0000null` sentinel. **Deci comentariul din audit.rs `same 0x02 byte marker keeps the two chains inspectable with the same toolchain` este o minciună factuală**: cele două chain-uri au canonicalize funcții diferite. Un tool care validează unul nu-l poate valida pe altul.

Fix: schimbă separator-ul la `\u0001` (aliniat cu TS) sau JSON canonical (sortare keys). Migrare pe DB existent: în rechain step la boot.

**Impact:** low probabilitate exploit real (fields sunt din enum types la origin), dar defense in depth compromisă. Plus comentariu greșit → developer future se bazează pe cross-inspect care nu funcționează.

---

### 70. `rsiState.ts::#ensureSubscribed` — listener leak permanent la mount/unmount rapid

`frontend-react/src/pages/rsiState.ts:63-77`:

```ts
#ensureSubscribed(): void {
  if (this.#subscribed) return;
  this.#subscribed = true;      // ← SYNC set
  void (async () => {
    try {
      const uDream = await events.onDreamCycle.listen(...);   // ← ASYNC register
      const uRsi = await events.onRsiEngineEvent.listen(...);
      this.#unlistens.push(() => uDream(), () => uRsi());     // ← push AFTER teardown may have run
    } catch (err) { ... }
  })();
}

#teardown(): void {
  for (const u of this.#unlistens) { try { u(); } catch {} }
  this.#unlistens = [];
  this.#subscribed = false;
}
```

Sequence problematică:
1. `MemoryLayersPage` mount → `rsiState.subscribe(fn)` → `#ensureSubscribed()` → `#subscribed = true`, IIFE starts async listen registration
2. User face `Ctrl+R` sau navighează → `MemoryLayersPage` unmount → cleanup returned from subscribe → `#listeners.delete(fn)` → size 0 → `#teardown()` → but `#unlistens` e EMPTY, deci nothing to unregister
3. IIFE continues → `await events.onDreamCycle.listen(...)` succeeds → `this.#unlistens.push(() => uDream(), () => uRsi())` → **listeners live PENTRU TOTDEAUNA**

Fiecare mount/unmount rapid adaugă noi listeners care primesc events pentru totdeauna. La ~100 iterații = 100 duplicate handlers pe dream_cycle events.

Fix:
```ts
#ensureSubscribed(): void {
  if (this.#subscribed) return;
  const gen = ++this.#gen;
  this.#subscribed = true;
  void (async () => {
    const uDream = await events.onDreamCycle.listen(...);
    const uRsi = await events.onRsiEngineEvent.listen(...);
    if (gen !== this.#gen) { uDream(); uRsi(); return; }  // teardown ran; unregister now
    this.#unlistens.push(...);
  })();
}
```

**Impact:** leak vizibil (nu memory ci event handlers), performance degradation în timp. Pattern-ul e răspândit — vezi §19 runda 1 pentru variante similare.

---

### 71. `read-file.ts` — descarcă tot fișierul în RAM înainte de size check → OOM

`FeralAgent/src/tools/builtin/read-file.ts:100-107`:

```ts
async execute(args, ctx) {
  ...
  const safePath = resolveAllowedPath(ctx.manifest, "fs:read", requested);
  const buf = await readFile(safePath);   // ← unbounded, întregul fișier în RAM
  const truncated = buf.byteLength > MAX_BYTES;
  const text = buf.toString("utf8", 0, MAX_BYTES);
  ...
}
```

`MAX_BYTES = 64 * 1024`, dar `readFile(safePath)` fără opțiuni descarcă complet. Un fișier 10GB în allowed path → `readFile` alocă 10GB → OOM sidecar. Rare în workspace normal, dar dacă workspace root include un `~/Downloads` sau path la modele GGUF, foarte real.

Fix: `fs.open` + `fs.read(fd, buffer, 0, MAX_BYTES, 0)` cu buffer fixat, sau `fs.stat` up-front cu refuse dacă size > safety threshold.

Similar §41 (network) din runda 2, dar pe filesystem.

---

### 72. `download_model` writeFile / notebook / edit-file — aceleași issues §35, verificate în alte 4 fișiere

Am confirmat același pattern non-atomic în:
- `FeralAgent/src/memory/checkpoint.ts` — folosește SQLite INSERT (atomic prin transaction), ok
- `FeralAgent/src/memory/graph.ts:118-122` — folosește `atomicWriteFileSync` (corect implementat cu tmp + fsync + rename)
- `FeralAgent/src/tools/builtin/notebook.ts:120` — `writeFileSync` DIRECT (bug §35 runda 2)
- `FeralAgent/src/tools/builtin/write-file.ts:112` — `writeFile` DIRECT (bug §35)
- `FeralAgent/src/tools/builtin/edit-file.ts:188` — `writeFile` DIRECT (bug §35)

**Ironia**: `memory/graph.ts` **exportă** helperul `atomicWriteFileSync(filePath, contents)`. Este LITERAL 1 linie fix per site — dar 3 tool files nu-l folosesc.

Not un bug nou, dar confirmă că fix-ul e trivial și e clar owned unde.

---

## SEVERITATE MEDIE — race, logic, correctness

### 73. `admin.rs::gateway_start` — race între port check și spawn (aceeași ca §42)

`crates/feral-cli/src/admin.rs:259-317`. Similar cu §42 runda 2. Nu adaugă nou.

---

### 74. `admin.rs::gateway_start` — write pid file necheckuit; stale pid la crash

`crates/feral-cli/src/admin.rs:298-300`:

```rust
let child = match cmd.spawn() { Ok(c) => c, ... };
let pid = child.id();
let _ = std::fs::write(feral_file("gateway.pid"), pid.to_string());
```

`let _ =` ignore returnul lui write. Ok — pid file e best-effort. Dar apoi:

```rust
for i in 0..40 {
    if port_in_use(port) { ... return 0; }
    tick(...); std::thread::sleep(500ms);
}
tick_done();
eprintln!("gateway did not bind port {port} within 20s...");
1
```

Dacă gateway pică imediat după spawn (înainte de a bind portul), returnează 1 cu error message — dar pid file rămâne pe disc cu pid mort. Următorul `feral status` (linia 197) vede pid + port_in_use=false → ambiguity. Pas subsequent `feral gateway stop` va încerca să kill pid care poate acum aparține unei alt proces user.

Fix: la spawn failure explicit, `remove_file(feral_file("gateway.pid"))`.

**Impact:** low (rar), dar când e triggger duplicate → user aleatoriu kill-uit.

---

### 75. `watchdog.rs::mark_patch_reverted` — non-atomic write pe pending-patches.json + no lock cross-process

`crates/feral-core/src/rsi/watchdog.rs:225-246`:

```rust
pub fn mark_patch_reverted(store_path: &Path, patch_id: &str) -> Result<()> {
    let bytes = std::fs::read(store_path)?;
    let mut v: serde_json::Value = serde_json::from_slice(&bytes)?;
    // ... modify v ...
    std::fs::write(store_path, serde_json::to_vec_pretty(&v)?)?;
    Ok(())
}
```

Read-modify-write non-atomic. Sidecar TS scrie același fișier concurent (`FeralAgent/src/rsi/l3-code/pending-patches.ts` — probabil). Race cu:
- Crash mid-write → JSON corupt → următorul auto-revert nu găsește patch text
- Concurrent TS write → last write wins → un patch marked applied de TS e overwritten de Rust cu status vechi

Fix: `atomic_write` (tmp + rename) + `withFileLock` similar `memory_graph.rs`.

**Impact:** medium — RSI auto-revert story se bazează pe pending-patches.json fiind mereu citibil.

---

### 76. `watchdog.rs::save_marker` — tmp + rename ok, dar dacă rename fail-uiește tmp file leak

`crates/feral-core/src/rsi/watchdog.rs:127-133`:

```rust
std::fs::write(&tmp, &bytes)?;
std::fs::rename(&tmp, path).with_context(|| ...)?;
```

Dacă `rename` fail-uiește (cross-device, permissions rare edge case), returnează Err — dar `tmp` file rămâne pe disc. Cu suffix `.tmp.{pid}.{n}`, pot acumula multe tmp-uri stale peste timp.

Fix: `if rename.is_err() { std::fs::remove_file(&tmp).ok(); }` — un cleanup pe error path.

**Impact:** low, cosmetic.

---

### 77. `admin.rs::doctor` — port check + separate token check → race pe gateway restart

`crates/feral-cli/src/admin.rs:1494-1553` — `doctor()` cheamă `check_port()`, `check_token()`, `check_sidecar()` etc. secvențial. Între ele gateway-ul poate restart. User vede raport inconsistent (port up, token missing, sidecar up).

Not critical, dar UX confuz.

---

### 78. TUI Go: `fetchSessionsCmd` accesează `a.SessionsAt` din goroutine fără sync

`tui/app/update.go:47-54`:

```go
func (a *App) fetchSessionsCmd() tea.Cmd {
    return func() tea.Msg {   // ← runs in goroutine
        if !a.SessionsAt.IsZero() && time.Since(a.SessionsAt) < 30*time.Second && a.SessionsErr == nil {
            return SessionsMsg{Sessions: a.Sessions, Err: nil}
        }
        ...
    }
}
```

`a.Sessions`, `a.SessionsAt`, `a.SessionsErr` sunt mutate din main loop (`Update` handler cu SessionsMsg). Bubbletea documenta că `tea.Cmd` closures nu au voie să atingă model. Aici încalcă explicit.

Consecință: go race detector (`go test -race`) va detecta imediat. Non-deterministic behavior sub load.

Fix: pass state prin closure snapshot, nu prin `a.*` reference.

**Impact:** rare crash sau garbage state pe context switch.

---

### 79. TUI Go: `saveWizardProgress` ignoră `WriteFile` error → progress silent pierdut

`tui/app/wizard.go:286-293`:

```go
func saveWizardProgress(step WizardStep, mode SetupMode, choice WizardChoice) {
    path, err := wizardProgressPath()
    if err != nil { return }
    payload := fmt.Sprintf("v%d:%d:%d:%d", ...)
    os.WriteFile(path, []byte(payload), 0644)   // ← err ignored
}
```

Dacă disk full sau `~/.feral` permission issue, user continuă wizard-ul fără avertisment. La restart cu Ctrl+C mid-wizard, se pierde tot progresul.

Fix: log + surface în TUI toast dacă write eșuează.

**Impact:** low (rare), dar UX degradat silent.

---

### 80. `admin.rs::run_gateway` (indirect, prin `main.rs`) și `gateway_restart` folosesc `port_in_use` polling — nu observă un gateway care întârzie sub 500ms

`crates/feral-cli/src/admin.rs:361-368`:

```rust
for i in 0..40 && !api.PortInUse(port); i++ {
    time.Sleep(250 * time.Millisecond)   // ← 250ms lag
}
```

Wait, asta e din Go TUI (`tui/app/commands.go:363`). Cel din Rust admin.rs:301 similar folosește `sleep(500ms) * 40 = 20s`. `port_in_use` face TCP connect care are propriul timeout... nu real bug, dar UX 500ms lag observabil.

Skip.

---

### 81. `user-hooks.ts::runHook` — `stderr` buffer nu are back-pressure

`FeralAgent/src/core/user-hooks.ts:127-129`:

```ts
child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 4096) stderr += chunk.toString();
});
```

Check e `stderr.length < 4096`, dar append nu-i truncat. Dacă chunk-ul e 8KB și stderr era 3900, deveine 11.9KB — pass through, nu-i cap real. Nu-i bug critic dar sub-optim (edge — poate un hook care spamă `> printf 'x'; sleep 0` timpuri finite pot buffer 10MB).

Fix: `stderr += chunk.toString().slice(0, Math.max(0, 4096 - stderr.length))`.

---

### 82. `grep.ts` — ReDoS via user-controlled pattern

`FeralAgent/src/tools/builtin/grep.ts:101`:

```ts
regex = new RegExp(pattern, caseInsensitive ? "i" : "");
```

`pattern` vine din agent tool call, poate fi catastrophic backtracking (`(a+)+$`, `(a|a)*b`, `(?:a{1,1000}){1,1000}`). `regex.test(line)` explodează exponentially → blochează event loop sidecar minutes/hours.

Nu-i security "external", dar dacă un model instruit greșit (sau prompt injection dintr-un fișier citit) generează pattern nasty, agent-ul se DoS-ează pe sine.

Fix: `re2` package (linear time), sau `vm.runInNewContext` cu timeout scurt.

**Impact:** medium — pattern user-generated e "nu tocmai trusted" (poate fi din tool result contents mai devreme, care ar putea veni de la web fetch).

---

### 83. `graph.ts::withFileLock` — busy-wait spin blocks event loop 50ms per retry

`FeralAgent/src/memory/graph.ts:63-64`:

```ts
const until = Date.now() + LOCK_RETRY_MS;
while (Date.now() < until) { /* spin briefly */ }
```

50ms sync spin CPU 100% util. În Node event loop single-thread, NIMIC altceva nu poate rula 50ms — inclusiv timers, socket reads, GC. Sub load moderate cu multiple locks (episodic write + fact write + query), sidecar-ul se pare frozen periodic.

Fix: `withFileLock` trebuie făcut async (`await new Promise(r => setTimeout(r, LOCK_RETRY_MS))`). Refactor major fiindcă `fn: () => T` sync trece la `fn: () => Promise<T>`.

**Impact:** medium — degradarea UX perceptibilă sub `feral gateway` load real.

---

### 84. `Extensions/ConnectorsPage` — `Promise.all([...]).finally(setLoading(false))` fără cleanup pe unmount

`frontend-react/src/pages/ExtensionsPage.tsx:35-46`:

```ts
const load = () => {
    setError(null);
    Promise.all([tauri.mcp.list(), tauri.mcp.catalog()])
      .then(([list, cat]) => {
        setInstalled(...); setCatalog(...);   // ← setState after unmount = warning
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
};
useEffect(load, []);
```

Dacă componentul unmount-uează înainte de Promise resolve, `setInstalled` / `setCatalog` sunt apelate pe unmounted component → React warning: "Can't perform a state update on an unmounted component". Nu-i crash, dar console spam + potential memory leak.

Fix: standard `let mounted = true; return () => { mounted = false; }` guard.

Same pattern în `ConnectorsPage.tsx:41`.

**Impact:** low, dar zi 1 se vede în devtools console.

---

### 85. `skills.rs::preview_local_file` — no size cap + no sensitive-path guard

`src-tauri/src/skills.rs:336-368` (`preview_local_file`):

```rust
pub fn preview_local_file(path: &str) -> Result<SkillPreview> {
    let p = std::path::Path::new(path);
    let metadata = std::fs::metadata(p)?;
    if !metadata.is_file() { bail!("..."); }
    let canon = p.canonicalize()?;
    ...
    let content = std::fs::read_to_string(&canon)?;  // ← unbounded read
    ...
}
```

Exposed la webview via `preview_local_skill` command (`src-tauri/src/lib.rs:345`). User (sau XSS) pointează la orice fișier din sistem:
- `~/.ssh/id_rsa` — private key returned ca "skill preview content" (aceași story ca §38)
- `/dev/urandom` — infinit read → OOM
- Fișier 10GB — OOM

Fix: `deny_sensitive(canon)` (helper propus la §38), plus `metadata.len() > 5 * MB` refuz.

**Impact:** high dacă webview XSS. Same threat model ca §38.

---

### 86. `admin.rs::providers_set_key` — key printed la echo pe tty non-piped (documentat, dar rămâne un bug UX)

Documentat la §linia 2107, dar consecință concretă: keyboard user vede API key-ul pe screen. Screen recording software (Zoom, Loom) sau colegii care privesc peste umăr văd key-ul plain text. Comparativ cu `rpassword` care ar face `***` — refuz de a adăuga dependency `tty-secrets`.

Sugesție: `tokio-console` sau `rpassword` (~30 loc). Nu-i critic security, dar user expectation modern.

---

## SEVERITATE JOASĂ — nitpicks, defensive, cosmetic

### 87. `admin.rs::gateway_stop` folosește loop `for i in 0..70 { sleep 500ms }` = 35s hard-coded, similar bug la restart

Design decision, nu bug. Skip.

### 88. `audit.rs::last_hash` recitește FULL file la fiecare append → O(n²) pe log lung

`crates/feral-core/src/rsi/audit.rs:143-166`:

```rust
pub fn last_hash(&self) -> Result<String> {
    let f = File::open(...)?;
    let reader = BufReader::new(f);
    let mut last: Option<String> = None;
    for line in reader.lines() {
        ...
        last = Some(row.entry_hash);
    }
    ...
}
```

Iterează prin TOATE line-urile pentru a găsi ultima. Log-ul e mic (bounds updates rare), dar pe log crescut la 10k+ entries, fiecare append devine O(n).

Fix: cache last_hash în struct, invalidate la append; sau seek de la EOF cu buffer reverse-scan.

**Impact:** none acum (log stays small), dar tehnic O(n²).

### 89. `admin.rs::feral_file` fără thread safety pe `feral_dir()`

`feral_core::paths::feral_dir()` folosește `once_cell` (verified anterior), deci thread-safe. Skip.

### 90. TUI: multe `os.WriteFile(path, data, 0644)` — permissions default nu-s ideale pentru user data

`tui/api/client.go`, `tui/app/wizard.go` folosesc `0644`. Pentru wizard progress etc. e ok, dar consistency slabă with `EnsureToken` care e `0600`.

---

## Recomandări prioritizate — round 3

1. **Un `httpClient()` helper cu timeout 30s** pentru `crates/feral-cli/src/admin.rs` (§65). 5 call site-uri, 1-line fix each.
2. **`connectors_set` să accepte `--secret KEY` prin stdin** (§66). Bot tokens leak-uiesc în `ps aux` zi 1.
3. **`audit.rs::append` să aibă lock intern** (§68) + canonicalize aliniată cu TS (§69). Otherwise integrity check inconsistent.
4. **rsiState.ts fix listener leak** (§70). Pattern-ul e reutilizabil pentru toate storurile globale reactive.
5. **`atomicWriteFileSync` folosit peste tot** (§72). Helper există în `memory/graph.ts`, doar de imported.
6. **`re2` pentru grep pattern** (§82). Sau vm sandbox cu timeout. Agent poate DoS-a sine printr-un tool call.
7. **`preview_local_file` guard** (§85). Same story ca §38 runda 2.

---

## Ce n-am acoperit încă

- `crates/feral-core/src/rsi/tier0.rs` (specs eval, 545 linii)
- `crates/feral-core/src/rsi/plan.rs` (planning heuristics)
- `crates/feral-core/src/rsi/goodhart.rs` (goodhart detection)
- `crates/feral-core/src/rsi/repo.rs` (git operations — parțial acoperit runda 2)
- FeralAgent's `src/rsi/*.ts` (L1-L4 layers, mare)
- FeralAgent's `src/brain/*.ts` (brain stack, task classifier)
- Frontend hooks (useChatStream, useVoiceRecorder, etc.)

**Trend observat pe 3 runde**: cele mai frecvente patterns problematice sunt:
1. Non-atomic writes de state files (peste 8 site-uri, deja există helper)
2. Reqwest/fetch fără timeout (Rust + Go + TS)
3. Read body/file fără size cap
4. Race între check și action (TOCTOU) — port bind, download insert, file exists
5. Substring/contains security checks (URL matching, allowlists)
6. React listener registration cu async setup fără mount guard

Un audit sistematic după fiecare pattern (grep-based cu manual verify) ar identifica 90% din bug-urile rămase într-o zi. Merită un test lint sau un helper util care închide fiecare categorie.
