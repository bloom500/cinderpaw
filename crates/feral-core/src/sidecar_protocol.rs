//! Rust mirror of FeralAgent/src/protocol.ts. Kept in sync by
//! tests/protocol_drift.rs, which reads protocol.ts at test time and
//! diffs the name sets.

pub const SIDECAR_PROTOCOL: u32 = 1;

pub const INBOUND_TYPES: &[&str] = &[
    "message", "ping", "shutdown", "set_model", "stop",
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
    "modules_list", "module_resolve", "module_evaluate",
    "resume_get", "rsi_response", "start_onboarding",
    "tool_confirmation_response",
    "mcp_reload", "mcp_status", "mcp_list_tools", "mcp_call_tool",
];

pub const OUTBOUND_TYPES: &[&str] = &[
    "chunk", "done", "tool_start", "tool_progress", "tool_done", "proactive",
    "model_set", "model_error", "pong", "error", "ask_user",
    "ask_user_cancelled", "usage", "budget_warning", "budget_exceeded",
    "heartbeat", "stream_progress", "cron_fired", "cron_error",
    "desktop_control_request", "rsi_engine_event", "rsi_request",
    "meta_result", "governance_result", "modules_result", "mcp_result",
    "resume_get_result", "fractal_bench_progress", "fractal_bench_result",
    "code_patches", "code_patch_resolved", "lora_reviews",
    "lora_review_resolved", "lora_train_result", "fractal_activity",
    "fractal_cluster_leaves_result", "dream_cycle", "provider_added",
    "provider_removed", "provider_validated", "provider_validation_failed",
    "connector_configured", "connector_connected", "connector_disconnected",
    "connector_connection_failed", "memory_mode_changed",
    "permission_changed", "model_download_started",
    "model_download_progress", "model_download_finished",
    "model_download_failed", "wizard_step_completed",
    "onboarding_goal_completed", "onboarding_all_goals_done",
    "onboarding_suggestion", "confirmation_required",
    "confirmation_granted", "confirmation_denied", "hello",
];
