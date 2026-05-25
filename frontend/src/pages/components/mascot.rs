use leptos::*;

#[component]
pub fn Mascot() -> impl IntoView {
    view! {
        <div id="mascot-container" class="mascot-container">
            <img class="mascot-layer mascot-body"   src="/Body.png"   alt="" />
            <img class="mascot-layer mascot-eyes"   src="/Eyes.png"   alt="" id="mascot-eyes" />
            <img class="mascot-layer mascot-mouth"  src="/Mouth.png"  alt="" id="mascot-mouth" />
        </div>
    }
}