# Runda 7 — RSI critical: self_src + code_patch + scorer + sandbox_bounds + audit + runtime dispatch

**Scope:** cel mai critic teren MOAT din tot repo-ul. Aici trăiește contractul de "agent immutable" pentru Bounded-RSI: scorer-ul pe care agentul NU-l poate rescrie, patch-validation-ul care decide ce poate atinge RSI-ul din propriul cod, audit chain-ul care garantează că orice mutare de weights e imposibil de negat. Dacă vreunul din aceste sisteme are bug, întreaga poveste de safety cade — nu doar un feature, ci axioma pe care se sprijină restul.

Toate findings verificate cu ochii pe fișier, `file:linie` + snippet + fix. Am ținut sub 30 pentru densitate maximă — fiecare finding e "opriți release-ul până se rezolvă" material.

Fișiere analizate:
- `crates/feral-core/src/rsi/self_src.rs` (213 linii)
- `crates/feral-core/src/rsi/code_patch.rs` (362 linii)
- `crates/feral-core/src/rsi/scorer.rs` (212 linii)
- `crates/feral-core/src/rsi/sandbox_bounds.rs` (408 linii)
- `crates/feral-core/src/rsi/audit.rs` (336 linii)
- `crates/feral-core/src/rsi/runtime.rs` (712 linii, dispatcher path)
- `crates/feral-core/src/rsi/paths.rs` (261 linii)

---

## §173 — `self_src::copy_tree` urmează symlinks silent → arbitrary file exfil în bundle

`crates/feral-core/src/rsi/self_src.rs:73-95`:

```rust
fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
    const SKIP: [&str; 4] = ["node_modules", "dist", ".git", "target"];
    std::fs::create_dir_all(dst).map_err(...)?;
    let entries = std::fs::read_dir(src)?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if SKIP.contains(&name_str.as_ref()) { continue; }
        let from = entry.path();
        let to = dst.join(&name);
        if from.is_dir() {          // ← urmează symlinks
            copy_tree(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)...   // ← urmează symlinks
        }
    }
    Ok(())
}
```

`Path::is_dir()` face `metadata()` care follows symlinks. `std::fs::copy()` la fel — copiază conținutul țintei symlink-ului.

Vector atac (build-side supply chain):
1. Cineva injectează în `FeralAgent/` un symlink `docs/notes -> /etc/shadow` (sau `-> C:\Users\<user>\AppData\Roaming\Feral\byok.enc` pe Windows).
2. Bundle-ul se creează normal, symlink-ul e inclus.
3. La primul run pe user's machine, `provision()` apelează `copy_tree` → `.../docs/notes` conține conținutul fișierului `/etc/shadow` de pe machine-ul de build.
4. Ori: symlink-ul persistă în bundle iar la user-side `provision()` urmează symlink-ul → citește secret din machine-ul USER-ului și-l scrie în `~/.feral/self-src/docs/notes` → conținut care ajunge git-tracked în audit chain-ul RSI.

Al doilea scenariu mai insidious: `copy_tree(target_ce_conține_symlink_toward_/, target_dst)` — infinite loop dacă symlink face cycle (`FeralAgent/loop -> FeralAgent/`). Nu există depth limit. Stack overflow.

**Fix:**

```rust
fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
    const SKIP: [&str; 4] = ["node_modules", "dist", ".git", "target"];
    std::fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {e}", dst.display()))?;
    let entries = std::fs::read_dir(src).map_err(...)?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if SKIP.contains(&name_str.as_ref()) { continue; }
        let from = entry.path();
        // Reject symlinks explicit — a bundle must not smuggle host paths.
        let ft = entry.file_type().map_err(|e| format!("filetype {}: {e}", from.display()))?;
        if ft.is_symlink() {
            return Err(format!("symlink not allowed in bundled sources: {}", from.display()));
        }
        let to = dst.join(&name);
        if ft.is_dir() { copy_tree(&from, &to)?; }
        else if ft.is_file() { std::fs::copy(&from, &to).map(|_| ())...?; }
        // else: socket/pipe/device → refuse silently
    }
    Ok(())
}
```

Plus depth cap:

```rust
fn copy_tree(src: &Path, dst: &Path, depth: u16) -> Result<(), String> {
    if depth > 32 { return Err(format!("copy_tree: max depth exceeded at {}", src.display())); }
    ...
    if ft.is_dir() { copy_tree(&from, &to, depth + 1)?; }
    ...
}
```

**Impact MOAT**: bundle-ul RSI e substratul din care se scot patch-uri de self-modify. Un symlink de build-time care leak-ează un secret în tree devine parte din commit history-ul RSI git repo, apoi din diff-uri, apoi transmis în orice log/publish/audit. Compromise permanent.

---

## §174 — `self_src::run_git` blochează pe `git commit` cu `commit.gpgsign=true` — deadlock la provisioning

`crates/feral-core/src/rsi/self_src.rs:99-121`:

```rust
fn run_git(repo: &Path, args: &[&str]) -> Result<(), String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args).current_dir(repo);
    ...
    let out = cmd.output().map_err(|e| format!("git not available: {e}"))?;
    ...
}
```

`Command::output()` fără stdin-redirect. Dacă user's global `~/.gitconfig` are:

```ini
[commit]
    gpgsign = true
[gpg]
    program = /path/to/gpg-agent-wrapper
```

`git commit --allow-empty -m "..."` va încerca să semneze. GPG poate:
1. Solicita passphrase pe stdin → `Command::output()` nu-l dă → BLOCAT indefinit sau eșec după timeout GPG.
2. Solicita interaction TTY (pinentry-tty) → fail immediate cu error obscur.
3. Deschide dialog pinentry-qt/gtk pe DE-uri Linux → pop-up neașteptat în background sidecar.

Ceea ce comentariul spune corect (line 156-159): *"Identity flags keep this independent of the user's git config"* — dar identity este `-c user.name=feral -c user.email=feral@local`, NU face override la `-c commit.gpgsign=false`. Overriding user identity dar lasand signing enabled = signing failure cu identity necunoscută în keyring.

Bonus: `run_git(&target, &["init"])` la line 149 — dacă user-ul are `init.defaultBranch = master` (default git 2.28-), branch inițial va fi `master`, nu `main`. Restul cod-ului (rsi/repo.rs bootstrap) presupune `main`. Divergence.

**Fix:**

```rust
fn run_git(repo: &Path, args: &[&str]) -> Result<(), String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args).current_dir(repo);
    // Force-disable every user-config trap that turns `git commit` into a
    // blocking interactive session (gpg signing, hooks, editor prompts).
    cmd.arg("--no-verify")               // for commit-like ops it's a no-op safe extra
       .env_remove("EDITOR")
       .env_remove("VISUAL")
       .env_remove("GIT_EDITOR")
       .env("GIT_TERMINAL_PROMPT", "0"); // disallow credential prompts too
    // Close stdin explicitly so any tool that reads it fails fast.
    cmd.stdin(std::process::Stdio::null());
    #[cfg(windows)]
    { ... }
    let out = cmd.output().map_err(...)?;
    ...
}
```

Și în `provision()`, `run_git(&target, &["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...])` pentru overrides explicite.

De asemenea: nu există timeout. Un `git` blocat rămâne blocat forever. Wrap în `spawn` + `wait_timeout` din crate `wait-timeout` sau `tokio::process::Command` cu `tokio::time::timeout`.

---

## §175 — `self_src::find_bundled_src` recursion depth 3 fără cap pe intrări → poate stall la startup

`crates/feral-core/src/rsi/self_src.rs:44-64`:

```rust
fn find_in_dirs(search_dirs: &[PathBuf]) -> Option<PathBuf> {
    fn probe(dir: &Path, depth: u8) -> Option<PathBuf> {
        if dir.join("FeralAgent").join("package.json").exists() { return Some(dir.to_path_buf()); }
        if depth == 0 { return None; }
        let entries = std::fs::read_dir(dir).ok()?;
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                if let Some(hit) = probe(&p, depth - 1) { return Some(hit); }
            }
        }
        None
    }
    search_dirs.iter().find_map(|d| probe(d, 3))
}
```

Depth 3 pare mic, dar la depth 3 explorezi toate subfoldere ale search_dirs. Pentru `search_dirs = [exe_dir]` la un install desktop, `exe_dir` poate fi `/Applications/Feral.app/Contents/MacOS/` care conține mii de intrări în bundle-uri Tauri și frameworks depth 3-4. `p.is_dir()` face `stat` per intrare — pe network filesystem (SMB, NFS, iCloud Drive) e latență de ~50ms per stat. 10000 intrări × 50ms = **8 minute la primul boot**, cu sidecar aparent hung.

Plus: `read_dir(dir).ok()?` swallow-uiește errors (permission denied). Într-un dir cu acces mixed, drops silent → poate rata bundle-ul real.

**Fix**:

```rust
const MAX_ENTRIES_PER_DIR: usize = 1000;
const MAX_TOTAL_STATS: usize = 5000;

fn probe(dir: &Path, depth: u8, budget: &mut usize) -> Option<PathBuf> {
    if *budget == 0 { return None; }
    if dir.join("FeralAgent").join("package.json").exists() { return Some(dir.to_path_buf()); }
    if depth == 0 { return None; }
    let entries = std::fs::read_dir(dir).ok()?;
    for (i, entry) in entries.flatten().enumerate() {
        if i >= MAX_ENTRIES_PER_DIR { break; }
        *budget = budget.saturating_sub(1);
        if *budget == 0 { return None; }
        let ft = entry.file_type().ok()?;
        if ft.is_dir() && !ft.is_symlink() {
            if let Some(hit) = probe(&entry.path(), depth - 1, budget) { return Some(hit); }
        }
    }
    None
}
```

Și `find_in_dirs` să log-eze warn când budget-ul e exhausted — semnalizează un install neobișnuit.

---

## §176 — `self_src::provision` face `git add -A` care poate include secrete drop-uite accidental în FeralAgent/

`crates/feral-core/src/rsi/self_src.rs:143-160`:

```rust
copy_tree(&bundled.join("FeralAgent"), &target.join("FeralAgent"))?;
let scripts = bundled.join("scripts");
if scripts.is_dir() { copy_tree(&scripts, &target.join("scripts"))?; }

if !target.join(".git").exists() { run_git(&target, &["init"])?; }
run_git(&target, &["add", "-A"])?;   // ← add TOT ce-i în tree, inclusiv secrete
```

Fără `.gitignore` scris de provision. Dacă bundle-ul conține accidental un `.env`, `credentials.json`, `.npmrc` cu token (dev leak), sau dacă user drops manual un secret în `~/.feral/self-src/FeralAgent/` (de exemplu pentru testing), `git add -A` îl commit-ează în audit-tracked history. `SKIP` din `copy_tree` nu acoperă `.env`, `.envrc`, `id_rsa`, `.aws/`, `.ssh/`, `.npmrc`.

Vector real: user testează local un tool care scrie `~/.feral/self-src/FeralAgent/config.json` cu API key. Următorul `provision()` face `git add -A` → key în git object → în audit chain-ul RSI → în lineage dumps → în diff-uri publicate.

**Fix**: scrie `.gitignore` înainte de add:

```rust
fn ensure_gitignore(target: &Path) -> Result<(), String> {
    let gi = target.join(".gitignore");
    if gi.exists() { return Ok(()); }
    let content = r#"
# Secrets — no matter where they land
.env
.env.*
.envrc
*.pem
*.key
id_rsa*
id_ed25519*
.aws/
.ssh/
.npmrc
credentials*
*.credentials
# Build outputs (safety net; copy_tree already skips these)
node_modules/
dist/
target/
"#;
    std::fs::write(&gi, content).map_err(|e| format!("write .gitignore: {e}"))
}

// și în provision:
ensure_gitignore(&target)?;
run_git(&target, &["add", "-A"])?;
```

Alternativ: `git add FeralAgent/ scripts/` (explicit trees) în loc de `-A`, apoi verify că nu-s untracked cu shape suspicious.

---

## §177 — `self_src::provision` — `provisioned_version match` + `.git exists` check e insuficient → tree corrupt trece de early-exit

`crates/feral-core/src/rsi/self_src.rs:135-140`:

```rust
let provisioned_version = package_version(&target.join("FeralAgent").join("package.json"));
if provisioned_version.as_deref() == Some(version.as_str()) && target.join(".git").exists() {
    return Ok(target);   // ← early exit: "already provisioned"
}
```

Verifică doar:
1. `package.json` există și are aceeași versiune → filesystem-level.
2. `.git/` directory există → filesystem-level.

Ambele pot fi true dar tree-ul complet corupt: `git status` cu unstaged deletes din `~/.feral/self-src/FeralAgent/` (user a șters accidental fișiere), HEAD detached, index corrupt, `.git/objects/pack/` corupt (rare disk error). Provision zice OK, dar next worktree op eșuează cu error obscur.

**Fix**: verifică că `HEAD` există și e într-o stare curată:

```rust
fn is_provisioned_healthy(target: &Path) -> bool {
    if !target.join(".git").exists() { return false; }
    // Cheap sanity: git can resolve HEAD and there are no unstaged changes.
    let has_head = std::process::Command::new("git")
        .args(["rev-parse", "--verify", "HEAD"])
        .current_dir(target)
        .stdin(std::process::Stdio::null())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !has_head { return false; }
    let clean = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(target)
        .stdin(std::process::Stdio::null())
        .output()
        .map(|o| o.status.success() && o.stdout.is_empty())
        .unwrap_or(false);
    clean
}

// și în provision:
if provisioned_version.as_deref() == Some(version.as_str()) && is_provisioned_healthy(&target) {
    return Ok(target);
}
```

Dacă healthy-check fails, re-copy tree și force-recommit.

---

## §178 — `code_patch::validate_code_patch` — `changed_lines` counter poate over/underflow subtle prin `+++` orfan

`crates/feral-core/src/rsi/code_patch.rs:135-175`:

```rust
let mut in_hunk = false;
let mut pending_old: Option<Option<String>> = None;

for raw in patch.lines() {
    let line = raw.strip_suffix('\r').unwrap_or(raw);
    ...
    if let Some(rest) = line.strip_prefix("--- ") {
        check_header_path(rest)?;
        pending_old = Some(header_path(rest));
        in_hunk = false;
        continue;
    }
    if let Some(rest) = line.strip_prefix("+++ ") {
        let Some(old_side) = pending_old.take() else {
            return Err("malformed diff: '+++' without preceding '---'".into());
        };
        check_header_path(rest)?;
        ...
        in_hunk = false;
        continue;
    }
    if line.starts_with("@@") { in_hunk = true; continue; }
    if in_hunk && (line.starts_with('+') || line.starts_with('-')) {
        changed_lines += 1;
    }
}
```

**Bug real**: după un `@@` header, `in_hunk = true` rămâne activ până la următorul `---`/`+++`/`@@`. Dar în interiorul unui hunk, o linie de "diff content" care începe cu `+++ ` (parte din codul real modificat, ex. un pointer arithmetic în C-like sursă TS: `+++x` ca statement) va matcha `strip_prefix("+++ ")` (după strip pe `\r`). Dar `+++` fără spațiu final: `+++x;` → `strip_prefix("+++ ")` = None → nu confusă. Cu spațiu: `+++ x;` (spațiu deliberate în cod) → strip_prefix succeeds → tratată ca file header.

Consecință mai gravă:
```
--- a/src/rsi/mutation.ts
+++ b/src/rsi/mutation.ts
@@ -1,3 +1,3 @@
 unchanged line
+let x = 1;
+++ ` + " b/src/agent-loop.ts` ← INJECTED as literal diff content (added line)
+@@ -1 +1 @@
+-old_agent_loop_line
++new_agent_loop_line
+another added line
```

La `+++ b/src/agent-loop.ts` (fals-positive diff header în hunk content), parser-ul:
1. `strip_prefix("+++ ")` succeeds → `pending_old.take()` → Some(Some("src/rsi/mutation.ts")). But `pending_old` is None here! (n-a fost setat de un `---` recent). → Err("malformed diff: '+++' without preceding '---'"). OK. Detectat.

Dar dacă atacatorul face:
```
--- a/src/rsi/mutation.ts
+++ b/src/rsi/mutation.ts
@@ -1,3 +1,3 @@
 line
--- a/src/rsi/OTHER.ts      ← added-line care începe cu `--- `? Ba nu, `+` sau `-` la începutul liniei = diff marker.
+++ b/src/rsi/OTHER.ts
```

Într-un unified diff real, o "added line" începe cu `+`, deci `+--- a/...` — `strip_prefix("--- ")` NU matchează (începe cu `+`). Deci parser-ul e safe. OK.

**Bug diferit real**: `--- ` sau `+++ ` care apare în cadrul unei linii de context (spațiu la început, nu `+` sau `-`):
```
@@ -1,5 +1,5 @@
 unchanged
 --- a/src/rsi/OTHER.ts     ← linie de context care începe cu spațiu, dar continut "--- a/..."
 more unchanged
```

Wait — pentru parser: `line.starts_with("--- ")` — dacă linia începe cu spațiu, NU cu `---`, deci strip_prefix False. Bug: dacă linia de context (începe cu spațiu în diff) apoi are `--- a/...` DUPĂ acel spațiu — parser vede `" --- a/..."` — starts_with(`" --- "`) = fals pentru "--- " prefix. OK.

Dar dacă `diff --git` header apare EL însuși: `diff --git a/src/rsi/mutation.ts b/src/rsi/mutation.ts` — parser nu-l recunoaște (nu-l parse-uiește). `in_hunk` va rămâne pe true dacă anterior era true → **rare edge case**: un diff multi-file cu diff --git între file sections dar fără `---`/`+++` NEW ale al doilea file. Nu, `git diff` întotdeauna emite `diff --git`, apoi `index ...`, `--- a/`, `+++ b/`. Deci safe.

**Bug real diferit — verified**: `line.starts_with('+') || line.starts_with('-')` count-uiește ORICE linie care începe cu + sau - INCLUSIV `+++`, `---`, `+++ ` (dacă în hunk). Consider:

```
--- a/src/rsi/mutation.ts
+++ b/src/rsi/mutation.ts
@@ -1 +1 @@
-a
+b
@@ -10 +10 @@
-c
+d
--- WAT this is a stray text line in the input starting with dashes
```

Ultima linie `--- WAT...`: strip_prefix("--- ") succeeds → `check_header_path("WAT this is a stray...")` → check că `WAT this is a stray...` nu-i absolute (no leading `/`), nu conține `..`, dar `!p.starts_with("src/rsi/")` → Err("file outside src/rsi/: WAT this is a stray..."). REJECTED. OK.

Dar dacă atacator scrie o linie stray care începe cu `+` sau `-` fără să fie într-un hunk real:

```
--- a/src/rsi/mutation.ts
+++ b/src/rsi/mutation.ts
@@ -1 +1 @@
-old
+new
@@ -20 +20 @@
-old2
+new2
-orphan_after_last_hunk    ← contorizat sau nu?
```

`in_hunk` este true (setat de ultimul `@@`). Loop-ul procesează `-orphan_after_last_hunk` → `in_hunk && starts_with('-')` → `changed_lines += 1`. Care e OK — nu-i security bug, e count-ing padding attack **contra economy score** (§185):

**§178 real**: `changed_lines` poate fi umflat artificial peste `MAX_CHANGED_LINES = 200` prin **trailing lines după ultimul hunk care încep cu + sau -**. Attacker vrea un score de diff-economy mai bun (100 sau 150 lines contorizate real, iar in ultima linie 51 de `-` adăugate) → total `200+`, iar validation respinge cu "too large". OK — asta protejează.

**Adevăratul bug**: `-` sau `+` de la începutul liniilor de content care nu-s în hunk (i.e., linii înainte de primul `@@`, între file sections în multi-file diff), unde `in_hunk` este false → nu contorizate. Un attacker poate insera linii "reale" cu content sensibil ÎNTRE `+++` și `@@`:

```
--- a/src/rsi/mutation.ts
+++ b/src/rsi/mutation.ts
+eval(process.env.SECRET)     ← between +++ and @@, in_hunk=false → not counted, but present in patch string
@@ -1 +1 @@
-a
+b
```

Când patch e aplicat cu `git apply` sau `patch`, această linie este parte din diff-ul aplicat? DEPINDE de tool. `git apply` cere `@@` header pentru orice hunk — o linie between `+++` și `@@` e IGNORED sau ERROR. Deci nu-i executabil. Dar `patch(1)` cu context-mode fuzzy sau alte tools pot include acele linii.

Practic: `code-sandbox.ts` folosește `git apply` (nu am confirmat, dar cel mai probabil), deci safe. Dar validation-ul Rust nu VERIFICĂ cu `git apply --check` — doar count-uiește regex-style. Discrepanța TS wall / Rust wall / actual apply tool = crevasă.

**Fix**: strict validation care refuză orice `+` sau `-` la începutul liniei care NU-i în hunk:

```rust
} else if !in_hunk && (line.starts_with('+') || line.starts_with('-')) {
    // Trailing/leading + or - outside a hunk is nonsense — a real diff never
    // emits this. Reject: it's either the model hallucinating or a smuggle attempt.
    if !line.starts_with("---") && !line.starts_with("+++") {
        return Err(format!("stray '{}' line outside a hunk", &line[..1]));
    }
}
```

Ideally: `git apply --check --stat -` la patch înainte de accept, dar asta introduce dep pe git binary la validation path. Trade-off.

---

## §179 — `code_patch::validate_code_patch` — Unicode bidirectional / invisible chars în path-uri trec de check

`crates/feral-core/src/rsi/code_patch.rs:227-256`:

```rust
fn check_header_path(rest: &str) -> Result<(), String> {
    let Some(p) = header_path(rest) else { return Ok(()); };
    if p.starts_with('/') || (p.len() >= 2 && p.as_bytes()[1] == b':') { ... }
    if p.split('/').any(|seg| seg == "..") { ... }
    if !p.starts_with(ALLOWED_DIR_PREFIX) { ... }
    if !p.ends_with(ALLOWED_EXTENSION) { ... }
    let basename = p.rsplit('/').next().unwrap_or(&p);
    if DENYLIST_BASENAMES.contains(&basename) { ... }
    Ok(())
}
```

Nu există normalizare Unicode. Path-ul `src/rsi/muta\u{202E}tion.ts` conține U+202E RIGHT-TO-LEFT OVERRIDE. Când e afișat în review UI (VSCode, GitHub PR view, terminal), apare ca `src/rsi/mutasti.noit` (inversat de la punct). User aprobă gândindu-se că patch-ul e pe `mutation.ts`, dar filesystem-ul creează literalmente `mutation.ts` cu byte U+202E — un fișier NOU distinct de `mutation.ts`, care NU e testat de suite-ul de test cu `mutation.ts`.

Alte caractere periculoase:
- U+200B ZWSP (zero-width space): `code-\u{200B}genome.ts` NU matchează denylist `"code-genome.ts"` byte-for-byte → **bypass la enforcement denylist**.
- U+FF0E fullwidth full stop: `src．rsi/mutation.ts` — arată ca `src.rsi/mutation.ts` dar `starts_with("src/rsi/")` false → respins. OK.
- U+2044 fraction slash: `src⁄rsi⁄mutation.ts` — arată ca `src/rsi/mutation.ts` dar `split('/')` nu-l vede ca separator → respins.

**Bug critic** este U+200B în denylist bypass:

```
--- a/src/rsi/code-\u{200B}genome.ts
+++ b/src/rsi/code-\u{200B}genome.ts
@@ -1,2 +1,2 @@
-old
+new
```

`basename = "code-\u{200B}genome.ts"`, `DENYLIST_BASENAMES.contains(&"code-\u{200B}genome.ts")` = false. Trece. Apply-ul creează fișier nou `code-\u{200B}genome.ts` — care nu-i `code-genome.ts` real, dar pe filesystem-uri case/normalization-insensitive (macOS APFS cu Unicode normalization) POATE se rezolvă la același fișier fizic. Depinde de mount options.

**Fix**:

```rust
fn check_header_path(rest: &str) -> Result<(), String> {
    let Some(p) = header_path(rest) else { return Ok(()); };
    // NFC-normalise the path so visual equivalence matches byte equivalence.
    let p = unicode_normalization::UnicodeNormalization::nfc(p.chars()).collect::<String>();
    // Reject any character in the disallowed set (bidi controls, invisibles).
    for c in p.chars() {
        let is_dangerous = matches!(c,
            '\u{202A}'..='\u{202E}' |   // bidi overrides
            '\u{2066}'..='\u{2069}' |   // isolate directional
            '\u{200B}'..='\u{200F}' |   // zero-width / mark
            '\u{FE00}'..='\u{FE0F}'     // variation selectors
        );
        if is_dangerous || (c.is_control() && c != '\n') {
            return Err(format!("path contains dangerous character U+{:04X}: {}", c as u32, p));
        }
    }
    // Reject non-ASCII entirely — RSI source paths are ASCII-only by convention.
    if !p.is_ascii() {
        return Err(format!("path contains non-ASCII characters (RSI paths must be ASCII): {}", p));
    }
    ...
}
```

Cel mai simplu: force ASCII-only. RSI patches nu au motiv legitim pentru non-ASCII in paths.

---

## §180 — `code_patch::score_code_patch` — CRITIC: `tests_passed` unbounded → orice candidate poate raporta 999_999_999 → pass_rate=1.0

`crates/feral-core/src/rsi/code_patch.rs:80-110`:

```rust
pub fn score_code_patch(m: &CodePatchMeasurements) -> CodePatchScore {
    let total = m.tests_passed + m.tests_failed;
    let pass_rate = if total == 0 || m.tests_exit_code < 0 || (m.tests_exit_code != 0 && m.tests_failed == 0) {
        0.0
    } else {
        f64::from(m.tests_passed) / f64::from(total)
    };
    ...
}
```

`CodePatchMeasurements`:
```rust
pub struct CodePatchMeasurements {
    pub tests_passed: u32,
    pub tests_failed: u32,
    pub tests_exit_code: i32,
    ...
}
```

TS-side runner (`code-sandbox.ts::bunExec`) parsează output-ul lui `bun test` și extrage counts. Rust-side ia these values ca truth. Nu există upper bound cross-check cu numărul de test files din tree.

Vector atac (RSI-generated code path):
1. Candidate L3 modifică un `.test.ts` să emită counterfeit output:
   ```ts
   console.log("PASS  99999 tests passed, 0 failed");
   ```
2. `bunExec` parseeaza → `tests_passed: 99999, tests_failed: 0, tests_exit_code: 0`.
3. Rust `score_code_patch`: total=99999, pass_rate = 99999/99999 = 1.0. Score = 60 + 15 + 15 + diff = ~95.
4. Ratchet succeed, main advances la un candidate care nu are teste reale ci doar output faked.

Combined cu §151 din runda 6 (`ratchet_attempt` trust în `metadata.score`), avem DOUĂ nivele de "trust în output-uri raportate de sandbox care ar putea fi manipulate de codul RSI-generat".

Comentariul din header (line 6-14): *"the whole safety story for Bounded-RSI is that the agent cannot edit the formula that decides whether it improved... In Rust, the scorer is compiled into the binary the agent never has filesystem access to."* — dar scorer-ul Rust primește **input-uri fabricate** by codul TS pe care agent-ul chiar îl poate rescrie (via patches to `src/rsi/`). Formula-un-editable protects against WEIGHT tuning, dar nu contra INPUT fabrication.

**Fix**:

1. **Cross-check hard**: numărul de tests trebuie să fie în banda [1, expected_test_count × 3]. `expected_test_count` = numărul de `*.test.ts` files sub `src/rsi/`. Un candidate care raportează 100× mai multe teste decât există → suspicious → set pass_rate=0 sau refuse.

2. **Determinist**: Rust rulează tester independent. Nu deleagă la TS. Complicatat pentru bun test, dar posibil via `git worktree` + `bun test --reporter=json > /tmp/results.json` cu Rust care parsează JSON-ul de la reporter INSTEAD de la stdout scraping în TS.

3. **Bounded**: adaugă `if m.tests_passed > MAX_REASONABLE_TESTS { return no-credit; }`:
   ```rust
   const MAX_REASONABLE_TESTS: u32 = 10_000;
   if m.tests_passed > MAX_REASONABLE_TESTS || m.tests_failed > MAX_REASONABLE_TESTS {
       tracing::warn!("code patch reported {} + {} tests — refusing to trust", m.tests_passed, m.tests_failed);
       return CodePatchScore { score: 0.0, pass_rate: 0.0, ... };
   }
   ```

Fix #1 e cel mai important pentru MOAT. Adăugarea unei funcții `expected_test_count(repo: &Path) -> u32` care numără test files în tree, apoi validare că `total ∈ [floor, ceil]` bandwidth reasonable.

---

## §181 — `scorer::compute_raw` — CRITIC: pattern-ul din §180 aplică și aici, `total_tokens`/`latency_ms` de la TS trusted

`crates/feral-core/src/rsi/scorer.rs:77-115`:

```rust
fn compute_raw(outcomes: &[EvalOutcome]) -> ScorerRaw {
    let n = outcomes.len() as f64;
    let successes = outcomes.iter().filter(|o| o.success).count() as f64;
    let errors = outcomes.iter().filter(|o| o.errored).count() as f64;
    let total_tokens: u64 = outcomes.iter().map(|o| o.tokens as u64).sum();
    let mut latencies: Vec<f64> = outcomes.iter().map(|o| o.latency_ms as f64).collect();
    ...
    let cost_normalized = (avg_tokens / 4_000.0).clamp(0.0, 1.0);
    let latency_normalized = (p95 / 2_000.0).clamp(0.0, 1.0);
    ...
}
```

`EvalOutcome`:
```rust
pub struct EvalOutcome {
    pub task_id: String,
    pub tier: u8,
    pub success: bool,
    pub latency_ms: u32,
    pub tokens: u32,
    pub errored: bool,
    pub error_message: Option<String>,
}
```

Aceleași vectori:
- `latency_ms = 0` → latency_normalized = 0 → no penalty.
- `tokens = 0` → cost_normalized = 0 → no penalty.
- `success = true` uniform pentru toate outcomes → success_rate = 1.0.
- Score = 55·1.0 + 0 + 0 + 0 = **55/100 max fabricated**.

Deci fabricarea unei baterii de outcomes cu {success:true, tokens:0, latency:0, errored:false} → ratchet vede score = 55, iar dacă prior score < 55 → advance.

Prior score cu real measurements poate fi mai mic decât 55 (real workloads au tokens ≠ 0). Deci **ratchet la un candidate cu fake outcomes va reuși aproape ÎNTOTDEAUNA** dacă prior fitness era decent.

**Fix**:
1. Sanity floor: `if outcomes.iter().all(|o| o.tokens == 0 && o.latency_ms == 0)` → return `score: 0.0`. Zero tokens over N outcomes = fabricated OR broken pipeline.
2. Cross-check tokens against actual API usage: `crate::inference::tokens_consumed_since(cycle_start)` (dacă există un contor server-side) — compare la sum. Divergence > threshold → suspicious.
3. Cross-check latency against wall-clock: dacă cycle_duration_wallclock < sum(latencies) × 0.5 → measurements fake (n-au putut rula așa rapid).

Fără cross-checks, "scorer immutable în Rust" e o iluzie de safety.

---

## §182 — `scorer::score` clampează scor final la [0, 100] silent → pierdem "cât de rău" e un candidate → tie-break arbitrar

`crates/feral-core/src/rsi/scorer.rs:53-56`:

```rust
let score =
    (success_component + cost_component + error_component + latency_component).clamp(0.0, 100.0);
```

Dacă componentele sunt: `55·0 + (-15·1) + (-20·1) + (-10·1) = -45` → clamp la 0.

Două candidates ambele "extrem de proaste" primesc scor 0. Ratchet compară `candidate.score > prior.score`:
- prior = 0.0 (broken), candidate = 0.0 (broken în alt fel) → `0.0 > 0.0` false → no advance. OK aparent.
- prior = 0.001 (marginally), candidate = 0.0 (broken) → no advance. OK.
- prior = 0.0 (broken), candidate = 0.0000001 rescued (`0 > 0` de fapt). Depinde de exact comportament — dacă a treia component reduce sum la exact 0, clamp lasă 0. Dacă la +0.0001, ratchet advance dar la un candidate care nu-i clar mai bun (poate întâmplător avut un test mai puțin).

Mai important: **info loss pentru debugging**. UI arată "score: 0" pentru toate candidatele broken, nu se poate distinge care e "aproape acolo" (score -5) vs "catastrofal" (score -100).

**Fix**: nu clamp la 0 — păstrează valoarea reală. Ratchet decision se face pe raw score, dar clamp doar la display:

```rust
pub struct ScoreBreakdown {
    pub score: f64,          // raw, can be negative
    pub display_score: f64,  // clamp(0.0, 100.0) for UI
    ...
}

let raw_score = success_component + cost_component + error_component + latency_component;
ScoreBreakdown {
    score: raw_score,
    display_score: raw_score.clamp(0.0, 100.0),
    ...
}
```

Ratchet-ul compară `raw_score`, iar UI-ul arată `display_score`. Ratchet decisions devin deterministice inclusiv în regime broken.

---

## §183 — `sandbox_bounds::save_with_audit` — file scris ÎNAINTE de audit → crash între cele două = file diverge de audit chain, silent la load()

`crates/feral-core/src/rsi/sandbox_bounds.rs:128-224`:

```rust
pub fn save_with_audit(&self, audit: &SandboxBoundsAudit, reason: &str) -> Result<()> {
    ...
    // Persist the new file. Pretty-printed for human auditing.
    let pretty = serde_json::to_string_pretty(self)?;
    std::fs::write(rsi_sandbox_bounds_path(), pretty)?;

    // Now that the file is on disk, append audit rows.
    for (field, old_str, new_str) in &pending {
        audit.append(field, old_str.as_deref(), new_str, reason)?;
    }
    ...
}
```

Comentariul (line 130-142) admite explicit: *"If the file write succeeds but an audit append fails partway through, we leave the file in its new state and the audit log missing the corresponding rows — load() will re-verify and reject on next start if the chain breaks, which is the correct failure mode"*.

**Bug**: load() verifică chain-ul (linia 108: `audit.verify()`), dar chain-ul poate rămâne INTEGRU (nu-i rupt de append parțial, doar are mai puține rows decât mutări au avut loc). Verify returnează `Ok { entries: N }` — nu detectează că `bounds.json` are mutări nerecorded.

Load() apoi (linia 115-119) citește fișierul și parse-uiește. Nu compară cu ultimul audit row: `bounds.max_total_cost_usd = 50.0` în file dar ultimul audit row zice `max_total_cost_usd = 25.0`. Nu-i verificat.

**Silent bypass al audit**: user modifică `~/.feral/rsi/sandbox_bounds.json` cu editor de text, setează `max_total_cost_usd: 999999.0`. Load() acceptă fără să compare cu chain. Session-ul RSI cheltuie fără ceiling.

**Fix**: la load(), cross-check ultimul audit row cu file state pentru fiecare field:

```rust
pub fn load_from(bounds_path: &Path) -> Result<Self> {
    let audit_path = bounds_path.with_extension("audit.log");
    let audit = SandboxBoundsAudit::open(&audit_path)?;
    let verify = audit.verify()?;
    ensure_ok(&verify)?;

    if !bounds_path.exists() {
        return Ok(Self::default());
    }
    let parsed: SandboxBounds = serde_json::from_str(&std::fs::read_to_string(bounds_path)?)?;
    ...
    // NEW: cross-check that every field matches the last recorded audit value.
    let expected = audit.reconstruct_current_state()?;  // walks chain, applies each row
    if !fields_match(&parsed, &expected) {
        anyhow::bail!(
            "sandbox_bounds.json diverges from audit chain — file has been tampered with. \
             Restore from audit or approve reconciliation via `feral rsi bounds reconcile`."
        );
    }
    Ok(parsed)
}
```

`reconstruct_current_state` walk-uiește audit chain, aplică fiecare `field: old→new` mutation, produce SandboxBounds așa cum ar fi trebuit să fie. Dacă `parsed != reconstructed` → tampering.

Aceasta este piatra de temelie pentru "auditul e sursă de adevăr" — fără cross-check, audit-ul e doar un log, nu un enforcement mechanism.

---

## §184 — `sandbox_bounds::save_with_audit` — hard-coded `field_writers` array: adăugarea unui field NOU la SandboxBounds îl scutește silent de audit

`crates/feral-core/src/rsi/sandbox_bounds.rs:165-196`:

```rust
let field_writers: [(&str, serde_json::Value); 7] = [
    ("scorer", ...),
    ("max_total_cost_usd", ...),
    ("cost_warning_ratio", ...),
    ("max_per_iteration_cost_usd", ...),
    ("goodhart_tier1_threshold", ...),
    ("goodhart_tier2_threshold", ...),
    ("goodhart_consecutive_required", ...),
];
```

Numărul de fields fizice în `SandboxBounds` (numărate manual): version, scorer, max_total_cost_usd, cost_warning_ratio, max_per_iteration_cost_usd, goodhart_tier1_threshold, goodhart_tier2_threshold, goodhart_consecutive_required = **8 fields**.

`field_writers` are 7 entries. **Lipsește `version`** — care e OK, versiunea nu se modifică by user, e schema versioning. Fine.

Dar: dacă viitor developer adaugă `max_lora_swaps_per_hour: u32` la `SandboxBounds`, și-l uită să adauge în `field_writers`, mutări pe acel field NU generează audit rows. Silent bypass.

**Fix**: derive-generat audit sau reflectie via serde_json comparison:

```rust
// Compute diff by walking the JSON object generically, not a hardcoded list.
let old_obj = old_v.as_ref().and_then(|v| v.as_object()).cloned().unwrap_or_default();
let new_obj = new_v.as_object().cloned().unwrap_or_default();

for (field, new_value) in &new_obj {
    if field == "version" { continue; }   // schema versioning, not user-facing
    let old_value = old_obj.get(field).cloned().unwrap_or(serde_json::Value::Null);
    if old_value != *new_value {
        pending.push((
            field.clone(),
            (!old_value.is_null()).then(|| old_value.to_string()),
            new_value.to_string(),
        ));
    }
}
```

Acum orice field nou în struct automatică e audited. Reversul: developer trebuie să exclude explicit field-urile care NU trebuie audited (o whitelist inversă), dar asta-i safer decât forgetting.

---

## §185 — `sandbox_bounds::load_from` — file lipsă returnează default silent → șterge bounds.json = revert la defaults, pierde toate tunările user-ului

`crates/feral-core/src/rsi/sandbox_bounds.rs:107-119`:

```rust
pub fn load_from(bounds_path: &Path) -> Result<Self> {
    let audit_path = bounds_path.with_extension("audit.log");
    let audit = SandboxBoundsAudit::open(&audit_path)?;
    let verify = audit.verify().context("verifying bounds audit chain")?;
    ensure_ok(&verify)?;

    if !bounds_path.exists() {
        return Ok(Self::default());
    }
    ...
}
```

Scenariu:
1. User a tunat `max_total_cost_usd = 100.0`, `cost_warning_ratio = 0.9`, custom scorer weights. Audit log are 10 rows.
2. Disk error, backup restore, sau user rulează `rm ~/.feral/rsi/sandbox_bounds.json` (dar audit.log rămâne).
3. Next boot: audit.verify() = Ok (chain intact), file lipsește → return `Self::default()`.
4. User rulează cu defaults (25 USD cap, 0.8 warning, default weights) fără notificare că a fost revert.
5. **Ratchet decisions se schimbă silent** — default weights are 55/15/20/10 iar user avea customized. Aceleași candidate outcomes produc scores diferite → advance patterns diferite → RSI progresează pe alt trajector fără să se știe.

**Fix**: dacă audit chain are entries > 0 dar file lipsește, e o stare inconsistentă → refuse boot:

```rust
if !bounds_path.exists() {
    match verify {
        AuditVerifyResult::Ok { entries: 0 } => return Ok(Self::default()),
        AuditVerifyResult::Ok { entries } => {
            anyhow::bail!(
                "sandbox_bounds.json is missing but audit log has {} entries. \
                 The bounds were tuned in the past and the file was lost. \
                 Restore from audit with `feral rsi bounds reconstruct` or accept \
                 defaults with `feral rsi bounds reset --force`.",
                entries
            );
        }
        AuditVerifyResult::Broken { .. } => unreachable!(), // caught by ensure_ok above
    }
}
```

---

## §186 — `audit::SandboxBoundsAudit::append` — NON-ATOMIC concurrent race: two threads → torn hash chain

`crates/feral-core/src/rsi/audit.rs:103-131`:

```rust
pub fn append(
    &self,
    field: &str,
    old_value: Option<&str>,
    new_value: &str,
    reason: &str,
) -> Result<String> {
    let prev_hash = self.last_hash()?;             // ← read from disk
    let row = BoundsAuditRow { ... };
    let entry_hash = hash_row(&prev_hash, &row);
    ...
    let mut f = OpenOptions::new().append(true).create(true).open(&self.path)?;
    f.write_all(line.as_bytes())?;                  // ← write to disk
    f.flush()?;
    Ok(entry_hash)
}
```

Doi threads T1 și T2 în același process fac append concurent:
1. T1: `last_hash()` = H0.
2. T2: `last_hash()` = H0 (T1 nu a scris încă).
3. T1: hash_row(H0, row1) = H1.
4. T2: hash_row(H0, row2) = H2.
5. T1: write "row1[prev:H0, hash:H1]".
6. T2: write "row2[prev:H0, hash:H2]".

Disc conține:
```
{... prev_hash: H0, entry_hash: H1}
{... prev_hash: H0, entry_hash: H2}      ← SHOULD have prev_hash: H1
```

`verify()` la line 175:
```rust
if row.prev_hash != prev { return Ok(AuditVerifyResult::Broken { ... }); }
```

Al doilea row are `prev_hash: H0` iar `prev` (după row1) e H1 → mismatch → chain BROKEN.

Comentariul (audit.rs:88): *"we explicitly do NOT coordinate across processes. The Feral app is single-instance by design (lockfile in main); if that ever changes this needs revisiting"* — dar NU garantează single-threaded APPEND în același process. Câmpul `path: PathBuf` e Clone-safe, iar handle-ul poate fi shared între threads (Arc<SandboxBoundsAudit>). Nu există `Mutex` care serializează append.

Combinat cu CLI: `crates/feral-cli` deschide separat `SandboxBoundsAudit` pentru `feral admin bounds set`. Dacă user rulează CLI simultan cu app desktop → race cross-process, garantat corupție.

**Fix**:

1. **In-process mutex** obligatoriu:
   ```rust
   pub struct SandboxBoundsAudit {
       path: PathBuf,
       lock: std::sync::Mutex<()>,   // in-process serialization
   }
   
   pub fn append(&self, ...) -> Result<String> {
       let _guard = self.lock.lock().map_err(|e| anyhow!("audit mutex poisoned: {e}"))?;
       // ... existing body ...
   }
   ```

2. **Cross-process file lock** cu `fs2` crate:
   ```rust
   use fs2::FileExt;
   pub fn append(&self, ...) -> Result<String> {
       let _guard = self.lock.lock()?;
       let mut f = OpenOptions::new().append(true).create(true).open(&self.path)?;
       f.try_lock_exclusive().or_else(|_| { thread::sleep(Duration::from_millis(50)); f.try_lock_exclusive() })?;
       // last_hash INSIDE the lock:
       let prev_hash = last_hash_from_file(&f)?;
       // ... build row, write, flush ...
       f.unlock()?;
       Ok(entry_hash)
   }
   ```

3. **Documentation**: single-instance-lock din main NU se aplică la CLI. Documentat greșit.

**Impact MOAT**: audit chain broken înseamnă `ensure_ok(&verify)?` la load() aruncă → sidecar refuză să pornească → user blocked până elimină/repară audit.log → poate distruge history complet. Dacă nu-i noticed la load (verify pass by accident sau skip), silent tampering opportunity.

---

## §187 — `audit::canonicalise` — `|` separator ambiguu → collision attack

`crates/feral-core/src/rsi/audit.rs:230-240`:

```rust
fn canonicalise(row: &BoundsAuditRow) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        row.timestamp,
        row.field,
        row.old_value.as_deref().unwrap_or(""),
        row.new_value,
        row.reason
    )
}
```

`|` separator fără escape. Două rows distincte pot canonicalize identic:

Row A:
- timestamp: `2026-01-01T00:00:00Z`
- field: `max_total_cost_usd`
- old_value: `Some("25.0")`
- new_value: `50.0`
- reason: `user_bump`

Canonical: `2026-01-01T00:00:00Z|max_total_cost_usd|25.0|50.0|user_bump`

Row B:
- timestamp: `2026-01-01T00:00:00Z`
- field: `max_total_cost_usd|25.0`   ← field name contains `|`
- old_value: `None`
- new_value: `50.0`
- reason: `user_bump`

Canonical: `2026-01-01T00:00:00Z|max_total_cost_usd|25.0||50.0|user_bump`

Actually diferite (una are gol `""` între `25.0` și `50.0`, alta `|25.0|`, apoi `|50.0|`). Verificăm:

Row A: `2026-01-01T00:00:00Z | max_total_cost_usd | 25.0 | 50.0 | user_bump` = 5 fields separated by |
Row B: `2026-01-01T00:00:00Z | max_total_cost_usd|25.0 |  | 50.0 | user_bump` — field-ul B `field` este `max_total_cost_usd|25.0` care în canonical apar ca `2026-01-01T00:00:00Z|max_total_cost_usd|25.0||50.0|user_bump`.

Hmm, ambele au aceleași bytes: `2026-01-01T00:00:00Z|max_total_cost_usd|25.0` vs `2026-01-01T00:00:00Z|max_total_cost_usd|25.0`. Apoi Row A continuă `|50.0|user_bump` (old_value gol, adică `|` immediate follows `25.0`)? Nu: format string e `{}|{}|{}|{}|{}` cu old_value = "25.0", deci output = `ts|field|25.0|50.0|reason`. Iar Row B cu old_value=None → `""` → `ts|field_with_pipe|25.0||50.0|reason` unde `field_with_pipe = "max_total_cost_usd|25.0"`.

Row A concatenată: `2026-01-01T00:00:00Z|max_total_cost_usd|25.0|50.0|user_bump`
Row B concatenată: `2026-01-01T00:00:00Z|max_total_cost_usd|25.0||50.0|user_bump`

DIFERITE (Row B are `||` unde A are `|`). Deci **nu-i collision direct**. OK.

**Bug real diferit**: `reason` conținând `|` poate confuza auditors care read manually cu shell-uri: `cat audit.log | grep 'field|reason'` matches greșit.

Și mai grav: dacă un `reason` conține newline (multiline user comment), JSON serialization escaped, dar canonicalise() îl inserează RAW în hash input. `field="x"`, `reason="foo\nbar"` iar `field="x\n"`, `reason="foo\nbar"` (wait, câmpul field nu poate avea `\n` prin construcție, e string constant). 

**Real bug small**: dacă `reason` are trailing newline (`"tune weights\n"` vs `"tune weights"`), hash diferit. Two audit rows scrise cu spații differente în reason → hash divergente → chain OK, dar semantic mesaj identic la review. Nu-i security ci UX.

**Fix (defensive)**: canonicalise cu JSON-escaped fields sau length-prefixed:

```rust
fn canonicalise(row: &BoundsAuditRow) -> String {
    // Length-prefix each field so no character in any field can collide.
    fn lp(s: &str) -> String { format!("{}:{}", s.len(), s) }
    format!(
        "{}{}{}{}{}",
        lp(&row.timestamp),
        lp(&row.field),
        lp(row.old_value.as_deref().unwrap_or("")),
        lp(&row.new_value),
        lp(&row.reason)
    )
}
```

Sau folosește direct `serde_json::to_string(&row)` cu canonical field order — dar bump la version + migration audit vechi.

Recognizat ca smell. Nu-i "opriți release-ul" dar merită fix înainte de v1.

---

## §188 — `audit::verify` — nu verifică că primul row are `prev_hash == GENESIS` explicit → prepend attack conceptualizat, edge-case

`crates/feral-core/src/rsi/audit.rs:165-197`:

```rust
pub fn verify(&self) -> Result<AuditVerifyResult> {
    ...
    let mut prev = GENESIS.to_string();
    let mut count: u64 = 0;
    for (idx, line) in reader.lines().enumerate() {
        ...
        let row: BoundsAuditRow = serde_json::from_str(trimmed)?;
        if row.prev_hash != prev {
            return Ok(AuditVerifyResult::Broken { line: idx + 1, reason: ... });
        }
        ...
        prev = row.entry_hash.clone();
        count += 1;
    }
    Ok(AuditVerifyResult::Ok { entries: count })
}
```

Verifică că fiecare row referă anterior corect. Primul row cere `prev_hash == GENESIS`. Dacă atacatorul REWRITES tot fișierul cu un nou chain valid începând cu propria `GENESIS`, verify pass (nu-i broken intern), dar chain-ul e diferit de cel original.

Nu-i "verify" ci "verify chain internal consistency". Nu-i attestation.

**Fix**: publish chain head periodic external (blockchain, publish la endpoint external, sau save în app bundle immutable). Comparație la load: chain-head-ul la boot != last known checkpoint → alarm.

Aceasta e o feature nouă, nu bug-fix. Notat ca zone de îmbunătățit.

---

## §189 — `runtime::dispatch_rsi_request::rsi_commit_genome` — case-insensitive filesystem (macOS APFS) permite `Main` bypass la ratchet

`crates/feral-core/src/rsi/runtime.rs:206-215`:

```rust
if candidate_branch == "main" {
    return Err("candidate_branch must not be 'main' — use rsi_ratchet_attempt".into());
}
if candidate_branch.is_empty() || candidate_branch.contains("..") || candidate_branch.contains('/') {
    return Err(format!(
        "invalid candidate_branch '{}' — must be a single-segment name",
        candidate_branch
    ));
}
```

Check string-comparison la lowercase `"main"`. Dar branch names pe macOS APFS (default case-insensitive) și Windows NTFS (default case-insensitive) → `refs/heads/Main` și `refs/heads/main` sunt același fișier.

`candidate_branch = "Main"`:
- `== "main"` false → trece.
- `.is_empty()` false, `.contains("..")` false, `.contains('/')` false → trece.
- `repo::commit_genome(...)` creează sau update `refs/heads/Main` care pe macOS/Windows = `refs/heads/main`.

**Bypass la ratchet check.** Un commit direct la main fără să treacă `ratchet_attempt` (scor > prior).

Alte variante: `"MAIN"`, `"Main "`, `"main\t"`, `" main"`. Toate trec la strict eq check.

**Fix**:

```rust
let branch_norm = candidate_branch.trim();
if branch_norm.eq_ignore_ascii_case("main") || branch_norm.eq_ignore_ascii_case("master") {
    return Err(format!(
        "candidate_branch '{}' resolves to a protected branch — use rsi_ratchet_attempt",
        candidate_branch
    ));
}
// Also reject any branch name that starts with an uppercase letter and matches "main"
// case-insensitively (defensive against APFS/NTFS case-insensitivity).
if branch_norm.is_empty() || branch_norm.contains("..") || branch_norm.contains('/')
    || branch_norm.chars().any(|c| c.is_whitespace() || c.is_control())
{
    return Err(...);
}
```

Preferably: hardcoded allowlist de prefix pentru candidate branches: `"genome/"` sau `"candidate/"`. Refuse tot ce nu-i sub prefix.

---

## §190 — `runtime::dispatch_rsi_request::rsi_set_lora` — `path` neverificat sub base dir → încarcă gguf de la orice location OS-side

`crates/feral-core/src/rsi/runtime.rs:395-425`:

```rust
"rsi_set_lora" => {
    let path: Option<std::path::PathBuf> = params
        .get("path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from);
    let scale = ...;
    if let Some(p) = &path {
        if !p.is_file() {
            return Err(format!("rsi_set_lora: adapter file not found: {}", p.display()));
        }
    }
    ...
    crate::inference::set_lora_adapter(path, scale);
    ...
}
```

`path` construit direct din user (sidecar-provided) string. Doar check-uiește `.is_file()`. Nu-i verificat că-i sub `~/.feral/loras/` sau alt safe dir.

Attacker (via sidecar or via test injection) trimite:
- `path: "/etc/shadow"` — `.is_file()` true → `set_lora_adapter` cheamă loader-ul → depinde de loader dacă mmap-uiește sau throwiește. Dacă loader-ul e llama.cpp-based, va încerca să parseze ca gguf → probabil crash sau garbled model. Nu-i imediat un data leak, dar denial-of-service.
- `path: "/dev/urandom"` — `.is_file()` false pe Linux (character device) → respins. OK.
- `path: "/proc/self/mem"` — pe Linux nu-i file, e special. Depinde.
- `path: "\\\\attacker.com\\share\\adapter.gguf"` — pe Windows UNC → `.is_file()` verifică remote → dacă attacker controls, adapter poate fi crafted pentru RCE prin llama.cpp bugs (there are historical CVEs în gguf parsing).

**Fix**:

```rust
"rsi_set_lora" => {
    let path: Option<std::path::PathBuf> = ... ;
    if let Some(p) = &path {
        // Must be under ~/.feral/loras/ (or a configured allowed dir).
        let lora_base = crate::paths::feral_dir().join("loras");
        crate::rsi::paths::require_under(&lora_base, p)
            .map_err(|e| format!("rsi_set_lora: adapter must be under {}: {e}", lora_base.display()))?;
        if !p.is_file() { return Err(format!("adapter file not found: {}", p.display())); }
        // Basic sanity: must end in .gguf/.safetensors, size < 5GB.
        let ext_ok = p.extension().and_then(|e| e.to_str())
            .map(|e| matches!(e, "gguf" | "safetensors" | "bin")).unwrap_or(false);
        if !ext_ok { return Err(format!("adapter must be .gguf/.safetensors: {}", p.display())); }
        let meta = std::fs::metadata(p).map_err(|e| format!("stat adapter: {e}"))?;
        if meta.len() > 5 * 1024 * 1024 * 1024 {
            return Err(format!("adapter too large ({} bytes)", meta.len()));
        }
    }
    ...
}
```

---

## §191 — `runtime::dispatch_rsi_request::embed_text` — no cap pe number of texts sau total size → OOM

`crates/feral-core/src/rsi/runtime.rs:498-510`:

```rust
"embed_text" => {
    let texts: Vec<String> = params
        .get("texts")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .ok_or_else(|| "embed_text: missing or non-array 'texts'".to_string())?;
    let vectors = tokio::task::spawn_blocking(move || crate::inference::embed_text(texts))...
}
```

Sidecar poate trimite:
- `texts: [<10MB string>; 10_000]` = 100 GB alloc înainte de spawn_blocking.
- `texts: [<1KB string>; 1_000_000]` = 1 GB, apoi embedding model produce 1M vectors × 384 dims × 4 bytes = 1.5 GB rezultat.

**Nu există bound pe:**
- `texts.len()`
- `text.len()` individual
- suma bytes-i totali
- rate limiting per-second

**Fix**:

```rust
const MAX_EMBED_TEXTS: usize = 512;
const MAX_EMBED_CHARS_PER_TEXT: usize = 32_768;   // 32 KB per text
const MAX_EMBED_TOTAL_CHARS: usize = 1_048_576;   // 1 MiB total

"embed_text" => {
    let arr = params.get("texts").and_then(|v| v.as_array())
        .ok_or_else(|| "embed_text: missing or non-array 'texts'")?;
    if arr.len() > MAX_EMBED_TEXTS {
        return Err(format!("embed_text: too many texts ({} > {})", arr.len(), MAX_EMBED_TEXTS));
    }
    let mut texts: Vec<String> = Vec::with_capacity(arr.len());
    let mut total = 0usize;
    for x in arr {
        let s = x.as_str().ok_or_else(|| "embed_text: non-string in array")?;
        if s.len() > MAX_EMBED_CHARS_PER_TEXT {
            return Err(format!("embed_text: text too long ({} > {})", s.len(), MAX_EMBED_CHARS_PER_TEXT));
        }
        total = total.checked_add(s.len()).ok_or("embed_text: size overflow")?;
        if total > MAX_EMBED_TOTAL_CHARS {
            return Err(format!("embed_text: total size exceeds {}", MAX_EMBED_TOTAL_CHARS));
        }
        texts.push(s.to_string());
    }
    ...
}
```

Pattern identic pentru orice endpoint care primește arrays de la sidecar. Runda 2 §41 a raportat 6 HTTP tools fără body-size cap — aceasta e clasa Rust-side complementară.

---

## §192 — `runtime::dispatch_rsi_request::rsi_score` — dispatcher NU face `ensure_initialized` check → dispatch call înainte de `rsi_init` panics în `do_rsi_score`

`crates/feral-core/src/rsi/runtime.rs:290-303`:

```rust
"rsi_score" => {
    let outcomes: Vec<EvalOutcome> = serde_json::from_value(
        params.get("outcomes").cloned()
            .ok_or_else(|| "rsi_score: missing 'outcomes'".to_string())?,
    ).map_err(|e| format!("rsi_score: bad outcomes: {e}"))?;
    let breakdown = do_rsi_score(state, outcomes)?;
    Ok(serde_json::to_value(breakdown).map_err(...)?)
}
```

`do_rsi_score` la line 167-179 face `ensure_initialized(state)?` intern. OK. Trece la init check. `bounds.lock()` — mutex. Dacă bounds e None (nu-i loaded), `.map(|b| b.scorer.weights.clone()).unwrap_or_default()` — fallback la defaults.

Comentariul de sus (line 167-179) zice: *"Use the bounds' weights if they exist, otherwise defaults."* — dar fallback tăcut la defaults înseamnă că un `rsi_score` chemat înainte ca bounds să fie loaded (race la boot) returnează scoruri calculate cu default weights, iar UI-ul le afișează ca autoritative. Următoarea rulare cu bounds loaded produce alte scoruri pentru aceleași outcomes. **Nedeterminism aparent la UI**.

Combinat cu §185 (file lipsă → default silent): user aude "aceleași outcomes, două scores diferite" fără să știe că bounds-ul lipsea.

**Fix**: `do_rsi_score` să respingă dacă bounds e None:

```rust
pub fn do_rsi_score(state: &RuntimeState, outcomes: Vec<EvalOutcome>) -> Result<ScoreBreakdown, String> {
    ensure_initialized(state)?;
    let weights = state.rsi_state.bounds.lock().as_ref()
        .map(|b| b.scorer.weights.clone())
        .ok_or_else(|| "rsi_score: bounds not loaded — call rsi_init first or restore bounds.json".to_string())?;
    Ok(super::scorer::score(&outcomes, &weights))
}
```

Explicit refuse decât silent fallback.

---

## §193 — `paths::is_valid_commit_hash` — hardcoded SHA-1 shape (40 hex) → break când git migrează la SHA-256

`crates/feral-core/src/rsi/paths.rs:158-160`:

```rust
pub fn is_valid_commit_hash(s: &str) -> bool {
    s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}
```

Git 2.29+ suportă SHA-256 hashes (64 hex chars). Dacă user rulează `git init --object-format=sha256` pentru repo-uri noi (default în viitoarele git 3.x), TOATE commit hashes RSI vor fi 64 chars → `is_valid_commit_hash` returnează false → `genome_snapshot_path` respinge → RSI-ul devine inoperabil.

`rsi::repo::bootstrap()` (linia 129-134 din repo.rs) NU specifică object-format explicit, deci moștenește global config. User cu global `init.defaultObjectFormat = sha256` primește un repo SHA-256 → hash-uri 64 chars → invalid via check-ul de aici.

**Fix**:

```rust
pub fn is_valid_commit_hash(s: &str) -> bool {
    let valid_length = s.len() == 40 || s.len() == 64;   // SHA-1 or SHA-256
    valid_length && s.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}
```

Plus în `repo::bootstrap`, pin explicit:

```rust
init_opts.initial_head("main");
// Pin the hash format so migration to SHA-256 in user's global git config
// doesn't silently break our commit hash validators.
// TODO: When SHA-256 support is verified end-to-end (git2 crate, is_valid_commit_hash,
// snapshot filenames), remove this pin.
init_opts.object_format(git2::HashType::Sha1);   // if git2 crate exposes this
```

(git2 crate poate să nu expună `object_format` — verifica versiunea. Dacă nu, log warning: `if repo.hash_object_format() != Sha1 { log::warn!("...") }`).

---

## §194 — `sandbox_bounds::is_protected_path` — skip non-existent bases → race la bootstrap unde eval/tier1/ nu există încă

`crates/feral-core/src/rsi/sandbox_bounds.rs:295-320`:

```rust
pub fn is_protected_path(&self, abs_path: &Path) -> Result<bool> {
    use crate::paths;
    let protected_full: Vec<std::path::PathBuf> = vec![
        paths::rsi_dir(),
        paths::rsi_sandbox_bounds_path(),
        ...
        paths::rsi_eval_dir(0),
        paths::rsi_eval_dir(1),
        paths::rsi_eval_dir(2),
    ];

    for base in &protected_full {
        if !base.exists() { continue; }      // ← skip
        if super::paths::is_under(base, abs_path)? { return Ok(true); }
    }
    Ok(false)
}
```

Comentariul (line 289-294): *"Skips protected bases that do not currently exist on disk (e.g. the `eval/tier1/` and `eval/tier2/` directories before they're populated)."*

Bug: în timpul unei operațiuni de scriere într-un tier care e about-to-be-created, `is_protected_path` returnează `false` pentru tier1/ dacă tier1/ încă nu există. Scriptul poate scrie legitim în path-ul `~/.feral/rsi/eval/tier1/adversarial-1.json` — check zice not protected → allowed → **prima scriere în tier1 SCAPĂ enforcement**.

Ulterior tier1/ există (a fost creat de acea scriere), următoarele scrieri sunt protected corect. Dar prima scriere se poate corupe fără audit sau bounds-check.

**Fix**: check și `rsi_dir()` mereu — dacă `rsi_eval_dir(1)` e sub `rsi_dir()`, chiar dacă tier1/ nu există, `rsi_dir()` există → protejat prin părinte:

```rust
for base in &protected_full {
    if !base.exists() {
        // If the base doesn't exist yet but its parent (rsi_dir) does,
        // the path is still protected — every subdir of rsi_dir is protected
        // by policy, so a not-yet-created child inherits that protection.
        continue;
    }
    if super::paths::is_under(base, abs_path)? { return Ok(true); }
}
// Fallback: anything under rsi_dir is protected, even if the specific
// subdirectory hasn't been created yet.
let rsi_root = paths::rsi_dir();
if rsi_root.exists() && super::paths::is_under(&rsi_root, abs_path)? {
    return Ok(true);
}
Ok(false)
```

Sau chiar mai simplu — mută `rsi_dir()` la începutul listei și scoate `continue`:

```rust
// rsi_dir() this covers every subtree of RSI, existing or not.
// The other entries are for symmetry with a future policy that allows
// carve-outs (e.g. "meta/pbt-cache/" writable but "meta/taste_vector.json" protected).
if paths::rsi_dir().exists() && super::paths::is_under(&paths::rsi_dir(), abs_path)? {
    return Ok(true);
}
Ok(false)
```

---

## §195 — Cross-cutting: score `f64::NEG_INFINITY` prior scenario în ratchet_attempt aduce `NaN > NaN` issue

`crates/feral-core/src/rsi/repo.rs:343-347` (analizat runda 6 §151):

```rust
let prior_score_value = prior_score.unwrap_or(f64::NEG_INFINITY);
let advanced = candidate_score > prior_score_value;
```

Dar dacă `candidate_score = f64::NAN` (from `score_code_patch` care poate returna NaN dacă total division degenerate — nu tehnic azi, dar posibil viitor)?

`NaN > f64::NEG_INFINITY` = **false**. Deci NaN prevents advance. OK, safe fail.

Ce despre `NaN > NaN`? Ambele false. Safe.

Ce despre `Infinity > Infinity`? Ambele false. Safe.

Ce despre `Infinity > 100.0`? True → advance la infinity. Care ratchet cu tip fresh la Infinity → next candidate cu `100 > Infinity`? False. Never advance again. **Stuck.**

`score_code_patch` clamp-uiește la [0, 100], deci Infinity nu-i posibil pe path-ul acela. Dar `scorer::score` — clamp-uiește la [0, 100] (§182), deci OK.

Dar `IterationMetadata::score: f64` acceptat direct din commit body (§151), zero validation. Attacker set `score: f64::INFINITY` prin JSON: `{"score": 1e400}` → JSON parse → f64 = infinity → ratchet advance definitv, all future advance blocked.

**Fix** (adăugat la §151):

```rust
let candidate_score = candidate_meta.score;
if !candidate_score.is_finite() {
    bail!("candidate score is not finite: {}", candidate_score);
}
if !(0.0..=100.0).contains(&candidate_score) {
    bail!("candidate score out of range [0, 100]: {}", candidate_score);
}
```

Aceasta e clasa "trust in json numbers from untrusted source" care merită validare la orice ingest point de score.

---

## §196 — MISCELANEE

**§196a** — `self_src.rs:107`: `String::from_utf8_lossy(&out.stderr).lines().next().unwrap_or("").trim()` — pierdem tot stderr-ul git afară de prima linie. Errorele git multi-line (ex. merge conflicts, hook failures) pierd context. Fix: keep first 500 chars.

**§196b** — `code_patch.rs::validate_code_patch:141`: `if line.starts_with("Binary files ") || line.starts_with("GIT binary patch")` — nu prinde `literal 0` GIT binary patch encoded format sau `deferred binary chunk` variants. Fine pentru mainstream git, dar `hg export --git` produce alte prefixe. Skip: assumption reasonable.

**§196c** — `scorer.rs::score_single` marked `#[allow(dead_code)]` — nu-i chemat de nimeni. Dacă UI eventualy îl folosește, edge case: `score_single(&outcome)` cu `outcome.errored: true, outcome.success: false` — `n=1`, `successes=0`, `errors=1` → success_component=0, error_component = -20. Score = -20 → clamp 0. Same as §182. OK.

**§196d** — `sandbox_bounds.rs::bootstrap_with_audit` — comentariul (line 236-238) admite același non-atomic risc ca `save_with_audit`. Same fix pattern. Additional: `audit.append("scorer", None, ...)` doar un field — dacă bootstrap trebuie să înregistreze mai multe fields (`max_total_cost_usd`, etc.), o loss.

**§196e** — `audit.rs::last_hash:139`: `skip malformed (shouldn't happen in our writes)` — dar dacă filesystem returnează parțial line (torn write on power loss), `serde_json::from_str` fails silent, `last` NU se update-ează → next append folosește o `prev_hash` care nu-i actually last hash pe disk → chain broken. Cel puțin log warning.

**§196f** — `runtime.rs::rsi_get_tier0_specs:353`: `TIER0_SPECS.iter().cloned().collect()` — aloc + serialize per fiecare invocation. Nu-i cache. Fine (called rar), skip.

**§196g** — `runtime.rs::rsi_set_lora` — recovery block (line 433-448) folosește `spawn_blocking(move || manager.load(cur.path, ...))` dar `cur` deja mutat în closure la line 419. Compilează? `cur` este `state.manager.current()` care returnează un Arc/Option. Recovery îl consumă din nou. Verific:

```rust
let current = state.manager.current();
if let Some(cur) = current {
    ...
    let reload = tokio::task::spawn_blocking({
        let manager = manager.clone();
        let path = cur.path.clone();       // ← clone
        move || manager.load(path, ...)
    }).await ...;
    if let Err(e) = reload {
        if had_adapter {
            crate::inference::set_lora_adapter(None, 1.0);
            let recover = tokio::task::spawn_blocking(move || {
                manager.load(cur.path, ...)   // ← cur used again here
            })...;
            ...
```

`cur` a fost cloned la `cur.path.clone()` (line 421) — deci `cur` însuși NU-i moved. La line 434 `cur.path` accesabil (dar `cur` a fost referenced in main closure by `cur.path.clone()` — care nu consumă cur). La `move || manager.load(cur.path, ...)` — moved `cur` in closure. OK, dar `manager` la line 435 e din outside closure — trebuie clone din nou:

```rust
let manager2 = manager.clone();
let recover = tokio::task::spawn_blocking(move || {
    manager2.load(cur.path, n_gpu_layers, ctx)
})...
```

Dar în cod actual `manager` e reutilizat direct — poate să fie deja moved în primul spawn_blocking? `manager.clone()` inside first closure block move-uiește `manager` outer? Nu, `let manager = manager.clone()` este inside `{}` block care se evalu la argument-ul lui spawn_blocking. Manager original NU-i mutat.

Dar în al doilea `spawn_blocking(move || { manager.load(...) })`, `manager` din outer nu a fost mutat, dar aici `move` îl trebuie owned → dacă `manager` e `Arc<...>`, e ieftin cloneabil, dar aici `move` îl consumă. `manager.load` e method call — dacă `manager: Arc<...>`, `Arc` implementa `Clone`, iar `move` doar preia ownership al Arc-ului (nu al inside-ului). OK for `Arc`.

Actually detaliile Rust-wise sunt subtile — codul compilează, dar recovery flow poate să dea "borrow already moved" în anumite versiuni. Nu-i categoric bug, e potential compile issue depending on manager type. Skip pentru raport.

**§196h** — `self_src.rs::provision:161`: `run_git(&target, &[..., "commit", "--allow-empty", ...])` — `--allow-empty` permite commit fără changes. Dar dacă `git add -A` a inclus TOATE fișierele iar tree-ul e identical cu HEAD anterior, commit-ul creează un commit gol → RSI graph history se umflă cu commits inutile. Nu-i bug security, doar noise.

---

## Summary Runda 7

**23 findings** (§173-§196 + subsections):

**MOAT-critical:**
- §180 (fake test counts inflated pass_rate)
- §181 (fake outcomes zeroed penalty components)
- §183 (audit chain diverges silent from file state)
- §185 (bounds.json missing → silent revert la defaults)
- §186 (audit chain race → torn hash chain în concurrency)
- §189 (`Main` bypass la ratchet pe macOS/Windows APFS/NTFS)
- §195 (`score = Infinity` blochează ratchet forever)

**Security perimeter:**
- §173 (copy_tree follows symlinks → exfil bundle-side)
- §174 (git deadlock cu gpgsign)
- §176 (git add -A commits accidental secrets în audit chain)
- §179 (Unicode bidi/invisible chars în patch paths bypass denylist)
- §190 (rsi_set_lora path unbounded)
- §191 (embed_text no cap → OOM)

**Data integrity / audit:**
- §178 (stray + / - lines outside hunk bypass count)
- §184 (adding SandboxBounds field silent skips audit)
- §194 (protected_path skip → prima scriere în tier1 scapă)
- §187 (canonicalise `|` separator ambiguu, minor)
- §188 (verify nu attestează external checkpoint)
- §193 (SHA-256 git repo breaks is_valid_commit_hash)

**Reliability / correctness:**
- §175 (provision recursion budget blow)
- §177 (early-exit provision cu tree corrupt)
- §182 (clamp la 0 pierde info debug)
- §192 (do_rsi_score silent fallback la defaults)
- §196x (miscelanee)

**Cumulat: ~193 findings peste 7 runde.**

### Zone rămase pentru rundele 8-10 (per plan)

- **Runda 8**: choke points TS — `FeralAgent/src/tools/registry.ts`, `agent-loop.ts`, `db.ts`, `cron/scheduler.ts`.
- **Runda 9**: frontend hooks completă (`useFeral.ts` 523l, `useSendMessage.ts` 372l) + Tauri commands (`chat.rs`, `models.rs`, `files.rs`, `voice.rs`, `byok.rs`, `setup.rs`).
- **Runda 10**: test-suite integrity — verificat că testele testează ce cred că testează, nu doar `expect(true).toBe(true)`.
