"""
Cinderpaw against TheAgentCompany.

────────────────────────────────────────────────────────────────────────────
WHY THIS IS SO MUCH SMALLER THAN THE tau2 BRIDGE

tau2 grades a REPLAY: `evaluator_env.py` builds a fresh environment and replays
the orchestrator's recorded trajectory into it, so a tool call the orchestrator
never saw did not happen. That forced the whole half-duplex dance in
`scripts/tau2/cinderpaw_agent.py`, where every domain tool is a host tool and
every call travels out to the orchestrator and back.

TheAgentCompany grades the LIVE ENVIRONMENT. Read `workspaces/base_image/eval.py`:
it decrypts `/utils/evaluator.py.enc` inside the task container, after the agent
has stopped, and calls `grade_checkpoints(trajectory)`. A real evaluator
(`admin-arrange-meeting-rooms`) opens `/workspace/ans.txt` off the disk and asks
the live RocketChat API for a chat history. The trajectory argument is optional —
the docs say it is "often used to grant partial credits", and `scoring.py`'s
`bonus_for_completing_any` exists specifically to forgive a missing one.

So there is nothing to route. The agent just has to ACT IN THE RIGHT PLACE.

────────────────────────────────────────────────────────────────────────────
HOW THE AGENT ENDS UP IN THE RIGHT PLACE

The sidecar runs here, on the host. Its filesystem and shell tools would act on
this machine, which is not where the exam is — and that failure is silent, which
is the dangerous kind: every command succeeds, and the evaluator finds an empty
/workspace.

The fix is a property the product already has. `boot.ts` registers host tools by
unregistering any built-in of the same name first:

    if (registry.unregister(t.manifest.name)) displaced.push(...)
    registry.register(t);

So this file declares host tools under the built-ins' OWN names, and each one
is the container's version. Nothing is shadowed or bypassed: `shell_exec` IS the
container's shell for this run, for every caller — subagents and the notebook
reach the same registry, so they are redirected too, without knowing it.

Everything else about Cinderpaw is left alone. That is the point of running
TheAgentCompany at all: tau2's airline number measured the agent loop with a
fresh CINDERPAW_HOME, no skills, no memory, no MCP. Here the whole stack runs.

────────────────────────────────────────────────────────────────────────────
WHAT MUST BE SAID NEXT TO ANY NUMBER THIS PRODUCES

1. The environment LLM (NPC coworkers on RocketChat, and the LLM graders) is a
   model WE choose. TAC's baselines used claude-3-5-sonnet-20241022 and the
   leaderboard asks which one you used. It is not the agent model. Report both.
2. `--home fresh` (the default) means cross-task memory cannot engage: each task
   gets a clean CINDERPAW_HOME, exactly like the tau2 run. `--home shared` turns
   the memory on and lets task N benefit from task N-1. Whichever was used is
   written into the summary, because they measure different things.
3. Only the tasks actually run are in the score. A subset is a subset; the
   summary says how many of the 175 it covers.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from queue import Empty, Queue
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parents[2]
SIDECAR_ENTRY = REPO_ROOT / "CinderpawAgent" / "src" / "index.ts"

DECRYPTION_KEY = "theagentcompany is all you need"

# The baseline's prompt is one sentence (run_eval.py in TheAgentCompany). The
# credentials block is added because the benchmark explicitly allows it — "we
# allow benchmark users to use whatever ways they want to provide the username
# and password" — and the baseline itself pre-logs-in through a browser and
# still puts the GitLab credentials in its system prompt. Without this the agent
# would fail tasks on authentication rather than on the work.
FIRST_MESSAGE = """Complete the task in /instruction/task.md

You are working at a software company. You act through the tools you have; your
shell and file tools run on the company workstation, which is where all the work
must land. The company's internal services and their credentials:

- GitLab      http://the-agent-company.com:8929   root / theagentcompany
- ownCloud    http://the-agent-company.com:8092   theagentcompany / theagentcompany
- Plane       http://the-agent-company.com:8091   agent@company.com / theagentcompany
              API key: plane_api_83f868352c6f490aba59b869ffdae1cf  (header X-API-Key),
              workspace slug: tac
- RocketChat  http://the-agent-company.com:3000   theagentcompany / theagentcompany

You have no browser on the workstation. Use their HTTP APIs, and git over http
for GitLab. Each service authenticates differently, and these were verified
against this exact deployment:

- GitLab rejects basic auth on /api/v4. Get a token first:
  POST http://the-agent-company.com:8929/oauth/token with the form body
  grant_type=password&username=root&password=theagentcompany
  then send it as `Authorization: Bearer <access_token>`.
- ownCloud is WebDAV under
  http://the-agent-company.com:8092/remote.php/dav/files/theagentcompany/
  with ordinary basic auth. PROPFIND lists, GET downloads, PUT uploads.
- RocketChat: POST /api/v1/login with {"user":..., "password":...}, then send
  `X-Auth-Token` and `X-User-Id` on every later call.
- Plane: send the API key as the `x-api-key` header; the workspace slug is
  `tac`.

python_default has openpyxl, odfpy, python-docx, python-pptx, pypdf and pandas
installed, so spreadsheets and documents are read with those rather than by
hand. Read /instruction/task.md first; it names the services the task
actually needs.

Work until the task is genuinely finished. Nobody is available to answer
questions, so make reasonable decisions and proceed."""


# ───────────────────────────────────────────────────────── container plumbing


class ContainerError(RuntimeError):
    pass


def docker(*args: str, timeout: float = 120.0, stdin: Optional[str] = None) -> subprocess.CompletedProcess:
    """One place every docker call goes through, so one place logs and times out."""
    return subprocess.run(
        ["docker", *args],
        input=stdin,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


@dataclass
class Container:
    """The task's workstation. Every agent tool call lands in here."""

    name: str
    image: str

    def start(self) -> None:
        # Remove a leftover from an interrupted run before claiming the name;
        # otherwise a resumed run dies on "name already in use" and looks like
        # a docker problem rather than a stale container.
        docker("rm", "-f", self.name)
        # `--network host` is what lets the container reach the services on
        # the-agent-company.com. On Windows it requires Docker Desktop's host
        # networking to be enabled (Settings > Resources > Network).
        r = docker(
            "run", "-d", "--name", self.name, "--network", "host",
            self.image, "/bin/bash", "-c", "sleep infinity",
            timeout=600.0,
        )
        if r.returncode != 0:
            raise ContainerError(f"could not start {self.image}: {r.stderr.strip()}")
        self.install_document_libraries()

    def install_document_libraries(self) -> None:
        """
        Give the container the libraries the exam's own files need.

        The task image ships lxml and unzip and nothing else: no openpyxl, no
        odfpy, no PDF reader, no LibreOffice. Counted across the 175 task and
        checkpoint files, the exam references .xlsx 60 times, .pdf 43, .csv 43,
        .odt 17 and .pptx 15. Without these an agent either burns turns
        installing them itself, once per task on a fresh container, or fails
        the task for a reason that is about packaging rather than competence.

        This is environment preparation, which the benchmark expects: its own
        baseline installs a headless Chrome into the container for browsing.
        Declare it alongside any score. Non-fatal, because a machine with no
        outbound network should still run the tasks that need no documents.
        """
        r = self.exec(
            ["pip", "install", "--quiet", "--disable-pip-version-check",
             "openpyxl", "odfpy", "python-docx", "python-pptx", "pypdf", "pandas"],
            cwd="/", timeout=600.0,
        )
        if r.returncode != 0:
            print(f"[tac] warning: document libraries not installed, "
                  f"document tasks may fail on packaging: "
                  f"{(r.stderr or '')[-300:]}", flush=True)

    def exec(
        self,
        argv: list[str],
        cwd: str = "/workspace",
        env: Optional[dict[str, str]] = None,
        timeout: float = 300.0,
        stdin: Optional[str] = None,
    ) -> subprocess.CompletedProcess:
        flags = ["exec", "-w", cwd]
        if stdin is not None:
            flags.append("-i")
        for k, v in (env or {}).items():
            flags += ["-e", f"{k}={v}"]
        return docker(*flags, self.name, *argv, timeout=timeout, stdin=stdin)

    def init(self, server_hostname: str, env_llm: dict[str, str]) -> None:
        """
        Run /utils/init.sh: reset the services this task depends on, seed its
        data, and start its NPCs.

        Slow on purpose. reset.sh polls the api-server's health check every 5s
        for up to 15 minutes, and it only resets the services named in the
        task's dependencies.yml — a RocketChat-only task does not pay for a
        GitLab reset.
        """
        # init.sh appends the the-agent-company.com entry with `echo >>`, which
        # assumes /etc/hosts ends in a newline. Docker Desktop on Windows writes
        # it WITHOUT one, so the entry fuses onto the last line:
        #
        #     ff02::2 ip6-allrouters127.0.0.1 the-agent-company.com
        #
        # The name then never resolves, every curl to the api-server returns
        # 000, and init.sh dies at "Resetting gitlab..." — for all 175 tasks,
        # with an error that reads like the services are down. One guard here
        # covers every task, because every task's init goes through this method.
        self.exec(
            ["sh", "-c", "[ -s /etc/hosts ] && [ -n \"$(tail -c 1 /etc/hosts)\" ] "
                         "&& echo >> /etc/hosts || true"],
            cwd="/",
            timeout=60.0,
        )
        r = self.exec(
            ["bash", "/utils/init.sh"],
            cwd="/",
            env={"SERVER_HOSTNAME": server_hostname, **env_llm},
            timeout=1500.0,
        )
        if r.returncode != 0:
            raise ContainerError(
                "init.sh failed — the services are probably not all healthy.\n"
                + (r.stdout or "")[-2000:] + (r.stderr or "")[-2000:]
            )
        self.refresh_gitlab_token()

    def refresh_gitlab_token(self) -> None:
        """
        Un-expire the token every GitLab evaluator grades with.

        `base_image/config.py` hardcodes GITLAB_ACCESS_TOKEN = "root-token", and
        the token baked into servers-gitlab:1.0.0 expired on 2025-11-18. Every
        request an evaluator then makes returns 401, every checkpoint returns
        False, and the task scores zero no matter what the agent did. Measured
        2026-09-02: sde-close-an-issue scored 0/2 with the issue verifiably
        closed and commented, then 2/2 after this fix, same environment state.

        Runs per task and AFTER init.sh, because reset-gitlab recreates the
        container from the image and restores the expired token every time.
        Only tasks that actually declare a GitLab dependency pay the ~40s.
        """
        deps = self.exec(["cat", "/utils/dependencies.yml"], cwd="/", timeout=60.0)
        if "gitlab" not in (deps.stdout or ""):
            return
        r = docker(
            "exec", "gitlab", "gitlab-rails", "runner",
            't = PersonalAccessToken.find_by(name: "root-token"); '
            'abort("no root-token") unless t; '
            't.update_columns(expires_at: Date.today + 3650); '
            'puts "active=#{t.reload.active?}"',
            timeout=300.0,
        )
        if "active=true" not in (r.stdout or ""):
            # Loud on purpose. A silent failure here does not look like a
            # failure, it looks like an agent that cannot do GitLab work.
            raise ContainerError(
                "could not un-expire GitLab's root-token, so every GitLab "
                "checkpoint would score zero regardless of the agent.\n"
                + (r.stdout or "")[-1000:] + (r.stderr or "")[-1000:]
            )

    def grade(self, trajectory: Path, env_llm: dict[str, str]) -> dict:
        """
        Run the evaluator in the container and read back its result.

        Note the flag name: the README says `--output_path`, but eval.py's
        argparse declares `--result_path`. The README is wrong; the code wins.
        """
        r = docker("cp", str(trajectory), f"{self.name}:/tmp/trajectory.jsonl", timeout=120.0)
        if r.returncode != 0:
            raise ContainerError(f"could not copy the trajectory in: {r.stderr.strip()}")
        r = self.exec(
            ["python_default", "/utils/eval.py",
             "--trajectory_path", "/tmp/trajectory.jsonl",
             "--result_path", "/tmp/result.json"],
            cwd="/utils",
            env={"DECRYPTION_KEY": DECRYPTION_KEY, **env_llm},
            timeout=900.0,
        )
        if r.returncode != 0:
            raise ContainerError(
                "eval.py failed:\n" + (r.stdout or "")[-2000:] + (r.stderr or "")[-2000:]
            )
        out = self.exec(["cat", "/tmp/result.json"], cwd="/")
        if out.returncode != 0:
            raise ContainerError("eval.py wrote no result.json")
        return json.loads(out.stdout)

    def stop(self) -> None:
        docker("rm", "-f", self.name, timeout=120.0)


# ─────────────────────────────────────────────────────────────── host tools

# Declared under the BUILT-INS' OWN NAMES so boot.ts displaces them (see the
# module docstring). Anything that touches a filesystem has to be in this list:
# a tool left undeclared stays behind the drawer but is still loadable by name,
# and the model that loads it would search this Windows machine and be told,
# truthfully and uselessly, that the file is not there.
HOST_TOOLS = [
    {
        "name": "shell_exec",
        "description": (
            "Run a shell command on the company workstation. This is a real shell: "
            "pipes, redirects, && and globbing all work. Use it for curl against the "
            "company services, git, python, and anything else the task needs."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "The command line to run."},
                "cwd": {"type": "string", "description": "Working directory. Defaults to /workspace."},
            },
            "required": ["command"],
        },
    },
    {
        "name": "read_file",
        "description": "Read a file on the company workstation.",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "Write a file on the company workstation, creating parent directories.",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"],
        },
    },
    {
        "name": "edit_file",
        "description": "Replace an exact string in a file on the company workstation.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "old_text": {"type": "string"},
                "new_text": {"type": "string"},
            },
            "required": ["path", "old_text", "new_text"],
        },
    },
    {
        "name": "list_directory",
        "description": "List a directory on the company workstation.",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
    {
        "name": "grep",
        "description": "Search file contents on the company workstation.",
        "inputSchema": {
            "type": "object",
            "properties": {"pattern": {"type": "string"}, "path": {"type": "string"}},
            "required": ["pattern"],
        },
    },
    {
        "name": "file_search",
        "description": "Find files by glob on the company workstation.",
        "inputSchema": {
            "type": "object",
            "properties": {"pattern": {"type": "string"}, "path": {"type": "string"}},
            "required": ["pattern"],
        },
    },
]

# Cinderpaw's built-in shell refuses to spawn a shell (argv[0] is exec'd
# directly, so a PATH hijack cannot happen and a command line cannot be
# re-parsed). That reasoning protects the user's own machine. This container is
# a disposable exam room on a private network, and half the benchmark is curl
# pipelines against the company's APIs, so here a shell is the tool.
# ponytail: `bash -lc` on purpose; the built-in's no-shell rule is about the
# user's machine, and this is not it.


def run_host_tool(ctr: Container, name: str, args: dict) -> str:
    def out(r: subprocess.CompletedProcess) -> str:
        text = (r.stdout or "") + (("\n" + r.stderr) if r.stderr else "")
        if r.returncode != 0:
            text = f"(exit {r.returncode})\n{text}"
        return text.strip() or "(no output)"

    if name == "shell_exec":
        cwd = args.get("cwd") or "/workspace"
        return out(ctr.exec(["bash", "-lc", str(args["command"])], cwd=cwd, timeout=600.0))

    if name == "read_file":
        return out(ctr.exec(["cat", str(args["path"])], cwd="/"))

    if name == "write_file":
        path = str(args["path"])
        # Content goes over stdin rather than into the command line: it is
        # arbitrary text, and a heredoc or a quoted argument would eventually
        # meet a backtick, a $ or a newline that changes its meaning.
        r = ctr.exec(
            ["bash", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "_", path],
            cwd="/",
            stdin=str(args.get("content", "")),
            timeout=300.0,
        )
        return "written" if r.returncode == 0 else out(r)

    if name == "edit_file":
        path, old, new = str(args["path"]), str(args["old_text"]), str(args["new_text"])
        r = ctr.exec(["cat", path], cwd="/")
        if r.returncode != 0:
            return out(r)
        body = r.stdout
        hits = body.count(old)
        if hits == 0:
            return "old_text not found in the file — read it again and match it exactly"
        if hits > 1:
            return f"old_text appears {hits} times — include more surrounding text so it is unique"
        w = ctr.exec(["bash", "-c", 'cat > "$1"', "_", path], cwd="/", stdin=body.replace(old, new))
        return "edited" if w.returncode == 0 else out(w)

    if name == "list_directory":
        return out(ctr.exec(["ls", "-la", str(args.get("path") or "/workspace")], cwd="/"))

    if name == "grep":
        path = str(args.get("path") or "/workspace")
        return out(ctr.exec(["grep", "-rn", "--", str(args["pattern"]), path], cwd="/", timeout=300.0))

    if name == "file_search":
        path = str(args.get("path") or "/workspace")
        return out(ctr.exec(["find", path, "-name", str(args["pattern"])], cwd="/", timeout=300.0))

    return f"unknown host tool {name}"


# ─────────────────────────────────────────────────────────────── the sidecar


def seed_agent_route() -> str:
    """
    Settle the AGENT's model and credentials before the sidecar is spawned.

    `Sidecar.spawn` only inherits os.environ, so on a machine where nothing is
    exported the sidecar quietly falls back to its own built-in default and the
    run measures a model nobody chose. That is not a visible failure — it is a
    number that looks fine and is wrong, which is worse.

    So: fill in key/base/provider from the repo `.env` (anything already
    exported wins), and refuse to start without an explicit model rather than
    guess one. Returns the model, for the record.
    """
    env_path = REPO_ROOT / ".env"
    if env_path.is_file():
        values: dict[str, str] = {}
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            values[k.strip()] = v.strip().strip('"').strip("'")
        key = values.get("OPENROUTER_API_KEY")
        if key:
            os.environ.setdefault("CINDERPAW_API_KEY", key)
            os.environ.setdefault("CINDERPAW_BASE_URL", "https://openrouter.ai/api/v1")
            os.environ.setdefault("CINDERPAW_PROVIDER", "openai_compatible")
        # Every CINDERPAW_* setting in .env is passed through, not a hand-picked
        # three. A run that has to be reproduced months later should not depend
        # on which shell exported what, and a setting that is silently ignored
        # because it was not on a list is worse than one that is missing: the
        # run looks configured and is not. Anything already exported still wins.
        for k, v in values.items():
            if k.startswith("CINDERPAW_") and v:
                os.environ.setdefault(k, v)

    # The sidecar appends `/v1/chat/completions` itself, while every provider
    # documents its base URL WITH the /v1 — the obvious value gives /v1/v1 and a
    # 404 on every turn. Applied to whatever is set, not just the default above.
    base = os.environ.get("CINDERPAW_BASE_URL")
    if base:
        os.environ["CINDERPAW_BASE_URL"] = re.sub(r"/v1$", "", base.rstrip("/"))

    return os.environ.get("CINDERPAW_MODEL", "").strip()


def resolve_bun() -> str:
    """
    Absolute path to a real bun EXECUTABLE.

    Same trap `scripts/tau2/cinderpaw_agent.py` documents: what is on PATH on
    Windows is `bun.cmd`, and CreateProcess cannot exec a .cmd. It fails at
    spawn time, which reads as "the agent produced nothing".
    """
    override = os.environ.get("CINDERPAW_BENCH_BUN")
    if override:
        return override
    hits = [p for p in [shutil.which("bun")] if p]
    if os.name == "nt":
        found = subprocess.run(["where.exe", "bun"], capture_output=True, text=True, check=False)
        hits = [ln.strip() for ln in found.stdout.splitlines() if ln.strip()] or hits
    for h in hits:
        if h.lower().endswith(".exe"):
            return h
    for h in hits:
        real = Path(h).parent / "node_modules" / "bun" / "bin" / "bun.exe"
        if real.is_file():
            return str(real)
    for c in (Path(os.environ.get("USERPROFILE", "_")) / ".bun" / "bin" / "bun.exe",
              Path(os.environ.get("HOME", "_")) / ".bun" / "bin" / "bun"):
        if c.is_file():
            return str(c)
    raise RuntimeError("no bun executable found; set CINDERPAW_BENCH_BUN to its full path")


@dataclass
class Sidecar:
    proc: subprocess.Popen
    inbox: Queue
    events: list[dict] = field(default_factory=list)
    stderr_tail: list[str] = field(default_factory=list)
    session_id: str = field(default_factory=lambda: f"tac-{uuid.uuid4().hex[:8]}")

    @classmethod
    def spawn(cls, home: Path, decl: Path, extra_env: dict[str, str]) -> "Sidecar":
        env = {
            **os.environ,
            # Nobody is at the machine. ask_user would hang the task forever.
            "CINDERPAW_AUTONOMOUS": "true",
            "CINDERPAW_HOME": str(home),
            "CINDERPAW_HOST_TOOLS": str(decl),
            **extra_env,
        }
        proc = subprocess.Popen(
            [resolve_bun(), str(SIDECAR_ENTRY)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=env, cwd=str(home), text=True, encoding="utf-8", errors="replace", bufsize=1,
        )
        sc = cls(proc=proc, inbox=Queue())

        # Both pipes get a draining thread. A full pipe buffer deadlocks the
        # child, and a blocking read on stdout has no timeout — a wedged sidecar
        # would hang the whole run with nothing on screen.
        def pump_stdout() -> None:
            for line in proc.stdout:  # type: ignore[union-attr]
                line = line.strip()
                if not line.startswith("{"):
                    continue
                try:
                    sc.inbox.put(json.loads(line))
                except json.JSONDecodeError:
                    continue
            sc.inbox.put(None)

        def pump_stderr() -> None:
            for line in proc.stderr:  # type: ignore[union-attr]
                sc.stderr_tail.append(line.rstrip())
                del sc.stderr_tail[:-60]

        threading.Thread(target=pump_stdout, daemon=True).start()
        threading.Thread(target=pump_stderr, daemon=True).start()
        return sc

    def send(self, payload: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()

    def tail(self) -> str:
        return "\n".join(self.stderr_tail[-20:]) or "(nothing on stderr)"

    def stop(self) -> None:
        try:
            self.send({"type": "shutdown"})
            self.proc.wait(timeout=10)
        except Exception:
            pass
        if self.proc.poll() is None:
            self.proc.kill()


def drive(sc: Sidecar, ctr: Container, deadline: float, turn_timeout: float) -> str:
    """
    Run one task to completion, executing the agent's tool calls in the container.

    Returns why it stopped. Unlike tau2 there is no orchestrator and no user
    simulator: one message goes in, the agent works, and the environment it
    changed is the answer.
    """
    sc.send({
        "type": "message",
        "id": uuid.uuid4().hex,
        "sessionId": sc.session_id,
        "content": FIRST_MESSAGE,
    })

    while True:
        if time.time() > deadline:
            return "task_timeout"
        try:
            ev = sc.inbox.get(timeout=min(turn_timeout, max(1.0, deadline - time.time())))
        except Empty:
            return "silent_timeout"
        if ev is None:
            return "sidecar_exited"
        sc.events.append(ev)
        kind = ev.get("type")

        if kind == "tool_request":
            try:
                content = run_host_tool(ctr, ev["tool"], ev.get("arguments") or {})
                sc.send({"type": "tool_response", "requestId": ev["id"], "content": content})
            except subprocess.TimeoutExpired:
                # A hung command is a tool failure the model can read and route
                # around, not a dead run.
                sc.send({
                    "type": "tool_response", "requestId": ev["id"],
                    "error": "the command did not finish in time and was killed",
                })
            except Exception as e:  # noqa: BLE001 - the model gets to see it
                sc.send({"type": "tool_response", "requestId": ev["id"], "error": str(e)})
            continue

        if kind == "done":
            # In autonomous mode a turn cut short by the wall clock is
            # continued; treating the first `done` as terminal would stop the
            # agent halfway through its own work.
            if ev.get("incomplete"):
                continue
            return "no_answer" if ev.get("outcome") == "no_answer" else "done"

        if kind == "error":
            return f"sidecar_error: {ev.get('message', '(no message)')}"


# ────────────────────────────────────────────────────────────────── the run


class Progress:
    """
    One JSONL line per event, explicitly flushed.

    Flushed because the live view depends on it. tau2 buffered its entire
    output — the run log stayed empty until the process exited — so anything
    scraping stdout would have shown nothing all run and looked fine in testing.
    """

    def __init__(self, path: Optional[Path]):
        self.fh = path.open("a", encoding="utf-8") if path else None

    def emit(self, **fields) -> None:
        line = json.dumps({"ts": time.time(), **fields})
        print(f"[tac] {line}", flush=True)
        if self.fh:
            self.fh.write(line + "\n")
            self.fh.flush()
            os.fsync(self.fh.fileno())


def run_task(task: str, args, decl: Path, env_llm: dict[str, str], prog: Progress) -> dict:
    image = f"ghcr.io/theagentcompany/{task}-image:{args.version}"
    ctr = Container(name=f"tac-{task}", image=image)
    if args.home == "fresh":
        home, home_is_disposable = Path(tempfile.mkdtemp(prefix=f"tac-home-{task}-")), True
    else:
        home, home_is_disposable = Path(args.shared_home), False
        home.mkdir(parents=True, exist_ok=True)
    sc: Optional[Sidecar] = None
    # Stamped per task too: these runs resume, so a single task file has to say
    # which model produced it without the summary next to it.
    record: dict = {"task": task, "image": image, "home": args.home,
                    "agent_model": os.environ.get("CINDERPAW_MODEL", ""),
                    "provider_pin": os.environ.get("CINDERPAW_OPENROUTER_PROVIDER", "") or None}
    started = time.time()

    try:
        prog.emit(event="task_start", task=task)
        ctr.start()
        prog.emit(event="init_start", task=task)
        ctr.init(args.server_hostname, env_llm)
        prog.emit(event="init_done", task=task, seconds=round(time.time() - started, 1))

        sc = Sidecar.spawn(home, decl, {})

        agent_started = time.time()
        record["stop_reason"] = drive(
            sc, ctr,
            deadline=agent_started + args.task_timeout,
            turn_timeout=args.turn_timeout,
        )
        record["agent_seconds"] = round(time.time() - agent_started, 1)
        prog.emit(event="agent_done", task=task,
                  stop_reason=record["stop_reason"], seconds=record["agent_seconds"])

        traj = Path(args.outputs) / f"{task}.trajectory.jsonl"
        traj.write_text(
            "".join(json.dumps(e) + "\n" for e in sc.events), encoding="utf-8"
        )
        record["trajectory"] = str(traj)

        prog.emit(event="grade_start", task=task)
        result = ctr.grade(traj, env_llm)
        record["result"] = result
        score = result.get("final_score", {})
        record["score"] = score
        prog.emit(event="task_done", task=task,
                  result=score.get("result"), total=score.get("total"))

    except Exception as e:  # noqa: BLE001 - one bad task must not end the run
        record["error"] = f"{type(e).__name__}: {e}"
        if sc is not None:
            record["stderr_tail"] = sc.tail()
        prog.emit(event="task_failed", task=task, error=record["error"])
    finally:
        if sc is not None:
            sc.stop()
            # The sidecar's own event stream is the only place that explains a
            # bad task: which tools ran, how many completions the turn took,
            # where the time went. results.json records none of it.
            if "trajectory" not in record and sc.events:
                traj = Path(args.outputs) / f"{task}.trajectory.jsonl"
                traj.write_text("".join(json.dumps(e) + "\n" for e in sc.events), encoding="utf-8")
        if not args.keep_containers:
            ctr.stop()
        if home_is_disposable:
            shutil.rmtree(home, ignore_errors=True)

    record["wall_seconds"] = round(time.time() - started, 1)
    return record


def self_check() -> None:
    """
    The dispatch in run_host_tool is the part that can silently do the wrong
    thing, so it gets the one check: every tool must reach the container, and
    edit_file must refuse an ambiguous match instead of picking one.

    Runs without docker — the container is faked.
    """
    calls: list[list[str]] = []

    class FakeContainer:
        def __init__(self, body: str = "alpha beta alpha"):
            self.body = body

        def exec(self, argv, cwd="/workspace", env=None, timeout=300.0, stdin=None):
            calls.append(argv)
            out = self.body if argv[0] == "cat" and stdin is None else ""
            return subprocess.CompletedProcess(argv, 0, out, "")

    ctr = FakeContainer()

    # Every declared tool dispatches; none falls through to "unknown host tool".
    sample = {
        "shell_exec": {"command": "ls"},
        "read_file": {"path": "/workspace/a.txt"},
        "write_file": {"path": "/workspace/a.txt", "content": "x"},
        "list_directory": {"path": "/workspace"},
        "grep": {"pattern": "TODO"},
        "file_search": {"pattern": "*.py"},
    }
    for tool in HOST_TOOLS:
        name = tool["name"]
        if name == "edit_file":
            continue
        got = run_host_tool(ctr, name, sample[name])
        assert not got.startswith("unknown host tool"), name

    # shell_exec must get a real shell, or every pipeline in the benchmark fails.
    assert ["bash", "-lc", "ls"] in calls, calls

    # A non-unique old_text is a wrong edit waiting to happen.
    amb = run_host_tool(ctr, "edit_file",
                        {"path": "/f", "old_text": "alpha", "new_text": "z"})
    assert "appears 2 times" in amb, amb
    missing = run_host_tool(ctr, "edit_file",
                            {"path": "/f", "old_text": "nope", "new_text": "z"})
    assert "not found" in missing, missing
    ok = run_host_tool(ctr, "edit_file",
                       {"path": "/f", "old_text": "beta", "new_text": "z"})
    assert ok == "edited", ok

    # The declaration must name the built-ins, or boot.ts displaces nothing and
    # the agent quietly works on this Windows machine instead of the container.
    names = {t["name"] for t in HOST_TOOLS}
    for required in ("shell_exec", "read_file", "write_file", "edit_file",
                     "list_directory", "grep", "file_search"):
        assert required in names, required

    print("self-check ok")


def main() -> int:
    if "--self-check" in sys.argv:
        self_check()
        return 0

    p = argparse.ArgumentParser(description="Run Cinderpaw against TheAgentCompany.")
    p.add_argument("--tasks", nargs="+", required=True,
                   help="Task names (e.g. admin-arrange-meeting-rooms), or a file with one per line.")
    p.add_argument("--outputs", default="bench-results/tac", help="Where results and trajectories land.")
    p.add_argument("--version", default="1.0.0", help="Task image tag.")
    p.add_argument("--server-hostname", default="localhost")
    p.add_argument("--progress", default=None, help="JSONL progress stream for the live view.")
    p.add_argument("--home", choices=["fresh", "shared"], default="fresh",
                   help="fresh: a clean CINDERPAW_HOME per task (comparable to the tau2 run, "
                        "cross-task memory cannot engage). shared: one home for the whole run.")
    p.add_argument("--shared-home", default=str(Path.home() / ".cinderpaw"),
                   help="CINDERPAW_HOME to use when --home shared.")
    p.add_argument("--task-timeout", type=float, default=1800.0,
                   help="Seconds the agent gets per task before it is stopped and graded as-is.")
    p.add_argument("--turn-timeout", type=float, default=600.0,
                   help="Seconds of total silence from the sidecar before the task is abandoned.")
    p.add_argument("--keep-containers", action="store_true",
                   help="Leave containers up after grading, to inspect a failure by hand.")
    args = p.parse_args()

    # The environment LLM drives the NPC coworkers and the LLM graders. It is
    # NOT the agent model, and the leaderboard asks which one was used.
    env_llm = {
        "LITELLM_API_KEY": os.environ.get("TAC_ENV_LLM_API_KEY", ""),
        "LITELLM_BASE_URL": os.environ.get("TAC_ENV_LLM_BASE_URL", "https://openrouter.ai/api/v1"),
        "LITELLM_MODEL": os.environ.get("TAC_ENV_LLM_MODEL", ""),
    }
    missing = [k for k in ("LITELLM_API_KEY", "LITELLM_MODEL") if not env_llm[k]]
    if missing:
        # Without this the NPCs never speak and every conversational task fails
        # for a reason that looks like the agent's fault.
        print(
            "Set the environment LLM before running. It plays the coworkers and\n"
            "runs the LLM graders, and it is separate from the agent's model:\n"
            "  TAC_ENV_LLM_API_KEY=<key>\n"
            "  TAC_ENV_LLM_MODEL=openai/<model-id>   (litellm needs the openai/ prefix\n"
            "                                         to honour an OpenRouter base URL)\n"
            "  TAC_ENV_LLM_BASE_URL=https://openrouter.ai/api/v1   (default)",
            file=sys.stderr,
        )
        return 2

    # The agent's own model, separate from the environment LLM above. The
    # leaderboard asks for both, so both are settled here and both are recorded.
    agent_model = seed_agent_route()
    if not agent_model:
        print(
            "Set the agent model before running. Nothing is guessed, because a\n"
            "silent fallback produces a plausible score for a model you did not pick:\n"
            "  CINDERPAW_MODEL=deepseek/deepseek-v4-flash-0731\n"
            "  CINDERPAW_OPENROUTER_PROVIDER=<slug>   (optional; pins routing to one\n"
            "                                          endpoint, so two runs of the same\n"
            "                                          model are actually comparable)\n"
            "The API key comes from .env (OPENROUTER_API_KEY) unless CINDERPAW_API_KEY is set.",
            file=sys.stderr,
        )
        return 2
    provider_pin = os.environ.get("CINDERPAW_OPENROUTER_PROVIDER", "").strip()
    print(f"[tac] agent {agent_model}" + (f" pinned to {provider_pin}" if provider_pin else " (unpinned routing)"),
          flush=True)

    if shutil.which("docker") is None:
        print("docker is not on PATH — install Docker Desktop and enable host networking.",
              file=sys.stderr)
        return 2

    tasks: list[str] = []
    for t in args.tasks:
        f = Path(t)
        if f.is_file():
            tasks += [ln.strip() for ln in f.read_text(encoding="utf-8").splitlines()
                      if ln.strip() and not ln.startswith("#")]
        else:
            tasks.append(t)

    outputs = Path(args.outputs)
    outputs.mkdir(parents=True, exist_ok=True)
    prog = Progress(Path(args.progress) if args.progress else None)

    decl_fd, decl_path = tempfile.mkstemp(prefix="tac-hosttools-", suffix=".json")
    with os.fdopen(decl_fd, "w", encoding="utf-8") as f:
        json.dump({"tools": HOST_TOOLS}, f)

    prog.emit(event="run_start", tasks=len(tasks), home=args.home,
              agent_model=agent_model, provider_pin=provider_pin or None,
              env_llm_model=env_llm["LITELLM_MODEL"])

    records = []
    for i, task in enumerate(tasks, 1):
        done = outputs / f"{task}.json"
        if done.is_file():
            # Resumable on purpose: these runs are long, and a night that dies
            # at task 90 must not start again at task 1.
            print(f"[tac] ({i}/{len(tasks)}) {task} — already graded, skipping", flush=True)
            records.append(json.loads(done.read_text(encoding="utf-8")))
            continue
        print(f"[tac] ({i}/{len(tasks)}) {task}", flush=True)
        rec = run_task(task, args, Path(decl_path), env_llm, prog)
        done.write_text(json.dumps(rec, indent=2), encoding="utf-8")
        records.append(rec)

    scored = [r for r in records if "score" in r]
    total = sum(r["score"].get("total", 0) for r in scored)
    got = sum(r["score"].get("result", 0) for r in scored)
    full = sum(1 for r in scored if r["score"].get("result") == r["score"].get("total") and r["score"].get("total"))
    summary = {
        "tasks_requested": len(tasks),
        "tasks_scored": len(scored),
        "tasks_failed_to_run": len(records) - len(scored),
        "full_completion": full,
        "points": {"result": got, "total": total},
        "partial_completion_score": round(got / total, 4) if total else 0.0,
        "home": args.home,
        "agent_model": agent_model,
        "provider_pin": provider_pin or None,
        "env_llm_model": env_llm["LITELLM_MODEL"],
        "note": "Covers only the tasks listed; TheAgentCompany 1.0.0 has 175.",
    }
    (outputs / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    prog.emit(event="run_done", **summary)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
