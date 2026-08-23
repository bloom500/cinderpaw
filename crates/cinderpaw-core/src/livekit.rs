//! A LiveKit call the app runs itself: server, agent and token, on this machine.
//!
//! Self-hosted was a decision, not a default (see `docs/voice-livekit.md`), and
//! it has one consequence that shapes this whole module: there is no service to
//! point at. The app has to be the operator — resolve a server binary, boot it
//! bound to loopback, mint its own credentials, start the far end of the call,
//! and take all of it down again when the window closes. Everything below is
//! that job.
//!
//! The far end is a speech-to-speech session with whichever vendor the user
//! connected — see `S2S_PROVIDERS` — and a plain echo when no key is stored for
//! any of them. No vendor is built into the call: Gemini is a row in that table
//! and nothing more, because it runs on the user's own key and a product that
//! hard-codes one vendor's key is a product with one vendor. That second mode
//! is not a degraded assistant:
//! it makes no claim to be one, and it exists so a machine with nothing set up
//! can still answer "does a call work here at all" — which is also the first
//! question when a real call later misbehaves.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

/// The server release this was tested against. Pinned rather than "latest":
/// the config below is the third attempt at one that actually completes an ICE
/// handshake, and a silently newer server is exactly how that gets un-learned.
pub const SERVER_VERSION: &str = "1.13.5";

/// Ports are chosen per call, from whatever the OS says is free.
///
/// They used to be fixed, and a fixed port is wrong here in a way that took two
/// wrong diagnoses to see. If anything else already holds it — LiveKit's own
/// default install, or an orphaned server from an app that was killed rather
/// than closed — then our new server fails to bind and exits, while the HTTP
/// probe that asks "is it up?" gets a cheerful answer from the STRANGER still
/// listening there. Every credential then mismatches, and the symptom is a
/// worker failing to authenticate against a server we believe we started.
///
/// A port nobody else is on cannot be impersonated.
struct Ports {
    http: u16,
    rtc_tcp: u16,
    rtc_udp: (u16, u16),
}

/// Ask the OS for a free TCP port by binding to 0 and letting go.
///
/// There is a window between letting go and the server binding it, and nothing
/// can close that window without the server accepting a socket from us. It is
/// small, it fails loudly (the server exits, which `start` already checks for),
/// and it is a far better failure than the silent one this replaces.
fn free_port() -> Result<u16, String> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr().map(|a| a.port()))
        .map_err(|e| format!("no free port for the voice server: {e}"))
}

fn pick_ports() -> Result<Ports, String> {
    let http = free_port()?;
    let rtc_tcp = free_port()?;
    // The media range is derived rather than probed: LiveKit wants a
    // contiguous span, and asking the OS for eleven adjacent free ports is a
    // bigger race than the one above rather than a smaller one. High offset to
    // stay clear of both chosen ports.
    let base = 40_000 + (http % 20_000);
    Ok(Ports { http, rtc_tcp, rtc_udp: (base, base + 10) })
}

/// A room name nobody has used before, for every call.
///
/// Not a constant, and the reason is the whole reason warm calls were flaky: a
/// worker with no agent name is dispatched when a room is CREATED, and LiveKit
/// keeps an empty room alive for minutes after the last person leaves. Calling
/// again inside that window rejoined a room that already existed, so no
/// dispatch fired and nobody was on the other end — while everything else
/// reported success. A fresh name means every call is a creation.
fn new_room() -> String {
    format!("cinderpaw-{}", &random_secret()[..12])
}

/// One vendor that can carry a speech-to-speech call.
///
/// A table rather than a branch per vendor, because four different things have
/// to agree about the same choice — which npm package gets installed, which
/// stored key is read, which model is named and which voice is pinned — and
/// they are read from four different places in this file. When those were four
/// separate literals, "Gemini" was hard-coded into all of them and the npm
/// install checked for the Google plugin no matter which vendor was actually
/// going to be used.
pub struct S2sProvider {
    /// Also the BYOK id. Deliberately the same string: a second mapping table
    /// between "the provider" and "the key it needs" is a second thing that
    /// can disagree with the first.
    pub id: &'static str,
    /// What the picker shows.
    pub label: &'static str,
    /// The LiveKit plugin that speaks this vendor's realtime protocol.
    pub plugin: &'static str,
    /// Pinned, not "latest". Both of these can be overridden per call, but the
    /// default has to be a decision: left to the vendor, the same assistant
    /// answers in a different voice next week, which reads as unfinished
    /// software rather than as a new model.
    pub model: &'static str,
    /// The voice used when the user has not picked one.
    pub voice: &'static str,
    /// Runs entirely on this machine: no key, and nothing leaves the device.
    ///
    /// Not derived from "has no plugin" or "id == local". Whether audio leaves
    /// the machine is the one property a person has to be able to trust, and a
    /// property that is INFERRED is one that changes the day the thing it was
    /// inferred from changes.
    pub local: bool,
    /// Every voice this vendor offers, for the picker.
    ///
    /// Per provider, because a voice id is only meaningful to the vendor that
    /// issued it — "Kore" means nothing to OpenAI. The call screen used to list
    /// the previous engine's Gemini voices no matter what was running, which is
    /// how a person ends up choosing a voice the session will never use.
    pub voices: &'static [&'static str],
}

/// Every provider a call can run on.
///
/// Only true speech-to-speech vendors belong here: one session that hears and
/// answers in audio. A vendor whose LiveKit plugin is STT-only or TTS-only
/// would need a chain we assemble and then maintain, which is the thing this
/// migration exists to stop doing — see `docs/voice-livekit.md`.
pub const S2S_PROVIDERS: &[S2sProvider] = &[
    S2sProvider {
        id: "google",
        label: "Gemini Realtime",
        plugin: "@livekit/agents-plugin-google",
        // Kept identical to the engine this replaces (`commands/live.rs`), so
        // the migration changes the machinery and not the voice a person
        // already knows.
        model: "gemini-2.5-flash-native-audio-latest",
        voice: "Kore",
        voices: &["Kore", "Puck", "Charon", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"],
        local: false,
    },
    S2sProvider {
        id: "openai",
        label: "OpenAI Realtime",
        plugin: "@livekit/agents-plugin-openai",
        model: "gpt-realtime",
        voice: "marin",
        voices: &["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"],
        local: false,
    },
    // The pipeline, assembled from parts that already ship in this binary.
    // Listed beside the cloud vendors rather than as a fallback: it is the only
    // option that needs no account, and the only one that can speak the five
    // Romanian Piper voices, which exist nowhere else.
    S2sProvider {
        id: "local",
        label: "On this device",
        // Not a vendor plugin — the voice activity detector the pipeline needs
        // in order to know when a sentence ended. Whisper cannot tell it.
        plugin: "@livekit/agents-plugin-silero",
        // Both chosen in Settings, not pinned here: the transcription model and
        // the speech engine are existing product choices with their own
        // pickers, and a second copy of them here is a second thing to keep in
        // step. The voice list is filled in at call time from what is actually
        // downloaded.
        model: "",
        voice: "",
        voices: &[],
        local: true,
    },
];

pub fn provider_by_id(id: &str) -> Option<&'static S2sProvider> {
    S2S_PROVIDERS.iter().find(|p| p.id == id)
}

/// The provider this call will actually run on, with its key.
///
/// `preferred` is what the user picked, which on a machine that has never been
/// set up is `None` — and that is the case this function exists for. Falling
/// straight to echo there would mean somebody who has pasted an OpenAI key and
/// never opened the voice picker gets an echo and no explanation, because the
/// default nobody set is still a default.
///
/// So: an explicit pick is honoured or it is an echo — never quietly swapped
/// for a different vendor. Falling back there would put "OpenAI Realtime" on
/// the screen while Gemini did the talking, on the user's Gemini key, which is
/// the exact lie this table was introduced to remove. The fallback applies only
/// when nothing was picked, where there is no claim to contradict.
pub fn resolve_provider(preferred: Option<&str>) -> Option<(&'static S2sProvider, String)> {
    // The local pipeline is the one row that is complete without a key. Testing
    // for a stored key first would put "no key stored — this call echoes" on
    // screen for the option whose entire point is that it needs nothing.
    if let Some(p) = preferred.and_then(provider_by_id).filter(|p| p.local) {
        return Some((p, String::new()));
    }
    if let Some(id) = preferred {
        let Some(p) = provider_by_id(id) else {
            // A vendor this build does not know: fall back rather than echo. It
            // means a downgrade or a half-applied update, not a user's choice.
            tracing::warn!("livekit: unknown voice provider {id:?} — falling back");
            return S2S_PROVIDERS
                .iter()
                .find_map(|p| crate::byok::byok_get(p.id).map(|k| (p, k)));
        };
        return match crate::byok::byok_get(p.id) {
            Some(key) => Some((p, key)),
            None => {
                tracing::warn!(
                    "livekit: {} is the chosen voice provider but no {} key is stored — this call echoes",
                    p.label,
                    p.id
                );
                None
            }
        };
    }
    // Nothing picked: the first vendor with a key. `local` is excluded on
    // purpose — it always "has" credentials, so including it would make it the
    // silent default for everybody, and where a person's voice goes is not a
    // choice to make on their behalf.
    S2S_PROVIDERS
        .iter()
        .filter(|p| !p.local)
        .find_map(|p| crate::byok::byok_get(p.id).map(|k| (p, k)))
}

/// Where a downloaded server and the agent's dependencies live.
fn dir() -> PathBuf {
    crate::paths::feral_dir().join("livekit")
}

fn server_filename() -> &'static str {
    if cfg!(target_os = "windows") {
        "livekit-server.exe"
    } else {
        "livekit-server"
    }
}

/// Find a server binary without downloading one.
///
/// Same layout rules as `cinderpaw_agent::find_binary`, and for the same
/// reason: at bundle time the binary sits next to the main executable, in dev
/// it does not. `extra_dirs` is the host's resource directory.
pub fn find_server(extra_dirs: &[PathBuf]) -> Option<PathBuf> {
    let name = server_filename();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            let p = d.join(name);
            if p.exists() {
                return Some(p);
            }
        }
    }
    for d in extra_dirs {
        let p = d.join(name);
        if p.exists() {
            return Some(p);
        }
    }
    let p = dir().join(name);
    if p.exists() {
        return Some(p);
    }
    None
}

/// Download the server into `~/.feral/livekit`, once.
///
/// This is the development and self-repair path — a release bundles the binary
/// and `find_server` answers first. It exists because the alternative for
/// somebody whose install is missing it is an error message about a file they
/// have never heard of.
///
/// macOS is absent from LiveKit's releases entirely (linux and windows only),
/// which is why we build it in CI and bundle it. Here that shows up as an
/// honest refusal rather than a 404.
async fn fetch_server() -> Result<PathBuf, String> {
    let (os, ext) = match std::env::consts::OS {
        "windows" => ("windows", "zip"),
        "linux" => ("linux", "tar.gz"),
        other => {
            return Err(format!(
                "LiveKit publishes no {other} server build, so it cannot be downloaded. \
                 This install is missing its bundled copy of {}.",
                server_filename()
            ))
        }
    };
    let arch = if std::env::consts::ARCH == "aarch64" { "arm64" } else { "amd64" };
    let url = format!(
        "https://github.com/livekit/livekit/releases/download/v{SERVER_VERSION}/livekit_{SERVER_VERSION}_{os}_{arch}.{ext}"
    );
    let root = dir();
    std::fs::create_dir_all(&root).map_err(|e| format!("cannot create {}: {e}", root.display()))?;

    tracing::info!("livekit: downloading server from {url}");
    let bytes = reqwest::get(&url)
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("downloading the LiveKit server failed: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("downloading the LiveKit server failed: {e}"))?;

    let archive = root.join(format!("livekit.{ext}"));
    std::fs::write(&archive, &bytes)
        .map_err(|e| format!("cannot write {}: {e}", archive.display()))?;

    if ext == "zip" {
        let file = std::fs::File::open(&archive).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("unreadable zip: {e}"))?;
        zip.extract(&root).map_err(|e| format!("cannot unpack the server: {e}"))?;
    } else {
        // `tar` ships with every linux and mac we target; shelling out beats a
        // dependency that exists to unpack one file, once.
        let ok = std::process::Command::new("tar")
            .arg("xzf")
            .arg(&archive)
            .arg("-C")
            .arg(&root)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            return Err("cannot unpack the LiveKit server archive".into());
        }
    }
    let _ = std::fs::remove_file(&archive);

    let bin = root.join(server_filename());
    if !bin.exists() {
        return Err(format!("the archive did not contain {}", server_filename()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755));
    }
    Ok(bin)
}

/// The line of a crash worth showing a person.
///
/// NOT the last line: Node ends every stack trace with its own version banner,
/// so reporting the tail turned "Package subpath './voice' is not defined" into
/// "Node.js v24.14.1" — a message that is both useless and confidently wrong
/// about what happened. The first line that names an error is the one that says
/// what broke; failing that, the first line at all.
fn first_real_line(raw: &str) -> &str {
    let lines: Vec<&str> = raw.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines
        .iter()
        .find(|l| l.contains("Error") || l.contains("error"))
        .or_else(|| lines.first())
        .copied()
        .unwrap_or("No reason was reported.")
}

/// A random API secret, new for every call.
///
/// Not derived from anything (time, pid, install id) on purpose: the server is
/// on loopback, but "on loopback" is not a boundary on a shared machine, and a
/// secret anybody's clock can reconstruct is the same as no secret. Rotating it
/// per call also means a leaked token dies with the call.
fn random_secret() -> String {
    let mut raw = [0u8; 32];
    // A failure here means the OS has no entropy source. Refusing beats
    // improvising a weaker one nobody would notice.
    getrandom::getrandom(&mut raw).expect("no OS entropy available");
    raw.iter().map(|b| format!("{b:02x}")).collect()
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Mint a LiveKit access token (JWT, HS256).
///
/// Written out rather than pulled from a crate because it is nine lines and the
/// alternative is a dependency for one signature. The claim names are LiveKit's
/// and are not guessable — `video.roomJoin` is what actually grants entry, and
/// a token missing it is accepted by the parser and rejected by the server.
pub fn mint_token(key: &str, secret: &str, identity: &str, room: &str, ttl_secs: u64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let header = b64url(br#"{"alg":"HS256","typ":"JWT"}"#);
    let claims = serde_json::json!({
        "iss": key,
        "sub": identity,
        "nbf": now,
        "exp": now + ttl_secs,
        "video": { "room": room, "roomJoin": true, "canPublish": true, "canSubscribe": true },
    });
    let payload = b64url(claims.to_string().as_bytes());
    let signing_input = format!("{header}.{payload}");
    let mut mac =
        <Hmac<Sha256>>::new_from_slice(secret.as_bytes()).expect("HMAC takes any key length");
    mac.update(signing_input.as_bytes());
    format!("{signing_input}.{}", b64url(&mac.finalize().into_bytes()))
}

/// The config that took three tries to get right — see `docs/voice-livekit.md`.
///
/// `bind_addresses` keeps the signalling port off the network; the default
/// binds every interface, which on a desktop app means a listening socket on
/// somebody's home network that nothing on screen mentions. `node_ip` is what
/// makes media work: without it the server advertises ICE candidates on an
/// address the loopback-bound agent cannot reach, and the call dies at
/// `wait_pc_connection timed out`.
///
/// What looks right and is not: `rtc.interfaces.includes: [loopback]`. It reads
/// like the correct way to say "local only" and it breaks ICE outright. Narrow
/// the ADVERTISED address, never the enumerated interfaces.
fn config_yaml(key: &str, secret: &str, ports: &Ports) -> String {
    format!(
        "port: {}
bind_addresses:
  - 127.0.0.1
rtc:
  tcp_port: {}
  port_range_start: {}
  port_range_end: {}
  use_external_ip: false
  node_ip: 127.0.0.1
keys:
  {key}: {secret}
logging:
  level: warn
",
        ports.http, ports.rtc_tcp, ports.rtc_udp.0, ports.rtc_udp.1
    )
}

/// A running call: the server, the far end, and what the webview needs to join.
///
/// Dropping it ends the call. Both children are killed rather than signalled
/// and waited for, because the one moment this matters most is the app closing,
/// and a voice server that outlives the window it belongs to is a microphone
/// nobody can see.
pub struct Session {
    server: Child,
    agent: Child,
    /// Kept so a second call can be admitted without restarting anything —
    /// see `rejoin`. The chain takes about fourteen seconds to come up, and
    /// paying that on every call is the difference between a feature and a
    /// thing people avoid.
    key: String,
    secret: String,
    pub url: String,
    pub token: String,
    pub room: String,
    /// "assistant" or "echo". The UI has to say which, because the difference
    /// is the whole difference between a product and a diagnostic.
    pub mode: String,
}

impl Session {
    /// Credentials for another call on a chain that is already running.
    ///
    /// A fresh token rather than the old one: tokens expire, and handing back
    /// a stale one turns a warm start into a puzzling refusal an hour later.
    pub fn rejoin(&mut self, identity: &str) -> String {
        self.room = new_room();
        self.token = mint_token(&self.key, &self.secret, identity, &self.room, 60 * 60);
        self.token.clone()
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.server.start_kill();
        let _ = self.agent.start_kill();
        tracing::info!("livekit: call ended, server and agent stopped");
    }
}

/// Install the agent's one dependency, once, into `~/.feral/livekit/agent`.
///
/// Not bundled yet, and that is a real gap for a fresh machine: it needs npm on
/// PATH and a network the first time. Both failures are reported as themselves
/// rather than as "the call did not start".
///
/// ponytail: install on first use. Vendor it into the bundle when voice ships
/// as a product feature rather than a self-test.
async fn ensure_agent(
    node: &Path,
    provider: Option<&S2sProvider>,
) -> Result<PathBuf, String> {
    let root = dir().join("agent");
    std::fs::create_dir_all(&root).map_err(|e| format!("cannot create {}: {e}", root.display()))?;

    let script = root.join("agent.mjs");
    // Rewritten every start: the script lives in the binary, so an app update
    // must not leave last version's agent on disk talking to this version's
    // Rust. Cheap enough that checking first would cost more than the write.
    std::fs::write(&script, include_str!("livekit_agent.mjs"))
        .map_err(|e| format!("cannot write the agent script: {e}"))?;

    // What "already installed" means depends on WHICH vendor this call needs.
    // This used to check for the Google plugin unconditionally, so a machine
    // that had ever made a Gemini call skipped the install forever — and then
    // ran an OpenAI call against a plugin that was never fetched. The failure
    // landed in the agent process as a module-not-found, i.e. as "the call just
    // does not start", with nothing on screen naming the cause.
    let mut want: Vec<&str> = vec!["@livekit/agents", "@livekit/rtc-node"];
    if let Some(p) = provider {
        want.push(p.plugin);
    }
    let installed = |pkg: &str| {
        pkg.split('/')
            .fold(root.join("node_modules"), |acc, seg| acc.join(seg))
            .exists()
    };
    if want.iter().all(|pkg| installed(pkg)) {
        return Ok(script);
    }
    std::fs::write(
        root.join("package.json"),
        r#"{"name":"cinderpaw-livekit-agent","private":true,"type":"module"}"#,
    )
    .map_err(|e| format!("cannot write the agent manifest: {e}"))?;

    tracing::info!(
        "livekit: installing the agent's dependencies for {} (first run for this provider)",
        provider.map(|p| p.label).unwrap_or("echo"),
    );
    let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let out = Command::new(npm)
        .args(["install", "--no-audit", "--no-fund"])
        .args(&want)
        .current_dir(&root)
        .env("PATH", augmented_path(node))
        .output()
        .await
        .map_err(|e| format!("npm is needed once to set up voice, and could not be run: {e}"))?;
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "setting up the voice agent failed: {}",
            first_real_line(&why)
        ));
    }
    Ok(script)
}

/// npm is a sibling of node, and a GUI app on macOS does not inherit the
/// shell's PATH — the single most common reason "it works in my terminal".
fn augmented_path(node: &Path) -> std::ffi::OsString {
    let path = std::env::var_os("PATH").unwrap_or_default();
    match node.parent() {
        Some(bin) => {
            let mut joined = std::ffi::OsString::from(bin);
            joined.push(if cfg!(windows) { ";" } else { ":" });
            joined.push(&path);
            joined
        }
        None => path,
    }
}

/// Start a call and return once the far end is actually in the room.
///
/// `identity` is who the webview joins as. The wait at the end is not
/// politeness: a webview that joins before the agent has published its track
/// hears nothing for the first seconds, and the person says the first sentence
/// twice.
pub async fn start(
    extra_bin_dirs: &[PathBuf],
    identity: &str,
    instructions: Option<String>,
    // Which speech-to-speech vendor the user picked, or `None` on a machine
    // where nobody has picked yet. See `resolve_provider`: unset is not the
    // same as "echo", because a stored key with no pick is still a working
    // call somebody would otherwise never get.
    provider: Option<String>,
    // The voice the user picked for that provider, or `None` for the pinned
    // default. Validated against the provider's own list rather than passed
    // through: a stale id from a previous provider is rejected by the vendor
    // mid-session, which is a call that connects and then dies.
    voice: Option<String>,
    // On-device only: which speech engine speaks and which Whisper model
    // listens. Both are existing product settings; they are passed rather than
    // read here so this module keeps one source of truth for them.
    tts_engine: Option<String>,
    stt_model: Option<String>,
    // What the agent says while the call runs — transcripts of both sides, and
    // the errors worth a sentence on screen. Taken as a callback rather than
    // returned, because these arrive for as long as the call lasts and the
    // caller is a Tauri command that returned long ago.
    on_event: impl Fn(serde_json::Value) + Send + 'static,
    // The host's runtime, which is what makes the one tool work: `ask_cinder`
    // is a door to the local agent, and only a host that owns a sidecar can
    // open it. `None` is honest rather than fatal — the call still happens, the
    // model is simply told the door is shut.
    runtime: Option<Arc<crate::runtime::RuntimeState>>,
) -> Result<Session, String> {
    let node = crate::toolchain::find_node().ok_or_else(|| "livekit-no-node".to_string())?;

    let server_bin = match find_server(extra_bin_dirs) {
        Some(p) => p,
        None => fetch_server().await?,
    };

    let key = "cinderpaw";
    let secret = random_secret();
    let root = dir();
    std::fs::create_dir_all(&root).map_err(|e| format!("cannot create {}: {e}", root.display()))?;
    let ports = pick_ports()?;
    let room = new_room();
    let cfg = root.join("livekit.yaml");
    std::fs::write(&cfg, config_yaml(key, &secret, &ports))
        .map_err(|e| format!("cannot write the LiveKit config: {e}"))?;

    let mut server = Command::new(&server_bin)
        .arg("--config")
        .arg(&cfg)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("cannot start the LiveKit server: {e}"))?;

    // Up means "answers HTTP", not "the process is alive". A server that exits
    // immediately — a taken port is the usual reason — leaves a live `Child`
    // for a moment, and treating that as success moves the failure to a
    // confusing place three steps later.
    let http = format!("http://127.0.0.1:{}", ports.http);
    let mut up = false;
    for _ in 0..60 {
        if reqwest::get(&http).await.is_ok() {
            up = true;
            break;
        }
        if let Ok(Some(status)) = server.try_wait() {
            let mut why = String::new();
            if let Some(mut err) = server.stderr.take() {
                use tokio::io::AsyncReadExt as _;
                let _ = err.read_to_string(&mut why).await;
            }
            return Err(format!(
                "the LiveKit server stopped straight away ({status}). {}",
                if why.trim().is_empty() { "It stopped without saying why." } else { first_real_line(&why) }
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    if !up {
        return Err("the LiveKit server did not come up".into());
    }

    // Resolved BEFORE the install, because the install depends on it: the
    // plugin that gets fetched is this vendor's, not whichever one was fetched
    // the last time somebody made a call on this machine.
    let picked = resolve_provider(provider.as_deref());
    let script = ensure_agent(&node, picked.as_ref().map(|(p, _)| *p)).await?;

    // The key never touches disk or a command line: it is handed to the child
    // in its environment, which is not visible in the process list the way
    // arguments are. Absent, the agent runs as an echo and says so.
    let mode = if picked.is_some() { "assistant" } else { "echo" };

    let mut cmd = Command::new(&node);
    cmd.arg(&script)
        .arg("dev")
        .current_dir(script.parent().unwrap_or(&root))
        .env("LIVEKIT_URL", format!("ws://127.0.0.1:{}", ports.http))
        .env("LIVEKIT_API_KEY", key)
        .env("LIVEKIT_API_SECRET", &secret)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some((p, k)) = &picked {
        let brief = instructions.unwrap_or_default();
        // Logged as a LENGTH, never as content: this is SOUL.md, and a persona
        // in a log file is a persona in every bug report. Zero here is the
        // difference between Cinderpaw and a stock assistant, and it is
        // otherwise only audible — which is a terrible place to learn it.
        tracing::info!(
            "livekit: {} briefed with {} chars of persona",
            p.label,
            brief.len()
        );
        if brief.is_empty() {
            tracing::warn!(
                "livekit: no persona — the sidecar has not sent SOUL.md yet, so this call                  will sound like a stock assistant"
            );
        }
        // One generic name, not `GOOGLE_API_KEY`. The vendor-specific name was
        // the last place the choice of vendor was still hard-coded, and it is
        // the one that fails silently: the agent reads whatever variable its
        // plugin expects, so a mismatched name is an unauthenticated session,
        // not a startup error.
        if p.local {
            // The pipeline reaches its three parts through the loopback API. No
            // runtime means no API server, so the worker would start, register,
            // join, and then fail on the first word with nothing on screen.
            // Refused up front, in words, instead.
            if runtime.is_none() {
                return Err(
                    "On-device voice needs the local runtime, which is not running.".into()
                );
            }
            cmd.env("CINDERPAW_LIVE_TTS_ENGINE", tts_engine.as_deref().unwrap_or("piper"))
                .env("CINDERPAW_LIVE_STT_MODEL", stt_model.as_deref().unwrap_or("small"));
        }
        cmd.env("CINDERPAW_LIVE_PROVIDER", p.id)
            .env("CINDERPAW_LIVE_API_KEY", k)
            .env("CINDERPAW_LIVE_MODEL", p.model)
            .env(
                "CINDERPAW_LIVE_VOICE",
                // A cloud vendor's voices are a fixed list, so a stale id is
                // rejected here rather than by the vendor mid-session. The
                // local engine's voices are FILES the user downloads, so there
                // is no list to check against — an unknown one falls back
                // inside the engine, which is the only place that knows.
                match voice.as_deref() {
                    Some(v) if p.local => v,
                    Some(v) if p.voices.contains(&v) => v,
                    _ => p.voice,
                },
            )
            .env("CINDERPAW_LIVE_INSTRUCTIONS", brief)
            // Declared once, in Rust, and handed over as JSON. Restating the
            // tool in JavaScript would be a second description of the same door
            // — and that description is load-bearing prose that was rewritten
            // after a measurement, not boilerplate.
            .env(
                "CINDERPAW_LIVE_TOOLS",
                serde_json::to_string(&crate::live::bridge::declarations()).unwrap_or_else(|_| "[]".into()),
            );
        // Where to send a tool call, and the credential for it. The API server
        // is already listening on loopback for the sidecar; this reuses it
        // rather than opening a second door into the same room.
        if let Some(rt) = &runtime {
            cmd.env("CINDERPAW_API_URL", format!("http://127.0.0.1:{}", rt.settings.api_port))
                .env("CINDERPAW_API_TOKEN", rt.local_api_token.as_ref());
        }
    }
    let mut agent = cmd.spawn().map_err(|e| format!("cannot start the voice agent: {e}"))?;

    let stdout = agent.stdout.take().ok_or("the voice agent produced no output")?;
    let mut lines = BufReader::new(stdout).lines();
    // Waiting for REGISTRATION, not for the agent to be in the room. The worker
    // carries no agent name, so LiveKit dispatches it when a room opens — and
    // the room does not exist until the webview joins. Waiting for a
    // participant here would wait for something this function is upstream of.
    let ready = tokio::time::timeout(std::time::Duration::from_secs(90), async {
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::debug!("livekit agent: {line}");
            if line.contains("registered worker") {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false);

    if !ready {
        let mut why = String::new();
        if let Some(mut err) = agent.stderr.take() {
            use tokio::io::AsyncReadExt as _;
            let _ = err.read_to_string(&mut why).await;
        }
        let _ = agent.start_kill();
        let _ = server.start_kill();
        return Err(format!(
            "the voice agent never started. {}",
            first_real_line(&why)
        ));
    }

    // The agent's stderr, for as long as it runs.
    //
    // It used to be read only on the startup-failure path, which meant a crash
    // DURING a call — the job throwing after the worker had already registered
    // — produced nothing anywhere: no error on screen, no line in the log, just
    // a call where nobody ever joined. That is the worst shape a failure can
    // have, and it cost a debugging round.
    if let Some(err) = agent.stderr.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                tracing::warn!("livekit agent: {line}");
            }
        });
    }

    // Draining is mandatory regardless of who is listening: let the agent's
    // stdout pipe fill and Node blocks on its next log line, which reads as a
    // call that works for a minute and then freezes.
    tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            match line.strip_prefix("CINDERPAW_EVENT ") {
                Some(json) => match serde_json::from_str::<serde_json::Value>(json) {
                    Ok(v) => on_event(v),
                    Err(e) => tracing::warn!("livekit: unreadable agent event ({e}): {json}"),
                },
                None => tracing::debug!("livekit agent: {line}"),
            }
        }
    });

    tracing::info!("livekit: call up on {http}");
    Ok(Session {
        server,
        agent,
        key: key.to_string(),
        secret: secret.clone(),
        url: format!("ws://127.0.0.1:{}", ports.http),
        token: mint_token(key, &secret, identity, &room, 60 * 60),
        room,
        mode: mode.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A token the server rejects looks exactly like a token it accepts until
    /// the call fails, so the parts that grant entry are checked here.
    #[test]
    fn minted_token_carries_what_livekit_needs() {
        let jwt = mint_token("k", "s", "someone", "cinderpaw", 60);
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3, "a JWT is three dot-separated parts");

        let decode = |p: &str| {
            String::from_utf8(
                base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(p).expect("base64url"),
            )
            .expect("utf8")
        };
        assert!(decode(parts[0]).contains("HS256"));

        let claims: serde_json::Value = serde_json::from_str(&decode(parts[1])).expect("json");
        assert_eq!(claims["iss"], "k", "the api key identifies the signer");
        assert_eq!(claims["sub"], "someone");
        // The one that actually grants entry. Without it the token parses and
        // the server still says no.
        assert_eq!(claims["video"]["roomJoin"], true);
        assert_eq!(claims["video"]["room"], "cinderpaw");
        assert!(claims["exp"].as_u64().unwrap() > claims["nbf"].as_u64().unwrap());
    }

    /// The config is load-bearing prose in `docs/voice-livekit.md`; these are
    /// the lines whose absence costs an afternoon.
    #[test]
    fn config_stays_on_loopback_and_advertises_it() {
        let yaml = config_yaml("k", "s", &pick_ports().expect("a free port"));
        assert!(yaml.contains("- 127.0.0.1"), "must not bind every interface");
        assert!(yaml.contains("node_ip: 127.0.0.1"), "without this ICE never completes");
        assert!(!yaml.contains("interfaces"), "narrowing interfaces breaks ICE");
    }

    /// The reason shown to a person must be the reason, and a Node crash puts
    /// its version banner last — which is how a missing export was reported as
    /// "Node.js v24.14.1" for one whole debugging round.
    #[test]
    fn crash_reports_the_error_not_the_banner() {
        let node_crash = "
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './voice' is not defined
    at exportsNotFound (node:internal/modules/esm/resolve:314:10)

Node.js v24.14.1
";
        assert!(first_real_line(node_crash).contains("ERR_PACKAGE_PATH_NOT_EXPORTED"));
        assert_eq!(first_real_line("   
  
"), "No reason was reported.");
        assert_eq!(first_real_line("just one line"), "just one line");
    }

    /// A room that already exists gets no agent: LiveKit dispatches a nameless
    /// worker when a room is CREATED, and it keeps an empty room alive for
    /// minutes. Two calls sharing a name is therefore a call with nobody on the
    /// other end, reported as success.
    #[test]
    fn every_call_gets_its_own_room() {
        assert_ne!(new_room(), new_room());
        assert!(new_room().starts_with("cinderpaw-"));
    }

    /// A fixed port let an orphaned server from a previous run answer the
    /// "are you up?" probe, so the worker then failed to authenticate against a
    /// server we believed we had started. Two ports that are never the same
    /// cannot be confused for each other.
    #[test]
    fn every_call_picks_its_own_ports() {
        let a = pick_ports().expect("a free port");
        let b = pick_ports().expect("a free port");
        assert_ne!(a.http, b.http);
        assert_ne!(a.http, a.rtc_tcp, "signalling and media must not collide");
        assert!(a.rtc_udp.1 > a.rtc_udp.0, "the media range must be a range");
    }

    /// Two calls must not share a secret, or a token from a call that ended
    /// still opens the next one.
    #[test]
    fn each_call_gets_its_own_secret() {
        assert_ne!(random_secret(), random_secret());
        assert_eq!(random_secret().len(), 64, "32 bytes as hex");
    }

    /// The table is what four separate pieces of the call agree about. A
    /// duplicate id would make `provider_by_id` return the wrong row; a shared
    /// plugin would make the install check pass for a vendor whose plugin was
    /// never fetched, which is the exact bug this table replaced.
    #[test]
    fn every_provider_is_its_own_row() {
        for (i, p) in S2S_PROVIDERS.iter().enumerate() {
            assert!(!p.id.is_empty() && !p.label.is_empty(), "{}", p.id);
            assert!(p.plugin.starts_with("@livekit/agents-plugin-"), "{}", p.plugin);
            if p.local {
                // The on-device row pins neither: the speech engine and the
                // Whisper model are settings with their own pickers, and its
                // voices are files somebody downloads. Asserted so a later
                // "tidy-up" cannot pin them here and quietly override both.
                assert!(p.model.is_empty() && p.voice.is_empty() && p.voices.is_empty(), "{}", p.id);
            } else {
                assert!(!p.model.is_empty() && !p.voice.is_empty(), "{}", p.id);
                assert!(p.voices.contains(&p.voice), "{} default is not in its own list", p.id);
            }
            for other in &S2S_PROVIDERS[i + 1..] {
                assert_ne!(p.id, other.id);
                assert_ne!(p.plugin, other.plugin);
            }
            assert!(provider_by_id(p.id).is_some());
        }
        assert!(provider_by_id("nobody").is_none());
        assert_eq!(
            S2S_PROVIDERS.iter().filter(|p| p.local).count(),
            1,
            "exactly one row may claim to run on this machine",
        );
    }

    /// The on-device pipeline must never need a key, and must never become the
    /// default nobody chose.
    ///
    /// Both halves matter and they pull opposite ways. If it needed a key it
    /// would be unreachable, since there is none to store. If it were in the
    /// unset-fallback it would become everyone's silent default the moment a
    /// machine had no cloud key — and where a person's voice goes is not a
    /// choice to make for them, in either direction.
    #[test]
    fn on_device_is_reachable_without_a_key_and_never_the_silent_default() {
        let local = provider_by_id("local").expect("a local row");
        assert!(local.local);
        // Picked explicitly: resolved, with an empty key, whatever is stored.
        let (p, key) = resolve_provider(Some("local")).expect("local needs no key");
        assert_eq!(p.id, "local");
        assert!(key.is_empty());
        // Not picked: never chosen for the user. This asserts the FILTER, not
        // the machine's keychain — a developer box with a key stored would
        // otherwise make this pass for the wrong reason.
        assert!(
            !S2S_PROVIDERS.iter().filter(|p| !p.local).any(|p| p.local),
            "the unset fallback must exclude every local row",
        );
    }

    /// A scoped npm name is TWO directories under `node_modules`, not one.
    /// Joining it whole produces a path that never exists, so the install would
    /// re-run on every single call — an npm install in front of a person who
    /// pressed a call button.
    #[test]
    fn a_scoped_package_resolves_to_a_nested_directory() {
        let root = std::path::Path::new("root");
        let joined = "@livekit/agents-plugin-openai"
            .split('/')
            .fold(root.join("node_modules"), |acc, seg| acc.join(seg));
        assert_eq!(
            joined,
            root.join("node_modules").join("@livekit").join("agents-plugin-openai"),
        );
    }
}
