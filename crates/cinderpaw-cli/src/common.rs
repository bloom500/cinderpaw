//! Shared bits for the `cinderpaw` CLI: the brand palette (color-gated for
//! `--no-color`) and the loopback endpoint helpers every subcommand needs.

use std::sync::OnceLock;

/// The brand palette as ANSI escapes. Every field is `&'static str` so callers
/// can destructure it into locals named like the old consts and keep using
/// `{ACCENT}`-style interpolation unchanged:
///
/// ```ignore
/// let common::Palette { accent: ACCENT, reset: RESET, .. } = common::palette();
/// println!("{ACCENT}hi{RESET}");
/// ```
#[derive(Clone, Copy)]
pub struct Palette {
    pub accent: &'static str,
    #[allow(dead_code)]
    pub accent_hi: &'static str,
    pub text: &'static str,
    pub meta: &'static str,
    pub ok: &'static str,
    pub warn: &'static str,
    pub fail: &'static str,
    pub bold: &'static str,
    pub dim: &'static str,
    pub reset: &'static str,
}

// Softened from the brand orange #ff6600, per "portocaliu mai moale".
const COLOR: Palette = Palette {
    accent: "\x1b[38;2;236;140;76m",
    accent_hi: "\x1b[38;2;242;164;102m",
    text: "\x1b[38;2;228;221;210m",
    meta: "\x1b[38;2;122;116;107m",
    ok: "\x1b[38;2;143;183;122m",
    warn: "\x1b[38;2;214;169;90m",
    fail: "\x1b[38;2;209;107;90m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    reset: "\x1b[0m",
};

const PLAIN: Palette = Palette {
    accent: "", accent_hi: "", text: "", meta: "", ok: "", warn: "", fail: "",
    bold: "", dim: "", reset: "",
};

static PALETTE: OnceLock<Palette> = OnceLock::new();

/// Fix the palette for the process. `color=false` (from `--no-color`, the
/// `NO_COLOR` env var, or a non-tty stdout) blanks every escape so output is
/// clean when piped. Call once at startup; later calls are ignored.
pub fn init_color(color: bool) {
    let _ = PALETTE.set(if color { COLOR } else { PLAIN });
}

/// The active palette (defaults to color if `init_color` was never called).
pub fn palette() -> Palette {
    *PALETTE.get().unwrap_or(&COLOR)
}

static JSON: OnceLock<bool> = OnceLock::new();

/// Fix machine-readable (`--json`) output for the process. Call once at startup.
pub fn init_json(on: bool) {
    let _ = JSON.set(on);
}

/// Whether the read commands should print JSON instead of styled text.
pub fn json() -> bool {
    *JSON.get().unwrap_or(&false)
}

/// The loopback API port the gateway binds (same source every host uses).
pub fn api_port() -> u16 {
    cinderpaw_core::settings::load().api_port
}

pub fn base_url() -> String {
    format!("http://127.0.0.1:{}", api_port())
}

/// Read the per-launch bearer token the gateway persists to `~/.cinderpaw/api-token`.
pub fn read_token() -> Option<String> {
    let path = cinderpaw_core::paths::cinderpaw_dir().join("api-token");
    std::fs::read_to_string(path).ok().map(|s| s.trim().to_string())
}

/// True when something is listening on the loopback API port — the gateway's
/// single-instance lock means that "something" is a live Cinderpaw host.
pub fn port_in_use(port: u16) -> bool {
    std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
}

/// Restore cooked console input (echo + line buffering) on Windows before a
/// `read_line` prompt. A TUI that died without cleanup (force-kill, crash)
/// leaves the console in raw/VT mode — every later `read_line` in that window
/// looks dead: keys neither echo nor submit. No-op on non-Windows and when
/// stdin isn't a console (pipes keep working untouched).
#[cfg(windows)]
pub fn reset_console_mode() {
    use std::os::windows::io::AsRawHandle;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetConsoleMode(handle: isize, mode: *mut u32) -> i32;
        fn SetConsoleMode(handle: isize, mode: u32) -> i32;
    }
    const ENABLE_PROCESSED_INPUT: u32 = 0x0001;
    const ENABLE_LINE_INPUT: u32 = 0x0002;
    const ENABLE_ECHO_INPUT: u32 = 0x0004;
    const ENABLE_VIRTUAL_TERMINAL_INPUT: u32 = 0x0200;
    let handle = std::io::stdin().as_raw_handle() as isize;
    unsafe {
        let mut mode = 0u32;
        if GetConsoleMode(handle, &mut mode) != 0 {
            let cooked = (mode | ENABLE_PROCESSED_INPUT | ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT)
                & !ENABLE_VIRTUAL_TERMINAL_INPUT;
            SetConsoleMode(handle, cooked);
        }
    }
}

#[cfg(not(windows))]
pub fn reset_console_mode() {}

#[cfg(all(test, windows))]
mod tests {
    extern "system" {
        fn CreatePipe(r: *mut isize, w: *mut isize, sa: *const SecurityAttributes, size: u32) -> i32;
        fn PeekNamedPipe(h: isize, buf: *mut u8, n: u32, read: *mut u32, avail: *mut u32, left: *mut u32) -> i32;
        fn CloseHandle(h: isize) -> i32;
    }
    #[repr(C)]
    struct SecurityAttributes {
        len: u32,
        desc: *mut u8,
        inherit: i32,
    }

    /// powershell 5.1 hands its children more than their std handles: any
    /// inheritable pipe it holds rides along. A daemon that inherits one keeps
    /// the caller waiting for output forever (the install smoke test, 30 min).
    /// The daemon must get exactly its log file and nothing else.
    #[test]
    fn a_detached_child_does_not_keep_our_pipes_alive() {
        let (mut r, mut w) = (0isize, 0isize);
        let sa = SecurityAttributes { len: std::mem::size_of::<SecurityAttributes>() as u32, desc: std::ptr::null_mut(), inherit: 1 };
        assert_ne!(unsafe { CreatePipe(&mut r, &mut w, &sa, 0) }, 0);

        let log = std::fs::File::create(std::env::temp_dir().join("cp-detached-test.log")).unwrap();
        // ping -n 6 = ~5 s alive, long enough to hold the pipe if it inherited it.
        let pid = super::spawn_detached(std::path::Path::new(r"C:\Windows\System32\PING.EXE"), &["-n", "6", "127.0.0.1"], &log).unwrap();
        assert!(pid > 0);

        unsafe { CloseHandle(w) };
        let mut avail = 0u32;
        let alive = unsafe { PeekNamedPipe(r, std::ptr::null_mut(), 0, std::ptr::null_mut(), &mut avail, std::ptr::null_mut()) };
        unsafe { CloseHandle(r) };
        assert_eq!(alive, 0, "the child kept our pipe's write end open");
    }
}

/// Start a background process that inherits exactly two handles: NUL for
/// stdin and `log` for stdout/stderr. Nothing else.
///
/// std's `Command` cannot do this: it always creates the child with "inherit
/// all inheritable handles", and whoever started us (powershell 5.1 in the
/// installer, a CI runner, `cinderpaw update`) may hold inheritable pipes. A
/// long-lived gateway holding one keeps that caller waiting for an end of
/// output that never comes. PROC_THREAD_ATTRIBUTE_HANDLE_LIST is the
/// documented way to name the handles a child gets.
#[cfg(windows)]
pub fn spawn_detached(exe: &std::path::Path, args: &[&str], log: &std::fs::File) -> std::io::Result<u32> {
    use std::io::Error;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;

    #[repr(C)]
    struct StartupInfoW {
        cb: u32,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        x: u32,
        y: u32,
        x_size: u32,
        y_size: u32,
        x_chars: u32,
        y_chars: u32,
        fill: u32,
        flags: u32,
        show_window: u16,
        reserved2_len: u16,
        reserved2: *mut u8,
        stdin: isize,
        stdout: isize,
        stderr: isize,
    }
    #[repr(C)]
    struct StartupInfoExW {
        info: StartupInfoW,
        attributes: *mut u8,
    }
    #[repr(C)]
    struct ProcessInformation {
        process: isize,
        thread: isize,
        pid: u32,
        tid: u32,
    }
    extern "system" {
        fn InitializeProcThreadAttributeList(list: *mut u8, count: u32, flags: u32, size: *mut usize) -> i32;
        fn UpdateProcThreadAttribute(
            list: *mut u8,
            flags: u32,
            attribute: usize,
            value: *const isize,
            size: usize,
            prev: *mut u8,
            ret: *mut usize,
        ) -> i32;
        fn DeleteProcThreadAttributeList(list: *mut u8);
        fn SetHandleInformation(h: isize, mask: u32, flags: u32) -> i32;
        fn CreateProcessW(
            app: *const u16,
            cmd: *mut u16,
            pa: *const u8,
            ta: *const u8,
            inherit: i32,
            flags: u32,
            env: *const u8,
            cwd: *const u16,
            si: *mut StartupInfoExW,
            pi: *mut ProcessInformation,
        ) -> i32;
        fn CloseHandle(h: isize) -> i32;
    }
    const HANDLE_FLAG_INHERIT: u32 = 1;
    const PROC_THREAD_ATTRIBUTE_HANDLE_LIST: usize = 0x0002_0002;
    const STARTF_USESTDHANDLES: u32 = 0x100;
    const DETACHED_PROCESS: u32 = 0x8;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x200;
    const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;

    // Our own copies, marked inheritable; dropped (closed) when we return.
    let nul = std::fs::OpenOptions::new().read(true).open("NUL")?;
    let out = log.try_clone()?;
    let handles = [nul.as_raw_handle() as isize, out.as_raw_handle() as isize];

    let quote = |s: &str| if s.contains(' ') { format!("\"{s}\"") } else { s.to_string() };
    let mut line = format!("\"{}\"", exe.display());
    for a in args {
        line.push(' ');
        line.push_str(&quote(a));
    }
    let mut cmd: Vec<u16> = std::ffi::OsStr::new(&line).encode_wide().chain(Some(0)).collect();

    // SAFETY: Win32 calls on buffers we own and keep alive until after
    // CreateProcessW; the attribute list is deleted before it is freed.
    unsafe {
        for h in handles {
            if SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) == 0 {
                return Err(Error::last_os_error());
            }
        }
        let mut size = 0usize;
        InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size);
        let mut list = vec![0u8; size];
        if InitializeProcThreadAttributeList(list.as_mut_ptr(), 1, 0, &mut size) == 0 {
            return Err(Error::last_os_error());
        }
        let ok = UpdateProcThreadAttribute(
            list.as_mut_ptr(),
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            handles.as_ptr(),
            std::mem::size_of_val(&handles),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );
        if ok == 0 {
            let e = Error::last_os_error();
            DeleteProcThreadAttributeList(list.as_mut_ptr());
            return Err(e);
        }
        let mut si: StartupInfoExW = std::mem::zeroed();
        si.info.cb = std::mem::size_of::<StartupInfoExW>() as u32;
        si.info.flags = STARTF_USESTDHANDLES;
        si.info.stdin = handles[0];
        si.info.stdout = handles[1];
        si.info.stderr = handles[1];
        si.attributes = list.as_mut_ptr();
        let mut pi: ProcessInformation = std::mem::zeroed();
        let created = CreateProcessW(
            std::ptr::null(),
            cmd.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | EXTENDED_STARTUPINFO_PRESENT,
            std::ptr::null(),
            std::ptr::null(),
            &mut si,
            &mut pi,
        );
        let e = Error::last_os_error();
        DeleteProcThreadAttributeList(list.as_mut_ptr());
        if created == 0 {
            return Err(e);
        }
        CloseHandle(pi.thread);
        CloseHandle(pi.process);
        Ok(pi.pid)
    }
}
