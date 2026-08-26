// CinderpawAgent/src/protocol.ts
// Single source of truth for the desktop<->sidecar stdin/stdout protocol.
// Rust mirror: crates/feral-core/src/sidecar_protocol.rs (kept in sync by
// crates/feral-core/tests/protocol_drift.rs).
//
// INBOUND_TYPES mirrors the `InboundMessage.type` union in ./types.ts (also
// pinned there at compile time by transports/tauri.ts's exhaustiveness
// check). OUTBOUND_TYPES mirrors the `OutboundEvent` union in ./types.ts,
// plus "hello" — the boot line emitted before any other protocol traffic,
// which is not itself part of `OutboundEvent`.

export const SIDECAR_PROTOCOL = 1;

// NOTE: keep this array free of comments. `protocol_drift.rs` extracts it by
// slicing between the brackets and splitting on commas, so any prose in here
// parses as type names.
//
// `admin_response`, `capability_response` and `provider_conformance` were
// missing from this list (and so from the Rust mirror) until 2026-08-26 — the
// allow-list was duplicated inside transports/tauri.ts and only that copy was
// compile-checked, so the canonical one fell behind in silence.
export const INBOUND_TYPES = [
  "message", "record_turn", "ping", "shutdown", "set_model", "stop",
  "ask_user_response", "ask_user_cancel",
  "cron_add", "cron_remove", "cron_toggle", "cron_list",
  "desktop_control_response", "connectors_reload",
  "fractal_benchmark", "fractal_cluster_leaves",
  "rsi_start", "rsi_stop", "rsi_set_concurrency", "rsi_dream_now",
  "rsi_code_patches_list", "rsi_code_patch_resolve",
  "rsi_lora_train", "rsi_lora_reviews_list", "rsi_lora_review_resolve",
  "meta_status", "meta_evolve", "meta_rollback", "meta_history",
  "governance_status", "governance_propose", "governance_approve",
  "governance_reject", "governance_rollback", "governance_freeze",
  "governance_unfreeze", "governance_verify", "governance_history",
  "modules_list", "module_resolve", "module_evaluate", "module_propose",
  "resume_get", "compact_session", "rsi_response", "start_onboarding",
  "tool_confirmation_response", "feedback",
  "mcp_reload", "mcp_status", "mcp_list_tools", "mcp_call_tool",
  "cowork_approval_resolve", "cowork_user_message",
  "admin_response", "capability_response", "provider_conformance",
  "cowork_history",
] as const;

export const OUTBOUND_TYPES = [
  "chunk", "done", "tool_start", "tool_progress", "tool_done", "proactive",
  "model_set", "model_error", "pong", "error", "ask_user",
  "ask_user_cancelled", "usage", "budget_warning", "budget_exceeded",
  "heartbeat", "stream_progress", "cron_fired", "cron_error",
  "desktop_control_request", "rsi_engine_event", "rsi_request",
  "meta_result", "governance_result", "modules_result", "mcp_result",
  "cowork_history_result",
  "resume_get_result", "compact_result", "fractal_bench_progress", "fractal_bench_result",
  "code_patches", "code_patch_resolved", "lora_reviews",
  "lora_review_resolved", "lora_train_result", "fractal_activity", "rlm_child",
  "fractal_cluster_leaves_result", "dream_cycle", "provider_added",
  "provider_removed", "provider_validated", "provider_validation_failed",
  "connector_configured", "connector_connected", "connector_disconnected",
  "connector_connection_failed", "memory_mode_changed",
  "permission_changed", "model_download_started",
  "model_download_progress", "model_download_finished",
  "model_download_failed", "wizard_step_completed",
  "onboarding_goal_completed", "onboarding_all_goals_done",
  "onboarding_suggestion", "confirmation_required",
  "confirmation_granted", "confirmation_denied", "rate_limited", "hello",
] as const;
