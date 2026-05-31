use leptos::*;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::context::LayoutContext;
use crate::tauri_bridge;

// ── Frontend types ─────────────────────────────────────────────────────────────

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

#[derive(Debug, Clone, Copy, PartialEq)]
enum Tab {
    Installed,
    Discover,
    Import,
}

#[component]
pub fn SkillHubDrawer() -> impl IntoView {
    let layout = use_context::<LayoutContext>().expect("LayoutContext");

    // ── Tab state ──────────────────────────────────────────────────────────────
    let (active_tab, set_active_tab) = create_signal(Tab::Installed);

    // ── Installed tab state ────────────────────────────────────────────────────
    let installed_skills = create_rw_signal::<Vec<SkillMeta>>(vec![]);
    let installed_loading = create_rw_signal(false);
    let installed_error = create_rw_signal::<Option<String>>(None);

    // ── Discover tab state ─────────────────────────────────────────────────────
    let remote_skills = create_rw_signal::<Vec<SkillMeta>>(vec![]);
    let remote_loading = create_rw_signal(false);
    let remote_error = create_rw_signal::<Option<String>>(None);
    let remote_fetched = create_rw_signal(false);

    // ── Detail panel state (shared) ───────────────────────────────────────────
    let selected_skill = create_rw_signal::<Option<SkillMeta>>(None);
    let selected_content = create_rw_signal::<Option<String>>(None);
    let selected_content_loading = create_rw_signal(false);
    let selected_content_error = create_rw_signal::<Option<String>>(None);

    // ── Transient action state ─────────────────────────────────────────────────
    let installing = create_rw_signal::<Option<String>>(None);
    let overwrite_pending = create_rw_signal::<Option<String>>(None);
    let remove_pending = create_rw_signal::<Option<String>>(None);

    // ── Import tab state ───────────────────────────────────────────────────────
    let import_input = create_rw_signal(String::new());
    let import_loading = create_rw_signal(false);
    let import_error = create_rw_signal::<Option<String>>(None);

    // ── Load installed on drawer open ──────────────────────────────────────────
    let open_signal = layout.skill_hub_open;
    create_effect(move |prev_open: Option<bool>| {
        let is_open = open_signal.get();
        if is_open && prev_open != Some(true) {
            installed_loading.set(true);
            installed_error.set(None);
            spawn_local(async move {
                match tauri_bridge::invoke::<Vec<SkillMeta>>(
                    "list_installed_skills",
                    json!({}),
                ).await {
                    Ok(list) => {
                        installed_skills.set(list);
                        installed_loading.set(false);
                    }
                    Err(e) => {
                        installed_error.set(Some(e));
                        installed_loading.set(false);
                    }
                }
            });
        }
        is_open
    });

    // ── reload_installed helper ────────────────────────────────────────────────
    let reload_installed = move || {
        installed_loading.set(true);
        installed_error.set(None);
        spawn_local(async move {
            match tauri_bridge::invoke::<Vec<SkillMeta>>("list_installed_skills", json!({})).await {
                Ok(list) => {
                    let installed_ids: std::collections::HashSet<String> =
                        list.iter().map(|m| m.id.clone()).collect();
                    installed_skills.set(list);
                    installed_loading.set(false);
                    remote_skills.update(|rs| {
                        for s in rs.iter_mut() {
                            s.install_status = if installed_ids.contains(&s.id) {
                                "installed".to_string()
                            } else {
                                "not_installed".to_string()
                            };
                        }
                    });
                }
                Err(e) => {
                    installed_error.set(Some(e));
                    installed_loading.set(false);
                }
            }
        });
    };

    view! {
        <div class=move || if layout.skill_hub_open.get() { "skh-drawer open" } else { "skh-drawer" }>

            // ── Header ──────────────────────────────────────────────────────────
            <div class="skh-header">
                <span class="skh-title">"Skills"</span>
                <button class="skh-close" on:click=move |_| {
                    layout.skill_hub_open.set(false);
                    selected_skill.set(None);
                }>
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none"
                        stroke="currentColor" stroke-width="1.6"
                        stroke-linecap="round" stroke-linejoin="round">
                        <line x1="3" y1="3" x2="13" y2="13"/>
                        <line x1="13" y1="3" x2="3" y2="13"/>
                    </svg>
                </button>
            </div>

            // ── Tab bar (hidden when detail panel is open) ───────────────────────
            {move || selected_skill.get().is_none().then(|| view! {
                <div class="skh-tabs">
                    <button
                        class=move || if active_tab.get() == Tab::Installed { "skh-tab active" } else { "skh-tab" }
                        on:click=move |_| set_active_tab.set(Tab::Installed)>
                        "Installed"
                    </button>
                    <button
                        class=move || if active_tab.get() == Tab::Discover { "skh-tab active" } else { "skh-tab" }
                        on:click=move |_| {
                            set_active_tab.set(Tab::Discover);
                            if !remote_fetched.get() {
                                remote_fetched.set(true);
                                remote_loading.set(true);
                                remote_error.set(None);
                                spawn_local(async move {
                                    match tauri_bridge::invoke::<Vec<SkillMeta>>(
                                        "fetch_remote_skills",
                                        json!({}),
                                    ).await {
                                        Ok(list) => {
                                            remote_skills.set(list);
                                            remote_loading.set(false);
                                        }
                                        Err(e) => {
                                            remote_error.set(Some(e));
                                            remote_loading.set(false);
                                        }
                                    }
                                });
                            }
                        }>
                        "Discover"
                    </button>
                    <button
                        class=move || if active_tab.get() == Tab::Import { "skh-tab active" } else { "skh-tab" }
                        on:click=move |_| set_active_tab.set(Tab::Import)>
                        "Import"
                    </button>
                </div>
            })}

            // ── Content area ────────────────────────────────────────────────────
            <div class="skh-content">
                {move || {
                    if let Some(skill) = selected_skill.get() {
                        let skill_id = skill.id.clone();
                        let is_installed = skill.install_status == "installed";

                        // Pre-clone skill_id for the back button and other closures
                        let skill_id_for_remove_check = skill_id.clone();
                        let skill_id_for_overwrite_check = skill_id.clone();

                        view! {
                            <div class="skh-detail">
                                // Back
                                <button class="skh-back" on:click=move |_| {
                                    selected_skill.set(None);
                                    selected_content.set(None);
                                    selected_content_loading.set(false);
                                    selected_content_error.set(None);
                                    overwrite_pending.set(None);
                                    remove_pending.set(None);
                                }>
                                    <svg viewBox="0 0 16 16" width="12" height="12" fill="none"
                                        stroke="currentColor" stroke-width="1.8"
                                        stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M10 3L5 8l5 5"/>
                                    </svg>
                                    " Back"
                                </button>

                                // Header
                                <div class="skh-detail-header">
                                    <div class="skh-detail-name">{skill.name.clone()}</div>
                                    <span class=format!("skh-badge skh-badge--{}", skill.trust_label)>
                                        {skill.trust_label.clone()}
                                    </span>
                                </div>

                                // Metadata row
                                <div class="skh-detail-meta">
                                    {if !skill.author.is_empty() {
                                        view! { <span>{skill.author.clone()}</span> }.into_view()
                                    } else { view! { <span></span> }.into_view() }}
                                    {if !skill.version.is_empty() && skill.version != "0.0.0" {
                                        view! { <span>"v"{skill.version.clone()}</span> }.into_view()
                                    } else { view! { <span></span> }.into_view() }}
                                    {if !skill.license.is_empty() {
                                        view! { <span>{skill.license.clone()}</span> }.into_view()
                                    } else { view! { <span></span> }.into_view() }}
                                </div>

                                // Tags
                                {if !skill.tags.is_empty() {
                                    let tags = skill.tags.clone();
                                    view! {
                                        <div class="skh-detail-tags">
                                            {tags.into_iter().map(|t| view! {
                                                <span class="skh-tag">{t}</span>
                                            }).collect_view()}
                                        </div>
                                    }.into_view()
                                } else { view! { <span></span> }.into_view() }}

                                // Source link
                                {if let Some(url) = skill.source_url.clone() {
                                    view! {
                                        <div class="skh-detail-source">
                                            <a href=url target="_blank" class="skh-source-link">"View source ↗"</a>
                                        </div>
                                    }.into_view()
                                } else { view! { <span></span> }.into_view() }}

                                // SKILL.md content
                                <div class="skh-detail-content-wrap">
                                    {move || {
                                        if selected_content_loading.get() {
                                            view! { <div class="skh-loading-text">"Loading skill content…"</div> }.into_view()
                                        } else if let Some(err) = selected_content_error.get() {
                                            view! { <div class="skh-error">{err}</div> }.into_view()
                                        } else if let Some(content) = selected_content.get() {
                                            view! { <pre class="skh-skill-content">{content}</pre> }.into_view()
                                        } else {
                                            view! { <span></span> }.into_view()
                                        }
                                    }}
                                </div>

                                // Actions
                                <div class="skh-detail-actions">
                                    {move || {
                                        if is_installed {
                                            // Remove flow
                                            let sid = skill_id_for_remove_check.clone();
                                            if remove_pending.get().as_deref() == Some(&skill_id_for_remove_check) {
                                                let sid2 = sid.clone();
                                                view! {
                                                    <div class="skh-confirm">
                                                        <div class="skh-confirm-text">
                                                            "Remove this skill from Feral? This cannot be undone in v1."
                                                        </div>
                                                        <div class="skh-confirm-btns">
                                                            <button class="btn" style="background:var(--red);"
                                                                on:click=move |_| {
                                                                    let id = sid2.clone();
                                                                    remove_pending.set(None);
                                                                    spawn_local(async move {
                                                                        let _ = tauri_bridge::invoke_unit(
                                                                            "remove_skill",
                                                                            json!({ "id": id }),
                                                                        ).await;
                                                                        selected_skill.set(None);
                                                                        selected_content.set(None);
                                                                        reload_installed();
                                                                    });
                                                                }>
                                                                "Confirm Remove"
                                                            </button>
                                                            <button class="btn ghost"
                                                                on:click=move |_| remove_pending.set(None)>
                                                                "Cancel"
                                                            </button>
                                                        </div>
                                                    </div>
                                                }.into_view()
                                            } else {
                                                view! {
                                                    <button class="btn ghost" style="color:var(--red);"
                                                        on:click=move |_| remove_pending.set(Some(sid.clone()))>
                                                        "Remove"
                                                    </button>
                                                }.into_view()
                                            }
                                        } else {
                                            // Install flow
                                            let sid = skill_id_for_overwrite_check.clone();
                                            let skill_id_for_disabled = skill_id_for_overwrite_check.clone();
                                            let skill_id_for_label = skill_id_for_overwrite_check.clone();
                                            if overwrite_pending.get().as_deref() == Some(&skill_id_for_overwrite_check) {
                                                let sid2 = sid.clone();
                                                view! {
                                                    <div class="skh-confirm">
                                                        <div class="skh-confirm-text">
                                                            "A skill with this ID is already installed. Overwrite?"
                                                        </div>
                                                        <div class="skh-confirm-btns">
                                                            <button class="btn"
                                                                on:click=move |_| {
                                                                    let id = sid2.clone();
                                                                    overwrite_pending.set(None);
                                                                    installing.set(Some(id.clone()));
                                                                    let content = selected_content.get().unwrap_or_default();
                                                                    if let Some(m) = selected_skill.get() {
                                                                        spawn_local(async move {
                                                                            let _ = tauri_bridge::invoke_unit(
                                                                                "install_skill",
                                                                                json!({ "meta": m, "content": content, "overwrite": true }),
                                                                            ).await;
                                                                            installing.set(None);
                                                                            reload_installed();
                                                                            selected_skill.update(|s| {
                                                                                if let Some(s) = s { s.install_status = "installed".to_string(); }
                                                                            });
                                                                        });
                                                                    }
                                                                }>
                                                                "Overwrite"
                                                            </button>
                                                            <button class="btn ghost"
                                                                on:click=move |_| overwrite_pending.set(None)>
                                                                "Cancel"
                                                            </button>
                                                        </div>
                                                    </div>
                                                }.into_view()
                                            } else {
                                                view! {
                                                    <button class="btn"
                                                        disabled=move || installing.get().as_deref() == Some(&skill_id_for_disabled)
                                                        on:click=move |_| {
                                                            let id = sid.clone();
                                                            let content = selected_content.get().unwrap_or_default();
                                                            if let Some(m) = selected_skill.get() {
                                                                installing.set(Some(id.clone()));
                                                                spawn_local(async move {
                                                                    match tauri_bridge::invoke::<bool>(
                                                                        "skill_exists_cmd",
                                                                        json!({ "id": id }),
                                                                    ).await {
                                                                        Ok(true) => {
                                                                            installing.set(None);
                                                                            overwrite_pending.set(Some(id));
                                                                        }
                                                                        Ok(false) => {
                                                                            let _ = tauri_bridge::invoke_unit(
                                                                                "install_skill",
                                                                                json!({ "meta": m, "content": content, "overwrite": false }),
                                                                            ).await;
                                                                            installing.set(None);
                                                                            reload_installed();
                                                                            selected_skill.update(|s| {
                                                                                if let Some(s) = s { s.install_status = "installed".to_string(); }
                                                                            });
                                                                        }
                                                                        Err(_) => { installing.set(None); }
                                                                    }
                                                                });
                                                            }
                                                        }>
                                                        {move || if installing.get().as_deref() == Some(&skill_id_for_label) { "Installing…" } else { "Install" }}
                                                    </button>
                                                }.into_view()
                                            }
                                        }
                                    }}
                                </div>
                            </div>
                        }.into_view()
                    } else {
                        match active_tab.get() {
                            Tab::Installed => render_installed_tab(
                                installed_loading,
                                installed_error,
                                installed_skills,
                                selected_skill,
                                selected_content,
                                selected_content_loading,
                                selected_content_error,
                                reload_installed,
                            ).into_view(),
                            Tab::Discover => {
                                view! {
                                    <div>
                                    {move || {
                                        if remote_loading.get() {
                                            // Skeleton while loading
                                            view! {
                                                <div class="skh-skeleton-list">
                                                    {(0..3).map(|_i: usize| view! {
                                                        <div class="skh-skeleton-card">
                                                            <div class="skh-skeleton-line skh-skeleton-line--title"></div>
                                                            <div class="skh-skeleton-line skh-skeleton-line--body"></div>
                                                            <div class="skh-skeleton-line skh-skeleton-line--body short"></div>
                                                        </div>
                                                    }).collect_view()}
                                                </div>
                                            }.into_view()
                                        } else if let Some(err) = remote_error.get() {
                                            view! {
                                                <div class="skh-error">
                                                    {err}
                                                    <button class="btn ghost" style="margin-top:8px;" on:click=move |_| {
                                                        remote_fetched.set(false);
                                                        remote_loading.set(true);
                                                        remote_error.set(None);
                                                        spawn_local(async move {
                                                            match tauri_bridge::invoke::<Vec<SkillMeta>>(
                                                                "fetch_remote_skills",
                                                                json!({}),
                                                            ).await {
                                                                Ok(list) => {
                                                                    remote_skills.set(list);
                                                                    remote_fetched.set(true);
                                                                    remote_loading.set(false);
                                                                }
                                                                Err(e) => {
                                                                    remote_error.set(Some(e));
                                                                    remote_fetched.set(true);
                                                                    remote_loading.set(false);
                                                                }
                                                            }
                                                        });
                                                    }>"Retry"</button>
                                                </div>
                                            }.into_view()
                                        } else if remote_skills.get().is_empty() {
                                            view! {
                                                <div class="skh-empty">
                                                    "No remote skills found."
                                                    <br/>
                                                    <span class="skh-empty-hint">"Check your connection or try again."</span>
                                                </div>
                                            }.into_view()
                                        } else {
                                            remote_skills.get().into_iter().map(|skill| {
                                                let is_installed = skill.install_status == "installed";
                                                let skill_for_click = skill.clone();
                                                let content_url = skill.content_url.clone().unwrap_or_default();
                                                view! {
                                                    <div class="skh-card">
                                                        <div class="skh-card-row">
                                                            <span class="skh-card-name">{skill.name.clone()}</span>
                                                            <span class=format!("skh-badge skh-badge--{}", skill.trust_label)>
                                                                {skill.trust_label.clone()}
                                                            </span>
                                                        </div>
                                                        <div class="skh-card-desc">{skill.description.clone()}</div>
                                                        {if is_installed {
                                                            view! { <span class="skh-installed-check">"✓ Installed"</span> }.into_view()
                                                        } else {
                                                            view! {
                                                                <button class="btn ghost skh-card-btn"
                                                                    on:click=move |_| {
                                                                        let url = content_url.clone();
                                                                        selected_skill.set(Some(skill_for_click.clone()));
                                                                        selected_content.set(None);
                                                                        selected_content_loading.set(true);
                                                                        selected_content_error.set(None);
                                                                        spawn_local(async move {
                                                                            match tauri_bridge::invoke::<SkillPreview>(
                                                                                "preview_remote_skill",
                                                                                json!({ "url": url }),
                                                                            ).await {
                                                                                Ok(preview) => {
                                                                                    selected_content.set(Some(preview.content));
                                                                                    selected_content_loading.set(false);
                                                                                }
                                                                                Err(e) => {
                                                                                    selected_content_error.set(Some(e));
                                                                                    selected_content_loading.set(false);
                                                                                }
                                                                            }
                                                                        });
                                                                    }>
                                                                    "Preview"
                                                                </button>
                                                            }.into_view()
                                                        }}
                                                    </div>
                                                }
                                            }).collect_view().into_view()
                                        }
                                    }}
                                    </div>
                                }.into_view()
                            },
                            Tab::Import => {
                                view! {
                                    <div class="skh-import">
                                        <div class="skh-import-label">
                                            "Paste a SKILL.md URL (https://raw.githubusercontent.com/…) or a local file path:"
                                        </div>
                                        <input
                                            class="input"
                                            style="font-size:12px;"
                                            placeholder="https://raw.githubusercontent.com/… or /path/to/SKILL.md"
                                            prop:value=move || import_input.get()
                                            on:input=move |e| import_input.set(event_target_value(&e))
                                        />
                                        <div class="row" style="margin-top:4px;">
                                            <button class="btn"
                                                disabled=move || import_loading.get() || import_input.get().trim().is_empty()
                                                on:click=move |_| {
                                                    let raw = import_input.get();
                                                    let input = raw.trim().to_string();
                                                    if input.is_empty() { return; }
                                                    import_loading.set(true);
                                                    import_error.set(None);
                                                    let is_url = input.starts_with("https://");
                                                    spawn_local(async move {
                                                        let result = if is_url {
                                                            tauri_bridge::invoke::<SkillPreview>(
                                                                "preview_remote_skill",
                                                                json!({ "url": input }),
                                                            ).await
                                                        } else {
                                                            tauri_bridge::invoke::<SkillPreview>(
                                                                "preview_local_skill",
                                                                json!({ "path": input }),
                                                            ).await
                                                        };
                                                        import_loading.set(false);
                                                        match result {
                                                            Ok(preview) => {
                                                                selected_skill.set(Some(preview.meta));
                                                                selected_content.set(Some(preview.content));
                                                                selected_content_loading.set(false);
                                                                selected_content_error.set(None);
                                                            }
                                                            Err(e) => {
                                                                import_error.set(Some(e));
                                                            }
                                                        }
                                                    });
                                                }>
                                                {move || if import_loading.get() { "Loading…" } else { "Preview" }}
                                            </button>
                                        </div>
                                        {move || import_error.get().map(|e| view! {
                                            <div class="skh-error">{e}</div>
                                        })}
                                    </div>
                                }.into_view()
                            },
                        }
                    }
                }}
            </div>
        </div>
    }
}

// ── Installed tab renderer ────────────────────────────────────────────────────

fn render_installed_tab(
    installed_loading: RwSignal<bool>,
    installed_error: RwSignal<Option<String>>,
    installed_skills: RwSignal<Vec<SkillMeta>>,
    selected_skill: RwSignal<Option<SkillMeta>>,
    selected_content: RwSignal<Option<String>>,
    selected_content_loading: RwSignal<bool>,
    selected_content_error: RwSignal<Option<String>>,
    reload_installed: impl Fn() + Copy + 'static,
) -> impl IntoView {
    view! {
        <div>
        {move || {
            if installed_loading.get() {
                view! { <div class="skh-loading-text">"Loading…"</div> }.into_view()
            } else if let Some(err) = installed_error.get() {
                view! {
                    <div class="skh-error">
                        {err}
                        <button class="btn ghost" style="margin-top:8px;"
                            on:click=move |_| reload_installed()>
                            "Retry"
                        </button>
                    </div>
                }.into_view()
            } else if installed_skills.get().is_empty() {
                view! {
                    <div class="skh-empty">
                        "No skills installed yet."
                        <br/>
                        <span class="skh-empty-hint">"Use Discover or Import to add skills."</span>
                    </div>
                }.into_view()
            } else {
                installed_skills.get().into_iter().map(|skill| {
                    let skill_for_click = skill.clone();
                    view! {
                        <div class="skh-card">
                            <div class="skh-card-row">
                                <span class="skh-card-name">{skill.name.clone()}</span>
                                <span class=format!("skh-badge skh-badge--{}", skill.trust_label)>
                                    {skill.trust_label.clone()}
                                </span>
                            </div>
                            <div class="skh-card-desc">{skill.description.clone()}</div>
                            <button class="btn ghost skh-card-btn"
                                on:click=move |_| {
                                    let id = skill_for_click.id.clone();
                                    selected_skill.set(Some(skill_for_click.clone()));
                                    selected_content.set(None);
                                    selected_content_loading.set(true);
                                    selected_content_error.set(None);
                                    spawn_local(async move {
                                        match tauri_bridge::invoke::<String>(
                                            "get_installed_skill_content",
                                            json!({ "id": id }),
                                        ).await {
                                            Ok(c) => {
                                                selected_content.set(Some(c));
                                                selected_content_loading.set(false);
                                            }
                                            Err(e) => {
                                                selected_content_error.set(Some(e));
                                                selected_content_loading.set(false);
                                            }
                                        }
                                    });
                                }>
                                "Details"
                            </button>
                        </div>
                    }
                }).collect_view().into_view()
            }
        }}
        </div>
    }
}
