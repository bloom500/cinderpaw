use leptos::*;
use serde_json::json;
use wasm_bindgen::prelude::*;

use crate::pages::types::SystemInfo;
use crate::tauri_bridge;

#[derive(Clone)]
struct Recommendation {
    model:       &'static str,
    tag:         &'static str,
    description: &'static str,
}

fn recommend(info: &SystemInfo) -> Recommendation {
    let available_gb = (info.ram_total_mb.saturating_sub(info.ram_used_mb)) as f64 / 1024.0;
    if available_gb > 12.0 {
        Recommendation {
            model:       "Llama 3 8B",
            tag:         "Recommended for your system",
            description: "Enough free RAM to run a full 8B model at full quality.",
        }
    } else if available_gb > 6.0 {
        Recommendation {
            model:       "Phi-3 Mini 3.8B",
            tag:         "Recommended for your system",
            description: "Great balance of quality and speed with your available memory.",
        }
    } else {
        Recommendation {
            model:       "Qwen 2.5 1.5B",
            tag:         "Recommended for your system",
            description: "A lightweight model tuned for constrained hardware.",
        }
    }
}

fn schedule_timeout(ms: i32, f: impl FnOnce() + 'static) {
    let cb = Closure::once(f);
    web_sys::window()
        .unwrap()
        .set_timeout_with_callback_and_timeout_and_arguments_0(cb.as_ref().unchecked_ref(), ms)
        .ok();
    cb.forget();
}

fn next_frame(f: impl FnOnce() + 'static) {
    let cb = Closure::once(f);
    web_sys::window()
        .unwrap()
        .request_animation_frame(cb.as_ref().unchecked_ref())
        .ok();
    cb.forget();
}

/// iOS-style hardware recommendation toast.
/// Slides in from the top, auto-dismisses after 6 s, dismisses on click.
#[component]
pub fn HwNotification() -> impl IntoView {
    let info_res = create_resource(
        || (),
        |_| async move {
            tauri_bridge::invoke::<SystemInfo>("get_system_info", json!({})).await.ok()
        },
    );

    let (visible, set_visible)   = create_signal(false);
    let (dismissed, set_dismissed) = create_signal(false);

    // Double-rAF: first frame applies the hidden base styles; second frame
    // flips `visible` so the CSS transition fires cleanly from the known state.
    create_effect(move |_| {
        if info_res.get().flatten().is_some() && !dismissed.get_untracked() {
            next_frame(move || {
                next_frame(move || {
                    set_visible.set(true);
                    // Auto-dismiss after 6 s
                    schedule_timeout(6000, move || {
                        set_visible.set(false);
                        // Wait for the exit transition (650 ms) before removing DOM node
                        schedule_timeout(700, move || set_dismissed.set(true));
                    });
                });
            });
        }
    });

    let dismiss = move |_: web_sys::MouseEvent| {
        set_visible.set(false);
        schedule_timeout(700, move || set_dismissed.set(true));
    };

    move || {
        if dismissed.get() {
            return view! { <span></span> }.into_view();
        }

        let content = info_res.get().flatten().map(|info| {
            let rec  = recommend(&info);
            let avail = (info.ram_total_mb.saturating_sub(info.ram_used_mb)) as f64 / 1024.0;
            let ram_label  = format!("{:.0} GB available", avail);
            let cpu_label  = {
                let s = info.cpu.clone();
                // Keep only the first meaningful part (up to first '@' or 28 chars)
                let end = s.find('@').unwrap_or(s.len()).min(28);
                s[..end].trim().to_string()
            };

            view! {
                <div
                    class=move || if visible.get() { "hwn-card hwn-visible" } else { "hwn-card" }
                    on:click=dismiss
                >
                    // Top row: label + close
                    <div class="hwn-row hwn-row--top">
                        <span class="hwn-tag">{rec.tag}</span>
                        <button class="hwn-close" on:click=dismiss>"✕"</button>
                    </div>

                    // Model name (large)
                    <div class="hwn-model">{rec.model}</div>

                    // Description
                    <div class="hwn-desc">{rec.description}</div>

                    // Divider
                    <div class="hwn-divider"></div>

                    // Specs row
                    <div class="hwn-row hwn-row--specs">
                        <span class="hwn-spec">{ram_label}</span>
                        <span class="hwn-sep">"·"</span>
                        <span class="hwn-spec">{format!("{} cores", info.cores)}</span>
                        <span class="hwn-sep">"·"</span>
                        <span class="hwn-spec hwn-spec--cpu">{cpu_label}</span>
                    </div>
                </div>
            }.into_view()
        });

        view! {
            <div class="hwn-wrapper">
                {content}
            </div>
        }.into_view()
    }
}
