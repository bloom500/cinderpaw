/**
 * The sandbox an artifact is allowed to run in. One constant, one reason.
 *
 * `allow-scripts` WITHOUT `allow-same-origin`. The two together are documented
 * as equivalent to removing the sandbox attribute entirely, and this is a Tauri
 * webview: a page with our origin can reach `invoke()`. Artifact HTML is written
 * by a model, sometimes from a web page it read or a file a stranger sent on one
 * of 21 chat platforms, so giving it our origin would be a stored-XSS primitive
 * pointed straight at the command surface.
 *
 * It lives in its own module, and is read from here rather than typed into the
 * `sandbox=` attribute, because the failure mode is somebody adding one more
 * flag six months from now to make a chart work, in a JSX attribute where
 * nothing looks wrong. A constant with a test attached is harder to widen by
 * accident than a string literal is.
 *
 * The sidecar has the same value in `CinderpawAgent/src/artifacts/app.ts`
 * (`APP_IFRAME_SANDBOX`), because it must brief the model on what its app can
 * and cannot do. Two copies of one word, each next to the code that needs it,
 * both pinned by a test.
 */
export const APP_IFRAME_SANDBOX = 'allow-scripts';
