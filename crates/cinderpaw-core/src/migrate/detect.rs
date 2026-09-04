//! Finding an existing install of another agent.
//!
//! A directory is not a find. Someone who uninstalled OpenClaw can be left with
//! an empty `~/.openclaw`, and reporting "found OpenClaw" for it sends the user
//! looking for config that is not there. A find requires a config file we can
//! actually open.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    OpenClaw,
    Hermes,
}

impl Source {
    pub fn label(self) -> &'static str {
        match self {
            Source::OpenClaw => "OpenClaw",
            Source::Hermes => "Hermes Agent",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Found {
    pub source: Source,
    /// The install root (`~/.openclaw`, `%LOCALAPPDATA%\hermes`).
    pub root: PathBuf,
    /// The config file inside it that proved this is a real install.
    pub config: PathBuf,
    /// Version stamp, when the source records one. Drives the staleness warning.
    pub version: Option<String>,
}

/// `~/.openclaw`, or the parent of `OPENCLAW_CONFIG_PATH` when set — OpenClaw
/// documents that variable as pointing at the real file.
pub fn openclaw_default_root() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("OPENCLAW_CONFIG_PATH") {
        if let Some(parent) = Path::new(&explicit).parent() {
            return Some(parent.to_path_buf());
        }
    }
    dirs::home_dir().map(|h| h.join(".openclaw"))
}

/// `%LOCALAPPDATA%\hermes` on Windows, `~/.hermes` everywhere else.
pub fn hermes_default_root() -> Option<PathBuf> {
    if cfg!(windows) {
        if let Some(local) = dirs::data_local_dir() {
            return Some(local.join("hermes"));
        }
    }
    dirs::home_dir().map(|h| h.join(".hermes"))
}

/// Config file names to try, in order, for one source tool.
///
/// One name per tool was a silent migration failure waiting to happen: the tool
/// says "No OpenClaw or Hermes install found", sends the user to `cinderpaw setup`,
/// and they start from scratch with their real config sitting right there. That
/// is the worst outcome this command has, and it costs a filename to avoid.
///
/// Only the SAME format under its other conventional extension — JSON5 is
/// routinely `.json5`, YAML is `.yaml` or `.yml` and no convention prefers one.
/// Nothing here guesses at a different layout: `config.json` for OpenClaw would
/// be an invention about their install, and inventing is how a migration reads
/// the wrong file confidently.
fn config_names(source: Source) -> &'static [&'static str] {
    match source {
        Source::OpenClaw => &["openclaw.json", "openclaw.json5"],
        Source::Hermes => &["config.yaml", "config.yml"],
    }
}

/// First candidate that exists as a file, or None.
fn first_config(root: &Path, source: Source) -> Option<PathBuf> {
    config_names(source)
        .iter()
        .map(|name| root.join(name))
        .find(|path| path.is_file())
}

pub fn detect_openclaw_at(root: &Path) -> Option<Found> {
    let config = first_config(root, Source::OpenClaw)?;
    let text = std::fs::read_to_string(&config).ok()?;
    // Version only — a parse failure here must not hide the install, because a
    // config we cannot parse is exactly what the user needs to be told about.
    let version = json5::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| {
            v.get("meta")?
                .get("lastTouchedVersion")?
                .as_str()
                .map(str::to_string)
        });
    Some(Found { source: Source::OpenClaw, root: root.to_path_buf(), config, version })
}

pub fn detect_hermes_at(root: &Path) -> Option<Found> {
    let config = first_config(root, Source::Hermes)?;
    Some(Found { source: Source::Hermes, root: root.to_path_buf(), config, version: None })
}

/// Every install we can find. `explicit_root` (from `--source`) is tried as
/// both shapes, so the user does not have to also tell us which tool it is.
pub fn detect(explicit_root: Option<&Path>) -> Vec<Found> {
    if let Some(root) = explicit_root {
        return detect_openclaw_at(root)
            .into_iter()
            .chain(detect_hermes_at(root))
            .collect();
    }
    openclaw_default_root()
        .as_deref()
        .and_then(detect_openclaw_at)
        .into_iter()
        .chain(hermes_default_root().as_deref().and_then(detect_hermes_at))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn openclaw_needs_a_readable_config_not_just_a_directory() {
        let tmp = tempdir().unwrap();
        let root = tmp.path().join(".openclaw");
        fs::create_dir_all(&root).unwrap();
        // Directory exists but holds no config: not a find.
        assert!(detect_openclaw_at(&root).is_none());

        fs::write(root.join("openclaw.json"), "{ /* json5 */ }").unwrap();
        let found = detect_openclaw_at(&root).expect("config present");
        assert_eq!(found.source, Source::OpenClaw);
        assert_eq!(found.config, root.join("openclaw.json"));
    }

    #[test]
    fn openclaw_version_comes_from_the_meta_stamp() {
        let tmp = tempdir().unwrap();
        let root = tmp.path().join(".openclaw");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("openclaw.json"),
            r#"{ meta: { lastTouchedVersion: "2026.6.11" } }"#,
        )
        .unwrap();
        assert_eq!(
            detect_openclaw_at(&root).unwrap().version.as_deref(),
            Some("2026.6.11")
        );
    }

    #[test]
    fn hermes_is_found_by_its_config_yaml() {
        let tmp = tempdir().unwrap();
        let root = tmp.path().join("hermes");
        fs::create_dir_all(&root).unwrap();
        assert!(detect_hermes_at(&root).is_none());

        fs::write(root.join("config.yaml"), "model: anthropic/claude\n").unwrap();
        let found = detect_hermes_at(&root).expect("config present");
        assert_eq!(found.source, Source::Hermes);
    }

    #[test]
    fn the_other_conventional_extension_is_still_a_find() {
        // Measured against a fixture install: a Hermes root holding `config.yml`
        // printed "No OpenClaw or Hermes install found" and pointed the user at
        // `cinderpaw setup` — i.e. start from scratch, with your real config sitting
        // right there unread. Worst outcome this command has, and a filename
        // buys it back. Same format, other conventional spelling; nothing here
        // guesses at a different layout.
        let tmp = tempdir().unwrap();

        let hermes = tmp.path().join("hermes");
        fs::create_dir_all(&hermes).unwrap();
        fs::write(hermes.join("config.yml"), "agent:\n  name: yml\n").unwrap();
        let found = detect_hermes_at(&hermes).expect("config.yml is a Hermes config");
        assert_eq!(found.config, hermes.join("config.yml"));

        let oc = tmp.path().join(".openclaw");
        fs::create_dir_all(&oc).unwrap();
        fs::write(oc.join("openclaw.json5"), "{ meta: { lastTouchedVersion: '9.9' } }").unwrap();
        let found = detect_openclaw_at(&oc).expect("openclaw.json5 is an OpenClaw config");
        assert_eq!(found.config, oc.join("openclaw.json5"));
        assert_eq!(found.version.as_deref(), Some("9.9"));
    }

    #[test]
    fn the_canonical_name_wins_when_both_exist() {
        // Two files, one install. Order decides, and it must be the documented
        // name — picking the variant would migrate whichever the user was NOT
        // editing.
        let tmp = tempdir().unwrap();
        let root = tmp.path().join("hermes");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("config.yml"), "agent:\n  name: variant\n").unwrap();
        fs::write(root.join("config.yaml"), "agent:\n  name: canonical\n").unwrap();
        assert_eq!(detect_hermes_at(&root).unwrap().config, root.join("config.yaml"));
    }

    #[test]
    fn hermes_root_is_localappdata_on_windows_and_dot_hermes_elsewhere() {
        let root = hermes_default_root().expect("a home dir exists");
        if cfg!(windows) {
            // The bug this test exists for: probing ~/.hermes on Windows finds
            // nothing, because Hermes does not put it there.
            assert!(!root.ends_with(".hermes"), "got {root:?}");
            assert!(root.ends_with("hermes"), "got {root:?}");
        } else {
            assert!(root.ends_with(".hermes"), "got {root:?}");
        }
    }
}
