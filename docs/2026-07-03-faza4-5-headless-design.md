# Faza 4.5 — Feral Headless: „One Brain, Many Faces"

**Status: DRAFT — așteaptă review Darius.** Deciziile marcate ⚑ au fost luate
cu default-ul recomandat pentru că întrebarea a rămas fără răspuns în sesiune;
oricare poate fi răsturnată înainte de implementare.

## Obiectiv

Feral Agent rulează ca serviciu local independent (daemon), fără aplicația
desktop. Desktop-ul devine DOAR unul dintre clienți. Un singur creier
(memorie + LoRA personal + Dreams + evoluție) expus prin conectori
(Discord/Slack/WhatsApp — deja existente — apoi Telegram/CLI/Web) și printr-un
Public Runtime API.

## Ce am furat de la OpenClaw și Hermes

Cercetate 2026-07-03 (docs.openclaw.ai, hermes-agent.nousresearch.com, repouri):

| Pattern | Sursă | Cum îl aplicăm |
|---|---|---|
| Un singur daemon gateway = „source of truth" pt sesiuni/rutare/canale | OpenClaw | `feral-server` = un proces, single-instance lock |
| „Platform differences live in the entry point, not the agent" — o clasă `AIAgent` pt CLI/gateway/editor | Hermes | Deja avem: `AgentLoop` transport-agnostic. Extindem principiul la Rust: `feral-core` crate + două entry-point-uri (Tauri app, feral-server) |
| Session key = `(user_id, platform)` → SQLite persistent | Hermes | Deja avem per-connector session ids în sidecar; le păstrăm |
| Service install: systemd/launchd user service la onboard; Windows = companion/tray | OpenClaw | `feral-server service install` → schtasks (Win), systemd user (Linux) |
| CLI vorbește cu daemonul (`openclaw gateway`, `hermes gateway start`) | ambele | `feral-server start/status/stop` + Public API ca substrat |
| Flow gateway: platform event → adapter → authorize → resolve session → agent → reply prin același adapter | Hermes | Identic cu ConnectorManager-ul nostru existent — validare că designul e sănătos |

Ce NU luăm: pivot cloud/VPS (Hermes Modal/Daytona), multi-agent routing
(OpenClaw), mobile nodes. Moat-ul Feral e localul; astea sunt post-moat.

## Insight-ul central

Stack-ul azi:

```
React UI → Tauri IPC → Rust host (lib.rs) → stdin/stdout NDJSON → Bun sidecar
                                   ↑______________ HTTP 11435 ______________|
                                        (inference, OpenAI-compat, LoRA)
```

Sidecarul vorbește cu modelul DEJA prin HTTP (11435), nu prin Tauri. Conectorii
trăiesc DEJA în sidecar. Deci punctul de decuplare NU e sidecar↔host, ci
**UI↔host**: tot ce e sub webview funcționează headless dacă host-ul Rust
poate porni fără fereastră. Protocolul stdin/stdout host↔sidecar rămâne
neschimbat — zero risc pe calea RSI/LoRA/embed care tocmai a trecut smoke-ul
Fazei 4.

## Arhitectura țintă

```
[Discord] [Slack] [WhatsApp] [Telegram*] ──┐        [CLI] [Web UI*] [Desktop App**]
                                           │                  │ (HTTP+SSE, token)
                                    Bun sidecar               │
                                 (AgentLoop, conectori)       │
                                           ↕ stdin/stdout     │
                              feral-server (Rust, headless) ──┘
                        = feral-core crate + entry point fără webview
                     inference 11435 + Public Runtime API + supervizare sidecar

Desktop app (Tauri) = feral-core crate + entry point cu webview (ca azi,
in-process — devine client HTTP al daemonului abia în Faza 5, vezi D4)
* = viitor   ** = Faza 5
```

## Decizii

**⚑ D1 — Cine servește modelul headless: `feral-core` crate + bin `feral-server`.**
Spargem `src-tauri/src` într-un workspace crate `feral-core` (inference.rs,
models.rs, api.rs, embeddings, feral_agent.rs supervizare sidecar, rsi/,
settings, paths, connectors config) și două binare subțiri: aplicația Tauri
(webview + comenzi IPC, ca azi) și `feral-server` (fără webview). Un singur
cod de inferență, `rsi_set_lora` și pipeline-ul LoRA merg identic headless.
Alternative respinse: sidecarul să pornească `llama-server` upstream (două căi
de inferență, pierde LoRA/RSI IPC); Tauri cu flag `--headless` (cară webview-ul
pe servere).

**D2 — Cuplarea la Tauri se rupe printr-un trait, nu prin rescriere.**
`lib.rs` emite evenimente spre UI (`app.emit`). `feral-core` primește un trait
`HostEvents` (sau echivalent minimal): implementarea Tauri emite spre webview;
implementarea headless loghează + le difuzează pe canalul de evenimente al
Public API (SSE). Comenzile `#[tauri::command]` devin wrappere subțiri peste
funcții din `feral-core`.

**D3 — Public Runtime API = api.rs promovat, nu server nou.**
Extindem router-ul axum existent (11435, bearer token, 127.0.0.1) cu:
- `POST /agent/chat` (SSE stream) — forward spre sidecar prin canalul
  stdin/stdout existent, cu `session_id` (default `api`); aceeași memorie,
  același LoRA, aceleași tool-uri ca desktop/conectori.
- `GET /agent/status` — model încărcat, LoRA activ, sidecar alive, conectori.
- `GET /agent/memory/search?q=` — căutare FMS.
- `POST /connectors/reload` — echivalentul poke-ului existent.
- Dreams/Training/Evolution: read-only status în v1 (`GET /agent/rsi/status`);
  triggere (`dream_now`, `train_now`) în v1 doar dacă sunt triviale de expus —
  altfel v2.
Rămâne 127.0.0.1-only + token (posture-ul actual din api.rs). Expunere LAN =
non-goal explicit (conectorii sunt outbound, nu au nevoie de porturi deschise).

**⚑ D4 — Desktop-ca-client se amână (slice opțional).**
În 4.5 desktop-ul continuă să-și îmbede host-ul (feral-core in-process) ca azi.
Coliziunea desktop+daemon simultan se rezolvă prin single-instance lock pe
11435: al doilea proces detectează portul ocupat și (v1) refuză pornirea cu
mesaj clar. Migrarea desktop-ului la client pur al daemonului = Faza 5 (e
schimbarea cu cel mai mare risc UI și nu blochează „serviciu AI independent").

**D5 — Service install: Windows întâi.**
`feral-server service install|uninstall` → Task Scheduler logon task (gratuit,
nativ, fără NSSM). Linux: systemd user unit. macOS: amânat (fază viitoare,
consistent cu targetul actual).

## Slices

1. **Slice 1 — Spargerea crate-ului.** `feral-core` ca workspace member;
   `src-tauri` devine consumator subțire. Criteriu: `cargo build` pe ambele
   binare, aplicația desktop funcționează identic (smoke manual), zero
   schimbare de protocol sidecar.
2. **Slice 2 — `feral-server` bin.** Entry point headless: config din
   `~/.feral`, spawn+supervizare sidecar (codul existent din feral_agent.rs),
   serve 11435, single-instance lock, log pe stderr/fișier. Criteriu: cu
   desktop-ul ÎNCHIS, `feral-server start` + mesaj pe Discord → răspuns de la
   același creier (memoria comună vizibilă).
3. **Slice 3 — Public Runtime API v1.** Endpoint-urile din D3. Criteriu:
   `curl -N /agent/chat` streamează un răspuns; sesiunea apare în memoria
   unificată.
4. **Slice 4 — Service + CLI UX.** `start/stop/status/service install`,
   docs (`docs/HEADLESS.md`). Criteriu: reboot → serviciul pornește →
   Discord răspunde fără nicio fereastră deschisă.
5. **Slice 5 (opțional, gated pe D4) — Desktop detectează daemonul** și afișează
   banner „running as service" în loc să pornească al doilea host.

## Non-goals (4.5)

- Expunere în LAN/internet a API-ului (conectorii sunt outbound).
- Multi-user / multi-tenant. Un daemon = un creier = un om.
- macOS service install.
- Web dashboard propriu (Control-UI à la OpenClaw) — Public API îl face posibil
  mai târziu.
- Mutarea desktop-ului pe client pur (Faza 5).

## Riscuri

- **Spargerea lib.rs (3600+ linii) e chirurgie.** Mitigare: Slice 1 mută
  module întregi, nu rescrie; comenzile Tauri rămân în src-tauri ca wrappere.
- **Două host-uri simultan (desktop + serviciu)** → lock pe 11435, mesaj clar.
- **Build-ul Vulkan pe Windows** are rețetă fragilă (vezi
  reference_windows_vulkan_build) — feral-server moștenește aceleași feature
  flags; nimic nou, dar de verificat la Slice 2.
- **RSI watchdog/auto-revert** presupune azi restartul app-ului desktop;
  headless trebuie să-și facă self-restart (serviciul îl repornește) — de
  verificat la Slice 2 că marker-ul PlannedExit funcționează sub schtasks.
