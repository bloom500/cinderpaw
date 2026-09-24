//! The one-command install keeps everything in ~/.cinderpaw except four things
//! the OS insists live elsewhere (spec 2026-09-24 §3): keychain secrets, a login
//! autostart entry, a PATH entry and a Cinderpaw shortcut. This file owns the
//! last three, in both directions, so `cinderpaw uninstall` removes exactly what
//! `cinderpaw self-install` created. Keychain entries belong to byok.rs.

use std::path::{Path, PathBuf};

pub const LABEL: &str = "dev.cinderpaw.engine";
const MARK_BEGIN: &str = "# >>> cinderpaw >>>";
const MARK_END: &str = "# <<< cinderpaw <<<";

fn path_block(bin: &Path) -> String {
    format!("{MARK_BEGIN}\nexport PATH=\"{}:$PATH\"\n{MARK_END}\n", bin.display())
}

/// The profile with our block present exactly once, at the end.
pub fn with_path_block(text: &str, bin: &Path) -> String {
    let mut out = without_path_block(text);
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&path_block(bin));
    out
}

/// Removes our marked block and nothing else. A profile without both markers
/// comes back unchanged: a block the user edited apart is not ours to guess at.
pub fn without_path_block(text: &str) -> String {
    let Some(start) = text.find(MARK_BEGIN) else { return text.to_string() };
    let Some(rel) = text[start..].find(MARK_END) else { return text.to_string() };
    let mut end = start + rel + MARK_END.len();
    if text[end..].starts_with('\n') {
        end += 1;
    }
    format!("{}{}", &text[..start], &text[end..])
}

/// The file a new terminal of this login shell reads.
pub fn profile_for(home: &Path, shell: &str, macos: bool) -> PathBuf {
    match shell.rsplit('/').next().unwrap_or("") {
        "zsh" => home.join(".zshrc"),
        "bash" if macos => home.join(".bash_profile"),
        "bash" => home.join(".bashrc"),
        "fish" => home.join(".config/fish/conf.d/cinderpaw.fish"),
        _ => home.join(".profile"),
    }
}

/// fish gets a whole file of ours instead of a block in someone else's.
pub fn fish_line(bin: &Path) -> String {
    format!("set -gx PATH \"{}\" $PATH\n", bin.display())
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\'', "&apos;")
        .replace('"', "&quot;")
}

/// launchd runs the gateway in the foreground and owns it, so it survives the
/// Terminal window closing. No KeepAlive: `cinderpaw stop` must stay stopped.
pub fn launch_agent_plist(exe: &Path, log: &Path) -> String {
    let exe = xml(&exe.display().to_string());
    let log = xml(&log.display().to_string());
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\">\n<dict>\n  \
<key>Label</key>\n  <string>{LABEL}</string>\n  \
<key>ProgramArguments</key>\n  <array>\n    <string>{exe}</string>\n    <string>gateway</string>\n  </array>\n  \
<key>RunAtLoad</key>\n  <true/>\n  \
<key>StandardOutPath</key>\n  <string>{log}</string>\n  \
<key>StandardErrorPath</key>\n  <string>{log}</string>\n\
</dict>\n</plist>\n"
    )
}

pub fn systemd_unit(exe: &Path) -> String {
    format!(
        "[Unit]\nDescription=Cinderpaw engine\n\n[Service]\nExecStart=\"{}\" gateway\nRestart=no\n\n[Install]\nWantedBy=default.target\n",
        exe.display()
    )
}

/// Used twice on Linux: the shortcut (`open`) and the autostart fallback
/// (`gateway start`, with `extra` = the autostart keys).
pub fn desktop_entry(name: &str, exe: &Path, args: &str, extra: &str) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName={name}\nExec=\"{}\" {args}\nTerminal=false\nCategories=Utility;\n{extra}",
        exe.display()
    )
}

fn same_dir(a: &str, b: &str) -> bool {
    a.trim_end_matches('\\').eq_ignore_ascii_case(b.trim_end_matches('\\'))
}

pub fn user_path_with(path: &str, bin: &str) -> String {
    if path.split(';').any(|p| same_dir(p, bin)) {
        return path.to_string();
    }
    let kept: Vec<&str> = path.split(';').filter(|p| !p.is_empty()).collect();
    if kept.is_empty() {
        bin.to_string()
    } else {
        format!("{};{bin}", kept.join(";"))
    }
}

pub fn user_path_without(path: &str, bin: &str) -> String {
    path.split(';').filter(|p| !p.is_empty() && !same_dir(p, bin)).collect::<Vec<_>>().join(";")
}

pub fn ps_quote(s: &str) -> String {
    s.replace('\'', "''")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_block_is_added_once_and_removed_exactly() {
        let bin = Path::new("/home/ana maria/.cinderpaw/bin");
        let rc = "export EDITOR=vim\n";
        let once = with_path_block(rc, bin);
        assert_eq!(with_path_block(&once, bin), once, "re-running must not add a second block");
        assert!(once.contains("export PATH=\"/home/ana maria/.cinderpaw/bin:$PATH\""));
        assert_eq!(without_path_block(&once), rc);
        // A file with no trailing newline still gets the block on its own line.
        assert!(with_path_block("alias k=kubectl", bin).starts_with("alias k=kubectl\n# >>> cinderpaw"));
        // Nothing of ours: untouched.
        assert_eq!(without_path_block("export PATH=/x:$PATH\n"), "export PATH=/x:$PATH\n");
    }

    #[test]
    fn profile_follows_the_login_shell() {
        let h = Path::new("/h");
        assert_eq!(profile_for(h, "/bin/zsh", true), h.join(".zshrc"));
        assert_eq!(profile_for(h, "/bin/bash", true), h.join(".bash_profile"));
        assert_eq!(profile_for(h, "/usr/bin/bash", false), h.join(".bashrc"));
        assert_eq!(profile_for(h, "/usr/bin/fish", false), h.join(".config/fish/conf.d/cinderpaw.fish"));
        assert_eq!(profile_for(h, "", false), h.join(".profile"));
    }

    #[test]
    fn plist_escapes_the_path() {
        let p = launch_agent_plist(Path::new("/Users/o'brien & co/.cinderpaw/bin/cinderpaw"), Path::new("/l.log"));
        assert!(p.contains("<string>/Users/o&apos;brien &amp; co/.cinderpaw/bin/cinderpaw</string>"));
        assert!(p.contains("<string>gateway</string>"));
        assert!(p.contains(&format!("<string>{LABEL}</string>")));
        assert!(p.contains("<key>RunAtLoad</key>\n  <true/>"));
    }

    #[test]
    fn unit_and_desktop_entries_quote_paths_with_spaces() {
        let exe = Path::new("/home/ana maria/.cinderpaw/bin/cinderpaw");
        assert!(systemd_unit(exe).contains("ExecStart=\"/home/ana maria/.cinderpaw/bin/cinderpaw\" gateway\n"));
        let d = desktop_entry("Cinderpaw", exe, "open", "");
        assert!(d.contains("Exec=\"/home/ana maria/.cinderpaw/bin/cinderpaw\" open\n"));
        assert!(d.starts_with("[Desktop Entry]\nType=Application\nName=Cinderpaw\n"));
    }

    #[test]
    fn windows_user_path_edits_are_exact_and_case_blind() {
        let bin = r"C:\Users\Ana Maria\.cinderpaw\bin";
        assert_eq!(user_path_with("", bin), bin);
        assert_eq!(user_path_with(r"C:\a;", bin), format!(r"C:\a;{bin}"));
        let lower = r"c:\users\ana maria\.cinderpaw\bin\";
        assert_eq!(user_path_with(&format!(r"C:\a;{lower}"), bin), format!(r"C:\a;{lower}"), "already there");
        assert_eq!(user_path_without(&format!(r"C:\a;{lower};D:\b"), bin), r"C:\a;D:\b");
        assert_eq!(user_path_without(r"C:\a", bin), r"C:\a");
    }

    #[test]
    fn powershell_single_quotes_are_doubled() {
        assert_eq!(ps_quote(r"C:\Users\o'brien"), r"C:\Users\o''brien");
    }
}
