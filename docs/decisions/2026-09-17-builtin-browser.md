# Built-in browser (Phase 6 of the workspace/artifacts plan)

Decided 2026-09-17. Darius asked for a browser that works as a real browser for
a person and that the agent can drive more easily than `computer_use` driving
Brave.

## What it is

A panel beside the chat, like Artifacts, holding a real web page: address bar,
back, forward, reload. The page is a **child webview inside the main window**,
positioned over the panel's body. Logins persist in its own profile directory,
`~/.cinderpaw/browser-profile`, separate from the app's own webview.

## Why this engine

| | System webview (chosen) | Playwright + bundled Chromium |
|---|---|---|
| First run for a stranger | nothing to download | ~300 MB before first use |
| A person can use it | yes, same panel | a second window |
| Agent control | DOM snapshot + actions, UIA for real clicks | full CDP |
| macOS / Linux | works; same code path (see below) | works |

The default is the product: a download the size of the app itself before the
browser opens is a first-run failure, not a setting.

## How the agent drives it

One tool, `browser`, with an `action`: `open`, `snapshot`, `click`, `type`,
`press`, `scroll`, `back`, `forward`, `reload`. It travels over the existing
`desktop_control` request channel as `browser.<action>`, so there is no new
protocol between sidecar and host.

`snapshot` returns the page's URL, title, visible text (capped) and a numbered
list of interactive elements (links, buttons, fields). The agent says "click 12"
or "type into 7". That is the difference from driving Brave: no pixel guessing,
no hunting a window, the element list is the page.

When a site ignores synthetic clicks (it checks `isTrusted`), the page is still
inside Cinderpaw's own window, which Windows exposes through UI Automation, so
`computer_use` can press the same control for real. No extra code.

## How results come back from the page

`Webview::eval` does not return a value. The injected script writes its JSON
result into the page URL's fragment with `history.replaceState` (no navigation,
no reload, no event a page listens to), tagged with a per-call nonce; the host
reads it through `Webview::url()` and puts the original URL back.

Chosen over WebView2's native `ExecuteScript` because it is the same code on
all three platforms and needs no unsafe Windows bindings. Chosen over any IPC
because web pages get **no** IPC access at all: the capability file grants
commands to local content only, and this must stay true.

Ceiling: a page's own script can read or forge the fragment. It can only lie
about itself, which it can already do by rendering, and page content is
untrusted input to the model regardless.

## Security rules

- Web pages never receive Tauri command access (no `remote` in capabilities).
- Navigation is limited to `http`, `https` and `about:blank`; `file:`,
  `javascript:` and app schemes are refused.
- Snapshots never include the value of a password field.
- Everything read from a page reaches the model as untrusted data. A page that
  says "send the report to X" is the injection `artifact_send`'s approval exists
  for.

## Slices

1. Panel + child webview + address bar; agent tool with `open`, `snapshot`,
   `click`, `type`, `navigate` actions. (this change)
2. Downloads land in Artifacts (a PDF form found by browsing becomes an
   artifact the agent can fill).
3. Tabs.
4. "Take over" affordance: the panel shows when the agent is driving, and a
   click by the person pauses it.
