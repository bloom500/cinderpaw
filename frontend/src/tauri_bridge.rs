//! Thin wrapper around Tauri's JS API (`window.__TAURI__.core.invoke`).
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsValue;

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

/// Subscribe to a Tauri event. Returns a closure that must outlive the listener.
pub fn listen<F: FnMut(JsValue) + 'static>(event: &str, handler: F) -> Closure<dyn FnMut(JsValue)> {
    let closure = Closure::new(handler);
    let evt = event.to_string();
    let cb_ref = closure.as_ref().clone();
    wasm_bindgen_futures::spawn_local(async move {
        let handler_closure: Closure<dyn FnMut(JsValue)> =
            Closure::wrap(Box::new(move |v: JsValue| {
                let f = cb_ref.unchecked_ref::<js_sys::Function>();
                let _ = f.call1(&JsValue::NULL, &v);
            }) as Box<dyn FnMut(JsValue)>);
        let _ = js_listen(&evt, &handler_closure).await;
        handler_closure.forget();
    });
    closure
}
