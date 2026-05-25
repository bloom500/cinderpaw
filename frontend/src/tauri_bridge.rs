//! Thin wrapper around Tauri's JS API (`window.__TAURI__.core.invoke`).
use js_sys::Function;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use wasm_bindgen::prelude::*;
use wasm_bindgen::{JsCast, JsValue};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = ["window", "__TAURI__", "core"], js_name = invoke)]
    async fn js_invoke(cmd: &str, args: JsValue) -> JsValue;

    #[wasm_bindgen(js_namespace = ["window", "__TAURI__", "event"], js_name = listen)]
    async fn js_listen(event: &str, handler: &Closure<dyn FnMut(JsValue)>) -> JsValue;
}

pub async fn invoke<T: DeserializeOwned>(cmd: &str, args: impl Serialize) -> Result<T, String> {
    let args_js = serde_wasm_bindgen::to_value(&args).map_err(|e| e.to_string())?;
    let result = js_invoke(cmd, args_js).await;
    serde_wasm_bindgen::from_value::<T>(result).map_err(|e| e.to_string())
}

pub async fn invoke_unit(cmd: &str, args: impl Serialize) -> Result<(), String> {
    let args_js = serde_wasm_bindgen::to_value(&args).map_err(|e| e.to_string())?;
    let _ = js_invoke(cmd, args_js).await;
    Ok(())
}

pub async fn invoke_json(cmd: &str, args: impl Serialize) -> Result<Value, String> {
    invoke(cmd, args).await
}

/// Subscribe to a Tauri event. The closure is leaked (app-lifetime listener).
pub fn listen<F: FnMut(JsValue) + 'static>(event: &str, handler: F) {
    let closure = Closure::new(handler);
    let evt = event.to_string();
    wasm_bindgen_futures::spawn_local(async move {
        let _ = js_listen(&evt, &closure).await;
        closure.forget();
    });
}

/// Register a Tauri event listener and return the unlisten handle.
/// Await this BEFORE invoking the command that emits the event to avoid races.
/// Pass the returned JsValue to `call_unlisten` when done.
pub async fn listen_once_async<F: FnMut(JsValue) + 'static>(event: &str, handler: F) -> JsValue {
    let closure = Closure::new(handler);
    let unlisten = js_listen(event, &closure).await;
    closure.forget();
    unlisten
}

/// Call the unlisten function returned by `listen_once_async`.
/// Silently does nothing if the value is not callable.
pub fn call_unlisten(jv: &JsValue) {
    if let Some(f) = jv.dyn_ref::<Function>() {
        let _ = f.call0(&JsValue::NULL);
    }
}
