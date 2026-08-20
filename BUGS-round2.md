# Sesiune de debugging — runda 2

**Autor:** Arena Agent Mode
**Data:** 2026-08-20
**Metoda:** aceeași — analiză statică cu ochii pe fișier. De data asta am ținut minte lecția §4 din runda 1 (nu mai număr cu `grep|wc`; scot manual identificatorii). Fiecare finding are `file:linie` și snippet direct din sursă.

**Nu duplic** cu BUGS.md prima rundă. Fiecare bug de aici e o zonă pe care n-am acoperit-o inițial sau o descoperire nouă.

**Sortare pe severitate + impact real** (nu doar tehnic).

---

## SEVERITATE ÎNALTĂ — impact vizibil, exploatabil sau data-loss serios

### 35. `write_file` și `edit_file` din agent NU sunt atomice — un crash mid-write distruge fișierul user-ului

**Fișiere:**
- `FeralAgent/src/tools/builtin/write-file.ts:112` — `await writeFile(safePath, content, "utf8")`
- `FeralAgent/src/tools/builtin/edit-file.ts:188` — `await writeFile(safePath, updated, "utf8")`
- `FeralAgent/src/tools/builtin/notebook.ts:120` — `writeFileSync(file(sessionId), JSON.stringify(book.snapshot()), "utf8")`

Toate scriu direct la `safePath`. Un SIGKILL/OOM/panic mid-write lasă fișierul truncat. Pentru `edit_file` asta e cel mai rău: agent-ul citește 800 linii de cod, aplică o modificare, dar procesul moare la byte 400 din writeFile → user pierde 400 linii de cod dintre care jumătate erau ale lui, nu ale agent-ului.

Fix (identic peste toate): `writeFile(safePath + ".tmp", content)` → `rename(tmp, safePath)`. Pe POSIX rename-ul e atomic; pe Windows API-ul e `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`.

Combină cu §2 din runda 1 (același design need într-un helper `atomicWriteFile`).

**Impact zi 1:** rar dar catastrofal — un timeout OS pe procesul sidecar în mijlocul edit-ului distruge munca user-ului. Comentariul din write-file.ts recunoaște că "un unread overwrite destroys everything it did not know was there"; același lucru se aplică unui write atomic care nu-i atomic.

---

### 36. `unsafe { std::env::set_var(...) }` pe zeci de locuri — UB real în tokio multi-threaded

**Fișiere principale:**
- `crates/feral-core/src/api.rs:2266-2270, 2354-2358` (LoRA/model swap în request handlers async)
- `crates/feral-core/src/boot.rs:165, 251, 256, 261-267` (boot config toggles)
- `crates/feral-core/src/feral_agent.rs:342`
- `src-tauri/src/commands/settings.rs:40, 45, 65-67, 92-94, 111, 113` (fiecare toggle din UI)
- `crates/feral-core/src/setup.rs:583-590`

Total: **42 apeluri `set_var` / `remove_var`** în producție.

`std::env::set_var` interacționează UB cu `std::env::var` concurrent (POSIX `setenv` NU e reentrant sub `getenv`). În Rust 1.83+ e marcat `unsafe` din exact motivul asta. Codul folosește `unsafe { set_var(...) }` cu comentariu "we are single-threaded inside the router task at this point" — dar tokio multi-worker RUNTIME rulează alt task în acelaşi timp, care poate face `std::env::var("PATH")` (întâmplător, prin orice crate care citește env), și pică pe race.

Rezultatul: memory scribble non-determinist. Cazul cel mai probabil: segfault la citire concurentă `std::env::var` cu string pointer devenit invalid.

**Fix:** un singur `Arc<RwLock<HashMap<String, String>>>` în `RuntimeState` care e sursa de adevăr; env-ul procesului se setează UN SINGUR PLAY la boot, iar mutațiile runtime scriu doar în map. Sidecar-ul re-citește env-ul la restart (deja face asta prin supervisor).

**Impact zi 1:** rar, dar când se întâmplă e crash inexplicabil al gateway-ului. Comentariul de la 2265-2266 zice explicit "SAFETY: we are single-threaded" — care e fals în tokio multi-worker.

---

### 37. `resolve_sidecar_api_key` face `contains("127.0.0.1")` — leak local token la remote endpoint

`crates/feral-core/src/feral_agent.rs:287-296`:

```rust
if base_url.contains("127.0.0.1") || base_url.contains("localhost") {
    Ok(local_token.to_string())
} else {
    ...
}
```

Un `FERAL_BASE_URL=http://127.0.0.1.evil.com/v1` sau `http://evil.com/?probe=127.0.0.1` sau chiar `http://localhost.attacker.com/` matches → local API bearer token trimis la endpoint remote.

Fix: parsează URL corect și verifică `parsed.host_str()` exact `== "127.0.0.1"` sau `== "localhost"` sau `== "::1"`.

Testul de la 1276 acoperă doar cazuri canonice — nu testează cazurile substring-based bypass. Adăugat în test:
```rust
assert!(resolve_sidecar_api_key("http://127.0.0.1.evil.com", "secret", None).is_err());
```

**Impact:** un utilizator care copiază greşit un URL de la un tutorial (subtle typo cu punct extra) își trimite bearer token-ul la un domeniu random. `FERAL_API_KEY` gate normal ar prinde asta, dar aici sare peste.

---

### 38. `read_file_as_text` este "read-any-text-file" primitive pentru webview — deny doar `~/.feral`, nu `~/.ssh`, `~/.aws`, `~/.config/gh`

`src-tauri/src/commands/files.rs:24-33`:

```rust
pub(crate) async fn read_file_as_text(path: String) -> Result<String, String> {
    let canonical = std::fs::canonicalize(&path)...;
    deny_feral_private(&canonical)?;
    let meta = std::fs::metadata(&canonical)...;
    if meta.len() > 10 * 1024 * 1024 { return Err("File too large (max 10 MB)".into()); }
    std::fs::read_to_string(&canonical).map_err(...)
}
```

`deny_feral_private` blochează doar `~/.feral`. Nimic nu blochează:
- `~/.ssh/id_rsa`, `~/.ssh/id_ed25519` (chei private)
- `~/.aws/credentials`
- `~/.gitconfig`, `~/.git-credentials`
- `~/.netrc`
- `~/.config/gh/hosts.yml`
- `~/Library/Application Support/Slack/...`

`read_file_as_data_url` (linia 50) are un extension allowlist strict pentru imagini care închide bug-ul. `read_file_as_text` nu are — nu are nicio extension check, nu are content-type sniff.

Un webview XSS (via markdown rendering compromis, iframe injection etc.) → `invoke("read_file_as_text", { path: "~/.ssh/id_rsa" })` → cheile SSH ale user-ului aterizează în chat, care poate fi mai apoi „citit" de agent și posted la cloud.

Fix minim:
```rust
fn deny_sensitive(canonical: &Path) -> Result<(), String> {
    let home = dirs::home_dir().unwrap_or_default();
    for sub in [".ssh", ".aws", ".gnupg", ".config/gh", ".git-credentials", ".netrc"] {
        if canonical.starts_with(home.join(sub)) {
            return Err("Access denied: sensitive credential path".into());
        }
    }
    Ok(())
}
```
Plus deny_feral_private, plus poate un extension allowlist pentru "text files chat-worthy" (.md, .txt, .json, .log, source code).

**Impact:** major dacă vreodată webview-ul are XSS. Chat markdown renderer folosește `react-markdown` + `rehype-highlight` — pattern-uri cu risc mediu.

---

### 39. `transcribe_audio_cloud(audio_path)` — Groq exfiltration primitive

`src-tauri/src/commands/voice.rs:154`:

```rust
pub(crate) async fn transcribe_audio_cloud(audio_path: String, provider: String) -> Result<String, String> {
    let key = byok::byok_get(&provider).ok_or("stt-no-key")?;
    let endpoint = match provider.as_str() { "groq" => "..." };
    let bytes = std::fs::read(&audio_path).map_err(|_| "stt-cloud-failed".to_string())?;
    // ... POST bytes multipart to groq.com ...
}
```

`audio_path` vine din frontend, `std::fs::read` la orice cale. Un attacker XSS/prompt-injection care ajunge la webview poate cere transcrierea `~/.ssh/id_rsa` → cheile private ajung la Groq API endpoints ca "audio bytes". Groq nu o să le transcribe, dar log-ul de request și billing-ul le văd, și un attacker cu cont Groq compromis vede body-ul request-ului.

Fix: `require_under(&paths::voice_dir(), audio_path)` similar cu §3 din runda 1.

**Impact:** exfiltration primitive prin XSS. La fel de rău ca §38.

---

### 40. `extract_file_text` — Zip bomb / Zip Slip DoS

`src-tauri/src/commands/files.rs:141-165` (`extract_zip_xml_text`):

```rust
let mut entry = archive.by_name(name).map_err(...)?;
let mut xml = String::new();
entry.read_to_string(&mut xml).map_err(...)?;
```

Guard-ul de sus limitează fișierul de intrare la 25 MB. Un .docx de 25 MB poate conține o singură entrare comprimată care se decomprimă la câțiva GB (ratio 10000:1 e trivial cu zlib pe conținut repetitiv). `entry.read_to_string(&mut xml)` alocă buffer nemărginit → OOM sidecar.

Verific și `entry.by_name(name)` — nu-i Zip Slip clasic (nu extract to disk), dar `name` e folosit ca lookup. Fine.

Fix: check `entry.size()` înainte de citire, sau `entry.take(cap).read_to_string(...)`. Cap logic ar fi ~200 KB (deja e MAX_CHARS 200k). Fizic: 50MB hard cap.

**Impact:** un attacker trimite un .docx în chat via drag&drop → sidecar OOMs → app crash. Zi 1.

---

### 41. Zeci de HTTP endpoints în agent-ul TS trag body-ul complet înainte de size check → OOM prin server compromis

**Fișiere:**
- `FeralAgent/src/tools/builtin/http-request.ts:110-113` (MAX_RESPONSE_BYTES = 256KB, dar `raw = await res.text()` FIRST)
- `FeralAgent/src/tools/builtin/fetch-url.ts:57-59` (MAX 32KB, same pattern)
- `FeralAgent/src/tools/builtin/read-webpage.ts:69-72` (MAX 400_000, same)
- `FeralAgent/src/egress/egress-proxy.ts:442-443` (`text: () => res.text(), json: () => res.json()` — expunse tool-urilor fără cap)
- `FeralAgent/src/egress/inference-providers.ts:1342, 1376` (postJson error handling)

Pattern peste tot:
```ts
const text = await res.text();  // ← unbounded, downloads everything
const truncated = text.length > MAX_CHARS;
const body = truncated ? text.slice(0, MAX_CHARS) : text;
```

Un endpoint compromis returnând stream de 10GB → sidecar OOM. `Content-Length` header e ignorat.

Fix corect: streaming read cu abort:
```ts
const reader = res.body?.getReader();
const chunks: Uint8Array[] = [];
let total = 0;
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  total += value.length;
  if (total > MAX) { await reader.cancel(); break; }
  chunks.push(value);
}
```

Sau minimal: check `res.headers.get("content-length")` up-front și refuz dacă > cap.

**Impact:** DoS. Un search result care returnează un URL malițios → deep_research face fetch → OOM. Rar în practică (cloudflare-uri etc. limitează), dar posibil cu server auto-hosted.

---

### 42. Single-instance guard din gateway are race între `drop(probe)` și `boot::start` bind

`crates/feral-cli/src/main.rs:338-347`:

```rust
match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
    Ok(probe) => drop(probe), // free it for the real server below
    Err(_) => { eprintln!("feral: port {port} is busy"); return 1; }
}
// ... câteva linii ...
feral_core::boot::start(runtime.clone(), events, None, Vec::new()).await;
```

Între `drop(probe)` și `boot::start` (care conține `api::serve` → `TcpListener::bind` din nou), OS-ul poate reasigna portul altui proces care aterizează în interval. `boot::start` fail-uiește cu error confuz ("Address in use") deşi guard-ul a spus ok.

Fix: transferă listener-ul direct: `feral_core::boot::start_with_listener(probe, ...)`.

**Impact:** foarte rar (fereastra e ~ms), dar cu concurrent gateway startups (systemd race) sau alt daemon din LAN care scanează porturi, poate lovi.

---

### 43. `filename` la download_model nu-i validat pentru path traversal

`src-tauri/src/commands/models.rs:38` (`download_model`) și `crates/feral-core/src/models.rs:156` (`download_hf_model_to`):

```rust
pub async fn download_hf_model_to(repo_id: String, filename: String, dest_dir: PathBuf, ...) {
    let dest = dest_dir.join(&filename);
    let tmp = dest.with_file_name(format!("{filename}.part"));
```

`filename` vine din frontend/user, fără validare. `dest_dir.join("../../etc/malicious.txt")` = scrie unde nu ar trebui. Chiar dacă HuggingFace refuză URL-ul cu `..`, un `filename` cu `/` sau `\\` funcționează local:

`filename = "safe/../../.ssh/authorized_keys"` → `dest = ~/.feral/models/safe/../../.ssh/authorized_keys` → după normalization = `~/.ssh/authorized_keys`.

Fix: `if filename.contains(['/', '\\\\', '\\0']) || filename.starts_with('.') || filename.contains("..") { return Err }`.

**Impact:** attacker cu control asupra frontend/webview poate scrie fișiere aleatoare unde procesul are permisiuni. Combină cu §38.

---

### 44. `short_id_for_filename` — coliziuni silențioase de snapshot pe genomes non-hex

`crates/feral-core/src/rsi/repo.rs:475-478`:

```rust
fn short_id_for_filename(id: &str) -> String {
    let hex: String = id.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    hex.chars().take(8).collect()
}
```

Un `genome_id` fără caractere hex (rare, dar posibil cu naming scheme custom) → returnează string gol → snapshot path = `genomes/.json` → toate genome-urile non-hex se suprapun pe același fișier. Ultimul commit câștigă, precedentele sunt overwritten fără eroare.

Testul de la linia 710 chiar verifică că "zzz!!!" → "" — dar nu semnalează bug-ul.

Fix: fallback la hash sau la ID escaped: `hash_hex(id)[..8].to_string()` sau `id.chars().map(|c| if c.is_ascii_hexdigit() { c } else { '_' }).take(16).collect()`.

**Impact:** medium — doar dacă genome_id-uri non-hex ajung vreodată. UUIDs sunt hex-heavy, dar orice migration schemă future poate lovi.

---

### 45. `API_AUTOLOAD_IN_FLIGHT` — flag rămâne setat forever la panic în task blocking

`crates/feral-core/src/api.rs:548-579`:

```rust
if !API_AUTOLOAD_IN_FLIGHT.swap(true, Ordering::SeqCst) {
    // ...
    let loaded = tokio::task::spawn_blocking(move || { ... /* poate panic */ })
        .await
        .unwrap_or(false);
    API_AUTOLOAD_IN_FLIGHT.store(false, Ordering::SeqCst);
```

Dacă `spawn_blocking` closure face panic, `spawn_blocking` returnează `Err(JoinError::Panic)` → `unwrap_or(false)` → dar STORE-ul rămâne executat? Da, se ajunge la linia 580. **OK, false alarm** — flag-ul e resetat.

Dar dacă handler-ul async e cancelled (client disconnect + drop future) ÎNAINTE de `.await`, `spawn_blocking` task-ul continuă în background, iar flag-ul rămâne `true` până când JoinHandle e drop-uit... `spawn_blocking` NU-şi respect cancellation, deci load-ul continuă. Chiar dacă handler-ul e drop-uit, task-ul continuă și eventual seteaza flag-ul back la false când handler-ul urmează (via future drop). Actually nu — dacă `.await` nu ajunge la linia store, flag rămâne SET.

Fix: `scopeguard::defer! { API_AUTOLOAD_IN_FLIGHT.store(false, ...) }` la începutul branch-ului, sau `on_drop` guard.

**Impact:** rar, dar consecință severă — până la restart gateway, orice `/api/chat` pică prin path-ul de wait 120s → timeout → 503. API-ul e efectiv down permanent după prima cancelled request.

---

## SEVERITATE MEDIE — buguri de logică, race-uri subtile, correctness

### 46. CORS origin check e substring-based (`starts_with`) — potențial bypass

`crates/feral-core/src/api.rs:57-63`:

```rust
.allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _| {
    origin.as_bytes().starts_with(b"http://localhost")
        || origin.as_bytes().starts_with(b"http://127.0.0.1")
}))
```

Origin `http://localhost.attacker.com` → `starts_with("http://localhost")` = TRUE → CORS pass.

Bearer token gate rămâne, deci nu-i imediat exploatabil. Dar pattern-ul e slab: aceleaşi vulnerabilităţi ca la §13 (allowlist substring).

Fix: `starts_with("http://localhost:") || starts_with("http://localhost/") || == "http://localhost"` (similar pentru 127.0.0.1).

**Impact:** low singur, higher combined cu §37 sau viitor bug care leak token.

---

### 47. `constant_time_eq` leak-uiește lungimea token-ului

`crates/feral-core/src/api.rs:265-274`:

```rust
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() { return false; }  // ← timing leak
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) { diff |= x ^ y; }
    diff == 0
}
```

Return early la length mismatch → attacker deduce lungimea token-ului real. Cu token generat de UUID×2 (64 chars hex) e fixed length, deci leak-ul nu ajută mult, dar principiul e greșit.

Fix: comparație până la max(a.len(), b.len()), sau `subtle::ConstantTimeEq` din crate `subtle`.

**Impact:** low, defense in depth.

---

### 48. `build_and_persist_api_token` — TOCTOU pe permissions

`crates/feral-core/src/boot.rs:136-142`:

```rust
if let Err(e) = std::fs::write(&token_path, token.as_bytes()) {  // ← default 0644 create
    ...
} else {
    #[cfg(unix)]
    {
        let _ = std::fs::set_permissions(&token_path, ...from_mode(0o600));  // ← after write
    }
}
```

Fereastră între `fs::write` (creează cu umask default → tipic 0644) și `set_permissions(0o600)` unde un alt process local poate `open()` file-ul și obține fd. Chiar dacă permissions se schimbă mai târziu, fd-ul rămâne valid.

Fix: `OpenOptions::new().mode(0o600).create_new(true).write(true).open(&token_path)`, apoi `write_all`.

**Impact:** low pe most systems (fereastră ~µs), dar pe multi-user Linux cu proces auxiliar care face inotify pe `~/.feral/` este exploatabil.

---

### 49. `save_settings` non-atomic — un crash mid-write pierde toate setările user-ului

`crates/feral-core/src/settings.rs:109-113`:

```rust
pub fn save(s: &Settings) -> anyhow::Result<()> {
    paths::ensure_dirs()?;
    let path = paths::settings_path();
    std::fs::write(path, serde_json::to_vec_pretty(s)?)?;
    Ok(())
}
```

Non-atomic. Crash mid-write → `settings.json` corupt. Următorul `settings::load()` la linia 89-102 emite `WARNING: could not be parsed` şi returnează `Settings::default()` — **toate customizările user-ului dispar**: api_port, active_route, desktop_control settings, RSI budget.

Cel mai rău: pe boot-ul următor `active_route` = None → cade back pe local model → connectors care merg pe cloud provider stau silent offline.

Fix: tmp + rename atomic. Combină cu §1/§2 în helper `atomic_save`.

**Impact:** medium — un crash rar, dar consecinţele sunt user-visible imediat (setările dispărute).

---

### 50. `cron/jobs.ts::upsert` copiază `nextRunMs` din existing chiar și când schedule-ul se schimbă

Deja identificat ca §17 în runda 1, dar cu o nuanță în plus: dacă schedule-ul se schimbă de la `every 5m` → `at 2026-01-01T00:00:00Z` (o dată în trecut), nextRunMs vechi rămâne. `computeNext` din scheduler.ts nu se cheamă la upsert; e apelat doar în `#runOne` după prima execuție.

Rezultat concret: user re-scriu jobul cu o dată în trecut, jobul se declanșează IMEDIAT pe next tick (pentru că nextRunMs vechi era în trecut), apoi rescheduled la null. Semantic diferit de "one-shot at past date = never run".

**Impact:** medium — cron edit UX confuz.

---

### 51. `to_socket_addrs()` sincron blochează runtime-ul tokio

Deja §21 din runda 1, dar am confirmat locația exactă:

`crates/feral-core/src/tools.rs:513`:

```rust
if let Ok(addrs) = (host_ip, port).to_socket_addrs() {
    for addr in addrs { ... }
}
```

Această funcție e apelată din `assert_public_url` care e chemată din `http_request` — un handler async al unui tool. `to_socket_addrs` blochează thread-ul curent al tokio worker → pe DNS slow (câteva sec), un tokio worker complet e blocat → toate cererile pe acel worker time out.

Fix: `tokio::task::spawn_blocking(move || { ... }).await` sau `tokio::net::lookup_host`.

---

### 52. `EMBED` state — race benign la double-load, dar sub-optim

`crates/feral-core/src/inference.rs:1088-1096`:

```rust
if EMBED.lock().is_none() {
    ...
    load_embedding(&path)?;
}
```

Doi apelanți concurenți văd `is_none() == true` amândoi → amândoi apelează `load_embedding` → llama.cpp mmap același fișier de două ori. Nu-i unsafe (fiecare load rezultă în EmbedState separat, iar al doilea `*EMBED.lock() = Some(...)` doar overwrite-uie primul), dar irosește RAM & timp.

Fix: `let mut guard = EMBED.lock(); if guard.is_none() { *guard = Some(load_embedding(&path)?); }` — check-and-set sub același lock.

**Impact:** low, dar pe boot rapid cu mai multe apeluri concurente `embed_batch`, se pot vedea 2 spikes de load.

---

### 53. `HugginggFace redirect follows` — skills.rs, `models.rs` reqwest fără `redirect::Policy::none()`

Deja §16 din runda 1 pentru `skills.rs`. Aceeași problemă în:
- `crates/feral-core/src/models.rs:171` (`download_hf_model_to` — HF poate redirecta la CDN, care e ok, dar nu re-validează URL-ul intermediar)
- `crates/feral-core/src/gpu_detect.rs` — nu-i cazul, nu face HTTP
- `src-tauri/src/commands/models.rs:326, 356` (`get_model_size_info`, `get_hf_model_size`) — no redirect config

Fix: `redirect::Policy::limited(5)` + validare per-hop (dar reqwest nu expune hook per-hop; trebuie manual follow, exact ce face `tools.rs::http_request`).

---

### 54. `sampler.accept(token)` fără decode → sampler state divergentă între calls dacă `tx.blocking_send` eşuează

`crates/feral-core/src/inference.rs:1873`:

```rust
if tx.blocking_send(s).is_err() {
    break; // frontend disconnected / cancelled
}
// ... decode, session_tokens.push, n_cur += 1
```

Token e sample-uit + accepted în sampler (linia 1863-1864), apoi `token_to_piece`, apoi trimis. Dacă send eşuează, break FĂRĂ a decode + fără push în session_tokens. Sampler state (repeat_penalty) reflect-ează token-ul, dar cache-ul nu — inconsistency benignă pentru că sampler-ul se aruncă la sfârșitul generation, dar cached_tokens salvat la linia 1906 nu conține token-ul.

Consecință: next call cu același prompt va computa prefix reuse cu cached_tokens-1 tokens. Sampler-ul nou nu-i afectat (fresh). OK în practică.

Bug e correct-by-design, dar comentariul de la 1877-1878 nu spune că sampler-ul poate ieși cu accept-ed token care nu-i în cache — un cititor viitor poate crede că sampler.accept și session_tokens.push sunt coupled.

---

### 55. `EnsureToken` din Go TUI — nu-i single-writer discipline; token race pe first-run

Deja §14 din runda 1, dar am confirmat sub-shape-ul: `os.WriteFile` cu `O_TRUNC|O_CREATE|O_WRONLY` (fără `O_EXCL`). Doi consumatori concurenți (TUI + gateway pe boot) pot ambii `ReadToken()` → empty → generează token diferit → ambii `WriteFile` → LAST WRITE WINS.

Sidecar-ul citit primul token, TUI-ul al doilea → discrepanță. HTTP requests ale TUI-ului pică cu 401 până când sidecar-ul restart-uiește.

Fix: `os.OpenFile(path, O_CREATE|O_EXCL|O_WRONLY, 0o600)` şi la `EEXIST` `ReadToken()` din nou (loop 2-3 times).

---

### 56. `runtime_shutdown` — `notify_waiters` + `notify_one` back-to-back

`crates/feral-core/src/api.rs:1767-1774`:

```rust
state.runtime.shutdown.notify_waiters();
state.runtime.shutdown.notify_one();
```

Comentariul zice că `notify_one` stochează permit dacă nimeni nu-i parked. Dar `notify_waiters` deja notifică ORICINE parked — dacă cineva e parked, `notify_waiters` îl trezește. Următorul `notify_one` va stoca UN permit extra care va fi consumat de următorul `notified()` (viitor, poate luni de zile mai târziu).

Consecință: primul `runtime.shutdown.notified().await` după startup se rezolvă instant, chiar fără shutdown request nou. Boot loop poate crede că a fost shutdown request → exit imediat.

Verific dacă `notified()` e apelat inainte de shutdown:

`crates/feral-cli/src/main.rs:363`:
```rust
tokio::select! {
    _ = tokio::signal::ctrl_c() => ...,
    _ = runtime.shutdown.notified() => tracing::info!("shutdown request — draining"),
}
```

`.notified()` returnează future care se rezolvă la următorul notify. Dacă notify a fost apelat înainte de `.notified()`, permit-ul e consumat de primul `.notified().await`. Dar shutdown notify e apelat DOAR din runtime_shutdown, care e endpoint HTTP — chemat DUPĂ ce boot::start a instalat router-ul → deci nu-i race.

**Verdict:** OK în practică (endpoint = post-boot only), dar back-to-back notify e redundant.

---

### 57. `deny_feral_private` verifică doar `starts_with(&feral)` — dar `feral.canonicalize()` poate fail-ui silent

`src-tauri/src/commands/files.rs:13-18`:

```rust
fn deny_feral_private(canonical: &Path) -> Result<(), String> {
    if let Ok(feral) = paths::feral_dir().canonicalize() {
        if canonical.starts_with(&feral) { return Err(...); }
    }
    Ok(())
}
```

Dacă `feral_dir().canonicalize()` eşuează (dir nu există încă — first boot), check-ul e sărit. `~/.feral/api-token` ar fi accesibil în first-run.

Fix: `let feral = paths::feral_dir(); std::fs::create_dir_all(&feral).ok(); let feral = feral.canonicalize().unwrap_or(feral);`

**Impact:** low (~/.feral exista mereu after first boot), dar defense in depth.

---

### 58. Rebuild script exec — `run_rebuild_script(repo_root)` cu `repo_root` din env

`crates/feral-core/src/feral_agent.rs:989-1005`:

```rust
let script = Path::new(repo_root).join("scripts").join("rsi-rebuild-sidecar.sh");
let mut cmd = tokio::process::Command::new("bash");
cmd.arg(&script).arg(repo_root);
```

`repo_root` e `std::env::var("FERAL_CODE_RSI_REPO")`. User cu control asupra env pote seta `repo_root = /tmp/attacker/`, plasa un `scripts/rsi-rebuild-sidecar.sh` malițios → rulat cu privilegiile procesului.

Ceva pop-up: dacă attacker controlează env-ul, deja controlează procesul (nu-i priv escalation). Dar dacă attacker doar controlează homedir-ul (rar) sau un config file care e persistat, poate leverage.

**Impact:** low, dar merită validat: `require_under(&paths::feral_dir(), Path::new(&repo_root))`.

---

### 59. Race benign pe `whatsapp-qr.json` — write + unlink concurrent

`FeralAgent/src/transports/connectors.ts:1254, 1262, 1270, 1295`:

Un event `qr` → write, dar în același tick un event `connection === "open"` → unlink. Race: unlink primul → write al doilea → fișier rămas cu QR expirat. Sau invers → fișier șters imediat după write, GUI nu vede QR-ul.

Fix: serializează operațiile pe același fișier printr-un mutex simplu.

**Impact:** low, doar UX cosmetic (QR display).

---

### 60. `find_in_dirs` din self_src poate loop-ui prin symlink în cerc pe depth arbitrar

`crates/feral-core/src/rsi/self_src.rs:45-63`:

```rust
fn probe(dir: &Path, depth: u8) -> Option<PathBuf> {
    if dir.join("FeralAgent").join("package.json").exists() { return Some(...); }
    if depth == 0 { return None; }
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {  // ← follows symlinks
            if let Some(hit) = probe(&p, depth - 1) { return Some(hit); }
        }
    }
    ...
}
```

`p.is_dir()` urmează symlinks. Un symlink `A → B` cu `B → A` bombă (deşi POSIX filesystem în general refuză cicluri direct). Dar `A/subdir → A_parent` e legit și cauzează depth-count consuming rapid.

Depth 3 mitigă. OK.

**Impact:** none în practică.

---

## SEVERITATE JOASĂ — warnings, minor, defensive

### 61. `bufio.Scanner` pe stream SSE — deja §11 rundă 1. Verificat linia 1184-1185.

### 62. Toate `.env::set_var` din tests

`crates/feral-core/tests/*.rs` folosesc `ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())` — corect defensive împotriva poisoned mutex după test panic. Fine.

### 63. `run_gateway` folosește `tokio::runtime::Runtime::new().expect("tokio runtime")` — dacă build failed pe multi-thread runtime setup pică cu unwrap. Non-actionable.

### 64. `#allow(dead_code)` peste tot în `crates/feral-core/src/rsi/paths.rs` — pentru scaffolding neapelat. Warning-uri legit dezactivate.

---

## Comparație cu spot-check-ul tău

Tu ai zis §4 e fals — corect. Numărătoarea mea a fost eroare de grep. Renunț la §4.

Alte cazuri unde am fost prea generic pe runda 1:

- §22 (CGNAT): confirmat real, ok.
- §21 (to_socket_addrs sincron): confirmat, tocmai am adăugat locația exactă la §51.
- §16 (redirect policy la skills.rs): confirmat, plus alte fișiere similare la §53.

---

## Recomandări prioritizate (dincolo de fixurile fizice)

1. **Un helper `atomic_write(path, bytes, mode)`** care rezolvă §1/§2/§12/§35/§49 (toate scrierile non-atomice).
2. **Un `RuntimeEnv` map înlocuind `std::env::set_var`** — §36 rezolvă 42 site-uri de UB potențial.
3. **Un `require_public_path(&Path)` helper** care blochează `~/.ssh`, `~/.aws`, etc. — §38/§39/§43 se rezolvă centralizat.
4. **Un `bounded_body_reader(res, MAX)` pentru fetch în TS** — §41 rezolvă în 6 tool files.
5. **Un test în CI care rulează suita src-tauri** — §4 rundă 1 (deşi eu am greşit numărătoarea, root cause CI e real).

---

## Ce n-am acoperit încă

- `crates/feral-cli/src/admin.rs` (~2100 linii — CLI subcommands mari).
- `crates/feral-core/src/rsi/watchdog.rs` (deja peer-checked, dar 500 linii de logică patch-revert).
- `crates/feral-core/src/rsi/audit.rs` (hash chain — probabil corect, dar merită un pass).
- Restul TUI Go — bubbletea state machine, poate ascunde race-uri.
- `frontend-react/src/pages/*` — n-am scanat aproape deloc.

Dacă vrei încă o rundă pe zonele astea, spune-mi și continui.
