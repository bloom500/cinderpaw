//! Commands that talk to the Cinderpaw Agent sidecar: chat relay, RSI/governance
//! surfaces, dream cycle, code-patch and LoRA review queues, fractal ops.

use crate::*;
use serde::{Deserialize, Serialize};
use tauri::State;

/// Controls-panel inference overrides forwarded verbatim to the sidecar,
/// which validates and clamps them. Both fields optional so the frontend can
/// send only what the user changed.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct FeralInferParams {
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
}

/// Is the sidecar ready right now?
///
/// The companion to `cinderpaw://agent-ready`, and the reason the banner used
/// to stay on screen forever: an event reaches only whoever is already
/// listening. The sidecar announces itself about eleven seconds in, and in a
/// cold start the webview can still be mounting — so the one announcement went
/// out to nobody and the frontend waited for a second that never came.
///
/// Asking is also what makes a reloaded window correct, which the event alone
/// never could.
#[tauri::command]
#[specta::specta]
pub(crate) fn agent_is_ready(state: State<'_, AppState>) -> bool {
    state.runtime.agent_ready.load(std::sync::atomic::Ordering::SeqCst)
}

/// Send a message to the Cinderpaw Agent sidecar. Returns the message ID that
/// will appear in the corresponding `cinderpaw://agent-output` chunk/done events.
///
/// `surface` says where the answer will be consumed — `"voice"` when it is going
/// to be spoken aloud, `"text"` for the normal composer. The sidecar turns it into
/// a per-turn surface brief, the same mechanism connectors use for "narrow column,
/// no tables", so a call gets an answer someone can listen to instead of the
/// desktop's full markdown read out loud.
#[tauri::command]
#[specta::specta]
pub(crate) async fn feral_send_message(
    state: State<'_, AppState>,
    content: String,
    session_id: String,
    images: Option<Vec<String>>,
    infer_params: Option<FeralInferParams>,
    surface: Option<String>,
) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();

    // Send a metadata-only roster of installed skills (id, name, description,
    // version, tags) on every message. The agent sidecar renders this as a
    // short "skill menu" in the system prompt, then loads the full SKILL.md
    // body on demand via the `read_skill` tool. Built per-send so the roster
    // always reflects the current install state — failures here are logged
    // and the message is sent without the roster.
    let skills_context: Vec<skills::SkillMeta> = skills::local_list()
        .unwrap_or_default()
        .into_iter()
        // Only ship local-installed skills to the agent — remote/community
        // entries have no content on disk to load and would just bloat the
        // menu. The frontend has its own UI for those.
        .filter(|m| matches!(m.source_provider, skills::SourceProvider::Local))
        .collect();

    let mut payload = serde_json::json!({
        "type": "message",
        "id": &id,
        "content": content,
        "sessionId": session_id,
    });
    // Image attachments (data URLs) ride along so the sidecar can hand
    // real pixels to vision-capable models.
    if let Some(imgs) = images.filter(|v| !v.is_empty()) {
        payload["images"] = serde_json::json!(imgs);
    }
    if !skills_context.is_empty() {
        payload["skillsContext"] = serde_json::to_value(&skills_context)
            .map_err(|e| format!("failed to serialize skills context: {e}"))?;
    }
    // Only forwarded when the host actually declared one: an absent field leaves
    // whatever brief the session already had, which is what connectors rely on.
    if let Some(s) = surface.as_deref().filter(|s| *s == "voice" || *s == "text") {
        payload["surface"] = serde_json::json!(s);
    }
    // Controls-panel overrides (temperature / max tokens). The sidecar's
    // agent loop validates and clamps them; here they just ride along.
    if let Some(p) = infer_params {
        payload["inferParams"] = serde_json::json!({
            "temperature": p.temperature,
            "max_tokens": p.max_tokens,
        });
    }
    let msg = payload.to_string();

    // Extract the sender without holding the lock across the await.
    let tx = {
        let guard = state.cinderpaw_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "cinderpaw-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg).await.map_err(|e| e.to_string())?;
    Ok(id)
}

/// Returns true when the Cinderpaw Agent sidecar is running and ready to receive messages.
#[tauri::command]
#[specta::specta]
pub(crate) fn cinderpaw_agent_status(state: State<'_, AppState>) -> bool {
    state.cinderpaw_agent_tx.lock().is_some()
}

/// Abort the Cinderpaw Agent's in-flight generation for `session_id` (or all
/// sessions when None). Forwards a `stop` message to the sidecar, whose
/// AgentLoop aborts the inference fetch and any running tool, then emits a
/// `done` event with `stopped: true` for each interrupted message.
#[tauri::command]
#[specta::specta]
pub(crate) async fn feral_stop_generation(
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> Result<(), String> {
    let mut payload = serde_json::json!({ "type": "stop" });
    if let Some(sid) = session_id {
        payload["sessionId"] = serde_json::Value::String(sid);
    }
    let msg = payload.to_string();
    let tx = {
        let guard = state.cinderpaw_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "cinderpaw-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Record the user's thumbs 👍/👎 on an assistant message. Fire-and-forget:
/// forwards a `feedback` line to the sidecar, which writes one audit row —
/// the wired source of the §2.10 `acceptance` personal-fitness signal that
/// feeds LoRA adaptation. `value` is "up" or "down".
#[tauri::command]
#[specta::specta]
pub(crate) async fn feral_submit_feedback(
    state: State<'_, AppState>,
    session_id: String,
    message_id: String,
    value: String,
) -> Result<(), String> {
    let msg = serde_json::json!({
        "type": "feedback",
        "sessionId": session_id,
        "feedbackMessageId": message_id,
        "feedbackValue": value,
    })
    .to_string();
    let tx = {
        let guard = state.cinderpaw_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "cinderpaw-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// PROVISIONAL (temporary Settings button): ask the sidecar to run the Fractal
/// Memory Search benchmark gate against the live RAPTOR tree. The sidecar runs
/// it off the hot path and emits a `fractal_bench_result` line (verdict +
/// recall/latency numbers) which Rust forwards over `cinderpaw://agent-output`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn feral_run_fractal_benchmark(state: State<'_, AppState>) -> Result<(), String> {
    let msg = serde_json::json!({ "type": "fractal_benchmark" }).to_string();
    let tx = {
        let guard = state.cinderpaw_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "cinderpaw-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Faza 6 (L6) Meta Evolution: drive the sidecar's MetaGenome engine.
/// Fire-and-forget like the other RSI commands — the sidecar replies with one
/// `meta_result` line forwarded over `cinderpaw://agent-output`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn feral_meta(state: State<'_, AppState>, op: String) -> Result<(), String> {
    if !matches!(op.as_str(), "status" | "evolve" | "rollback" | "history") {
        return Err(format!("invalid meta op '{op}'"));
    }
    let msg = serde_json::json!({ "type": format!("meta_{op}") }).to_string();
    let tx = {
        let guard = state.cinderpaw_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "cinderpaw-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Slice A6 (L5 Governance) — drive the sidecar's GovernanceLifecycle from
/// the desktop Governance card. Fire-and-forget like `feral_meta`; the
/// sidecar replies with one `governance_result` line over
/// `cinderpaw://agent-output`. Only the ops the card needs are exposed — the
/// full set lives in the gateway API + `feral governance` CLI. Approve
/// deliberately omits `documentHash`: the sidecar computes it from the
/// stored proposal (A5 convenience path).
#[tauri::command]
#[specta::specta]
pub(crate) async fn feral_governance(
    state: State<'_, AppState>,
    op: String,
    policy_id: Option<String>,
    reason: Option<String>,
) -> Result<(), String> {
    if !matches!(op.as_str(), "status" | "verify" | "approve" | "reject") {
        return Err(format!("invalid governance op '{op}'"));
    }
    let mut msg = serde_json::json!({ "type": format!("governance_{op}") });
    if let Some(id) = policy_id {
        msg["policyId"] = serde_json::Value::String(id);
    }
    if let Some(r) = reason {
        msg["reason"] = serde_json::Value::String(r);
    }
    let tx = {
        let guard = state.cinderpaw_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "cinderpaw-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg.to_string()).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Phase B (L4 Architecture Evolution) — drive the sidecar's module
/// lifecycle from the desktop Architecture card. Fire-and-forget like
/// `feral_governance`; the sidecar replies with one `modules_result` line
/// over `cinderpaw://agent-output`. Only the card's ops are exposed (list /
/// approve / reject / demote) — `evaluate` lives in the gateway API + CLI
/// (it monopolises the model for minutes; not a card button).
#[tauri::command]
#[specta::specta]
pub(crate) async fn feral_modules(
    state: State<'_, AppState>,
    op: String,
    module_id: Option<String>,
    seam: Option<String>,
    note: Option<String>,
) -> Result<(), String> {
    let msg_type = match op.as_str() {
        "list" => "modules_list",
        "approve" | "reject" | "demote" => "module_resolve",
        _ => return Err(format!("invalid modules op '{op}'")),
    };
    let mut msg = serde_json::json!({ "type": msg_type });
    if msg_type == "module_resolve" {
        msg["moduleAction"] = serde_json::Value::String(op);
    }
    if let Some(id) = module_id {
        msg["moduleId"] = serde_json::Value::String(id);
    }
    if let Some(s) = seam {
        msg["seam"] = serde_json::Value::String(s);
    }
    if let Some(n) = note {
        msg["note"] = serde_json::Value::String(n);
    }
    let tx = {
        let guard = state.cinderpaw_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "cinderpaw-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg.to_string()).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// BRSI §2.8 `user` Wake trigger: ask the sidecar's Dream Cycle to run one
/// evolutionary episode now, bypassing the idle/cooldown gate. Fire-and-forget
/// like the benchmark command — the sidecar's scheduler launches on its next
/// tick and emits the usual `dream_cycle` "started"/"ended" events.
#[tauri::command]
#[specta::specta]
pub(crate) async fn feral_dream_now(state: State<'_, AppState>) -> Result<(), String> {
    let msg = serde_json::json!({ "type": "rsi_dream_now" }).to_string();
    let tx = {
        let guard = state.cinderpaw_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "cinderpaw-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Faza 2 Slice 5 — approval gate: ask the sidecar for the pending code-patch
/// queue. Fire-and-forget; the sidecar replies with one `code_patches` line
/// (full queue + first-10 window state) forwarded over `cinderpaw://agent-output`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn feral_code_patches_list(state: State<'_, AppState>) -> Result<(), String> {
    let msg = serde_json::json!({ "type": "rsi_code_patches_list" }).to_string();
    let tx = {
        let guard = state.cinderpaw_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "cinderpaw-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Faza 2 Slice 5 — approval gate: approve or reject one pending code patch.
/// `action` is validated HERE so a compromised webview cannot smuggle another
/// verb; an approval also live-applies in the sidecar when the source repo is
/// configured. The sidecar acks with `code_patch_resolved` + a refreshed
/// `code_patches` line.
#[tauri::command]
#[specta::specta]
pub(crate) async fn feral_code_patch_resolve(
    state: State<'_, AppState>,
    patch_id: String,
    action: String,
) -> Result<(), String> {
    if action != "approve" && action != "reject" {
        return Err(format!("invalid action '{action}' — approve|reject"));
    }
    let msg = serde_json::json!({
        "type": "rsi_code_patch_resolve",
        "id": patch_id,
        "patchAction": action,
    })
    .to_string();
    let tx = {
        let guard = state.cinderpaw_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "cinderpaw-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Agent Cowork S6 — ask the sidecar to replay one thread's cowork messages.
///
/// Fire-and-forget: the answer arrives as a `cowork_history_result` event on
/// the normal stream, paired by thread id. The panel is otherwise live-only,
/// so reopening a chat where teammates had worked showed nothing at all even
/// though every row was still in the mailbox.
#[tauri::command]
#[specta::specta]
pub(crate) async fn feral_cowork_history(
    state: State<'_, AppState>,
    thread_id: Option<String>,
) -> Result<(), String> {
    let tid = thread_id.as_deref().unwrap_or("").trim().to_string();
    let msg = serde_json::json!({
        "type": "cowork_history",
        "threadId": tid,
    })
    .to_string();
    let tx = {
        let guard = state.cinderpaw_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "feral-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Agent Cowork S6 — send a message the person typed in the Agent Cowork
/// panel straight to one teammate's inbox.
///
/// Direct on purpose. Asking the main agent to pass it along costs a whole
/// model turn to retype something the human already wrote, and lets the
/// wording drift on the way — the telephone game Darius named. The sidecar
/// validates the teammate id against the roster; empty bodies are rejected
/// here so a stray Enter cannot wake an agent for nothing.
#[tauri::command]
#[specta::specta]
pub(crate) async fn feral_cowork_send_message(
    state: State<'_, AppState>,
    to_agent_id: String,
    body: String,
    thread_id: Option<String>,
) -> Result<(), String> {
    if to_agent_id.trim().is_empty() {
        return Err("no teammate selected".to_string());
    }
    if body.trim().is_empty() {
        return Err("message is empty".to_string());
    }
    let msg = serde_json::json!({
        "type": "cowork_user_message",
        "toAgentId": to_agent_id,
        "body": body,
        "threadId": thread_id,
    })
    .to_string();
    let tx = {
        let guard = state.cinderpaw_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "feral-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Agent Cowork S4 — approval gate: forward the user's approve/deny answer
/// for one cowork approval request to the sidecar. `action` is validated HERE
/// so a compromised webview cannot smuggle another verb. Fire-and-forget; the
/// sidecar acks through the `cowork_event` stream (approval_approved /
/// approval_denied), which also closes the chat bubble.
#[tauri::command]
#[specta::specta]
pub(crate) async fn feral_cowork_approval_resolve(
    state: State<'_, AppState>,
    request_id: String,
    action: String,
) -> Result<(), String> {
    if action != "approve" && action != "reject" {
        return Err(format!("invalid action '{action}' — approve|reject"));
    }
    let msg = serde_json::json!({
        "type": "cowork_approval_resolve",
        "id": request_id,
        "approvalAction": action,
    })
    .to_string();
    let tx = {
        let guard = state.cinderpaw_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "cinderpaw-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Agent Cowork S6 — the person writing to a teammate DIRECTLY from the
/// transcript panel, without spending a main-agent turn to retype what they
/// already wrote. Fire-and-forget; the sidecar emits the `cowork_event` that
/// puts the message on screen, or an `error` event naming the teammate it
/// could not find.
#[tauri::command]
#[specta::specta]
pub(crate) async fn feral_cowork_send_message(
    state: State<'_, AppState>,
    to: String,
    body: String,
    thread_id: Option<String>,
) -> Result<(), String> {
    if to.trim().is_empty() || body.trim().is_empty() {
        return Err("a teammate and a message are both required".to_string());
    }
    let msg = serde_json::json!({
        "type": "cowork_send_message",
        "coworkTo": to,
        "content": body,
        "coworkThreadId": thread_id,
    })
    .to_string();
    let tx = {
        let guard = state.cinderpaw_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "cinderpaw-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Agent Cowork S6 — replay one chat thread's cowork mailbox. Fire-and-forget;
/// the sidecar answers with one `cowork_history` event. Without this the
/// transcript panel is empty after every restart, and a person cannot tell
/// "nobody answered" from "the app forgot".
#[tauri::command]
#[specta::specta]
pub(crate) async fn feral_cowork_history(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<(), String> {
    if thread_id.trim().is_empty() {
        return Err("thread_id is required".to_string());
    }
    let msg = serde_json::json!({
        "type": "cowork_history",
        "coworkThreadId": thread_id,
    })
    .to_string();
    let tx = {
        let guard = state.cinderpaw_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "cinderpaw-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Faza 4 (L2 LoRA) — personal-adaptation gate: ask the sidecar for the LoRA
/// review inbox + per-domain champions. Fire-and-forget; the sidecar replies
/// with one `lora_reviews` line forwarded over `cinderpaw://agent-output`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn feral_lora_reviews_list(state: State<'_, AppState>) -> Result<(), String> {
    let msg = serde_json::json!({ "type": "rsi_lora_reviews_list" }).to_string();
    let tx = {
        let guard = state.cinderpaw_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "cinderpaw-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Faza 4 (L2 LoRA) — approve or reject one LoRA review card. `action` is
/// validated HERE (same rule as code patches: the webview can't smuggle
/// another verb). An approval promotes the adapter to domain champion AND
/// applies it to the loaded model live. Sidecar acks with
/// `lora_review_resolved` + a refreshed `lora_reviews`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn feral_lora_review_resolve(
    state: State<'_, AppState>,
    card_id: String,
    action: String,
) -> Result<(), String> {
    if action != "approve" && action != "reject" {
        return Err(format!("invalid action '{action}' — approve|reject"));
    }
    let msg = serde_json::json!({
        "type": "rsi_lora_review_resolve",
        "id": card_id,
        "loraAction": action,
    })
    .to_string();
    let tx = {
        let guard = state.cinderpaw_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "cinderpaw-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Faza 4 (L2 LoRA) — run one training cycle (dataset → trainer → paired eval
/// → review card). Fire-and-forget; progress lands as a `lora_train_result`
/// line + a refreshed `lora_reviews`. Training needs a local primary model and
/// FERAL_LORA_TRAINER_BIN on the sidecar's env — without them the sidecar
/// reports a clear "training unavailable" reason instead of erroring here.
#[tauri::command]
#[specta::specta]
pub(crate) async fn feral_lora_train(state: State<'_, AppState>, domain: Option<String>) -> Result<(), String> {
    let msg = serde_json::json!({
        "type": "rsi_lora_train",
        "loraDomain": domain.unwrap_or_else(|| "general".into()),
    })
    .to_string();
    let tx = {
        let guard = state.cinderpaw_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "cinderpaw-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Reactive-tree drill-down: ask the sidecar for the real member memories of a
/// top-level RAPTOR cluster. Fire-and-forget like the benchmark — the sidecar
/// replies with a `fractal_cluster_leaves_result` line (paired by `request_id`)
/// which Rust forwards over `cinderpaw://agent-output`; the React tree correlates by
/// id. Returns once the request is queued.
#[tauri::command]
#[specta::specta]
pub(crate) async fn feral_fractal_cluster_leaves(
    state: State<'_, AppState>,
    request_id: String,
    cluster_index: u32,
) -> Result<(), String> {
    let msg = serde_json::json!({
        "type": "fractal_cluster_leaves",
        "id": request_id,
        "clusterIndex": cluster_index,
    })
    .to_string();
    let tx = {
        let guard = state.cinderpaw_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "cinderpaw-agent is not running".to_string())?
            .clone()
    };
    tx.send(msg).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Forward the user's `ask_user` selection back to the Cinderpaw Agent sidecar.
///
/// The React side calls this after the user picks an option in the
/// `AskUserCard`. Without this command the sidecar never receives the
/// user's response, the pending `AskUserBridge.ask()` Promise hangs, and
/// the agent eventually times out (regression test for the v0.1.x bug
/// where the user reported "I picked an answer and the agent
/// immediately said it timed out").
///
/// `request_id` matches the `id` of the original outbound `ask_user`
/// event. `answers` is the user's selection (1 answer per question).
#[tauri::command]
#[specta::specta]
pub(crate) async fn feral_ask_user_response(
    state: State<'_, AppState>,
    request_id: String,
    answers: Vec<cinderpaw_agent::AskUserAnswer>,
) -> Result<(), String> {
    let line = cinderpaw_agent::build_ask_user_response_line(&request_id, &answers)?;
    let tx = {
        let guard = state.cinderpaw_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "cinderpaw-agent is not running".to_string())?
            .clone()
    };
    tx.send(line).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Cancel a pending `ask_user` request (user clicked Skip, or the UI is
/// tearing down). The sidecar calls `AskUserBridge.cancel(id, reason)`
/// which rejects the tool's `await ctx.askUser.ask(...)` with the
/// supplied reason. The agent loop sees the rejection and continues
/// with whatever fallback the model chose for the missing input.
#[tauri::command]
#[specta::specta]
pub(crate) async fn feral_ask_user_cancel(
    state: State<'_, AppState>,
    request_id: String,
    reason: Option<String>,
) -> Result<(), String> {
    let line = cinderpaw_agent::build_ask_user_cancel_line(&request_id, reason.as_deref())?;
    let tx = {
        let guard = state.cinderpaw_agent_tx.lock();
        guard
            .as_ref()
            .ok_or_else(|| "cinderpaw-agent is not running".to_string())?
            .clone()
    };
    tx.send(line).await.map_err(|e| e.to_string())?;
    Ok(())
}
