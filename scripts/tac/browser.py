#!/usr/bin/env python3
"""
A real browser for the agent, because the baseline has one.

TheAgentCompany's reference agent drives the deployment through a headless
browser: ownCloud's and Plane's login pages are a click for it, and a
reverse-engineering exercise for an API-only agent. Measured in the smoke run
on 2026-09-02 - the agent spent 25 of its 30 minutes working out GitLab's
personal-access-token flow through curl, and the task timed out one checkpoint
short. That gap is tooling, not capability, and arguing about it in a writeup
is worse than closing it.

Two decisions worth knowing before reading the code:

**Chromium runs on the HOST, not in the task container.** The services listen
on the host's own ports, the task image ships no browser, and installing one
per task would cost more wall clock than the task itself. `host-resolver-rules`
makes `the-agent-company.com` resolve to loopback, so every URL the agent
writes works verbatim in both places and nothing in the prompt has to explain
the difference.

**Text only, no screenshots.** The agent model reads text, so a screenshot
would be an image it cannot see, billed as tokens it cannot use. Every page
comes back as its visible text plus a numbered index of the things that can be
clicked or typed into, which is what makes a page addressable to a model that
cannot point at it.
"""

from __future__ import annotations

import time

# The services all live on the host. Chromium is told to resolve the company
# domain to loopback rather than us rewriting the agent's URLs, so what the
# agent types is what gets fetched.
RESOLVER_RULE = "MAP the-agent-company.com 127.0.0.1"

# Caps, so one enormous page cannot eat a task's whole context. Both are
# generous for the service UIs this drives, and both announce themselves when
# they bite rather than truncating silently.
# How long to wait for a single-page app to render before reading it. 8s was
# not enough: measured 2026-09-03, a cold RocketChat rendered nothing inside it
# and the page came back blank, while the same page took 2s once warm. The
# first task of a run is exactly when every service is cold.
SETTLE_MS = 20000

# After an action, wait for the PAGE to stop changing rather than for the
# network to go quiet. RocketChat holds a websocket open and never reaches
# networkidle at all, so waiting on the connection waits forever and then reads
# the intermediate frame anyway: measured 2026-09-03, submitting the login form
# returned a page whose button still said "please wait", three seconds before
# the logged-in home rendered. Watching the text works on all four services
# without knowing anything about any of them.
STABLE_MAX_S = 6.0
STABLE_POLL_MS = 400

MAX_TEXT = 6000
MAX_ELEMENTS = 80

# One selector, used for both the listing and the addressing, so element [12]
# in what the agent read is element [12] when it clicks.
INTERACTIVE = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"]'

# Collect what a text-only agent can act on. The index is the address: the
# agent says click "12" and never needs a CSS selector it cannot see. Document
# order is reading order, so the numbers line up with the text above them.
COLLECT_JS = """
(sel) => {
  for (const old of document.querySelectorAll('[data-tacidx]')) {
    old.removeAttribute('data-tacidx');
  }
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (r.width === 0 && r.height === 0) continue;
    const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder')
      || el.getAttribute('name') || el.getAttribute('value')
      || (el.innerText || '').trim() || el.getAttribute('title') || '').trim();
    el.setAttribute('data-tacidx', String(out.length));
    out.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      label: label.slice(0, 80),
      href: (el.getAttribute('href') || '').slice(0, 120)
    });
  }
  return out;
}
"""


class BrowserUnavailable(RuntimeError):
    """Playwright or its Chromium is not installed on this machine."""


class Browser:
    """One browser per task. Cookies and logins persist across tool calls
    inside a task and die with it, the same lifetime the container has, so no
    task can inherit another task's session."""

    def __init__(self) -> None:
        self._pw = None
        self._browser = None
        self.page = None

    def _ensure(self):
        if self.page is not None:
            return self.page
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as e:
            raise BrowserUnavailable(
                "playwright is not installed. Run `pip install playwright` and "
                "`python -m playwright install chromium`."
            ) from e
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(
            headless=True,
            args=["--host-resolver-rules=" + RESOLVER_RULE],
        )
        ctx = self._browser.new_context(viewport={"width": 1280, "height": 900},
                                        ignore_https_errors=True)
        ctx.set_default_timeout(20000)
        self.page = ctx.new_page()
        return self.page

    def close(self) -> None:
        try:
            if self._browser is not None:
                self._browser.close()
        except Exception:  # noqa: BLE001 - teardown must never fail a task
            pass
        try:
            if self._pw is not None:
                self._pw.stop()
        except Exception:  # noqa: BLE001
            pass
        self._pw = self._browser = self.page = None

    # ---- the four verbs -----------------------------------------------------

    def _settle(self) -> None:
        """Wait for the app to actually render.

        Every service here is a single-page app: RocketChat is Meteor, Plane and
        ownCloud are React. `domcontentloaded` fires on the empty shell, before
        a single word exists. Measured 2026-09-03 against RocketChat, the first
        page this driver ever opened came back with no text and nothing
        clickable, which to the agent is indistinguishable from a service that
        is down. So the wait is for content, not for an event.

        Bounded and swallowed: a page that genuinely has no text (a redirect, a
        JSON endpoint opened by hand) is still a page, and should be returned as
        it is rather than raising.
        """
        page = self.page
        try:
            page.wait_for_function(
                "document.body && document.body.innerText.trim().length > 0",
                timeout=SETTLE_MS,
            )
        except Exception:  # noqa: BLE001 - an empty page is a legitimate result
            pass
        # Then let an in-flight transition finish: poll until the text has been
        # the same twice running, or the budget runs out.
        last, stable, deadline = None, 0, time.time() + STABLE_MAX_S
        while time.time() < deadline:
            try:
                size = page.evaluate("document.body ? document.body.innerText.length : 0")
            except Exception:  # noqa: BLE001 - mid-navigation, try again next poll
                size = None
            if size is not None and size == last:
                stable += 1
                if stable >= 2:
                    break
            else:
                stable = 0
            last = size
            page.wait_for_timeout(STABLE_POLL_MS)

    def navigate(self, url: str) -> str:
        page = self._ensure()
        page.goto(url, wait_until="domcontentloaded")
        self._settle()
        return self.read()

    def read(self) -> str:
        """The page as a model can use it: where it is, what it says, and a
        numbered list of what can be acted on."""
        page = self._ensure()
        try:
            text = page.inner_text("body")
        except Exception:  # noqa: BLE001 - a page with no body is still a page
            text = ""
        text = text.strip()
        clipped = len(text) > MAX_TEXT
        if clipped:
            text = text[:MAX_TEXT]

        try:
            els = page.evaluate(COLLECT_JS, INTERACTIVE)
        except Exception:  # noqa: BLE001
            els = []
        more = len(els) - MAX_ELEMENTS
        lines = []
        for i, e in enumerate(els[:MAX_ELEMENTS]):
            kind = e["tag"] + ("[" + e["type"] + "]" if e.get("type") else "")
            label = e.get("label") or e.get("href") or ""
            lines.append(("  [%d] %s %s" % (i, kind, label)).rstrip())

        parts = ["URL: " + page.url, "TITLE: " + page.title(), ""]
        if text:
            parts.append(text)
        else:
            # Never hand back a silently blank page. Blank reads as "this
            # service is down" to an agent, and the usual cause is the opposite:
            # an app that is still booting and will answer a second later.
            parts.append("(no text rendered within %ds. The page may still be "
                         "loading - read it again before concluding anything.)"
                         % (SETTLE_MS // 1000))
        if clipped:
            parts.append("... (text clipped at %d characters)" % MAX_TEXT)
        parts += ["", "CLICKABLE / TYPEABLE (address these by number):"]
        parts += lines or ["  (nothing interactive found)"]
        if more > 0:
            parts.append("  ... and %d more not listed" % more)
        return "\n".join(parts)

    def _locate(self, target: str):
        """A target is an element number from the last read, or failing that
        the visible text of the thing. Numbers first, because that is what the
        listing hands out and a bare number is never a useful selector."""
        page = self._ensure()
        if target.strip().isdigit():
            i = int(target.strip())
            els = page.evaluate(COLLECT_JS, INTERACTIVE)
            if i >= len(els):
                raise ValueError(
                    "no element [%d] on this page; it lists %d. Read the page "
                    "again, the numbering follows the page." % (i, len(els))
                )
            # Address the element the LISTING produced, not the nth match of
            # the selector. They are different sets: the listing drops anything
            # hidden or zero-sized, `nth` counts it. Measured 2026-09-03 on
            # RocketChat's login page, where [0] read as the username field and
            # `nth(0)` was the logo link - an agent clicking by number would
            # have hit the wrong element on every page with a hidden node in it,
            # and the mistake looks like the model being careless.
            return page.locator('[data-tacidx="%d"]' % i)
        return page.get_by_text(target, exact=False).first

    def click(self, target: str) -> str:
        page = self._ensure()
        self._locate(target).click()
        page.wait_for_load_state("domcontentloaded")
        self._settle()
        return self.read()

    def type_text(self, target: str, text: str, submit: bool = False) -> str:
        page = self._ensure()
        loc = self._locate(target)
        loc.fill(text)
        if submit:
            loc.press("Enter")
            page.wait_for_load_state("domcontentloaded")
            self._settle()
        return self.read()


# The declarations handed to the agent, kept next to the implementation so a
# new verb cannot be added to one and forgotten in the other.
BROWSER_TOOLS = [
    {
        "name": "browser_navigate",
        "description": (
            "Open a URL in the workstation's browser and return the page: its text "
            "and a numbered list of everything clickable or typeable. The browser "
            "keeps cookies, so once you log in you stay logged in."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"url": {"type": "string"}},
            "required": ["url"],
        },
    },
    {
        "name": "browser_read",
        "description": "Re-read the current page, after something on it has changed.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "browser_click",
        "description": (
            "Click an element on the current page, then return the new page. Address "
            "it by the number from the page listing, or by its visible text."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"target": {"type": "string"}},
            "required": ["target"],
        },
    },
    {
        "name": "browser_type",
        "description": (
            "Type into a field on the current page, then return the page. Address the "
            "field by its number from the page listing, or by its visible label. Set "
            "submit true to press Enter afterwards."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "target": {"type": "string"},
                "text": {"type": "string"},
                "submit": {"type": "boolean"},
            },
            "required": ["target", "text"],
        },
    },
]


def run_browser_tool(br: "Browser", name: str, args: dict) -> str:
    if name == "browser_navigate":
        return br.navigate(str(args["url"]))
    if name == "browser_read":
        return br.read()
    if name == "browser_click":
        return br.click(str(args["target"]))
    if name == "browser_type":
        return br.type_text(str(args["target"]), str(args["text"]),
                            bool(args.get("submit", False)))
    raise ValueError("unknown browser tool " + name)
