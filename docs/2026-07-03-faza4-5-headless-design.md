# Faza 4.5 — Feral Headless: „One Brain, Many Faces"

**Status: APPROVED (Darius, 2026-07-03)** cu trei completări integrate mai jos:
`docs/runtime-invariants.md`, endpoint SSE `/events`, secțiune graceful
shutdown. Deciziile D1/D4 confirmate exact cum erau.

Toate deciziile de aici și din Slice 1-6 se validează împotriva
[`runtime-invariants.md`](runtime-invariants.md).

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
| Un singur daemon gateway = „source of truth" pt sesiuni/rutare/canale | OpenClaw | binarul `feral` = un proces, single-instance lock |
| „Platform differences live in the entry point, not the agent" — o clasă `AIAgent` pt CLI/gateway/editor | Hermes | Deja avem: `AgentLoop` transport-agnostic. Extindem principiul la Rust: `feral-core` crate + două entry-point-uri (Tauri app, binarul `feral`) |
| Session key = `(user_id, platform)` → SQLite persistent | Hermes | Deja avem per-connector session ids în sidecar; le păstrăm |
| Service install: systemd/launchd user service la onboard; Windows = companion/tray | OpenClaw | `feral service install` → schtasks (Win), systemd user (Linux) |
| CLI vorbește cu daemonul (`openclaw gateway`, `hermes gateway start`) | ambele | `feral gateway start/stop/status` + Public API ca substrat |
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
                              binarul feral (Rust, headless) ──┘
                        = feral-core crate + entry point fără webview
                     inference 11435 + Public Runtime API + supervizare sidecar

Desktop app (Tauri) = feral-core crate + entry point cu webview (ca azi,
in-process — devine client HTTP al daemonului abia în Faza 5, vezi D4)
* = viitor   ** = Faza 5
```

## Decizii

**D1 (confirmat) — Cine servește modelul headless: `feral-core` crate + bin `feral`.**
Spargem `src-tauri/src` într-un workspace crate `feral-core` (inference.rs,
models.rs, api.rs, embeddings, feral_agent.rs supervizare sidecar, rsi/,
settings, paths, connectors config) și două binare subțiri: aplicația Tauri
(webview + comenzi IPC, ca azi) și binarul `feral` (fără webview). Un singur
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
Namespace-ul e `/runtime/*`, nu `/agent/*`: peste doi ani pot exista mai multe
tipuri de agenți; runtime-ul rămâne constant. Extindem router-ul axum existent
(11435, bearer token, 127.0.0.1) cu:
- `POST /runtime/chat` (SSE stream) — forward spre sidecar prin canalul
  stdin/stdout existent, cu `session_id` (default `api`); aceeași memorie,
  același LoRA, aceleași tool-uri ca desktop/conectori (invarianta 11).
- `GET /runtime/status` — model încărcat, LoRA activ, sidecar alive, conectori.
- `GET /runtime/models`, `GET /runtime/lora` — inventar + adapter activ.
- `GET /runtime/memory/search?q=` — căutare FMS.
- `GET /runtime/connectors` + `POST /runtime/connectors/reload`.
- `GET /runtime/tools` — tool-urile expuse de sidecar.
- `GET /runtime/dreams` — status Dream Cycle (read-only în v1; `dream_now` /
  `train_now` doar dacă sunt triviale de expus — altfel v2).
- `GET /events` (SSE) — **stream unificat de observabilitate**: DreamStarted,
  DreamFinished, MemoryStored, ToolExecuted, RatchetAdvanced, ConfidenceFailed,
  LoRATrainingStarted, LoRATrainingFinished. Aceeași sursă pentru toți:
  implementarea headless a trait-ului `HostEvents` (D2) publică aici; desktop-ul
  (Faza 5), CLI-ul (live logs) și conectorii (status) consumă același stream.
Rămâne 127.0.0.1-only + token (posture-ul actual din api.rs). Expunere LAN =
non-goal explicit (conectorii sunt outbound, nu au nevoie de porturi deschise).

**D3b — Runtime Manifest.** `GET /runtime/manifest` întoarce snapshot-ul
declarativ al runtime-ului: `version, models, loras, connectors, memories,
dreams, providers`. Fundația pentru `feral export` / `feral import`
(reproducibilitate) — în 4.5 doar read-only manifest; export/import = fază
viitoare.

**D4 (confirmat) — Desktop-ca-client se amână (slice opțional).**
În 4.5 desktop-ul continuă să-și îmbede host-ul (feral-core in-process) ca azi.
Coliziunea desktop+daemon simultan se rezolvă prin single-instance lock pe
11435: al doilea proces detectează portul ocupat și (v1) refuză pornirea cu
mesaj clar. Migrarea desktop-ului la client pur al daemonului = Faza 5 (e
schimbarea cu cel mai mare risc UI și nu blochează „serviciu AI independent").

**D5 — Service install: Windows întâi.**
`feral service install|uninstall` → Task Scheduler logon task (gratuit,
nativ, fără NSSM). Linux: systemd user unit. macOS: amânat (fază viitoare,
consistent cu targetul actual).

**D6 — CLI `feral` + TUI.**
Binarul headless se prezintă ca un CLI cu subcomenzi, à la
`openclaw gateway` / `hermes gateway start`:
- `feral gateway` / `feral gateway start|stop|restart|status` — daemonul.
- `feral model` — list/load/unload (peste `/runtime/models`).
- `feral doctor` — diagnostic: port 11435 liber/ocupat, token prezent, model pe
  disc, sidecar binar, GPU detectat, connectors.json valid.
- `feral help` — evident.
- `feral chat` — **TUI frumos în terminal** pentru cine preferă experiența de
  terminal: chat interactiv (peste `/runtime/chat` SSE) + status line (model,
  LoRA, mood) + live events din `/events`. Subcomenzile de management sunt
  Slice 4; TUI-ul complet e Slice 6.
Toate subcomenzile vorbesc cu daemonul prin Public Runtime API (invarianta 6:
CLI-ul e un client stateless, înlocuibil cu `curl`).

**D7 — Graceful shutdown.**
Runtime-ul nu moare niciodată cu munca pe masă. La SIGTERM / CTRL+C /
`feral gateway stop` / service stop:
1. Refuză mesaje noi (connectorii răspund „shutting down", API întoarce 503).
2. Dream Cycle în curs → checkpoint sau abort curat (fără stare parțială).
3. LoRA training în curs → oprește trainer-ul, curăță adapterele temporare;
   modelul rămâne pe adapterul activ valid (recovery-ul bare-model din
   `rsi_set_lora` rămâne plasa de siguranță).
4. Journal/provenance flush (invarianta 9: append-only, nimic pierdut).
5. Memory sync (FMS/SQLite flush + close).
6. Sidecar primește shutdown pe stdin, drenează handler-ele în zbor
   (mecanismul `#pending` există deja în TauriTransport), apoi exit.
7. Abia apoi exit 0. Timeout dur (30s) → kill, ca să nu atârne serviciul.
Marker-ul PlannedExit al watchdog-ului RSI se scrie și pe această cale, ca
restartul de serviciu să nu fie confundat cu un crash.

**D8 — Plugin API (doar contracte, zero implementare în 4.5).**
Spec-ul rezervă punctele de extensie viitoare: `Connector`, `Tool`,
`MemoryBackend`, `Provider`, `Trainer`. Toate există deja ca interfețe interne
în sidecar (Transport/connectori, tool registry, provider targets,
CliTrainer); Plugin API = promovarea lor în contracte publice documentate,
într-o fază viitoare. În 4.5 doar le numim, ca deciziile de acum să nu le
blocheze.

## Slices

1. **Slice 1 — Runtime Extraction.** `feral-core` ca workspace member;
   `src-tauri` devine consumator subțire. Nu e doar spargerea crate-ului — e
   momentul în care runtime-ul devine entitatea primară și desktop-ul un
   entry point. Criteriu: `cargo build` pe ambele binare, aplicația desktop
   funcționează identic (smoke manual), zero schimbare de protocol sidecar.
2. **Slice 2 — binarul `feral` (gateway).** Entry point headless: config din
   `~/.feral`, spawn+supervizare sidecar (codul existent din feral_agent.rs),
   serve 11435, single-instance lock, graceful shutdown (D7), log pe
   stderr/fișier. Criteriu: cu desktop-ul ÎNCHIS, `feral gateway start` +
   mesaj pe Discord → răspuns de la același creier (memoria comună vizibilă);
   CTRL+C în timpul unui răspuns → shutdown curat, journal intact.
3. **Slice 3 — Public Runtime API v1.** Endpoint-urile din D3 + `/events` SSE
   + `/runtime/manifest` (D3b). Criteriu: `curl -N /runtime/chat` streamează
   un răspuns; sesiunea apare în memoria unificată; `curl -N /events` arată
   ToolExecuted/MemoryStored live.
4. **Slice 4 — Service + CLI UX.** `feral gateway start|stop|restart|status`,
   `feral model`, `feral doctor`, `feral service install`, docs
   (`docs/HEADLESS.md`). Criteriu: reboot → serviciul pornește → Discord
   răspunde fără nicio fereastră deschisă; `feral doctor` prinde portul ocupat
   și tokenul lipsă.
5. **Slice 5 (opțional, gated pe D4) — Desktop detectează daemonul** și afișează
   banner „running as service" în loc să pornească al doilea host.
6. **Slice 6 — `feral chat` TUI.** Chat interactiv în terminal peste
   `/runtime/chat` + `/events`: status line (model, LoRA, mood), live events,
   estetică îngrijită. Criteriu: o conversație completă din terminal, fără
   desktop, cu aceeași memorie.

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
  reference_windows_vulkan_build) — binarul `feral` moștenește aceleași feature
  flags; nimic nou, dar de verificat la Slice 2.
- **RSI watchdog/auto-revert** presupune azi restartul app-ului desktop;
  headless trebuie să-și facă self-restart (serviciul îl repornește) — de
  verificat la Slice 2 că marker-ul PlannedExit funcționează sub schtasks.
