//! Main-window close parks the desktop runtime in the tray. Quit drains the
//! sidecar through stdin EOF before ending the host, as the CLI does (D7).
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

const ID: &str = "cinderpaw-runtime";
static QUITTING: AtomicBool = AtomicBool::new(false);
static DRAINED: AtomicBool = AtomicBool::new(false);
// ponytail: told once per run, not once ever; persist it if people find it noisy.
static TOLD: AtomicBool = AtomicBool::new(false);

pub fn install(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "runtime-open", "Open Cinderpaw", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "runtime-quit", "Quit Cinderpaw", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut builder = TrayIconBuilder::with_id(ID)
        .menu(&menu)
        .tooltip("Cinderpaw is running. Your tasks keep going.")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "runtime-open" => crate::deep_link::focus_main_window(app),
            "runtime-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                crate::deep_link::focus_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    // Auxiliary windows (especially the call pill) retain their own lifecycle.
    // If tray creation failed, preserve the old close behavior: never strand a
    // hidden runtime with no way to reopen or quit it.
    if window.label() != "main"
        || QUITTING.load(Ordering::Acquire)
        || window.app_handle().tray_by_id(ID).is_none()
    {
        return;
    }
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        if let Err(error) = window.hide() {
            tracing::warn!(%error, "tray: could not hide main window");
        }
        // Someone who clicks X expects the app to be gone. Say where it went.
        if !TOLD.swap(true, Ordering::AcqRel) {
            use tauri_plugin_notification::NotificationExt;
            let _ = window
                .app_handle()
                .notification()
                .builder()
                .title("Cinderpaw is still running")
                .body("Your tasks keep going. To quit, right-click the Cinderpaw icon near the clock and choose Quit.")
                .show();
        }
    }
}

pub fn on_exit_requested(app: &tauri::AppHandle, code: Option<i32>, api: &tauri::ExitRequestApi) {
    // Tauri does not allow preventing updater restarts. Their existing Exit
    // fallback still kills the child; never convert a restart into a quit.
    if code == Some(tauri::RESTART_EXIT_CODE) || DRAINED.load(Ordering::Acquire) {
        return;
    }
    api.prevent_exit();
    if QUITTING.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    let runtime = app
        .try_state::<crate::AppState>()
        .map(|s| s.runtime.clone());
    tauri::async_runtime::spawn(async move {
        if let Some(runtime) = runtime {
            *runtime.cinderpaw_agent_planned_exit.lock() =
                Some(cinderpaw_core::runtime::PlannedExit::shutdown());
            runtime.cinderpaw_agent_tx.lock().take();
            // Taking ownership stops supervision from respawning the child.
            let child = runtime.cinderpaw_agent_process.lock().take();
            if let Some(mut child) = child {
                match drain_child(&mut child, Duration::from_secs(30)).await {
                    Ok(status) => tracing::info!(?status, "tray: sidecar stopped"),
                    Err(error) => tracing::warn!(%error, "tray: sidecar shutdown failed"),
                }
            }
        }
        DRAINED.store(true, Ordering::Release);
        app.exit(code.unwrap_or(0));
    });
}

async fn drain_child(
    child: &mut tokio::process::Child,
    grace: Duration,
) -> std::io::Result<std::process::ExitStatus> {
    match tokio::time::timeout(grace, child.wait()).await {
        Ok(status) => status,
        Err(_) => {
            tracing::warn!("tray: sidecar exceeded shutdown grace period; killing");
            child.kill().await?;
            child.wait().await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn completed_child_is_reaped_without_being_killed() {
        #[cfg(windows)]
        let mut child = tokio::process::Command::new("cmd")
            .args(["/C", "exit 0"])
            .spawn()
            .unwrap();
        #[cfg(not(windows))]
        let mut child = tokio::process::Command::new("true").spawn().unwrap();
        assert!(drain_child(&mut child, Duration::from_secs(10))
            .await
            .unwrap()
            .success());
        assert!(child.id().is_none());
    }

    #[tokio::test]
    async fn unresponsive_child_is_killed_and_reaped_after_the_deadline() {
        #[cfg(windows)]
        let mut child = tokio::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 60",
            ])
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        #[cfg(not(windows))]
        let mut child = tokio::process::Command::new("sleep")
            .arg("60")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let status = drain_child(&mut child, Duration::from_millis(50))
            .await
            .unwrap();
        assert!(!status.success());
        assert!(child.id().is_none());
    }
}
