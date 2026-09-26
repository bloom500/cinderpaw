//! The local web page (spec 2026-09-24 §4): embedded assets, one-time codes
//! and browser sessions. The page never holds the bearer token: `cinderpaw
//! open` asks for a one-time code with the token, the page trades the code
//! for an HttpOnly cookie, and the cookie is only honoured from our own
//! address. Sessions are stored as SHA-256 hashes, so the file on disk is not
//! a list of working cookies.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use sha2::{Digest, Sha256};

pub struct Assets {
    pub index_html: &'static str,
    pub app_js: &'static str,
    pub app_css: &'static str,
}

static REGISTERED: OnceLock<Assets> = OnceLock::new();

/// Called by the CLI before boot. The Desktop never calls it, so it serves no
/// page and accepts no cookies.
pub fn register(assets: Assets) {
    let _ = REGISTERED.set(assets);
}

pub fn registered() -> Option<&'static Assets> {
    REGISTERED.get()
}

pub const COOKIE: &str = "cinderpaw_session";
pub const SESSION_TTL: u64 = 30 * 24 * 3600;
// Ten minutes, not one: the installer prints the link when it cannot open a
// browser (SSH, containers), and a person reading and clicking it, or a cold
// browser on a slow machine, took longer than 60 s and landed signed out.
const CODE_TTL: u64 = 600;

pub enum Session {
    Invalid,
    Valid,
    /// Valid, and its expiry was pushed out: send the cookie again.
    Renewed,
}

struct Store {
    file: PathBuf,
    codes: HashMap<String, u64>,    // code -> expiry
    sessions: HashMap<String, u64>, // sha256(id) hex -> expiry
}

pub struct WebUi {
    pub assets: &'static Assets,
    store: Mutex<Store>,
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::getrandom(&mut buf).expect("OS random source");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn hash(id: &str) -> String {
    Sha256::digest(id.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl Store {
    fn save(&self) {
        let body = serde_json::json!({ "sessions": self.sessions });
        if let Some(dir) = self.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Err(e) = std::fs::write(&self.file, body.to_string()) {
            tracing::warn!(?e, "web: could not save browser sessions; they will not survive a restart");
        }
    }
}

impl WebUi {
    pub fn new(assets: &'static Assets, sessions_file: PathBuf, now: u64) -> Self {
        let sessions = std::fs::read_to_string(&sessions_file)
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| serde_json::from_value::<HashMap<String, u64>>(v["sessions"].clone()).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|(_, exp)| *exp > now)
            .collect();
        WebUi { assets, store: Mutex::new(Store { file: sessions_file, codes: HashMap::new(), sessions }) }
    }

    pub fn issue_code(&self, now: u64) -> String {
        let code = random_hex(16);
        let mut s = self.store.lock().unwrap();
        s.codes.retain(|_, exp| *exp > now);
        s.codes.insert(code.clone(), now + CODE_TTL);
        code
    }

    pub fn redeem(&self, code: &str, now: u64) -> Option<String> {
        let mut s = self.store.lock().unwrap();
        let exp = s.codes.remove(code)?; // single use: gone whether or not it expired
        if exp < now {
            return None;
        }
        let id = random_hex(32);
        s.sessions.insert(hash(&id), now + SESSION_TTL);
        s.save();
        Some(id)
    }

    pub fn check(&self, session: &str, now: u64) -> Session {
        let mut s = self.store.lock().unwrap();
        let key = hash(session);
        match s.sessions.get(&key).copied() {
            Some(exp) if exp > now => {
                if exp - now < SESSION_TTL / 2 {
                    s.sessions.insert(key, now + SESSION_TTL);
                    s.save();
                    Session::Renewed
                } else {
                    Session::Valid
                }
            }
            Some(_) => {
                s.sessions.remove(&key);
                s.save();
                Session::Invalid
            }
            None => Session::Invalid,
        }
    }
}

pub fn session_cookie(id: &str) -> String {
    format!("{COOKIE}={id}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_TTL}")
}

pub fn cookie_value(header: &str) -> Option<&str> {
    header.split(';').map(str::trim).find_map(|kv| kv.strip_prefix(COOKIE)?.strip_prefix('='))
}

/// The cookie is only good from our own address. Host pins the name (a DNS
/// rebinding page arrives as `evil.example:11435`); Origin pins the page that
/// sent it, and must be present on anything that is not a plain read.
pub fn same_origin(method: &str, host: Option<&str>, origin: Option<&str>, port: u16) -> bool {
    let own_host = format!("127.0.0.1:{port}");
    if host != Some(own_host.as_str()) {
        return false;
    }
    match origin {
        Some(o) => o == format!("http://{own_host}"),
        None => method == "GET" || method == "HEAD",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_ASSETS: Assets = Assets { index_html: "<div id=\"root\"></div>", app_js: "", app_css: "" };
    const T0: u64 = 1_800_000_000;

    fn ui() -> (WebUi, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        (WebUi::new(&TEST_ASSETS, dir.path().join("web-sessions.json"), T0), dir)
    }

    #[test]
    fn a_code_works_once_and_only_for_ten_minutes() {
        let (ui, _d) = ui();
        let code = ui.issue_code(T0);
        assert_eq!(code.len(), 32);
        assert!(ui.redeem(&code, T0 + CODE_TTL - 1).is_some());
        assert!(ui.redeem(&code, T0 + CODE_TTL - 1).is_none(), "second use must fail");
        let late = ui.issue_code(T0);
        assert!(ui.redeem(&late, T0 + CODE_TTL + 1).is_none(), "expired code must fail");
        assert!(ui.redeem("not-a-code", T0).is_none());
    }

    #[test]
    fn a_session_lasts_thirty_days_and_is_renewed_on_use() {
        let (ui, _d) = ui();
        let id = ui.redeem(&ui.issue_code(T0), T0).unwrap();
        assert_eq!(id.len(), 64);
        assert!(matches!(ui.check(&id, T0 + 3600), Session::Valid));
        // Past the halfway mark a use renews it for another 30 days.
        assert!(matches!(ui.check(&id, T0 + 20 * 86400), Session::Renewed));
        // Day 49 is past the original 30 days: still in (and renewed again, to day 79).
        assert!(!matches!(ui.check(&id, T0 + 49 * 86400), Session::Invalid));
        // Thirty days of silence after the last use: out.
        assert!(matches!(ui.check(&id, T0 + 80 * 86400), Session::Invalid));
        assert!(matches!(ui.check("forged", T0), Session::Invalid));
    }

    #[test]
    fn sessions_survive_a_restart_and_the_file_holds_no_usable_cookie() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("web-sessions.json");
        let id = {
            let ui = WebUi::new(&TEST_ASSETS, file.clone(), T0);
            ui.redeem(&ui.issue_code(T0), T0).unwrap()
        };
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(!text.contains(&id), "the cookie value must not be on disk");
        let again = WebUi::new(&TEST_ASSETS, file, T0 + 60);
        assert!(matches!(again.check(&id, T0 + 60), Session::Valid));
    }

    #[test]
    fn the_cookie_is_httponly_strict_and_thirty_days() {
        let c = session_cookie("abc");
        assert_eq!(c, format!("{COOKIE}=abc; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_TTL}"));
        assert_eq!(cookie_value(&format!("theme=dark; {COOKIE}=abc; x=1")), Some("abc"));
        assert_eq!(cookie_value("theme=dark"), None);
    }

    #[test]
    fn only_our_own_address_may_use_the_cookie() {
        let p = 11435;
        assert!(same_origin("GET", Some("127.0.0.1:11435"), None, p));
        assert!(same_origin("POST", Some("127.0.0.1:11435"), Some("http://127.0.0.1:11435"), p));
        assert!(!same_origin("POST", Some("127.0.0.1:11435"), None, p), "writes need an Origin");
        assert!(!same_origin("GET", Some("evil.example:11435"), None, p), "DNS rebinding");
        assert!(!same_origin("GET", Some("localhost:11435"), None, p));
        assert!(!same_origin("GET", Some("127.0.0.1:11435"), Some("http://evil.example"), p));
        assert!(!same_origin("GET", Some("127.0.0.1:11436"), None, p));
        assert!(!same_origin("GET", None, None, p));
    }
}
