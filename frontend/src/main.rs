use leptos::*;
use leptos_router::*;
use wasm_bindgen::JsCast;

mod tauri_bridge;
mod pages;

use pages::{agents::AgentsPage, chat::ChatPage, models::ModelsPage, settings::SettingsPage};

fn main() {
    console_error_panic_hook::set_once();
    let document = web_sys::window().unwrap().document().unwrap();
    let app_el = document.query_selector("#app").unwrap().unwrap();
    leptos::mount_to(app_el.unchecked_into(), || view! { <App/> });
}

#[component]
fn App() -> impl IntoView {
    view! {
        <Router>
            <div class="layout">
                <Sidebar/>
                <main class="main">
                    <Routes>
                        <Route path="/" view=ModelsPage/>
                        <Route path="/models" view=ModelsPage/>
                        <Route path="/chat" view=ChatPage/>
                        <Route path="/agents" view=AgentsPage/>
                        <Route path="/settings" view=SettingsPage/>
                    </Routes>
                </main>
            </div>
        </Router>
    }
}

#[component]
fn Sidebar() -> impl IntoView {
    view! {
        <aside class="sidebar">
            <div class="brand">"FERAL"</div>
            <NavItem href="/models" icon="◧" label="Models"/>
            <NavItem href="/chat" icon="✦" label="Chat"/>
            <NavItem href="/agents" icon="⚙" label="Agents"/>
            <NavItem href="/settings" icon="⚒" label="Settings"/>
        </aside>
    }
}

#[component]
fn NavItem(href: &'static str, icon: &'static str, label: &'static str) -> impl IntoView {
    view! {
        <A href=href class="nav-link" active_class="active">
            <span class="nav-icon">{icon}</span>
            <span>{label}</span>
        </A>
    }
}
