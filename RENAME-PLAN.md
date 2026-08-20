# Rename Plan — Feral → Cinderpaw

**Decision date:** 2026-08-20
**Old brand:** Feral
**New brand:** Cinderpaw
**Rationale:** vezi §0 mai jos.

---

## §0 De ce Cinderpaw

**Fit cu asset-ul vizual:** mascota efectivă (`frames.ts` — 95 frame-uri pixel-art) e un pixel creature warm terracotta cu picioruse (paws) mici. "Cinder" (ember, warm coal) + "paw" (small creature) = descrie asset direct. `Feral` = descriptor generic sălbatic; `LittleBeast` = descriptor generic cute-monster. `Cinderpaw` = descriere directă a exact ce vede user.

**Disponibilitate verificată 2026-08-20:**

| Registry | Status | Notes |
|---|---|---|
| GitHub `bloom500/cinderpaw` (repo) | ✅ liber | 404 |
| GitHub user `cinderpaw` | ✅ liber | 404 |
| GitHub org `cinderpaw` | ✅ liber | 404 |
| npm `cinderpaw` | ✅ liber | 404 |
| npm scope `@cinderpaw/*` | ✅ liber | poți claim la primul publish |
| npm `cinderpaw-agent`, `-cli` | ✅ libere | 404 |
| crates.io `cinderpaw`, `-core`, `-cli` | ✅ libere | 404 |
| PyPI `cinderpaw` | ✅ liber | 404 |
| `cinderpaw.ai` | ✅ liber | Identity Digital 404 |
| `cinderpaw.io` | ✅ liber | Identity Digital 404 |
| `cinderpaw.app` | ✅ liber | Google Registry 404 |
| `cinderpaw.dev` | ✅ liber | Google Registry 404 |
| `cinderpaw.com` | ❌ luat 2012 | RegistryGate GmbH (parked/speculator DE), potentially acquirable |

**Risc conflict:** "Cinderpaw" e un character canonic din seria Warriors (Erin Hunter, HarperCollins). Nu-i brand comercial, nu-i trademark filed (verificat prin trademarkia search). SEO organic dominat de fanfiction (DeviantArt, Wattpad, Warriors wikis). **Zero risc legal**, moderate SEO friction — dar Warriors fandom = tineri creativi, potențial early adopter demografic.

**Domain principal:** `cinderpaw.ai`

**Bundle identifier:** `ai.cinderpaw.app`

**CLI binary name:** `cinderpaw` (înlocuiește `feral`)

---

## §1 Scope — inventarul complet de schimbări

Măsurat pe repo state la momentul scrierii:

| Categoria | # locații | Effort |
|---|---|---|
| Text `Feral` (mixed case) | 1488 hits | mecanic sed cu awareness pentru context |
| Text `feral` (lowercase) | 2538 hits | mecanic + necesar exclude pattern-uri legitime |
| Text `FERAL` (uppercase) | 1811 hits | mecanic — env vars |
| Cargo packages | 3 (`feral-cli`, `feral-core`, `feral`) | rename + `Cargo.toml` deps update |
| npm packages | 2 (`feral-agent`, `feral-frontend-react`) | rename + `package.json` |
| Tauri productName | 1 (`"Feral"`) | 1-line change |
| Tauri identifier | 1 (`ai.feral.app`) | **breaking** — see §4 |
| Env vars `FERAL_*` | ~130 unique | dual-read wrapper needed — see §5 |
| localStorage keys `feral.*` | 4 (`onboarding`, `agentByokDismissed`, `autoUpdateCheck`, `fractal.maturityFloor`) | + `feral-ui`, `feral-model`, `feral_active_agent_id`, `feral_agents_onboarding` — migrator la boot |
| Event names `feral://` | ~20 unique | frontend + rust sync în single PR |
| Files with `feral` in name | 19 files | rename + import path updates |
| Directories `feral-core`, `feral-cli`, `FeralAgent` | 3 dirs | rename + Cargo workspace + gitignore |
| `~/.feral/` home dir | ~527 references in code | **breaking** — see §4 |
| Domain `feral.local` (git commit author) | 4 sites (`repo.rs`, `safety-point.ts`, tests) | mecanic |
| `feral-agent` git identity | in `repo.rs`, `self_src.rs` | mecanic |

---

## §2 Strategia — 4 faze independent shippable

Nu se poate face totul într-un singur PR — risc de breakage prea mare + reviewers copleșiți. Fazez:

| Faza | Ce | Cine | Risc | Effort |
|---|---|---|---|---|
| **A. Cosmetic** | UI strings, mascot component name, docs, README, marketing | Un dev (poate Opus 5) | Zero (user vede LittleBeast dar aplicație rulează Feral technical stack) | 1-2 zile |
| **B. Intern packages + events** | Cargo/npm rename, `feral://` events, code identifiers | Un dev | Compile-break pentru forkuri/PR-uri in-flight; zero pentru useri | 1 săptămână |
| **C. Bundle + state migration** | `identifier`, env vars dual-read, `~/.feral` → `~/.cinderpaw` migrator la boot | Un dev + testing cross-platform | **HIGH pentru useri existenți** — necesită migrator robust + release notes | 2-3 săptămâni |
| **D. Repo + external** | GitHub repo rename, publish `.ai` domain, npm/crates publish, deprecate old | Un dev + comms | Break links externi; GitHub redirect ajută parțial | 1 zi coordination + weeks de brand awareness |

**Ordine recomandată:** A → B → C → D. Fazele A + B pot fi în paralel; C trebuie DUPĂ B (packages renamed); D trebuie DUPĂ C (users migrated cu succes).

**Alternate:** A live imediat cu next release. B în release următor. C major version bump (v1.0 sau v2.0). D după stabilization.

---

## §3 Faza A — Cosmetic (safe, 1-2 zile)

**Ce se schimbă user-visible:**
- App name în UI (Sidebar logo, SettingsPage title, About panel, welcome screen)
- Onboarding wizard toate string-urile "Feral" → "Cinderpaw"
- Documentation, README, CHANGELOG entries forward
- `productName` în tauri.conf.json
- Mascot component name (`FeralMascot` → `CinderpawMascot`) — pattern search-replace safe

**Ce NU se schimbă în această fază:**
- Bundle identifier `ai.feral.app` (rămâne)
- Cargo/npm package names (rămân)
- `~/.feral/` home directory (rămâne)
- Env vars `FERAL_*` (rămân)
- `feral://` event names (rămân)
- CLI binary `feral` (rămâne)
- GitHub repo name (rămâne)

**Rezultat:** user care instalează next release vede "Cinderpaw" peste tot în UI. Zero migration friction. Aplicația e same technically.

### A.1 — Introduce `lib/brand.ts` (fișier central de source-of-truth)

**Frontend (`frontend-react/src/lib/brand.ts`):**

```ts
/**
 * Brand constants — single source of truth pentru UI-facing strings.
 * Cuvântul "Feral" nu ar mai trebui să apară hardcoded în componenta UI
 * după această migrare. Pentru un rebrand viitor, edit acest file.
 */
export const APP_NAME = 'Cinderpaw' as const;
export const APP_NAME_LOWER = 'cinderpaw' as const;
export const AGENT_DEFAULT_NAME = APP_NAME;
export const APP_DOMAIN = 'cinderpaw.ai' as const;

/** Legacy names — folosit pentru migration lookups, deprecation warnings. */
export const LEGACY_BRAND_NAMES = ['Feral', 'feral', 'FERAL'] as const;

/** Public brand copy — folosit în welcome/about/onboarding. */
export const BRAND_TAGLINE = 'An AI companion that lives on your machine.';
```

**Sidecar (`FeralAgent/src/brand.ts`) — mirror:**

```ts
export const APP_NAME = 'Cinderpaw';
export const APP_HOME_DIR_NAME = '.cinderpaw';   // pentru §5 folosire viitoare
export const LEGACY_HOME_DIR_NAME = '.feral';
```

**Rust (`crates/feral-core/src/brand.rs`) — mirror:**

```rust
pub const APP_NAME: &str = "Cinderpaw";
pub const APP_HOME_DIR_NAME: &str = ".cinderpaw";
pub const LEGACY_HOME_DIR_NAME: &str = ".feral";
pub const APP_DOMAIN: &str = "cinderpaw.ai";
pub const APP_IDENTIFIER: &str = "ai.feral.app";  // NU se schimbă în faza A
```

### A.2 — Search-replace UI strings

**Target files (pattern din frontend audit rounds):**

```bash
# UI text — safe replacements. Nu atinge component names, event strings, env vars.
FRONTEND_UI_FILES=(
  frontend-react/src/App.tsx
  frontend-react/src/components/layout/Sidebar.tsx           # linia 240: "Feral" logo
  frontend-react/src/components/settings/AppearanceTab.tsx   # linia 50: "Pick how Feral looks"
  frontend-react/src/components/settings/AboutTab.tsx        # about strings
  frontend-react/src/components/onboarding/OnboardingWizard.tsx  # linii 183, 230, 236, 269, 812
  frontend-react/src/pages/MemoryLayersPage.tsx              # linii 23, 197
  frontend-react/src/components/settings/FeralDreamsPanel.tsx    # linii 590, 591, 747
  frontend-react/src/components/chat/EmptyStates.tsx         # welcome greetings
  frontend-react/src/hooks/useFeral.ts                       # linia 469 notification
)

# NU folosi sed-uri automate — fiecare replacement trebuie inspected.
# Pattern: 'Feral' cu context UI-facing → 'Cinderpaw' sau {APP_NAME}
```

**Pattern-uri de refactor:**

```tsx
// ÎNAINTE:
<span>Feral</span>
// DUPĂ:
import { APP_NAME } from '@/lib/brand';
<span>{APP_NAME}</span>

// ÎNAINTE:
placeholder="Feral"
// DUPĂ:
placeholder={AGENT_DEFAULT_NAME}

// ÎNAINTE:
'Pick how Feral looks'
// DUPĂ:
`Pick how ${APP_NAME} looks`

// ÎNAINTE:
"Feral Agent stopped"
// DUPĂ:
`${APP_NAME} agent stopped`
```

### A.3 — Rename component files (search-replace bulk)

```bash
# Rename fișiere frontend:
git mv frontend-react/src/components/chat/mascot/FeralMascot.tsx frontend-react/src/components/chat/mascot/CinderpawMascot.tsx
git mv frontend-react/src/components/agents/FeralModelSelector.tsx frontend-react/src/components/agents/CinderpawModelSelector.tsx
git mv frontend-react/src/components/chat/FeralGlobalMount.tsx frontend-react/src/components/chat/CinderpawGlobalMount.tsx
git mv frontend-react/src/components/settings/FeralDreamsPanel.tsx frontend-react/src/components/settings/CinderpawDreamsPanel.tsx
git mv frontend-react/src/hooks/useFeral.ts frontend-react/src/hooks/useCinderpaw.ts
git mv frontend-react/src/stores/feral.ts frontend-react/src/stores/cinderpaw.ts
git mv frontend-react/src/lib/feralAgentStream.ts frontend-react/src/lib/cinderpawAgentStream.ts
git mv frontend-react/src/lib/feralLiveSession.ts frontend-react/src/lib/cinderpawLiveSession.ts

# Update imports pattern:
find frontend-react/src -name "*.tsx" -o -name "*.ts" | xargs sed -i \
  -e "s/from '@\/components\/chat\/mascot\/FeralMascot'/from '@\/components\/chat\/mascot\/CinderpawMascot'/g" \
  -e "s/from '@\/hooks\/useFeral'/from '@\/hooks\/useCinderpaw'/g" \
  -e "s/from '@\/stores\/feral'/from '@\/stores\/cinderpaw'/g" \
  -e "s/FeralMascot/CinderpawMascot/g" \
  -e "s/FeralModelSelector/CinderpawModelSelector/g" \
  -e "s/FeralGlobalMount/CinderpawGlobalMount/g" \
  -e "s/FeralDreamsPanel/CinderpawDreamsPanel/g" \
  -e "s/useFeral\b/useCinderpaw/g" \
  -e "s/useFeralStore/useCinderpawStore/g" \
  -e "s/useFeralGlobal/useCinderpawGlobal/g" \
  -e "s/useFeralSendMessage/useCinderpawSendMessage/g" \
  -e "s/useFeralStream/useCinderpawStream/g"
```

**Sidecar TS analogous** (`FeralAgent/src/**/*.ts` — mai puține fișiere cu Feral în nume).

### A.4 — Tauri productName + about strings

**`src-tauri/tauri.conf.json`:**

```jsonc
{
  "productName": "Cinderpaw",           // ← ERA "Feral"
  "identifier": "ai.feral.app",         // ← NU se schimbă (Faza C)
  "version": "0.2.0",                   // ← bump minor pentru rebrand cosmetic
  // rest unchanged
}
```

### A.5 — Docs, README, CHANGELOG

- `README.md` — rescrie hero paragraph, screenshots captions, install instructions cu "Cinderpaw"
- `CHANGELOG.md` — nouă entry:
  ```markdown
  ## v0.2.0 — 2026-XX-XX — Rebrand to Cinderpaw
  
  - Renamed the app from **Feral** to **Cinderpaw**. Same little pixel companion, new name. This is a cosmetic change; your data, settings, and agents are untouched. The bundle identifier, the CLI command (`feral`), and the config directory (`~/.feral/`) are unchanged in this release — a future version will migrate them together with a one-shot migrator. See [rename plan](./RENAME-PLAN.md).
  ```
- `docs/**/*.md` — bulk update:
  ```bash
  find docs -name "*.md" | xargs sed -i 's/\bFeral\b/Cinderpaw/g'
  ```
  **REVIEW ONE BY ONE** — command `\bFeral\b` respectă boundaries dar nu-i infallibil pentru cazuri complexe.

### A.6 — Faza A checklist

- [ ] `lib/brand.ts`, `FeralAgent/src/brand.ts`, `crates/feral-core/src/brand.rs` create
- [ ] Sidebar logo, onboarding wizard, all UI strings folosesc `APP_NAME`
- [ ] Component files renamed (`FeralMascot` → `CinderpawMascot` etc.)
- [ ] `tauri.conf.json` productName → "Cinderpaw"
- [ ] README updated cu new brand identity
- [ ] CHANGELOG entry explicit despre ce SE și NU se schimbă
- [ ] Screenshots UI regenerate în docs/
- [ ] Frontend audit fixes din §F31, §F32, §F53 rezolvate ca side-effect
- [ ] Test suites run green (Cargo test + Bun test + Vitest)
- [ ] Mascot renderer test cases still pass (95 frame-uri intact)

---

## §4 Faza B — Intern packages + events (compile-break-ing, 1 săptămână)

**Ce se schimbă:**
- Cargo package names: `feral-core` → `cinderpaw-core`, `feral-cli` → `cinderpaw-cli`, `feral` (tauri) → `cinderpaw`
- npm packages: `feral-agent` → `cinderpaw-agent`, `feral-frontend-react` → `cinderpaw-frontend-react`
- Rust extern use paths (15+ locații)
- Event names `feral://*` → `cinderpaw://*` (~20 unique names)
- Git identity în commits RSI (`feral-rsi <rsi@feral.local>` → `cinderpaw-rsi <rsi@cinderpaw.local>`)
- Directory rename: `crates/feral-core/` → `crates/cinderpaw-core/`, `crates/feral-cli/` → `crates/cinderpaw-cli/`, `FeralAgent/` → `CinderpawAgent/`

**Ce NU se schimbă:**
- Bundle identifier
- Env vars
- `~/.feral/` home dir
- CLI binary name (rămâne `feral` pentru compat)

### B.1 — Rename Cargo packages

**`Cargo.toml` workspace:**

```toml
members = ["src-tauri", "crates/cinderpaw-core", "crates/cinderpaw-cli"]
# was: ["src-tauri", "crates/feral-core", "crates/feral-cli"]
```

**`crates/cinderpaw-core/Cargo.toml`:**

```toml
[package]
name = "cinderpaw-core"

[lib]
name = "cinderpaw_core"
```

**`crates/cinderpaw-cli/Cargo.toml`:**

```toml
[package]
name = "cinderpaw-cli"

[[bin]]
name = "cinderpaw-cli"

[dependencies]
cinderpaw-core = { path = "../cinderpaw-core", default-features = false }
# etc.
```

**`src-tauri/Cargo.toml`:**

```toml
[package]
name = "cinderpaw"
# was: "feral"

[dependencies]
cinderpaw-core = { path = "../crates/cinderpaw-core", default-features = false }
# feature flags:
inference = ["cinderpaw-core/inference"]
# etc.
```

### B.2 — Rename directories + git mv

```bash
git mv crates/feral-core crates/cinderpaw-core
git mv crates/feral-cli crates/cinderpaw-cli
git mv FeralAgent CinderpawAgent
```

### B.3 — Update Rust `use` paths

```bash
# Search-replace pentru extern use:
find . -name "*.rs" -not -path "*/target/*" -not -path "*/node_modules/*" | xargs sed -i \
  -e 's/use feral_core::/use cinderpaw_core::/g' \
  -e 's/use feral_cli::/use cinderpaw_cli::/g' \
  -e 's/extern crate feral_core/extern crate cinderpaw_core/g'
```

**Locații critice** (from audit):
- `src-tauri/src/lib.rs:17` — `pub use feral_core::{...}`
- `src-tauri/src/rsi/commands.rs:45` — `use feral_core::rsi::runtime::*;`
- `src-tauri/src/connectors.rs:31-32` — `pub use feral_core::connectors::...`
- `crates/cinderpaw-cli/src/migrate.rs:18` — `use feral_core::migrate::...`
- `crates/cinderpaw-core/tests/*.rs` — 8+ files

### B.4 — npm package renames

**`CinderpawAgent/package.json`:**

```json
{
  "name": "cinderpaw-agent",
  "bin": {
    "cinderpaw-agent": "./bin/cinderpaw.js"
  }
}
```

Rename `bin/feral.js` → `bin/cinderpaw.js` — update `#!/usr/bin/env` shebang și any self-refs.

**`frontend-react/package.json`:**

```json
{
  "name": "cinderpaw-frontend-react"
}
```

### B.5 — Event names `feral://` → `cinderpaw://`

```bash
find . -name "*.rs" -o -name "*.ts" -o -name "*.tsx" -o -name "*.json" | \
  xargs sed -i 's|feral://|cinderpaw://|g'
```

Verify: `~20 unique events` (per audit), toate on-brand:

- `cinderpaw://agent-output`, `agent-ready`, `agent-exit`, `agent-event`
- `cinderpaw://download-progress`, `-complete`, `-error`
- `cinderpaw://embedding-download-*`
- `cinderpaw://model-load-progress`
- `cinderpaw://rsi-patch-reverted`
- `cinderpaw://stream-start`, `-done`, `-error`, `-progress`, `-stopped`, `-truncated`, `-usage`
- `cinderpaw://whisper-download-*`

Frontend + Rust emit sites și listen sites trebuie sync în același PR.

### B.6 — Git identity for RSI commits

**`crates/cinderpaw-core/src/rsi/repo.rs:196, 286`:**
- `Signature::now("feral-rsi", "rsi@feral.local")` → `Signature::now("cinderpaw-rsi", "rsi@cinderpaw.local")`

**`CinderpawAgent/src/core/safety-point.ts:103-106`:**
- `GIT_AUTHOR_NAME: "Feral"` → `"Cinderpaw"`
- `GIT_AUTHOR_EMAIL: "..@feral.local"` → `"..@cinderpaw.local"`

Impact: commits RSI viitoare vor fi cu new identity. Commits existente rămân cu old (istoric git imutabil, expected).

### B.7 — Faza B checklist

- [ ] `cargo check --workspace` green
- [ ] `cargo test --workspace` green
- [ ] `bun test` (sidecar) green
- [ ] `bun run typecheck` (frontend) green
- [ ] `cargo build --release` produce binary correct
- [ ] npm packages resolve correct (dependencies interne workspace)
- [ ] `bin/cinderpaw.js` executable
- [ ] Manual smoke test: sidecar boot + emit event `cinderpaw://agent-ready` observable în UI
- [ ] RSI git commits use new identity
- [ ] CHANGELOG entry: "Internal package rename — no user-facing changes"

---

## §5 Faza C — Bundle + state migration (CRITICAL, 2-3 săptămâni)

**Ce se schimbă:**
- Tauri `identifier: "ai.feral.app"` → `"ai.cinderpaw.app"`
- `~/.feral/` → `~/.cinderpaw/` cu migrator la boot
- Env vars `FERAL_*` acceptate cu deprecation warnings, `CINDERPAW_*` primary
- macOS Keychain entries migrate
- Windows Credential Manager entries migrate
- Registry HKCU keys (Windows) migrate

**Riscuri:**
- Bundle ID change = app **NOUĂ** pentru OS. macOS/Windows văd Cinderpaw ca separat de Feral. Users cu Feral instalat trebuie explicit să migreze. Fără migrator, două icoane pe Desktop, duplicate keychain prompts, state divergent.
- `~/.feral` cu date critice (BYOK keys encrypted, RSI git repo, embeddings, conversations) — corupt migration = data loss.
- macOS require re-code-signing pentru new identifier.

### C.1 — Bundle identifier change

**`src-tauri/tauri.conf.json`:**

```jsonc
{
  "productName": "Cinderpaw",
  "identifier": "ai.cinderpaw.app",     // ← CHANGE, was "ai.feral.app"
  "version": "1.0.0",                   // ← MAJOR version bump obligatoriu
}
```

**Impact per OS:**

- **macOS:** app pornește ca `Cinderpaw.app`, keychain keys sub `ai.cinderpaw.app`. Old `Feral.app` rămâne pe disc separate până user delete manual. Notarize + code-sign under new identifier.
- **Windows:** MSI installer generează new UUID pentru upgrade code. User cu Feral vede două intrări în Programs. Registry `HKCU\Software\ai.cinderpaw.app` nou.
- **Linux:** `.desktop` entry nou. Icon path.

### C.2 — `~/.feral` → `~/.cinderpaw` migrator

**Design:** un-shot migrator care rulează la primul boot Cinderpaw. Detectează `~/.feral`, copy atomic la `~/.cinderpaw`, verifică integrity, mark old ca `.feral.migrated` (nu delete — safety).

**`crates/cinderpaw-core/src/migrate_home.rs` (nou):**

```rust
//! One-shot migrator for ~/.feral → ~/.cinderpaw.
//! 
//! Idempotent: runs the copy exactly once, marks source directory as
//! `.feral.migrated-to-cinderpaw` on completion. Never deletes source.
//! On any failure, cinderpaw home dir is rolled back and app refuses to
//! start with an actionable error.

use std::path::PathBuf;
use anyhow::{Context, Result, bail};

pub const MIGRATION_MARKER: &str = ".migrated-to-cinderpaw";

pub fn maybe_migrate() -> Result<MigrationOutcome> {
    let old = home::home_dir().context("no home dir")?.join(".feral");
    let new = home::home_dir().context("no home dir")?.join(".cinderpaw");

    // Already migrated (or fresh install, no old dir).
    if !old.exists() {
        return Ok(MigrationOutcome::NoLegacyHome);
    }
    if new.exists() && old.join(MIGRATION_MARKER).exists() {
        return Ok(MigrationOutcome::AlreadyMigrated);
    }
    if new.exists() && !old.join(MIGRATION_MARKER).exists() {
        // Both exist but not marked migrated — user intervention needed
        // (avoid overwriting new dir with partial legacy data).
        bail!(
            "Both ~/.feral and ~/.cinderpaw exist. Cinderpaw refuses to \
             overwrite. Move one aside and restart. See RENAME-PLAN.md §C.2."
        );
    }

    // Copy old → new atomic (via temp dir + rename).
    let tmp = new.with_extension("cinderpaw.tmp");
    if tmp.exists() { std::fs::remove_dir_all(&tmp)?; }
    copy_dir_recursive(&old, &tmp)
        .context("copy ~/.feral → ~/.cinderpaw.tmp")?;

    // Fix any internal path references (e.g. RSI git remote URLs, absolute
    // paths in config files). See C.2.b below.
    rewrite_internal_paths(&tmp, &old, &new)?;

    // Atomic rename final.
    std::fs::rename(&tmp, &new).context("rename tmp to final")?;

    // Mark old dir as migrated (do NOT delete — user can rollback).
    std::fs::write(
        old.join(MIGRATION_MARKER),
        format!("Migrated to {} at {}\n", new.display(), chrono::Utc::now().to_rfc3339()),
    )?;

    Ok(MigrationOutcome::Migrated { from: old, to: new })
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<()> {
    // ... standard recursive copy, skip SYMLINKS (§173 audit lesson),
    //     verify no cycles, honor size limits.
}

fn rewrite_internal_paths(dir: &std::path::Path, old_root: &std::path::Path, new_root: &std::path::Path) -> Result<()> {
    // Files that may contain absolute paths pointing back to ~/.feral:
    //   - rsi/settings.json (may reference eval_dir absolute)
    //   - mcp.json (may reference stdio server binaries)
    //   - Any *.json config with baseUrl / path fields
    // Grep-replace old_root string with new_root string in known files only.
}

pub enum MigrationOutcome {
    NoLegacyHome,
    AlreadyMigrated,
    Migrated { from: PathBuf, to: PathBuf },
}
```

**Boot hook** (`src-tauri/src/lib.rs` sau boot.rs):

```rust
fn main() {
    // BEFORE any other init (before opening DB, before RSI bootstrap).
    match cinderpaw_core::migrate_home::maybe_migrate() {
        Ok(MigrationOutcome::Migrated { from, to }) => {
            tracing::info!("Migrated {} → {}", from.display(), to.display());
            // Show toast on first-open: "Welcome to Cinderpaw — your data
            // from Feral has been imported."
        }
        Ok(_) => { /* no-op */ }
        Err(e) => {
            tracing::error!("Home migration failed: {}", e);
            // Show blocking dialog with error + link la troubleshooting.
            // Refuse to continue boot.
            std::process::exit(1);
        }
    }
    // ... rest of boot
}
```

**Testing plan:**
- Test cu `~/.feral/` gol (fresh install).
- Test cu `~/.feral/` populate (real user data).
- Test cu ambele dirs prezente (rollback scenario).
- Test cu permission denied pe destination.
- Test cu symlinks în source (audit §173 lesson — refuse).
- Test cu 10GB `~/.feral` (progress reporting?).
- Test pe fiecare OS separately.

### C.3 — Env vars dual-read

**Pattern general** — introduce un helper:

```rust
// crates/cinderpaw-core/src/env.rs
/// Read env var cu fallback la legacy FERAL_* name.
/// Emits deprecation warning în tracing when legacy name is used.
pub fn env_or_legacy(new_name: &str, legacy_name: &str) -> Option<String> {
    if let Ok(v) = std::env::var(new_name) {
        return Some(v);
    }
    if let Ok(v) = std::env::var(legacy_name) {
        tracing::warn!(
            "Env var {} is deprecated, use {} instead. Support will be \
             removed in v2.0.",
            legacy_name, new_name
        );
        return Some(v);
    }
    None
}
```

**Refactor call sites** — 130+ unique env vars. Priority order:

1. **User-facing (documented în CHANGELOG, README):**
   - `FERAL_HOME` → `CINDERPAW_HOME`
   - `FERAL_API_KEY` → `CINDERPAW_API_KEY`
   - `FERAL_BASE_URL` → `CINDERPAW_BASE_URL`
   - `FERAL_BUDGET_CONVERSATION`, `FERAL_BUDGET_DAY`, `FERAL_BUDGET_POLICY`
   - `FERAL_TRUSTED_BASE_URLS`, `FERAL_FETCH_DOMAINS`
   - `FERAL_ENABLE_SHELL_EXEC`, `FERAL_ENABLE_CODE_EXEC`
   - `FERAL_PERMISSION_MODE`
2. **RSI/dev:** `FERAL_RSI_*` (~15 vars)
3. **Internal/testing:** `FERAL_TEST_*`, `FERAL_BENCH_*`, `FERAL_FMS_BENCH`
4. **Ops:** `FERAL_PUBLIC_JOURNAL_*`

TS side analogous (`config.ts` — cfgInt/cfgString helpers cu fallback):

```ts
// CinderpawAgent/src/config.ts
export function envOrLegacy(newName: string, legacyName: string): string | undefined {
  const v = process.env[newName];
  if (v !== undefined) return v;
  const legacy = process.env[legacyName];
  if (legacy !== undefined) {
    console.warn(`[cinderpaw] env ${legacyName} deprecated, use ${newName}`);
    return legacy;
  }
  return undefined;
}
```

### C.4 — localStorage migration frontend

**`frontend-react/src/lib/localStorageMigration.ts` (nou):**

```ts
const MIGRATION_MAP: Record<string, string> = {
  'feral.onboarding':          'cinderpaw.onboarding',
  'feral.agentByokDismissed':  'cinderpaw.agentByokDismissed',
  'feral.autoUpdateCheck':     'cinderpaw.autoUpdateCheck',
  'feral.fractal.maturityFloor': 'cinderpaw.fractal.maturityFloor',
  'feral-ui':                  'cinderpaw-ui',
  'feral-model':               'cinderpaw-model',
  'feral_active_agent_id':     'cinderpaw_active_agent_id',
  'feral_agents_onboarding':   'cinderpaw_agents_onboarding',
};

const MIGRATION_FLAG = 'cinderpaw.localStorageMigrated_v1';

export function migrateLocalStorage(): void {
  if (typeof localStorage === 'undefined') return;
  if (localStorage.getItem(MIGRATION_FLAG) === 'true') return;

  let migrated = 0;
  for (const [oldKey, newKey] of Object.entries(MIGRATION_MAP)) {
    const val = localStorage.getItem(oldKey);
    if (val !== null && localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, val);
      // DO NOT remove old key — allow rollback dacă user downgrade.
      migrated++;
    }
  }
  localStorage.setItem(MIGRATION_FLAG, 'true');
  if (migrated > 0) {
    console.info(`[cinderpaw] migrated ${migrated} localStorage keys from feral.*`);
  }
}
```

**Boot hook** — `main.tsx`:

```tsx
import { migrateLocalStorage } from './lib/localStorageMigration';

migrateLocalStorage();  // BEFORE anything reads localStorage

// ... existing ReactDOM.createRoot
```

Bonus fix pentru §F57 (audit anterior):

```tsx
// Wrap toate JSON.parse din persist:
let stored: unknown = {};
try {
  stored = JSON.parse(localStorage.getItem('cinderpaw-ui') || '{}');
} catch (err) {
  console.error('[boot] corrupted cinderpaw-ui localStorage, resetting:', err);
  localStorage.removeItem('cinderpaw-ui');
}
```

### C.5 — CLI binary name

**Options:**
- **A. Change binary name:** `feral` → `cinderpaw` command. Break user muscle memory + scripts existente. Include shim: `feral` → `cinderpaw` deprecation warning + exec.
- **B. Keep `feral` binary name** pentru compat, add `cinderpaw` as alias. User poate folosi ambele.

**Recomandare:** B pentru safe migration path. Deprecate `feral` peste 2 versiuni.

```rust
// crates/cinderpaw-cli/src/main.rs
fn main() {
    let argv0 = std::env::args().next().unwrap_or_default();
    if argv0.ends_with("feral") || argv0.ends_with("feral.exe") {
        eprintln!(
            "warning: `feral` command is deprecated, use `cinderpaw` instead. \
             Support removed in v2.0."
        );
    }
    // ... rest of CLI
}
```

Shipping: install script include both `feral` (shim) și `cinderpaw` (main).

### C.6 — Faza C checklist

- [ ] `migrate_home.rs` implementat + tested cross-platform
- [ ] Boot hook runs migrator FIRST, blocks on error
- [ ] Env var dual-read helper implementat, applied la user-facing vars (Priority 1)
- [ ] localStorage migrator rulează la main.tsx boot
- [ ] Bundle ID updated în tauri.conf.json
- [ ] Version bump la 1.0.0 (major)
- [ ] macOS code-signed with new identifier
- [ ] Windows MSI generates new upgrade code, tested upgrade path
- [ ] Linux .desktop entry updated
- [ ] CHANGELOG comprehensive migration guide
- [ ] Blog post / release notes explaining migration
- [ ] In-app notification: "Welcome to Cinderpaw — your Feral data has been imported"
- [ ] Rollback docs (how to revert to Feral if migrator fails)
- [ ] Support playbook pentru users blocked pe migration errors
- [ ] `feral` CLI shim cu deprecation warning

---

## §6 Faza D — Repo + external publish (1 zi + ongoing awareness)

**Ce se schimbă:**
- GitHub repo `bloom500/feral` → `bloom500/cinderpaw` (via GitHub repo rename — automatic redirect for git operations)
- Publish `cinderpaw-core`, `cinderpaw-cli` pe crates.io
- Publish `cinderpaw-agent`, `@cinderpaw/agent` pe npm
- Register domenii: `cinderpaw.ai` (primary), `cinderpaw.io`, `cinderpaw.app`, `cinderpaw.dev` (protective)
- Create GitHub org `cinderpaw` (optional)
- Deprecate old crates/npm packages cu redirect notice

### D.1 — GitHub rename

```bash
# From repo settings → Rename repository → bloom500/cinderpaw
# Git redirects automatically (git clone bloom500/feral still works).
# Update local remote:
git remote set-url origin git@github.com:bloom500/cinderpaw.git
```

Update:
- README badges (CI badge URLs, etc.)
- Docs referencing github.com/bloom500/feral → cinderpaw
- Any Cargo.lock or package-lock URLs pinning git deps

### D.2 — Publish packages

```bash
cd crates/cinderpaw-core && cargo publish
cd ../cinderpaw-cli && cargo publish

cd ../../CinderpawAgent && npm publish --access public
```

**Deprecate old (dacă vreodată au fost publicate):**

```bash
cargo yank --version 0.1.0 feral-core  # nu delete, mark unavailable
npm deprecate feral-agent@"*" "Renamed to cinderpaw-agent"
```

### D.3 — Domain registration

- `cinderpaw.ai` — primary, redirect all others aici
- `cinderpaw.io`, `.app`, `.dev` — defensive, redirect la .ai
- `cinderpaw.com` — attempt purchase via broker (RegistryGate GmbH — cel mai probabil rezonabil sub $5k)

### D.4 — External comms

- Blog post: "Feral is now Cinderpaw"
- HackerNews launch (dacă e cazul)
- Twitter/BlueSky announcement
- Update social profiles (dacă există @feral handle undeva)
- Update any listed reg listing (ProductHunt, etc.)

---

## §7 Cross-referință cu bug audit findings

Rebrand-ul rezolvă natural findings existente:

| Audit finding | Rezolvat de faza |
|---|---|
| §F12 (localStorage keys `feral.*` need migration) | Faza C.4 |
| §F16 (hardcoded "Feral" în UI) | Faza A.2 |
| §F31 (OnboardingWizard "Feral" hint) | Faza A.2 |
| §F32 (Welcome text "Feral") | Faza A.2 |
| §F53 (component names) | Faza A.3 |
| §F57 (localStorage corrupt crash) | Faza C.4 (bonus fix) |
| §F60e (`LOCAL_PROVIDER_ID = 'feral-local'`) | Faza B (identifier rename) |

Un plan de rebrand bine executat = un-shot fix pentru clase de bug-uri de tehnic debt.

---

## §8 Timing recomandat

**Săptămâna 1 (paralel cu Opus 5 bug fixes):**
- Faza A completă (cosmetic + brand.ts).
- Release ca v0.2.0.
- Users văd "Cinderpaw" în UI.

**Săptămânile 2-3:**
- Faza B (internal packages).
- Release intern preview, no user-facing changes.

**Săptămânile 4-6:**
- Faza C (migrator + bundle ID).
- Extensive testing, especially cross-platform.
- Beta release cu subset useri.

**Săptămâna 7:**
- Faza D (public launch).
- Release v1.0.0 stable cu new brand.

**Total:** ~7 săptămâni de la commit A.1 la v1.0.0 GA.

---

## §9 Rollback plan (dacă merge prost)

**Faza A rollback:** revert commits. Zero user impact.

**Faza B rollback:** revert commits. Ecosystem-internal (nu-i publicat). Zero user impact.

**Faza C rollback:** MAI GREU. Users cu `~/.cinderpaw` migrated:
- App v2 (Feral revert) tries `~/.feral` — dar poate fi stale (v0.2.0-.migrated marker).
- Migrator NU deletează `~/.feral`, deci safe rollback: user delete `~/.cinderpaw`, remove marker, Feral revert app funcționează.
- **Documentează procedura explicit** în release notes.

**Faza D rollback:** GitHub rename e reversibil, dar packages published pe npm/crates.io **NU se pot delete** (immutable). Doar `yank`/`deprecate`. Poate coabita cu new packages până user upgrade.

---

## §10 Success metrics

- [ ] Zero user reports "unde-mi sunt conversațiile" post-migration
- [ ] Zero user reports "BYOK key nu mai merge" post-migration
- [ ] `cinderpaw.ai` primary domain live cu redirect din alte TLDs
- [ ] npm downloads `cinderpaw-agent` > deprecate `feral-agent`
- [ ] GitHub stars migrate correct (automatic prin rename)
- [ ] SEO organic: prima pagină Google pentru "cinderpaw AI" arată produsul (nu Warriors fandom)
- [ ] In-app telemetry (dacă există): `identifier: ai.cinderpaw.app` = 95%+ users în 30 zile după release v1.0

---

## §11 Open questions / decisions rămase

- [ ] GitHub org `cinderpaw` sau rămâne `bloom500` account?
- [ ] Domain `cinderpaw.com` — attempt purchase via broker? Buget rezervat?
- [ ] `feral` CLI binary — keep as shim indefinite, sau sunset after v1.5?
- [ ] Env vars dual-read window — 2 versiuni? 5? forever?
- [ ] Marketing: leverage mascota ca companion cinderpaw ownable — merch, stickers, GitHub avatar?
- [ ] Trademark USPTO application pentru "Cinderpaw" în Class 42 (software as service) — recommend înainte de faza D public launch.

---

**End of plan.** Aprobare + kick-off pe faza A oricând.
