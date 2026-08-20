# Sesiune de debugging: bug-uri găsite prin analiză statică

**Autor:** Arena Agent Mode
**Data:** 2026-08-20
**Metoda:** analiză statică prin cod (nu am rulat `cargo`/`bun`/`go` — nu-s instalate în sandbox). Fiecare bug e verificat manual cu ochii pe surse. Referințele arată `fișier:linie` pe care le poți deschide direct.

Repo scanat:
- `src-tauri/` (Rust, Tauri host, ~5k linii)
- `crates/feral-core/` (Rust runtime, ~15k linii)
- `crates/feral-cli/` (Rust CLI, ~4k linii)
- `FeralAgent/` (TypeScript sidecar, ~600 fișiere)
- `frontend-react/` (React + Tauri)
- `tui/` (Go / Bubble Tea, ~13k linii)

Total: **~30 bug-uri distincte**, sortate pe severitate. Nu sunt toate — o citire cu mai mult timp pe fiecare fișier ar produce mai multe. Am prioritizat bug-urile cu impact vizibil (crash, data loss, security, dead behavior).

---

## SEVERITATE ÎNALTĂ — bugs care rup produsul sau leak secrete

### 1. Secrete în clar cu permisiuni default pe disc — `mcp.json`, `connectors.json`, `agents/*.json`

**Fișiere:**
- `src-tauri/src/mcp.rs:64-69` (`save_config`)
- `crates/feral-core/src/connectors.rs:358-362` (`save_connector_configs`)
- `FeralAgent/src/tools/builtin/connectors-manage.ts:198-200`
- `src-tauri/src/agents.rs:44-50` (`save`)

Fișierele conțin secrete puternice: token-uri OAuth, bot tokens Discord/Slack/Telegram/WhatsApp, API keys MCP. Toate scriu cu `std::fs::write` / Node `writeFile` fără:
- **`chmod 0600`** (pe Unix rămân `0644` — citibile de orice user local)
- **atomic rename** (temp file + rename) — un crash mid-write corupe fișierul

Contrast: `crates/feral-core/src/boot.rs:136-142` și `byok_file_store.rs:110-114` fac corect (chmod + tmp). Deci echipa cunoaște pattern-ul; nu e aplicat consecvent.

**Impact:** Pe multi-user desktop (Linux/macOS) alți useri locali pot citi tokenurile. Un crash în scriere lasă un JSON corupt care omoară boot-ul următor.

---

### 2. Race condition + write neatomic pe `conversations/index.json` și `projects.json`

**Fișiere:**
- `src-tauri/src/conversations.rs:96, 140` (`write_index`, `save_to_dir`)
- `src-tauri/src/projects.rs:34, 42` (`save_to`, `delete_from`)

Pattern read-modify-write pe fișierul JSON al indexului, fără mutex sau lockfile, cu `fs::write` direct (fără temp + rename). Două `save_conversation` invocate concurent din UI pot pierde ambele modificări. Un crash mid-write lasă un `index.json` corupt care blochează sidebar-ul.

Codul are deja pattern-ul corect implementat în `src-tauri/src/memory_graph.rs:216-252` (`with_file_lock` + `atomic_write`). Se poate refolosi.

---

### 3. `delete_from_dir` execută `remove_file` pe path arbitrar citit din JSON

`src-tauri/src/conversations.rs:167-173`:

```rust
if let Ok(conv) = load_from_dir(dir, id) {
    for m in &conv.messages {
        if let Some(v) = &m.voice {
            let _ = std::fs::remove_file(&v.audio_path);   // <-- neverified
        }
    }
}
```

`v.audio_path` vine din fișierul JSON al conversației. Dacă un atacator poate scrie într-o conversație (via unele modele care fabrică voice metadata pentru mesaje, sau via `save_conversation` cu payload manipulat), `delete_conversation` va apela `remove_file` pe orice path scriabil de proces — `~/.ssh/id_rsa`, `~/.feral/api-token`, `~/.feral/byok.json`, etc.

**Fix:** `require_under(&paths::feral_dir(), &v.audio_path)` înainte de `remove_file`.

---

### 4. `EXPECTED_COMMAND_COUNT` și suite de teste care e roșie de commituri întregi

`src-tauri/src/commands/mod.rs:53` declară `EXPECTED_COMMAND_COUNT: usize = 132`, dar `collect_commands![]` din `src-tauri/src/lib.rs:284-416` conține **135 identificatori**. Comentariile de la 40-52 recunosc explicit că testul e roșu de la commitul `fe5b5b6` (`connectors_whatsapp_qr`) și de la `9c1849f` (`feral_submit_feedback`).

Cauza rădăcină e mai gravă decât testul stricat: **CI nu rulează suite-ul `src-tauri`**, ceea ce înseamnă că *orice* regresie în `#[tauri::command]` trece nedetectată. Fix-ul real e configurația CI, nu constanta.

Verificat: `sed -n '284,420p' src-tauri/src/lib.rs | grep -v '^\s*//' | grep -v 'collect_commands' | grep -v '^\s*\]' | grep -v '^\s*$' | wc -l` → 135.

---

### 5. `ensureListeners()` din `chatStream.ts` reține un promise rejected pentru totdeauna

`frontend-react/src/lib/chatStream.ts:41-83`

```ts
let initPromise: Promise<void> | null = null;
async function ensureListeners(): Promise<void> {
  if (unlistens.length > 0) return;
  if (initPromise) return initPromise;
  initPromise = (async () => { ... })();
  return initPromise;
}
```

Dacă primul `listen()` throw-uește (permission denied, Tauri host bug, race la boot), `initPromise` rămâne cached ca un promise **rejected**. Următoarele `startChatStream` returnează același promise rejected → chat-ul e mort permanent până la reload.

**Fix:** `.catch(err => { initPromise = null; throw err; })` pe promise-ul creat.

---

### 6. `startChatStream` — timeout absent, streams pot rămâne agățate în `inflight`

`frontend-react/src/lib/chatStream.ts:126-149`

Nu există un fallback dacă backend-ul nu emite niciodată `done`/`error` (ex: sidecar crashed silent, event listener deregistered greșit). Intrarea rămâne în `inflight` pentru totdeauna, `isChatStreaming(sessionId)` returnează `true`, sidebar spinner-ul e stuck.

Comentariul din top-ul fișierului chiar spune că problema asta a existat înainte cu unmount. Acum nu mai există unmount cleanup, dar în schimb nu mai există *nici un* cleanup pe eșec silent.

---

### 7. UTF-8 split la marginea chunk-urilor SSE

**Fișiere:**
- `src-tauri/src/commands/chat.rs:704` (`String::from_utf8_lossy(&bytes)` per chunk)
- `crates/feral-cli/src/admin.rs:713` (același pattern)

Când un codepoint UTF-8 multi-byte (emoji, chirilic, chinez) e împărțit între două chunk-uri de rețea, `from_utf8_lossy` per chunk produce `U+FFFD` (`�`) pentru byte-urile de continuare orfane. Textul afișat în UI apare mutilat.

**Fix:** decode incremental (`encoding_rs::Decoder` sau păstrare buffer de bytes cu decode doar când e complet).

---

### 8. `download_model` și `download_embedding_model` — TOCTOU pe map-ul de descărcări

**Fișiere:**
- `src-tauri/src/commands/models.rs:42-50, 834-848`

```rust
{
    let map = state.downloads.lock();
    if map.contains_key(&key) {
        return Err(format!("Download already in progress: {}", key));
    }
}                                     // <-- lock released

// ... check `paths::embedding_model_path().exists()` ... (embedding-only)

let cancel = ...;
state.downloads.lock().insert(key.clone(), cancel.clone());  // <-- second lock
```

Două apeluri concurente pentru același model trec de check și amândouă inserează + spawnează task-uri de download. Se ajunge la două task-uri care scriu concurrent în același `.part`.

**Fix:** păstrează lock-ul pe toată operațiunea sau folosește `entry().or_insert_with(...)` atomic.

---

### 9. TUI Go: HTTP calls fără timeout — UI se poate freeza indefinit

`tui/api/client.go` — 16 apeluri folosesc `http.DefaultClient.Do(req)` fără timeout:

```
tui/api/client.go:307, 340, 363, 394, 413, 431, 460, 504, 554, 633, 645, 663, 706, 1175, 1355, 1556
```

Doar 3 endpoint-uri au timeout explicit (`SetupVerify`, `CompactSession`, `DownloadModel`). Un gateway hang înseamnă că `FetchStatus`, `ListModels`, `SetModel`, `ReloadConnectors` etc. blochează pentru totdeauna — TUI-ul se pare freezat cu Ctrl-C ca singura scăpare.

**Fix:** `client := &http.Client{Timeout: 10 * time.Second}` la nivel de package sau injectat.

---

### 10. `ignored errors` pe `http.NewRequest` în TUI

`tui/api/client.go:305, 338, 360, ...` — pattern `req, _ := http.NewRequest(...)`. `http.NewRequest` întoarce eroare la un URL invalid (ex: `baseURL` conține caracter neașteptat), iar `req` va fi `nil`. Următorul `http.DefaultClient.Do(req)` va face **panic nil-deref** în goroutine.

**Fix:** propagă eroarea.

---

### 11. TUI Go: `bufio.Scanner` cu buffer 64KB pe stream SSE

`tui/api/client.go:1184-1185`:

```go
scanner := bufio.NewScanner(resp.Body)
scanner.Buffer(make([]byte, 0, 65536), 65536)
```

`MaxScanTokenSize = 65536`. Un tool result mare (list_directory pe un director cu multe fișiere, grep cu multe hits, orice `data:` line > 64KB) va crăpa cu `bufio.Scanner: token too long` și streamul se închide mid-turn. Utilizatorul vede răspunsul întrerupt fără să afle de ce.

**Fix:** crește dramatic sau schimbă cu `bufio.Reader.ReadBytes('\n')` fără limită.

---

### 12. `writeFile` pe token-ul API și pe cheile Discord/OAuth în TS sidecar

- `FeralAgent/src/tools/builtin/connectors-manage.ts:200` — `writeFile(file, ..., "utf8")` fără `{ mode: 0o600 }` și fără atomic rename. Fișierul conține secrete în clar.

Notă: `api.EnsureToken` în Go (`tui/api/client.go:243-246`) folosește `os.WriteFile(path, ..., 0o600)` — corect. `boot.rs` idem. Dar path-ul TS ignoră permissions.

---

### 13. Substring matching pentru allowlist de aplicații — permite bypass

`src-tauri/src/desktop_control.rs:222-227`:

```rust
if !allowlist.is_empty() {
    let permitted = allowlist.iter().any(|a| {
        let a = norm(a);
        !a.is_empty() && (n == a || n.contains(&a))  // <-- substring!
    });
```

Un utilizator care allowlist-uiește `notepad` permite AUTOMAT `notepad-evil.exe`, `notepadcmd.exe`, `xxnotepad.exe`, etc. Aceeași problemă în `HARD_DENY` la linia 217 (`n.contains(deny)`) — dar acolo eroarea e conservativă (false positive → refuz).

**Fix pentru allowlist:** match exact pe basename, sau glob explicit, nu substring.

---

### 14. Race condition pe `EnsureToken` din TUI Go

`tui/api/client.go:219-249`:

```go
if existing, err := ReadToken(); err == nil && existing != "" {
    return existing, nil
}
// ... generate raw ...
if err := os.WriteFile(path, ...); err != nil { ... }
```

Doi consumatori concurenți (TUI + gateway) care încep simultan pot ambii genera token diferit; ultimul câștigă. `os.WriteFile` cu `O_TRUNC` overwrite-uiește. Nu-i `O_EXCL` create — nu-i single-writer discipline ca în `FeralAgent/src/db.ts`.

**Impact:** o pornire concurentă poate schimba token-ul sub sidecar, iar cererile către gateway încep să eșueze cu 401.

---

### 15. `LOCK_STALE_AFTER_MS = 60_000` peste `LOCK_HEARTBEAT_MS = 10_000` — margin insuficient

`FeralAgent/src/db.ts:26, 46`

Heartbeat 10s, stale 60s = 6 rate-uri pierdute. Dar `setInterval` cu `unref` poate fi paused arbitrar sub GC pause / debugger / OS swap. Comentariul recunoaște: „Six missed beats is not a pause, it is a corpse.” Adevărat statistic, dar există sisteme (Windows sub load I/O, VM-uri suspendate) care ratează minutar. Un peer live poate avea lock-ul furat.

Nu-i critic — comportamentul e conservator (poate face un lock steal false pozitiv rar), dar merită documentat că sub condiții extreme se comportă greșit.

---

### 16. `redirect::Policy::none()` lipsă în `skills.rs` fetching → SSRF potențial pe redirect

`src-tauri/src/skills.rs:226, 264, 302` — toate cele 3 `reqwest::Client::builder()` fetch-uri pentru manifest/skill nu setează `.redirect(Policy::none())`. `validate_content_url` (linia 17) verifică URL-ul inițial dar nu hop-urile redirect.

Un URL pe raw.githubusercontent.com care redirectă intern (de exemplu pentru LFS) sau un URL clonabil pe alt subdomain riscă să evadeze allowlist-ul.

Contrast: `crates/feral-core/src/tools.rs:534-540` (http_request) o face corect cu redirect manual.

---

## SEVERITATE MEDIE — buguri de logică, race-uri subtile, memory leaks

### 17. `cron/scheduler.ts` — `nextRunMs` nu se recalculează după `upsert` cu schedule modificat

`FeralAgent/src/cron/jobs.ts:134-158` (`upsert`):

Dacă utilizatorul editează schedule-ul unui job existent (de la `every 5m` la `every 1h`), codul copiază `existing?.nextRunMs` — computat pe schedule-ul vechi. Rezultat: prima execuție după edit se face la ora veche, nu la cea nouă.

**Fix:** dacă `input.schedule` diferă de `existing.schedule`, recalculează `nextRunMs` cu `nextRunAt(input.schedule, now)`.

---

### 18. `chatStream.ts` — auto-stop la send nou stopează greșit toate sesiunile

`frontend-react/src/lib/chatStream.ts:105-118`:

```ts
if (inflight.size > 0) {
  const interrupted: string[] = [];
  for (const [prevId, entry] of inflight) {
    entry.stopped = true;
    entry.onError('Interrupted by a new message');
    inflight.delete(prevId);
    interrupted.push(prevId);
  }
```

Aici e implicat că e „only one chat stream at a time”. Dar arhitectura permite (și `useChatStream` chiar creează) session-id-uri diferite per componentă. Dacă vreodată se deschid 2 chat-uri în paralel (multiplayer / multi-tab), send într-unul oprește pe celălalt.

Nu-i imediat vizibil pentru că UI-ul curent are un singur `ChatInput` mounted, dar contractul e fragil.

---

### 19. Listener leak în React când `.listen(...).then(fn => unlistens.push(fn))` unmountează înainte de `.then`

**Fișiere:**
- `frontend-react/src/App.tsx:72-78` (`modelLoadProgressEvent`)
- `frontend-react/src/components/chat/StreamingIndicator.tsx:56-58` (`streamProgressEvent`, `onStreamProgress`)
- `frontend-react/src/components/settings/FractalBenchmarkPanel.tsx:103-104`

Pattern-ul:
```ts
useEffect(() => {
  let unlisten: (() => void) | null = null;
  events.foo.listen(cb).then(fn => { unlisten = fn; });
  return () => { unlisten?.(); };
}, []);
```

Dacă componentul unmountează înainte ca `.then` să ruleze, callback-ul de cleanup ruleză cu `unlisten` încă `null`; apoi `.then` se rezolvă și înregistrează listener-ul într-un component deja unmounted. Leak permanent + callback rulează pe state stale.

**Fix:**
```ts
useEffect(() => {
  let mounted = true;
  let unlisten: UnlistenFn | null = null;
  events.foo.listen(cb).then(fn => {
    if (!mounted) fn();
    else unlisten = fn;
  });
  return () => { mounted = false; unlisten?.(); };
}, []);
```

---

### 20. `parseInvokeXml` — regex-ul lax poate consuma prea mult text

`FeralAgent/src/core/agent-loop.ts:2870`:

```js
const invokeRe = /<(?:[A-Za-z_][\w.-]*:)?invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)(?:<\/(?:[A-Za-z_][\w.-]*:)?invoke>|$)/g;
```

Cu `|$` la sfârșit, o etichetă `<invoke>` neînchisă consumă TOT restul răspunsului până la EOF. Dacă modelul emite `<invoke name="write_file">` la mijloc și continuă cu prose după, tot ce urmează devine `body` de tool call.

Există un guard la linia 2903 care sare peste dacă e „announcement” (bare opener fără args), dar dacă modelul emite `<invoke name="x"><parameter name="y">…` neînchis, guard-ul nu detectează cazul.

---

### 21. `assert_public_url` — DNS lookup blocking pe async runtime

`crates/feral-core/src/tools.rs:513`:

```rust
if let Ok(addrs) = (host_ip, port).to_socket_addrs() {
```

`to_socket_addrs()` face DNS lookup SINCRON pe thread-ul curent. Într-un runtime tokio, blochează worker-ul pentru sute de ms → mii de ms dacă DNS-ul e slow. La un URL cu multe A/AAAA records, apelul asta poate bloca tot runtime-ul.

**Fix:** `tokio::task::spawn_blocking` sau `tokio::net::lookup_host`.

---

### 22. `is_blocked_v4` nu blochează CGNAT (100.64.0.0/10)

`crates/feral-core/src/tools.rs:449-457`:

```rust
fn is_blocked_v4(a: std::net::Ipv4Addr) -> bool {
    a.is_loopback() || a.is_private() || a.is_link_local() || a.is_unspecified() || a.is_broadcast() || a.octets()[0] == 0
}
```

`Ipv4Addr::is_private` acoperă doar `10/8, 172.16/12, 192.168/16`. Nu blochează:
- **CGNAT `100.64.0.0/10`** — folosit pentru interne ISP și în multe LAN-uri corporate
- **Documentation ranges `192.0.2/24, 198.51.100/24, 203.0.113/24`** — rar, dar merită blocate din prudență
- **`0.0.0.0/8`** — parțial acoperit de `octets()[0] == 0`, dar `is_unspecified` doar `0.0.0.0` exact.

Un atacator care controlează un domeniu care rezolvă la `100.64.x.x` poate atinge servere interne ISP.

---

### 23. `SETTINGS_TTL_MS = 2_000` cache pe permission mode — modificarea nu se aplică pentru 2 sec

`FeralAgent/src/core/permission-mode.ts:49-50`:

```ts
const SETTINGS_TTL_MS = 2_000;
let cached: { mode: PermissionMode | null; at: number } | null = null;
```

Documentat că e „human-paced”. OK pentru chat, dar dacă utilizatorul face „switch to read_only, run this destructive command” în rapid succession, până la 2s de comenzi pot trece cu vechea permission mode. E o eroare de securitate mică, dar merită documentat mai vizibil pentru utilizatorii care se bazează pe read_only pentru delegare de încredere.

---

### 24. Log în plain text pentru args în `agents::list`

`src-tauri/src/agents.rs:69-77`:

```rust
tracing::info!("agents::list: loaded agent {} ({:?})", cfg.id, cfg.name);
```

Nu-i critic, dar `AgentConfig.system_prompt` (poate conține instrucțiuni sensibile de la user) e loguit indirect prin `cfg` în multiple locuri similare. Nu am găsit un incident concret dar merită o trecere.

---

### 25. `add_memory_facts` — lockfile stale after 30s, dar timeout wait doar 5s

`src-tauri/src/memory_graph.rs:220, 235`:

```rust
let timeout = std::time::Duration::from_secs(5);
...
if modified.elapsed().unwrap_or(std::time::Duration::MAX)
    > std::time::Duration::from_secs(30)
```

Dacă un writer legit ține lock-ul între 5s și 30s (RSI compaction, un embed batch mare), apelantul get timeout după 5s cu eroare, chiar dacă lock-ul e valid. UX prost: „lock timeout” la un scenariu normal.

---

### 26. `run_inference_watchdog` — abandon `join_handle` fără cleanup pe error path

`src-tauri/src/commands/chat.rs:196-198`:

```rust
// Drop the watchdog join handle so the task can complete and free
// its emit buffers. We don't `await` it — chat_stream returns
// immediately and the watchdog will see stop == true within one
// heartbeat (≤750 ms) and exit.
drop(watchdog_handle);
```

OK pe happy path. Dar pe error path (linia 175-183) — se face `return Err(...)` fără `stop.store(true)` explicit. `StopSlot::drop` (linia 27) apelează `registry.end` care nu setează stop. Watchdog-ul rulează încă un ciclu până la 750ms, dar în timpul asta observă flag-ul `stop` deja setat de tripping. OK în practice, dar comportament subtil.

---

### 27. `AgentConfig.model_id` neverificat înaintea folosirii

`src-tauri/src/agents.rs:92-127` — preset-urile toate au `model_id: String::new()`. Nici o validare în `save` că `model_id` referează un model existent. Un `run` va crăpa/loop când modelul nu se poate încărca — mesaj de eroare crypic în loc de „selectează model întâi”.

---

### 28. `is_under` în `crates/feral-core/src/rsi/paths.rs` — path.strip_prefix(parent) poate să nu funcționeze cum se așteaptă

`crates/feral-core/src/rsi/paths.rs:64-68`:

```rust
let file_name = path
    .strip_prefix(parent)
    .unwrap_or(path)              // <-- fallback: TOATA calea, nu doar tail-ul
    .as_os_str()
    .to_owned();
return Ok(canon_parent.join(file_name).starts_with(&base_canon));
```

`path.strip_prefix(parent)` reușește doar dacă `parent` e prefix strict. Comentariul spune că e OK pentru că safe_join a curățat de `..`, dar dacă vreodată `is_under` e apelat direct (non-safe_join callers), un edge case poate rezulta în `canon_parent.join(entire_path)` = ceva rulându-se pe disc arbitrar. E defensiv dar merită asertat.

---

## SEVERITATE JOASĂ — warnings, dead code, comportamente ciudate

### 29. Warning-uri de compilare Rust vechi

`src-tauri/cargo-errors.log`:
- `unused import: std::os::windows::process::CommandExt` — `src-tauri/src/feral_agent.rs:104` (dar acest fișier nu există în cod curent — poate log stale; verific: `crates/feral-core/src/feral_agent.rs` e cel real)
- `unused variable: settings` — `crates/feral-core/src/byok.rs:192` (fn `load`)
- `dead_code: chat_endpoint`, `is_openai_compatible` metode — `byok.rs:64, 69`
- `dead_code: TestProviderRequest`, `ToolCall`

Trivial dar sugerează că build-ul curent are warnings unresolved.

---

### 30. `code_execute` ignoră stdout binar → decodare lossy

`crates/feral-core/src/tools.rs:434-437`:

```rust
let mut s = String::from_utf8_lossy(&out.stdout).into_owned();
if !out.stderr.is_empty() {
    s.push_str("\n[stderr]\n");
    s.push_str(&String::from_utf8_lossy(&out.stderr));
}
```

Un script Python care emite bytes non-UTF-8 (imagine base64 raw, output binar) pierde datele silențios via `U+FFFD`. Nu-i o eroare fatală dar merită documentat.

---

### 31. `CronScheduler.stop()` nu așteaptă tick-ul curent

`FeralAgent/src/cron/scheduler.ts:126-133`:

```ts
stop(): void {
    this.#running = false;
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
}
```

`clearTimeout` doar oprește viitorul tick. Dacă `tick()` e în mijlocul unui `runOne` (poate dura minute), `stop()` returnează imediat iar jobul rămâne în execuție. Callerul (`boot.ts:2065`) trece direct la `db.close()` — dacă jobul face un `db.query` chiar atunci, îl prinde pe fereastra unde DB e închis → crash sau eroare log.

**Fix:** `stop(): Promise<void>` care așteaptă `inflight = false`.

---

### 32. Multiple `unwrap_or_default()` care ascund erori de deserializare

`crates/feral-core/src/byok.rs:970-975`:

```rust
match std::fs::read(&path) {
    Ok(bytes) => serde_json::from_slice::<ByokSettings>(&bytes).unwrap_or_default(),
    Err(_) => ByokSettings::default(),
}
```

Dacă `byok.json` e corupt (JSON invalid), `unwrap_or_default()` ștampilează implicit toate setările utilizatorului la default. Utilizatorul pierde toate providerele configurate fără nicio notificare. Aceleași pattern în `mcp.rs:57-62`, `settings.rs`, `connectors.rs`.

**Fix:** loghează eroarea de deserializare EXPLICIT (`tracing::error!`), poate cu rename fișier corupt (`byok.json.corrupt-<ts>`) și pornește cu default.

---

### 33. `parseDoneWhenFromMessage` — regex `matchAll` cu flag `g` nu face nimic dacă textul nu are `done_when:` — dar coerce `.at(-1)` poate să dispară pe input non-string

`FeralAgent/src/cron/done-when.ts:222`:

```ts
const matches = [...text.matchAll(/^\s*done_when:\s*(.+)$/gim)];
const raw = matches.at(-1)?.[1]?.trim();
```

OK. Dar dacă `text` conține blocuri de cod cu `done_when:` în ele (utilizatorul scrie un exemplu în chat), regex-ul le prinde și le folosește. Fără parsing markdown-aware.

---

### 34. `panic!` inside `unwrap_or_else` (test) în `crates/feral-core/src/rsi/tier0.rs:543`

Nu-i production, dar arată o cultură de „skimp on error message clarity”.

---

## Alte lucruri interesante găsite

### Comentarii care admit bug-uri

- `FeralAgent/src/rsi/l2-adapt/personal-fitness.ts:47-51`: trei semnale RSI marcate TODO wire — funcționalitate promisă în interfață dar neimplementată. Ratingul modelului e pe baza a 1-2 semnale, nu 4.
- `crates/feral-core/src/inference.rs:872`: `TODO(inference): currently dead — no caller reads max_contexts()`
- `src-tauri/src/lib.rs:432`: specta bindings export dezactivat cu TODO — regenerarea manuală a bindings-urilor înseamnă drift silențios TS ↔ Rust
- `src-tauri/src/commands/mod.rs:40-52`: recunoașterea explicită că CI nu rulează testele Tauri (bug meta #4)

### Fișiere fără atomic write dar ar merita
- `src-tauri/src/mcp.rs`
- `src-tauri/src/connectors.rs` (via `feral-core`)
- `src-tauri/src/projects.rs`
- `src-tauri/src/conversations.rs`
- `src-tauri/src/agents.rs`
- `src-tauri/src/commands/system.rs:86`
- `crates/feral-core/src/byok.rs:980` (write_metadata)

---

## Recomandări prioritizate

1. **Închide gap-urile de secret-on-disk** (§1, §12) — un fix comun pentru toate cu un helper `write_secret_atomic(path, bytes)`.
2. **Repară TOCTOU-urile de download** (§8) — un dry-run + `entry().or_insert_with` fix.
3. **Adaugă timeouts în TUI Go** (§9) — un helper `newAPIClient()` cu timeout default.
4. **Rulează test-suite-ul `src-tauri` în CI** (§4) — cauza rădăcină.
5. **Migrează scheme de tip lock+atomic pentru toate fișierele JSON de state** (§2) — refactor helper.
6. **Repară listener leaks în React** (§19) — pattern la nivel de codebase.
7. **UTF-8 incremental decode pe streams** (§7, §11).
8. **Redirect policy explicit în toate fetchurile care validează URL-uri** (§16).

---

## Nu am putut verifica

- Comportamentul runtime (nu am `cargo`/`bun`/`go` în sandbox — doar `node`).
- Bug-uri de arhitectură specifice OS-ului (Windows COM handling, macOS entitlements).
- Concurrency real între sidecar TS și host Rust — logica arată în general corectă cu lock-uri, dar behavior sub load rămâne netestat aici.
- Content-ul actual al `Cargo.lock` dependencies pentru CVE-uri cunoscute (fără `cargo audit`).

Un al doilea pas natural ar fi: `cargo audit`, `bun audit`, `govulncheck`, apoi rulare test-suites (`cargo test -p feral --lib`, `bun test` în `FeralAgent`, `go test ./...` în `tui`).
