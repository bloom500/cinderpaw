//! The computer stays awake while the agent works.
//!
//! A long task stopped halfway when the PC went to sleep on its idle timer: the
//! person walked away, which is exactly what a long task is for. Only system
//! sleep is held; the screen still turns off as usual. Hermes ships the same
//! ("While working"), 1 Nov 2026.
//!
//! ponytail: Windows and macOS. Linux would hold `systemd-inhibit`; add it when
//! someone asks. Held at most two hours per turn, so a "done" that never
//! arrives (a crashed page) cannot keep a laptop awake all night.

use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;

static HOLD: Mutex<Option<Sender<()>>> = Mutex::new(None);
const MAX_HOLD: Duration = Duration::from_secs(2 * 60 * 60);

#[tauri::command]
#[specta::specta]
pub fn keep_awake(on: bool) {
    let mut hold = HOLD.lock().unwrap_or_else(|e| e.into_inner());
    // Dropping the sender wakes the holder below, which lets go.
    let _ = hold.take();
    if !on {
        return;
    }
    let (tx, rx) = channel::<()>();
    *hold = Some(tx);
    std::thread::spawn(move || {
        // Windows ties the request to the thread that made it, so this thread
        // makes it, waits, and clears it.
        #[cfg(windows)]
        unsafe {
            use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};
            SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
        }
        // `-w` ends caffeinate with this app, even if it crashes.
        #[cfg(target_os = "macos")]
        let child = std::process::Command::new("caffeinate")
            .args(["-i", "-w", &std::process::id().to_string()])
            .spawn()
            .ok();
        let _ = rx.recv_timeout(MAX_HOLD);
        #[cfg(windows)]
        unsafe {
            use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS};
            SetThreadExecutionState(ES_CONTINUOUS);
        }
        #[cfg(target_os = "macos")]
        if let Some(mut c) = child {
            let _ = c.kill();
            let _ = c.wait();
        }
    });
}
