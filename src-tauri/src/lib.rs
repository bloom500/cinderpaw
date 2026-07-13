mod agents;
mod commands;
mod connectors;
mod conversations;
mod desktop_control;
mod disk_encryption;
mod events;
mod mcp;
mod memory_graph;
mod memory_resume;
mod projects;
mod rsi;
mod skills;

use commands::*;

pub use feral_core::{
    api, byok, db_key, feral_agent, gpu_detect, inference, models, paths,
    perf_policy, settings, sysinfo_mod, tools,
};
#[cfg(feature = "whisper")]
pub use feral_core::transcription;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

/// `HostEvents` for the desktop entry point (Faza 4.5 Slice 2): forwards
/// every runtime event to the webview via `app.emit` AND onto the runtime's
/// broadcast bus (`events_tx`). The bus fan-out matches the headless
/// `BusEvents` sink — without it, the desktop's embedded HTTP API (`/events`
/// SSE, the id-correlated roundtrips in `api.rs`, and the MCP roundtrips in
/// `mcp.rs`) would never observe sidecar output. The headless gateway uses
/// `feral_core::host::LogEvents`/`BusEvents` instead — see `crates/feral-cli`.
struct TauriEvents(
    tauri::AppHandle,
    tokio::sync::broadcast::Sender<feral_core::host::HostEvent>,
);
impl feral_core::host::HostEvents for TauriEvents {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let _ = self.0.emit(event, payload.clone());
        let _ = self.1.send(feral_core::host::HostEvent {
            event: event.to_string(),
            payload,
        });
    }
}

use crate::agents::AgentConfig;
use crate::inference::{InferParams, Message};
use crate::models::ModelInfo;
use crate::perf_policy::{deadline_message, perf_policy, DeadlineReason, PerfPolicy};
use crate::settings::Settings;
use crate::sysinfo_mod::SystemInfo;

/// Per-download cancellation flag. Cloned into the spawned download task and
/// into the AppState map so `cancel_download` can flip it from another command.
type CancelFlag = Arc<AtomicBool>;

/// Display-safe snapshot of the Feral Agent's active LLM backend.
/// API keys are never included — Rust injects them before forwarding to the sidecar.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct FeralModelConfigView {
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub display_name: String,
}

pub struct AppState {
    /// Host-agnostic runtime shared with any future non-Tauri host (Faza 4.5
    /// Slice 2). Holds the model manager, settings, local API token, the
    /// Feral Agent sidecar handles, and the RSI substrate/engine state.
    /// `AppState` derefs to this so every existing `state.manager` /
    /// `state.rsi_state` / etc. call site across this file keeps compiling.
    pub runtime: std::sync::Arc<feral_core::runtime::RuntimeState>,
    pub downloads: Arc<Mutex<HashMap<String, CancelFlag>>>,
    pub stop_signals: Arc<StopRegistry>,
    /// System info pre-computed in a background thread at startup so the
    /// first call to get_system_info() returns instantly.
    pub system_info_cache: Arc<Mutex<Option<SystemInfo>>>,
    /// Cached display-safe view of the model the sidecar is currently using.
    /// Updated optimistically by feral_set_model; None until first set_model call.
    pub feral_model_config: Arc<Mutex<Option<FeralModelConfigView>>>,
}

/// One stop flag per streaming session.
///
/// This used to be a single shared `Arc<AtomicBool>` on `AppState`, which made
/// "stop generating" unreliable in two ways: `stop_generation` took no session
/// and therefore stopped every stream at once, and each new generation RESET
/// the shared flag — so starting a stream in one session silently un-stopped a
/// stream still running in another, and that one kept generating with nothing
/// left that could interrupt it.
#[derive(Default)]
pub struct StopRegistry(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl StopRegistry {
    /// Register a fresh flag for `session_id` and hand it to the generation
    /// about to start. Replaces any previous flag for that session (a session
    /// only ever has one stream in flight), so a stop aimed at an earlier,
    /// already-finished generation cannot abort the new one.
    pub fn begin(&self, session_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.0.lock().insert(session_id.to_string(), flag.clone());
        flag
    }

    /// Release `session_id`'s flag when its generation ends — but only if it is
    /// still the one that was registered. A newer generation for the same
    /// session owns a different `Arc`, and its flag must survive.
    pub fn end(&self, session_id: &str, flag: &Arc<AtomicBool>) {
        let mut map = self.0.lock();
        if map.get(session_id).is_some_and(|f| Arc::ptr_eq(f, flag)) {
            map.remove(session_id);
        }
    }

    /// Trip the flag for one session. No-op when that session has nothing in
    /// flight (a stale stop click from a tab whose stream already finished).
    pub fn request_stop(&self, session_id: &str) {
        if let Some(flag) = self.0.lock().get(session_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod stop_registry_tests {
    use super::*;

    #[test]
    fn stop_reaches_only_its_own_session() {
        let reg = StopRegistry::default();
        let a = reg.begin("a");
        let b = reg.begin("b");

        reg.request_stop("a");

        assert!(a.load(Ordering::SeqCst), "the stopped session must see it");
        assert!(!b.load(Ordering::SeqCst), "a bystander session must keep generating");
    }

    #[test]
    fn starting_a_session_does_not_unstop_another() {
        // The old global flag was reset by every new generation, so this
        // sequence silently revived a stream the user had already stopped.
        let reg = StopRegistry::default();
        let a = reg.begin("a");
        reg.request_stop("a");

        let _b = reg.begin("b");

        assert!(a.load(Ordering::SeqCst), "a's stop must survive b starting");
    }

    #[test]
    fn a_stale_stop_cannot_abort_the_next_generation() {
        let reg = StopRegistry::default();
        let first = reg.begin("a");
        reg.end("a", &first);

        let second = reg.begin("a");
        reg.request_stop("a");
        assert!(second.load(Ordering::SeqCst));

        // ...but ending the FIRST generation again must not evict the second's
        // flag, or the stop would land on nothing.
        reg.end("a", &first);
        reg.request_stop("a");
        assert!(second.load(Ordering::SeqCst));
    }

    #[test]
    fn stopping_an_idle_session_is_a_no_op() {
        let reg = StopRegistry::default();
        reg.request_stop("nobody");
    }
}

impl std::ops::Deref for AppState {
    type Target = feral_core::runtime::RuntimeState;
    fn deref(&self) -> &Self::Target {
        &self.runtime
    }
}

pub(crate) fn download_key(repo_id: &str, filename: &str) -> String {
    format!("{}::{}", repo_id, filename)
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ProgressPayload {
    pub percentage: f64,
    pub status_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct DownloadProgress {
    pub repo_id: String,
    pub filename: String,
    pub progress: f32,
}

// ---------- Model commands ----------


// ---------- Chat ----------


// ---------- System ----------


// ---------- Agents ----------


// ---------- Feral Agent ----------





// ---------- Conversations ----------


// ---------- Voice messages (on-device STT) ----------




// ---------- Projects ----------


// ---------- Settings ----------


// ---------- BYOK ----------





// ---------- Entry ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")))
        .init();

    // Faza 4.5 Slice 2: the runtime (token + settings + ModelManager) is
    // built by the host-agnostic `feral_core::boot::build_runtime`. The
    // headless `feral-cli` gateway calls the same function — see
    // `crates/feral-cli/src/main.rs`.
    let runtime = feral_core::boot::build_runtime();

    // Pre-compute system info in a background thread so the first IPC call
    // returns instantly instead of waiting 2-3 s for PowerShell + sysinfo.
    // Tauri-only field on AppState; the headless gateway doesn't need it.
    let system_info_cache: Arc<Mutex<Option<SystemInfo>>> = Arc::new(Mutex::new(None));
    {
        let cache = system_info_cache.clone();
        std::thread::spawn(move || {
            let info = sysinfo_mod::collect();
            *cache.lock() = Some(info);
        });
    }

    let state = AppState {
        runtime,
        downloads: Arc::new(Mutex::new(HashMap::new())),
        stop_signals: Arc::new(StopRegistry::default()),
        system_info_cache,
        feral_model_config: Arc::new(Mutex::new(None)),
    };

    let specta_builder = tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            get_models,
            get_loaded_model,
            download_model,
            download_embedding_model,
            cancel_download,
            load_model,
            start_model_load,
            unload_model,
            set_lora_adapter,
            delete_model,
            chat_stream,
            stop_generation,
            get_system_info,
            disk_encryption::disk_encryption_status,
            save_agent,
            get_agents,
            delete_agent,
            get_agent_presets,
            run_agent,
            save_conversation,
            load_conversations,
            load_conversation,
            delete_conversation,
            clear_all_conversations,
            save_voice_blob,
            whisper_model_present,
            transcribe_audio,
            transcribe_audio_cloud,
            download_whisper_model,
            load_projects,
            save_project,
            delete_project,
            get_settings,
            save_settings,
            set_desktop_control_enabled,
            set_desktop_control_yolo,
            set_token_budget_conversation,
            set_rsi_budget,
            search_hf_models,
            get_hf_model_detail,
            get_model_size_info,
            get_hf_model_size,
            get_byok_settings,
            provider_catalog,
            setup_detect,
            setup_verify,
            save_byok_provider,
            remove_byok_provider,
            test_byok_provider,
            chat_cloud_stream,
            chat_complete_local,
            chat_cloud_complete,
            read_file_as_text,
            read_file_as_data_url,
            extract_file_text,
            skills::list_installed_skills,
            skills::get_installed_skill_content,
            skills::fetch_remote_skills,
            skills::fetch_community_skills,
            skills::preview_remote_skill,
            skills::preview_local_skill,
            skills::skill_exists_cmd,
            skills::install_skill,
            skills::remove_skill,
            feral_send_message,
            feral_agent_status,
            feral_stop_generation,
            feral_run_fractal_benchmark,
            feral_dream_now,
            feral_meta,
            feral_governance,
            feral_modules,
            feral_code_patches_list,
            feral_code_patch_resolve,
            feral_lora_reviews_list,
            feral_lora_review_resolve,
            feral_lora_train,
            feral_fractal_cluster_leaves,
            feral_set_model,
            feral_get_model_config,
            get_local_api_token,
            feral_ask_user_response,
            feral_ask_user_cancel,
            get_onboarding_record,
            set_onboarding_record,
            list_ollama_models,
            mcp::mcp_catalog,
            mcp::mcp_list,
            mcp::mcp_install,
            mcp::mcp_set_enabled,
            mcp::mcp_remove,
            mcp::mcp_list_tools,
            mcp::mcp_call_tool,
            connectors::connectors_catalog,
            connectors::connectors_list,
            connectors::connectors_save,
            connectors::connectors_set_enabled,
            connectors::connectors_remove,
            connectors::connectors_whatsapp_qr,
            memory_graph::get_memory_graph,
            memory_graph::add_memory_facts,
            memory_resume::get_last_task,
            desktop_control::list_windows,
            desktop_control::get_accessibility_tree,
            desktop_control::find_elements,
            desktop_control::click_element,
            desktop_control::type_into_element,
            desktop_control::get_element_value,
            desktop_control::get_focused_element,
            desktop_control::take_element_action,
            desktop_control::send_keys,
            desktop_control::launch_app,
            rsi::commands::rsi_init,
            rsi::commands::rsi_status,
            rsi::commands::rsi_get_bounds,
            rsi::commands::rsi_update_bounds,
            rsi::commands::rsi_score,
            rsi::commands::rsi_get_tier0_specs,
            rsi::commands::rsi_commit_genome,
            rsi::commands::rsi_ratchet_attempt,
            rsi::commands::rsi_log,
            rsi::commands::rsi_lca,
            rsi::commands::rsi_diff,
            rsi::commands::rsi_record_goodhart_sample,
            rsi::commands::rsi_reset_goodhart,
            rsi::commands::rsi_start,
            rsi::commands::rsi_stop,
            rsi::commands::rsi_set_concurrency,
            rsi::commands::rsi_dream_telemetry,
            rsi::commands::rsi_journal_recent,
            rsi::commands::rsi_champion_tree,
        ])
        .events(tauri_specta::collect_events![
            crate::events::TokenEvent,
            crate::events::StreamDoneEvent,
            crate::events::StreamErrorEvent,
            crate::events::StreamTruncatedEvent,
            crate::events::StreamProgressEvent,
            crate::events::DownloadProgressEvent,
            crate::events::DownloadCompleteEvent,
            crate::events::DownloadErrorEvent,
            crate::events::ModelLoadProgressEvent,
            crate::events::AgentStreamEvent,
            crate::events::FeralAgentOutputEvent,
        ]);

    // TODO: re-enable once all u64 fields have #[specta(type = Number)] annotations.
    // The specta export requires every u64/i64 field to be annotated because
    // TypeScript loses precision on integers > 2^53.
    // #[cfg(debug_assertions)]
    // specta_builder
    //     .export(
    //         specta_typescript::Typescript::default()
    //             .header("// AUTO-GENERATED — do not edit. Regenerated by `cargo tauri dev/build`.\n"),
    //         "../frontend-react/src/lib/tauri/bindings.ts",
    //     )
    //     .expect("failed to export specta bindings");

    let specta_builder_for_setup = specta_builder.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .setup(move |app| {
            specta_builder_for_setup.mount_events(app);
            let _handle = app.handle().clone();

            // Faza 4.5 Slice 2: every runtime service (AMD-guard, RSI
            // bootstrap, env exports, API server, supervised sidecar)
            // delegates to the host-agnostic `feral_core::boot::start`.
            // The headless `feral-cli` gateway calls the same function with
            // a different `events` and `desktop_control = None` — see
            // `crates/feral-cli/src/main.rs`.
            //
            // `boot::start` is `async` (Task 4 smoke fix: a sync version
            // panicked with "no reactor running" when Tauri 2's sync setup
            // closure called `tokio::spawn` inside it). Tauri's
            // `async_runtime::spawn` works in both sync and async contexts,
            // so the setup closure stays sync and the boot runs in the
            // background — same pattern the MCP reconnect below uses.
            let runtime = app.handle().state::<AppState>().runtime.clone();
            let events: Arc<dyn feral_core::host::HostEvents> =
                Arc::new(TauriEvents(app.handle().clone(), runtime.events_tx.clone()));
            let desktop_control: Option<feral_core::host::DesktopControlHandler> = {
                let dc: feral_core::host::DesktopControlHandler =
                    Arc::new(|action, params| {
                        Box::pin(async move {
                            crate::desktop_control::handle_request(&action, &params).await
                        })
                    });
                Some(dc)
            };
            let extra_bin_dirs: Vec<PathBuf> = vec![app.path().resource_dir().ok()]
                .into_iter()
                .flatten()
                .collect();
            tauri::async_runtime::spawn(async move {
                feral_core::boot::start(runtime, events, desktop_control, extra_bin_dirs).await;
            });

            // MCP extensions: no host-side reconnect anymore (R5). The
            // sidecar's McpManager reconciles `~/.feral/mcp.json` at its own
            // boot and on every `mcp_reload` poke — desktop and headless
            // gateway get identical behavior for free.

            // No model auto-load. The user picks a model explicitly from the UI
            // (Local Models tab / Onboarding). Auto-loading on every startup
            // caused lag (model mmap takes seconds and several GB of RAM/VRAM)
            // and crashed the host for non-technical users who didn't know
            // why their machine froze. Removal: 2026-06-30, per user report.

            Ok(())
        })
        .invoke_handler(specta_builder.invoke_handler())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    let mut fa_guard = state.feral_agent_process.lock();
                    if let Some(ref mut child) = *fa_guard {
                        let _ = child.start_kill();
                        tracing::info!("Feral Agent sidecar stopped");
                    }
                    // Drop the tx so the stdin writer task exits cleanly.
                    *state.feral_agent_tx.lock() = None;
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_key_format() {
        assert_eq!(download_key("TheBloke/Mistral-7B", "model.Q4_K_M.gguf"),
                   "TheBloke/Mistral-7B::model.Q4_K_M.gguf");
    }

    #[test]
    fn download_key_uniqueness() {
        let k1 = download_key("repo/a", "file.gguf");
        let k2 = download_key("repo/b", "file.gguf");
        let k3 = download_key("repo/a", "other.gguf");
        assert_ne!(k1, k2);
        assert_ne!(k1, k3);
        assert_ne!(k2, k3);
    }

}
