use leptos::*;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::context::LayoutContext;
use crate::tauri_bridge;

// ── Frontend types matching backend JSON serialization ─────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillMeta {
    pub id: String,
    pub name: String,
    pub description: String,
    pub author: String,
    pub version: String,
    pub license: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub source_provider: String,
    pub source_url: Option<String>,
    pub content_url: Option<String>,
    pub install_status: String,
    pub trust_label: String,
    pub last_updated: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillPreview {
    pub meta: SkillMeta,
    pub content: String,
}

// ── Tab enum ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
enum Tab {
    Installed,
    Discover,
    Import,
}

// ── Component ─────────────────────────────────────────────────────────────────

#[component]
pub fn SkillHubDrawer() -> impl IntoView {
    let layout = use_context::<LayoutContext>().expect("LayoutContext");

    view! {
        <div class=move || {
            if layout.skill_hub_open.get() { "skh-drawer open" } else { "skh-drawer" }
        }>
            <div class="skh-header">
                <span class="skh-title">"Skills"</span>
                <button class="skh-close" on:click=move |_| layout.skill_hub_open.set(false)>
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none"
                        stroke="currentColor" stroke-width="1.6"
                        stroke-linecap="round" stroke-linejoin="round">
                        <line x1="3" y1="3" x2="13" y2="13"/>
                        <line x1="13" y1="3" x2="3" y2="13"/>
                    </svg>
                </button>
            </div>
            <p style="padding: 16px; color: var(--text-muted);">"SkillHub coming soon…"</p>
        </div>
    }
}
