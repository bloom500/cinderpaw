# Brief MiniMax — Faza 3 (stabilizare BRSI), leaves delegate

Repo: `D:\FeralLocalAI` (monorepo: `src-tauri/` Rust + Tauri, `FeralAgent/` sidecar Bun/TS, `frontend-react/`).
Spec-ul fazei: `docs/superpowers/specs/2026-07-02-faza3-stabilizare-design.md` — citește-l întâi.

## Reguli (obligatorii)

1. **Citește codul real înainte să scrii.** Dacă un fișier/funcție numită aici nu există, OPREȘTE-TE și raportează — nu inventa.
2. **NU atinge**: `FeralAgent/src/rsi/pending-patches.ts`, `FeralAgent/src/rsi/code-genome.ts` (sunt gate/wall — pe denylist), nimic din `frontend-react/`.
3. Nu modifica teste existente în afara sarcinii A (poți doar ADĂUGA teste noi).
4. Testele trebuie să exercite comportament real, nu stub-uri care trec mereu.
5. Verificare înainte de a raporta DONE:
   - `cd FeralAgent && bunx tsc --noEmit && bun test` (totul verde)
   - `cd src-tauri && cargo check --no-default-features --features inference` și `cargo test --no-default-features --features inference rsi::watchdog` (verde)
6. Lasă schimbările pe disc în repo (fără commit). Raportează la final: lista fișierelor atinse + output-ul comenzilor de verificare.

## Sarcina A — Slice 4: cleanup `.tmp-tree-champ-*.json` (mic)

`FeralAgent/tests/rsi-sidecar.test.ts:405` creează
`../.tmp-tree-champ-${Math.random()}.json` (championTreePath) și nu-l șterge
niciodată → repo-ul se umple de fișiere temp. Fixează testul (și orice alt
loc din `FeralAgent/tests/` care scrie `.tmp-tree-champ-*`) ca fișierul să
fie șters garantat la teardown (`afterEach`/`finally` cu `rmSync(..., { force: true })`).
Apoi șterge fișierele `.tmp-tree-champ-*.json` deja existente în working tree.

## Sarcina B — Slice 3 (miezul pur): decizia watchdog crash→auto-revert (Rust)

Context din spec: după ce un code-patch e aplicat pe sursă, scriem un marker;
dacă sidecarul moare de ≥2 ori în fereastra de 10 min de la apply, hostul
face auto-revert. TU scrii DOAR modulul pur de decizie + persistența
markerului; integrarea în supervizorul de sidecar o face alt agent.

Fișier NOU: `src-tauri/src/rsi/watchdog.rs`, înregistrat în
`src-tauri/src/rsi/mod.rs` (uită-te cum sunt înregistrate modulele existente).

Contract exact (nu-l schimba — pe el se face integrarea):

```rust
/// Marker scris la applyPatchLive (partea TS îl scrie; alt agent o leagă).
/// Cale canonică: ~/.feral/rsi/last_applied_patch.json
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PatchMarker {
    pub patch_id: String,
    /// Unix ms la momentul apply-ului.
    pub applied_at_ms: u64,
}

pub struct WatchdogOpts {
    /// Fereastra de observație de la apply. Default 600_000 (10 min).
    pub window_ms: u64,
    /// Câte morți de sidecar în fereastră declanșează revert. Default 2.
    pub crash_threshold: usize,
}
impl Default for WatchdogOpts { /* valorile de mai sus */ }

/// Citește markerul; None pe fișier lipsă, corupt sau versiune greșită —
/// NU panica niciodată (disciplina "journal": corupt => start gol).
pub fn load_marker(path: &std::path::Path) -> Option<PatchMarker>;

/// Scrie markerul atomic (temp + rename).
pub fn save_marker(path: &std::path::Path, m: &PatchMarker) -> anyhow::Result<()>;

/// Șterge markerul (după fereastra stabilă sau după revert).
pub fn clear_marker(path: &std::path::Path);

/// Decizia pură: `exit_timestamps_ms` = momentele la care sidecarul a murit
/// (hostul le acumulează). Revert dacă cel puțin `crash_threshold` exit-uri
/// cad în [applied_at_ms, applied_at_ms + window_ms]. Exit-uri din afara
/// ferestrei nu contează. `now_ms` există pentru simetrie/teste viitoare.
pub fn should_revert(
    marker: &PatchMarker,
    exit_timestamps_ms: &[u64],
    now_ms: u64,
    opts: &WatchdogOpts,
) -> bool;

/// Markerul e expirat (now > applied_at + window) => poate fi șters.
pub fn marker_expired(marker: &PatchMarker, now_ms: u64, opts: &WatchdogOpts) -> bool;
```

Teste unit în același fișier (`#[cfg(test)]`), minim:
- 2 exit-uri în fereastră → true; 1 exit → false; 2 exit-uri dar unul înainte
  de apply → false; exit-uri după expirarea ferestrei → false.
- `load_marker` pe JSON corupt / fișier lipsă → None, fără panică.
- round-trip save → load.
- `marker_expired` la limite (exact la margine: expirat doar STRICT după).

## Sarcina C — Slice 2 (unealta): script rebuild sidecar

Fișier NOU: `scripts/rsi-rebuild-sidecar.ps1`. Rol: după un apply de patch pe
sursă, hostul îl invocă să facă patch-ul „agentul viu".

Comportament:
1. Param `-RepoRoot` (default `D:\FeralLocalAI`... NU — default: rădăcina
   repo-ului dedusă din locația scriptului, `$PSScriptRoot\..`).
2. Dacă `bun` nu e pe PATH → scrie pe stderr un mesaj clar și `exit 2`
   (toolchain absent = cazul mașinilor de useri; hostul tratează 2 ca
   „rebuild indisponibil", nu ca eroare).
3. `cd <RepoRoot>\FeralAgent && bun run build` — orice eșec → `exit 1`.
4. Copiază `FeralAgent\dist\feral-agent.exe` peste
   `src-tauri\binaries\feral-agent-x86_64-pc-windows-msvc.exe`.
5. Succes → `exit 0`, printează calea binarului scris.

Fără test automat (e script de mediu); în schimb rulează-l tu o dată și
include output-ul în raport.

## Ce NU faci (rămâne la agentul principal)

Integrarea supervizor `#11` + scrierea markerului din TS la apply, invocarea
scriptului din Rust, restart/revert live, UI. Doar A + B + C de mai sus.
