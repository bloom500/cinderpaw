//! A LiveKit call the app runs itself: server, agent and token, on this machine.
//!
//! Self-hosted was a decision, not a default (see `docs/voice-livekit.md`), and
//! it has one consequence that shapes this whole module: there is no service to
//! point at. The app has to be the operator — resolve a server binary, boot it
//! bound to loopback, mint its own credentials, start the far end of the call,
//! and take all of it down again when the window closes. Everything below is
//! that job.
//!
//! What is deliberately NOT here yet: speech recognition, a model, and speech
//! synthesis. The agent this starts echoes what it hears. Proving the transport
//! inside the real app is a separate problem from proving the brain, and doing
//! them together means a broken call and two suspects.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

/// The server release this was tested against. Pinned rather than "latest":
/// the config below is the third attempt at one that actually completes an ICE
/// handshake, and a silently newer server is exactly how that gets un-learned.
pub const SERVER_VERSION: &str = "1.13.5";

/// Loopback ports. High and unusual on purpose — 7880 is LiveKit's documented
/// default, so it is the one port a person who already self-hosts LiveKit will
/// have taken, and colliding with their real server is a rude way to fail.
const HTTP_PORT: u16 = 7885;
const RTC_TCP: u16 = 7886;
const RTC_UDP: (u16, u16) = (7896, 7906);

const ROOM: &str = "cinderpaw";

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
fn config_yaml(key: &str, secret: &str) -> String {
    format!(
        "port: {HTTP_PORT}
bind_addresses:
  - 127.0.0.1
rtc:
  tcp_port: {RTC_TCP}
  port_range_start: {}
  port_range_end: {}
  use_external_ip: false
  node_ip: 127.0.0.1
keys:
  {key}: {secret}
logging:
  level: warn
",
        RTC_UDP.0, RTC_UDP.1
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
    pub url: String,
    pub token: String,
    pub room: String,
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
async fn ensure_agent(node: &Path) -> Result<PathBuf, String> {
    let root = dir().join("agent");
    std::fs::create_dir_all(&root).map_err(|e| format!("cannot create {}: {e}", root.display()))?;

    let script = root.join("agent.mjs");
    // Rewritten every start: the script lives in the binary, so an app update
    // must not leave last version's agent on disk talking to this version's
    // Rust. Cheap enough that checking first would cost more than the write.
    std::fs::write(&script, include_str!("livekit_agent.mjs"))
        .map_err(|e| format!("cannot write the agent script: {e}"))?;

    if root.join("node_modules").join("@livekit").join("rtc-node").exists() {
        return Ok(script);
    }
    std::fs::write(
        root.join("package.json"),
        r#"{"name":"cinderpaw-livekit-agent","private":true,"type":"module"}"#,
    )
    .map_err(|e| format!("cannot write the agent manifest: {e}"))?;

    tracing::info!("livekit: installing the agent's dependencies (first run only)");
    let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let out = Command::new(npm)
        .args(["install", "--no-audit", "--no-fund", "@livekit/rtc-node"])
        .current_dir(&root)
        .env("PATH", augmented_path(node))
        .output()
        .await
        .map_err(|e| format!("npm is needed once to set up voice, and could not be run: {e}"))?;
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "setting up the voice agent failed: {}",
            why.trim().lines().last().unwrap_or("npm failed")
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
pub async fn start(extra_bin_dirs: &[PathBuf], identity: &str) -> Result<Session, String> {
    let node = crate::toolchain::find_node().ok_or_else(|| "livekit-no-node".to_string())?;

    let server_bin = match find_server(extra_bin_dirs) {
        Some(p) => p,
        None => fetch_server().await?,
    };

    let key = "cinderpaw";
    let secret = random_secret();
    let root = dir();
    std::fs::create_dir_all(&root).map_err(|e| format!("cannot create {}: {e}", root.display()))?;
    let cfg = root.join("livekit.yaml");
    std::fs::write(&cfg, config_yaml(key, &secret))
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
    let http = format!("http://127.0.0.1:{HTTP_PORT}");
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
                why.trim().lines().last().unwrap_or("Port 7885 may already be in use.")
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    if !up {
        return Err("the LiveKit server did not come up".into());
    }

    let script = ensure_agent(&node).await?;
    let agent_token = mint_token(key, &secret, "cinderpaw-agent", ROOM, 60 * 60);
    let mut agent = Command::new(&node)
        .arg(&script)
        .arg(format!("ws://127.0.0.1:{HTTP_PORT}"))
        .arg(&agent_token)
        .current_dir(script.parent().unwrap_or(&root))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("cannot start the voice agent: {e}"))?;

    let stdout = agent.stdout.take().ok_or("the voice agent produced no output")?;
    let mut lines = BufReader::new(stdout).lines();
    let ready = tokio::time::timeout(std::time::Duration::from_secs(45), async {
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::debug!("livekit agent: {line}");
            if line.contains("CINDERPAW_AGENT_READY") {
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
            "the voice agent never joined the call. {}",
            why.trim().lines().last().unwrap_or("No reason was reported.")
        ));
    }

    // Keep draining, or the agent's stdout pipe fills and Node blocks on its
    // next log line — a call that works for a minute and then freezes.
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });

    tracing::info!("livekit: call up on {http}");
    Ok(Session {
        server,
        agent,
        url: format!("ws://127.0.0.1:{HTTP_PORT}"),
        token: mint_token(key, &secret, identity, ROOM, 60 * 60),
        room: ROOM.to_string(),
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
        let yaml = config_yaml("k", "s");
        assert!(yaml.contains("- 127.0.0.1"), "must not bind every interface");
        assert!(yaml.contains("node_ip: 127.0.0.1"), "without this ICE never completes");
        assert!(!yaml.contains("interfaces"), "narrowing interfaces breaks ICE");
    }

    /// Two calls must not share a secret, or a token from a call that ended
    /// still opens the next one.
    #[test]
    fn each_call_gets_its_own_secret() {
        assert_ne!(random_secret(), random_secret());
        assert_eq!(random_secret().len(), 64, "32 bytes as hex");
    }
}
