# Feral User Guide

A short, practical guide. For installation and hardware requirements see the
[README](../README.md).

## Chat vs Agent — which toggle do I want?

The switch at the right of the typing bar changes who answers you.

| | **Chat** | **Agent** |
|---|---|---|
| What it is | A direct line to the model | An autonomous assistant wrapped around the model |
| Can read/write files | No | Yes (across your home folder; `~/.feral` and `~/.ssh` are always off-limits) |
| Can search the web | No | Yes (`web_search`, `deep_research`, `read_webpage`, `fetch_url`) |
| Can run commands | No | Yes (`shell_exec`; disable with `FERAL_ENABLE_SHELL_EXEC=false`) |
| Remembers across sessions | No (per-conversation history only) | Yes — 4-layer persistent memory |
| Speed | Fastest (one completion per message) | Slower (may loop through several tool calls) |
| Best for | Quick questions, drafting, brainstorming | Tasks: "summarize this folder", "research X and write a report" |

Rule of thumb: if your request contains a verb that touches the outside world
(read, write, search, run, check), use **Agent**. If it's all in the model's
head, use **Chat**.

Both modes work with a local GGUF model or a cloud key (BYOK). The agent can
run on a different model than chat — pick it from the model selector while in
Agent mode.

## What the agent can do (built-in tools)

| Tool | What it does | Notes |
|---|---|---|
| `web_search` | DuckDuckGo search | no API key needed |
| `read_webpage` | Fetches a URL as clean Markdown | via Jina Reader |
| `deep_research` | Multi-step research → cited Markdown report | takes minutes; shows progress |
| `read_file` / `write_file` / `list_directory` | File access across your workspace roots (launch dir + home by default) | `~/.feral`, `~/.ssh`, and anything in `FERAL_FS_DENY` are always refused |
| `fetch_url` / `http_request` | Fetch any public URL / call any API | SSRF-guarded, rate-limited, audited |
| `read_skill` | Loads an installed skill's instructions | see Skills below |
| `connectors_manage` | The agent sets up its own WhatsApp/Discord/Slack connectors when you ask | it can write tokens but never read them back |
| `tool_health` | The agent reports its own tool success rates | |
| `scan_workspace` | Finds hardcoded secrets / risky patterns in your code | never prints the secret values |
| `shell_exec` | Run shell commands | **on by default**; disable with `FERAL_ENABLE_SHELL_EXEC=false` |

While the agent works, tool calls appear as small bubbles next to the mascot —
click a finished bubble to see exactly what the tool returned.

Sometimes the agent asks *you* something mid-task (a question card appears in
the chat). Answer it and the agent continues; ignore it for 5 minutes and it
proceeds with the recommended option.

## Scheduled tasks (cron)

The agent can run tasks on a schedule (e.g. "every morning summarize my
notes"). Scheduled runs use the same tools and memory as a normal agent
session. Results and failures appear as toast notifications in the corner of
the app.

## Skills

Skills are instruction packs that teach the agent new workflows.

- **Install:** sidebar → Skills → browse the catalog → Install. New skills are
  available to the agent on your very next message — no restart.
- **What happens under the hood:** the agent sees a one-line menu of your
  installed skills and loads a skill's full instructions only when relevant.
- **Create your own:** drop a folder into `~/.feral/skills/<my-skill>/` with a
  `SKILL.md` inside. Front matter (name, description) + Markdown body with the
  instructions. The description is what the agent uses to decide when your
  skill applies — make it specific.

## Connectors (WhatsApp, Discord, Slack)

Your agent can answer you from your messaging apps — same brain, same memory,
still running on your machine.

- **Set up:** sidebar → Connectors, or just ask the agent in chat ("connect
  yourself to Discord"). WhatsApp pairs by scanning a QR code; Discord and
  Slack take a bot token.
- **Only allowlisted people** can talk to your agent — you choose who when
  enabling the connector.
- In the terminal: `feral connectors` (and `/connectors add whatsapp` inside
  `feral chat` shows the QR right in the transcript).

## Memory and privacy

- The agent remembers durable facts about you (name, preferences, projects)
  and can recall past conversations. Everything is stored locally in SQLite.
- Wrap anything in `<private>…</private>` and it will be used for the current
  reply but **never written to memory**.
- Settings → Privacy shows exactly what is and isn't stored.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Chat input disabled | No model loaded and no cloud key — Models → download/load, or Settings → Cloud Keys |
| "Agent offline" banner | The agent process crashed; it restarts automatically. If the banner says restarts were suspended, restart the app |
| First reply takes minutes | Normal on CPU for the first message (model load + prompt processing) — the indicator under the message explains what's happening |
| "The model stopped responding…" | Model/provider hung; retry, or switch to a smaller/faster model |
| Key rejected (401) | Settings → Cloud Keys — re-paste the key, check it's active with the provider |
| Empty answer from a thinking model | The model spent its whole budget thinking — raise max tokens in the controls popover, or use a larger model |
