#!/usr/bin/env python3
"""
Does the agent actually SEE a document? One command, real file, real model.

The three tasks lost on 3 September (admin-make-spreadsheet,
admin-mass-forms-filling, admin-read-survey-and-summarise) all hand the answer
over as a PDF, and the agent was reading those bytes as text and trying to
recover the characters with PIL. The fix is a path for pixels: `read_file`
renders the document, `tool_response` carries the images, and the agent loop
attaches them to the next model call.

This probe walks that whole path with nothing faked but the container:

    1. pull the REAL drinks_survey.pdf out of the running ownCloud container
       (or take any local file with --file),
    2. render it exactly as the harness does (`render_pdf` in run_tac.py),
    3. spawn the real sidecar with `read_file` declared as a host tool,
    4. ask it a question that can only be answered by looking,
    5. answer its tool call with the pixels, and print what it says.

Then it checks the answer against what is actually on the page. That last step
is the one that matters: a run where the plumbing works and the model still
cannot read the page is a run that will score zero, and it should fail here in
forty seconds instead of thirty minutes into a task.

    python scripts/tac/vision_probe.py
    python scripts/tac/vision_probe.py --file some.pdf --ask "..." --expect a,b

Needs: Docker running with the ownCloud container up (unless --file), bun, an
OPENROUTER_API_KEY in the repo .env, and PyMuPDF on this machine
(`python -m pip install pymupdf`).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from queue import Empty

sys.path.insert(0, str(Path(__file__).resolve().parent))

from run_tac import Sidecar, docker, render_pdf, seed_agent_route  # noqa: E402

# The survey behind two of the three lost tasks. It lives in ownCloud, which is
# where the task tells the agent to go looking for it.
OWNCLOUD_PDF = (
    "/var/www/html/data/theagentcompany/files/Documents/Admin/drinks_survey.pdf"
)

# What is on that page. Coke and Mountain Dew are the clear winners; Apple Juice
# and Sprite tie for third (the task's own checkpoints say so). Any two of these
# named back means the model read the ticks, not the filename.
DEFAULT_EXPECT = ["coke", "mountain dew", "apple juice", "sprite"]

DEFAULT_ASK = (
    "There is a scanned drinks questionnaire at /workspace/drinks_survey.pdf on this "
    "workstation. Call read_file on it, look at the pages, and tell me which drinks "
    "got the most votes. Name the drinks. Do not write any code."
)


def fetch_pdf(dest: Path) -> Path:
    """Copy the real survey out of the running ownCloud container."""
    r = docker("cp", f"owncloud:{OWNCLOUD_PDF}", str(dest), timeout=120.0)
    if r.returncode != 0:
        raise SystemExit(
            "could not copy the survey out of ownCloud "
            f"({r.stderr.strip() or 'no error text'}).\n"
            "Is the `owncloud` container running? Otherwise pass --file with any PDF."
        )
    return dest


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--file", help="PDF or image to show the agent (default: the real ownCloud survey)")
    ap.add_argument("--ask", default=DEFAULT_ASK)
    ap.add_argument("--expect", default=",".join(DEFAULT_EXPECT),
                    help="comma-separated strings; at least --need of them must appear in the answer")
    ap.add_argument("--need", type=int, default=2)
    ap.add_argument("--timeout", type=float, default=300.0, help="seconds to let the agent work")
    args = ap.parse_args()

    model = seed_agent_route()
    if not model:
        raise SystemExit("CINDERPAW_MODEL is not set (repo .env or environment) - refusing to guess one")

    with tempfile.TemporaryDirectory(prefix="tac-vision-") as tmp:
        tmpdir = Path(tmp)
        src = Path(args.file) if args.file else fetch_pdf(tmpdir / "drinks_survey.pdf")
        if not src.is_file():
            raise SystemExit(f"{src} does not exist")
        data = src.read_bytes()
        print(f"document: {src} ({len(data)} bytes)")

        if src.suffix.lower() == ".pdf":
            note, images = render_pdf(data, "/workspace/" + src.name)
        else:
            import base64
            mime = "image/png" if src.suffix.lower() == ".png" else "image/jpeg"
            note = f"/workspace/{src.name} - {mime} image, {len(data)} bytes; attached below."
            images = ["data:" + mime + ";base64," + base64.b64encode(data).decode("ascii")]
        if not images:
            raise SystemExit("nothing was rendered:\n" + note)
        print(f"rendered:  {len(images)} image(s), {sum(len(i) for i in images) // 1024} KB of data URL")
        print(f"model:     {model}")

        # `read_file` under its own name, so boot.ts displaces the built-in and
        # the agent cannot quietly read this Windows machine instead.
        decl = tmpdir / "host-tools.json"
        decl.write_text(json.dumps({"tools": [{
            "name": "read_file",
            "description": "Read a file on the company workstation.",
            "inputSchema": {"type": "object",
                            "properties": {"path": {"type": "string"}},
                            "required": ["path"]},
        }]}), encoding="utf-8")

        home = tmpdir / "home"
        home.mkdir()
        sc = Sidecar.spawn(home, decl, {})
        answer_parts: list[str] = []
        reads = 0
        try:
            sc.send({"type": "message", "id": uuid.uuid4().hex,
                     "sessionId": sc.session_id, "content": args.ask})
            deadline = time.time() + args.timeout
            while True:
                left = deadline - time.time()
                if left <= 0:
                    print("TIMEOUT: the agent did not answer in time")
                    break
                try:
                    ev = sc.inbox.get(timeout=left)
                except Empty:
                    print("TIMEOUT: the agent went quiet")
                    break
                if ev is None:
                    print("the sidecar exited:\n" + sc.tail())
                    break
                kind = ev.get("type")
                if kind == "tool_request":
                    print(f"  -> agent called {ev['tool']}({json.dumps(ev.get('arguments') or {})[:120]})")
                    if ev["tool"] == "read_file":
                        reads += 1
                        sc.send({"type": "tool_response", "requestId": ev["id"],
                                 "content": note, "images": images})
                    else:
                        sc.send({"type": "tool_response", "requestId": ev["id"],
                                 "error": f"{ev['tool']} is not available in this probe"})
                elif kind == "done":
                    # A turn cut short by the wall clock reports `incomplete`
                    # and is continued by the loop itself; waiting for the first
                    # `done` would read half an answer as the whole one.
                    if ev.get("incomplete"):
                        if ev.get("content"):
                            answer_parts.append(str(ev["content"]))
                        continue
                    if ev.get("content"):
                        answer_parts.append(str(ev["content"]))
                    break
                elif kind == "error":
                    print("sidecar error: " + str(ev.get("message")))
                    break
        finally:
            sc.stop()

        answer = "\n".join(answer_parts).strip()
        if not answer:
            # No `done` content (a timeout, say) - reassemble from the stream.
            answer = "".join(
                str(e.get("content") or "") for e in sc.events if e.get("type") == "chunk"
            ).strip()

        print("\n--- the agent's answer " + "-" * 40)
        print(answer or "(nothing)")
        print("-" * 62)

        wanted = [w.strip().lower() for w in args.expect.split(",") if w.strip()]
        hits = [w for w in wanted if w in answer.lower()]
        print(f"read_file calls: {reads}")
        print(f"expected any {args.need} of {wanted}")
        print(f"found: {hits or 'none'}")
        if reads == 0:
            print("\nFAIL: the agent never called read_file, so nothing was shown to it.")
            return 1
        if len(hits) < args.need:
            print("\nFAIL: the pixels reached the model and the answer does not match the page.")
            return 1
        print("\nPASS: the agent read a real document it could not have read as text.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
