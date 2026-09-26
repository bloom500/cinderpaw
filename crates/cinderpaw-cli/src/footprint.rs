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

// ── the OS side ────────────────────────────────────────────────────────────

use std::process::{Command, Stdio};

/// Ok = a thing done (quiet), Err = a sentence the user must see.
pub type Step = Result<String, String>;

/// Profiles we may have written to. Uninstall strips all of them, because the
/// login shell can change between install and uninstall.
#[cfg(unix)]
const PROFILES: [&str; 4] = [".zshrc", ".bashrc", ".bash_profile", ".profile"];

#[cfg(unix)]
fn quiet(cmd: &mut Command) -> bool {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(unix)]
fn write(path: &Path, text: &str) -> Step {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("I couldn't create {}: {e}", dir.display()))?;
    }
    std::fs::write(path, text).map_err(|e| format!("I couldn't write {}: {e}", path.display()))?;
    Ok(path.display().to_string())
}

fn exe_in(bin: &Path) -> PathBuf {
    bin.join(if cfg!(windows) { "cinderpaw.exe" } else { "cinderpaw" })
}

#[cfg(unix)]
fn macos_plist(home: &Path) -> PathBuf {
    home.join("Library/LaunchAgents").join(format!("{LABEL}.plist"))
}
#[cfg(unix)]
fn macos_app(home: &Path) -> PathBuf {
    home.join("Applications/Cinderpaw.app")
}
#[cfg(unix)]
fn systemd_file(home: &Path) -> PathBuf {
    home.join(".config/systemd/user/cinderpaw.service")
}
#[cfg(unix)]
fn xdg_autostart(home: &Path) -> PathBuf {
    home.join(".config/autostart/cinderpaw.desktop")
}
#[cfg(unix)]
fn linux_shortcut(home: &Path) -> PathBuf {
    home.join(".local/share/applications/cinderpaw.desktop")
}
#[cfg(unix)]
fn fish_file(home: &Path) -> PathBuf {
    home.join(".config/fish/conf.d/cinderpaw.fish")
}

/// Every file this module may create on unix, for uninstall and its test.
#[cfg(unix)]
fn owned_paths(home: &Path) -> Vec<PathBuf> {
    vec![
        macos_plist(home),
        macos_app(home),
        systemd_file(home),
        xdg_autostart(home),
        linux_shortcut(home),
        fish_file(home),
    ]
}

/// File-only half of install (unix): testable in a temp home. Service
/// registration (launchctl / systemctl) is `install` and `start_with_service`.
#[cfg(unix)]
fn install_files(home: &Path, bin: &Path, shell: &str) -> Vec<Step> {
    let exe = exe_in(bin);
    let macos = cfg!(target_os = "macos");
    let mut steps = Vec::new();

    let profile = profile_for(home, shell, macos);
    if profile == fish_file(home) {
        steps.push(write(&profile, &fish_line(bin)));
    } else {
        let old = std::fs::read_to_string(&profile).unwrap_or_default();
        steps.push(write(&profile, &with_path_block(&old, bin)));
    }

    if macos {
        let log = bin.parent().unwrap_or(bin).join("gateway.log");
        steps.push(write(&macos_plist(home), &launch_agent_plist(&exe, &log)));
        let app = macos_app(home).join("Contents");
        steps.push(write(
            &app.join("Info.plist"),
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\
<key>CFBundleName</key><string>Cinderpaw</string>\
<key>CFBundleIdentifier</key><string>dev.cinderpaw.open</string>\
<key>CFBundlePackageType</key><string>APPL</string>\
<key>CFBundleExecutable</key><string>cinderpaw-open</string>\
</dict></plist>\n",
        ));
        let launcher = app.join("MacOS/cinderpaw-open");
        steps.push(write(&launcher, &format!("#!/bin/sh\nexec \"{}\" open\n", exe.display())));
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755));
    } else {
        steps.push(write(&systemd_file(home), &systemd_unit(&exe)));
        steps.push(write(
            &linux_shortcut(home),
            &desktop_entry("Cinderpaw", &exe, "open", "Comment=Open Cinderpaw in your browser\n"),
        ));
    }
    steps
}

#[cfg(unix)]
fn remove_files(home: &Path) -> Vec<String> {
    let mut done = Vec::new();
    for name in PROFILES {
        let p = home.join(name);
        if let Ok(text) = std::fs::read_to_string(&p) {
            let stripped = without_path_block(&text);
            if stripped != text && std::fs::write(&p, stripped).is_ok() {
                done.push(format!("the PATH line in {}", p.display()));
            }
        }
    }
    for p in owned_paths(home) {
        let gone = if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
        if gone.is_ok() {
            done.push(p.display().to_string());
        }
    }
    done
}

pub fn install(home: &Path, bin: &Path) -> Vec<Step> {
    #[cfg(unix)]
    {
        let mut steps = install_files(home, bin, &std::env::var("SHELL").unwrap_or_default());
        if !cfg!(target_os = "macos") {
            let enabled = quiet(Command::new("systemctl").args(["--user", "daemon-reload"]))
                && quiet(Command::new("systemctl").args(["--user", "enable", "cinderpaw.service"]));
            if !enabled {
                let _ = std::fs::remove_file(systemd_file(home));
                steps.push(write(
                    &xdg_autostart(home),
                    &desktop_entry(
                        "Cinderpaw engine",
                        &exe_in(bin),
                        "gateway start",
                        "NoDisplay=true\nX-GNOME-Autostart-enabled=true\n",
                    ),
                ));
                if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
                    steps.push(Err(
                        "Cinderpaw won't start by itself when this computer restarts. Run `cinderpaw open` to start it."
                            .into(),
                    ));
                }
            }
        }
        steps
    }
    #[cfg(windows)]
    {
        let _ = home;
        windows::install(bin)
    }
}

/// Human lines of what was removed.
pub fn remove(home: &Path) -> Vec<String> {
    #[cfg(unix)]
    {
        if cfg!(target_os = "macos") {
            if let Some(uid) = uid() {
                quiet(Command::new("launchctl").args(["bootout", &format!("gui/{uid}/{LABEL}")]));
            }
        } else {
            quiet(Command::new("systemctl").args(["--user", "disable", "--now", "cinderpaw.service"]));
        }
        let done = remove_files(home);
        if !cfg!(target_os = "macos") {
            quiet(Command::new("systemctl").args(["--user", "daemon-reload"]));
        }
        done
    }
    #[cfg(windows)]
    {
        let _ = home;
        windows::remove()
    }
}

#[cfg(unix)]
fn uid() -> Option<String> {
    let out = Command::new("id").arg("-u").output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty())
}

/// Start (or restart) the engine under the login service manager, so it is
/// not a child of the installer's terminal. False = caller falls back to
/// `cinderpaw gateway start`.
pub fn start_with_service(home: &Path) -> bool {
    #[cfg(unix)]
    {
        if cfg!(target_os = "macos") {
            let (Some(uid), true) = (uid(), macos_plist(home).exists()) else { return false };
            quiet(Command::new("launchctl").args(["bootout", &format!("gui/{uid}/{LABEL}")]));
            return quiet(Command::new("launchctl").args(["bootstrap", &format!("gui/{uid}")]).arg(macos_plist(home)));
        }
        systemd_file(home).exists() && quiet(Command::new("systemctl").args(["--user", "restart", "cinderpaw.service"]))
    }
    #[cfg(windows)]
    {
        let _ = home;
        // ponytail: Windows has no per-user service manager without admin; `gateway start` detaches fine.
        false
    }
}

#[cfg(windows)]
mod windows {
    use super::*;

    fn programs() -> PathBuf {
        let appdata = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_default();
        appdata.join(r"Microsoft\Windows\Start Menu\Programs")
    }
    fn startup_lnk() -> PathBuf {
        programs().join(r"Startup\Cinderpaw.lnk")
    }
    fn menu_lnk() -> PathBuf {
        programs().join("Cinderpaw.lnk")
    }

    fn ps(script: &str) -> Result<String, String> {
        let out = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .stdin(Stdio::null())
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }

    /// WindowStyle 7 = minimized: the console these console-subsystem
    /// commands need shows as a taskbar blip, not a black window at login.
    fn shortcut(lnk: &Path, exe: &Path, args: &str) -> Step {
        ps(&format!(
            "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}');$s.TargetPath='{}';$s.Arguments='{}';$s.WindowStyle=7;$s.Save()",
            ps_quote(&lnk.display().to_string()),
            ps_quote(&exe.display().to_string()),
            args
        ))
        .map(|_| lnk.display().to_string())
        .map_err(|e| format!("I couldn't make the Cinderpaw shortcut: {e}"))
    }

    // The raw (unexpanded) value, written back as ExpandString: the default
    // user PATH holds %USERPROFILE% entries, and [Environment]::SetEnvironmentVariable
    // would flatten them to REG_SZ. The null write after is only there because
    // it broadcasts WM_SETTINGCHANGE, so new terminals see the change.
    const READ: &str =
        "$k=Get-Item 'HKCU:\\Environment'; $k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)";
    fn write_path(value: &str) -> Result<String, String> {
        ps(&format!(
            "Set-ItemProperty 'HKCU:\\Environment' Path '{}' -Type ExpandString;[Environment]::SetEnvironmentVariable('CINDERPAW_PATH_TOUCH',$null,'User')",
            ps_quote(value)
        ))
    }

    pub fn install(bin: &Path) -> Vec<Step> {
        let exe = exe_in(bin);
        let bin_s = bin.display().to_string();
        let path = ps(READ).and_then(|cur| {
            let next = user_path_with(&cur, &bin_s);
            if next == cur {
                Ok(String::new())
            } else {
                write_path(&next)
            }
        });
        vec![
            path.map(|_| "PATH".into()).map_err(|e| format!("I couldn't add Cinderpaw to PATH: {e}")),
            shortcut(&startup_lnk(), &exe, "gateway start"),
            shortcut(&menu_lnk(), &exe, "open"),
        ]
    }

    pub fn remove() -> Vec<String> {
        let mut done = Vec::new();
        for lnk in [startup_lnk(), menu_lnk()] {
            if std::fs::remove_file(&lnk).is_ok() {
                done.push(lnk.display().to_string());
            }
        }
        let bin = cinderpaw_core::paths::cinderpaw_dir().join("bin").display().to_string();
        if let Ok(cur) = ps(READ) {
            let next = user_path_without(&cur, &bin);
            if next != cur && write_path(&next).is_ok() {
                done.push("the PATH entry".into());
            }
        }
        done
    }
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

    #[cfg(unix)]
    #[test]
    fn install_then_remove_leaves_the_home_as_it_was() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        std::fs::write(h.join(".zshrc"), "export EDITOR=vim\n").unwrap();
        let bin = h.join(".cinderpaw/bin");
        std::fs::create_dir_all(&bin).unwrap();

        let steps = install_files(h, &bin, "/bin/zsh");
        assert!(steps.iter().all(|s| s.is_ok()), "{steps:?}");
        assert!(std::fs::read_to_string(h.join(".zshrc")).unwrap().contains(".cinderpaw/bin:$PATH"));
        // Re-run is a no-op on the profile.
        let again = std::fs::read_to_string(h.join(".zshrc")).unwrap();
        install_files(h, &bin, "/bin/zsh");
        assert_eq!(std::fs::read_to_string(h.join(".zshrc")).unwrap(), again);

        let removed = remove_files(h);
        assert!(!removed.is_empty());
        assert_eq!(std::fs::read_to_string(h.join(".zshrc")).unwrap(), "export EDITOR=vim\n");
        for p in owned_paths(h) {
            assert!(!p.exists(), "left behind: {}", p.display());
        }
    }

    #[test]
    fn powershell_single_quotes_are_doubled() {
        assert_eq!(ps_quote(r"C:\Users\o'brien"), r"C:\Users\o''brien");
    }
}
