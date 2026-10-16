# Cinderpaw User Guide

A short, practical guide. For installation and hardware requirements see the
[README](../README.md).

## Start here

Everything you type goes to the agent. It reads what you asked, works out what
it needs (a file, a web search, a command), does it, and answers. There is no
mode to pick.

**First, give it a brain.** The agent thinks with a model, and it needs one
before it can answer:

- **Easiest:** press **Sign in with OpenRouter** on the home screen. Your
  browser opens, you log in, and that is it.
- **Already have a key?** Open **Models → Cloud** and paste it (OpenAI,
  Anthropic, Google and about 30 more).
- **Want it free and offline?** Open **Models → Hugging Face** and pick a model
  the app says fits your computer. Small models make more mistakes.

**Three things to try first:**

1. "What is in my Downloads folder? Group it by type." It reads your files.
2. "Find three reviews of the Framework 13 laptop and sum them up." It searches
   the web.
3. "Make me a one-page PDF with my plan for this week: ..." It makes a file you
   can open, edit and send.

Every step it takes shows up in a card on its reply, so you can see what it
did. It asks you first before anything you cannot take back: deleting outside
your folders, installing software, posting online, or sending a file to a chat.

## What the agent can do (built-in tools)

| Tool | What it does | Notes |
|---|---|---|
| `web_search` | DuckDuckGo search | no API key needed |
| `read_webpage` | Fetches a URL as clean Markdown | via Jina Reader |
| `deep_research` | Multi-step research → cited Markdown report | takes minutes; shows progress |
| `read_file` / `write_file` / `list_directory` | File access across workspace roots (launch dir + home + scratch by default) | Root and protected-path checks apply, with a scratch exception; see [security limits](../SECURITY.md) |
| `fetch_url` / `http_request` | Fetch any public URL / call any API | SSRF-guarded, rate-limited, audited |
| `read_skill` | Loads an installed skill's instructions | see Skills below |
| `connectors_manage` | The agent sets up its own WhatsApp/Discord/Slack connectors when you ask | it can write tokens but never read them back |
| `tool_health` | The agent reports its own tool success rates | |
| `scan_workspace` | Finds hardcoded secrets / risky patterns in your code | never prints the secret values |
| `shell_exec` | Run shell commands | **on by default**; disable with `CINDERPAW_ENABLE_SHELL_EXEC=false` |

While the agent works, each tool it uses shows up as a step in a card on its
reply. The card folds away once the answer is done. Click the card to open it
again, and click a step to see more about it.

Sometimes the agent asks *you* something mid-task (a question card appears in
the chat). Answer it and the agent continues. After the default 5-minute timeout,
routine questions use the recommended option; questions marked for human
escalation remain unapproved.

## Scheduled tasks (cron)

The agent can run tasks on a schedule (e.g. "every morning summarize my
notes"). Scheduled runs use the same tools and memory as a normal agent
session. Results and failures appear as toast notifications in the corner of
the app.

## Skills

Skills are instruction packs that teach the agent new workflows.

- **Install:** Settings → Capabilities → Skills → Discover → Install. New skills
  are ready for the agent on your very next message. No restart needed.
- **What happens under the hood:** the agent sees a one-line menu of your
  installed skills and loads a skill's full instructions only when relevant.
- **Create your own:** drop a folder into `~/.cinderpaw/skills/<my-skill>/` with a
  `SKILL.md` inside. Front matter (name, description) + Markdown body with the
  instructions. The description is what the agent uses to decide when your
  skill applies — make it specific.

## Connectors (WhatsApp, Discord, Slack)

Your agent can answer you from your messaging apps — same brain, same memory,
still running on your machine.

- **Set up:** Settings → Accounts, or ask the agent in chat ("connect
  yourself to Discord"). WhatsApp pairs by scanning a QR code; Discord and
  Slack take a bot token.
- **Only allowlisted people** can talk to your agent — you choose who when
  enabling the connector.
- In the terminal: `cinderpaw connectors` (and `/connectors add whatsapp` inside
  `cinderpaw chat` shows the QR right in the transcript).

## Memory and privacy

- The agent remembers durable facts about you (name, preferences, projects)
  and can recall past conversations. Everything is stored locally in SQLite.
- Complete `<private>…</private>` blocks are stripped from the agent loop's
  episodic text. The model still sees them; other storage paths are not covered.
- Settings → Privacy summarizes storage and online features.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Cinderpaw answers "I need a model before I can do that" | No model loaded and no cloud key. Use the buttons under that answer, or open Models to download one, or add a key in Models → Cloud tab |
| "Agent offline" banner | The agent process crashed; it restarts automatically. If the banner says restarts were suspended, restart the app |
| First reply takes minutes | Normal on CPU for the first message (model load + prompt processing) — the indicator under the message explains what's happening |
| "The model stopped responding…" | Model/provider hung; retry, or switch to a smaller/faster model |
| Key rejected (401) | Models → Cloud tab. Paste the key again, and check with the provider that it is still active |
| Empty answer from a thinking model | The model used its whole budget thinking. Use a larger model, or one that does not think first |
