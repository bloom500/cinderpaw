# Changelog

> From this release on, Cinderpaw uses **calendar versioning**: a release is named by
> its date, e.g. `2026.06.17`. (Internally the build uses the equivalent semver
> `2026.6.17`, since semver forbids leading zeros — the padded date is what's
> shown everywhere in the app and on releases.)

## 2026.08.21

### Changed

- **The app is now called Cinderpaw.** Same little pixel companion, new name —
  "cinder" for the warm ember it is coloured after, "paw" for the creature it
  actually is. The old name described a mood; this one describes what you see on
  screen. Everything you have keeps working: your conversations, agents,
  settings, connectors and models are untouched, and you do not have to do
  anything.

  The three things that carry your data moved too, together and in one step,
  because moving some of them and not the others is what leaves an install in
  two halves: the config folder is now `~/.cinderpaw/`, the command is now
  `cinderpaw`, and the app identifies itself to your operating system under its
  new name.

  Nothing is copied over you and nothing is deleted. On the first start after
  updating, your `~/.feral/` is carried across and then left exactly where it
  is, marked as migrated — remove it whenever you are satisfied, or never. The
  same happens to what your browser view stored: theme, language, the voices and
  transcription engine you picked, and the fact that you have already done the
  onboarding. If any of it cannot be carried across, the app says so on your
  screen and stops before changing anything, rather than starting up looking
  like a fresh install.

  The old names keep working where they can. `feral` stays as a second name for
  the command, every `FERAL_*` environment variable is still read (the
  `CINDERPAW_*` one wins, and the old one warns once), and a `~/.local/share/feral`
  bundle from before the rename is still found. See RENAME-PLAN.md.

### Added

- **Your chats are filed under the day they happened.** Today, Yesterday,
  Previous 7 days, Previous 30 days, then months — in the sidebar and on the
  Chats page. By the calendar rather than by hours elapsed, so a chat from
  eleven last night is under Yesterday and one from one this morning is under
  Today, which is what those words mean to the person reading them.
- **Rename and delete sit on every chat and project**, in the sidebar itself.
  Renaming does not change where a chat sits in the list: the order is when you
  last talked to it, and fixing a typo in a name is not talking to it.
- **Chats and Projects left the sidebar's navigation.** They were rows leading
  to a page that listed what the sidebar already lists, and the actions were the
  only thing that page had that the rail did not.

### Fixed

- **Ten rounds of audit findings.** A long pass over the whole tree, applying
  the ones that were real. The theme running through them: guards that read
  correctly and did not hold. The improvement ratchet took the candidate's word
  for its own score; the sanity checks that are meant to be ungameable matched
  answers by substring, so "there are 18 planets" passed for "8"; the notebook
  sandbox handed back objects that could reach the host from one property
  deeper; a candidate patch ran its tests with every secret in the environment
  visible to it.

  And the quiet ones, which cost more people more often: a freshly created
  scheduled task never ran at all, because nothing ever worked out when its
  first run should be. A fact remembered across twenty conversations had its
  count reset on every cleanup pass, so the cleanup then decided it was cold and
  deleted it. Recording a voice message and having it fail left the microphone
  live. The progress bar for the embedding download was invisible.

- **Everything your browser view remembered survives the rename.** The webview
  keeps its storage in a folder named after the app, so renaming the app pointed
  it at an empty one. On its own that would have reset your theme, your
  language, the transcription and voice engines you had chosen, your enabled
  tools, the active agent and your saved call recordings — and brought the
  onboarding wizard back for someone who finished it months ago, with no message
  anywhere explaining any of it. The old folder is now carried across on first
  start, and left where it was.

  The most visible symptom was the phone button offering to set up transcription
  instead of placing a call: it had no record of the engine you already picked,
  so it asked again.

- **The date headings in the chat list are readable.** They were drawn in the
  disabled-text colour, which on a light background is present in the page and
  absent from the screen.

## 2026.08.15

### Added

- **You can call Cinderpaw and talk to it.** Press the phone button and it answers
  out loud, in your language, interrupting and being interrupted, the way a
  call works. While it talks it can still use everything it has: your files,
  your memory of past conversations, the web. There is one door between the
  voice and the agent (`ask_feral`), so the caller reaches the same assistant
  the chat window does, with all 43 tools behind it, rather than a stripped-down
  phone version of it. You watch the work happen: a browser, a terminal, a
  search widget light up in the call for whatever it is actually doing, and the
  sphere in the middle moves while a tool runs.
- **The call keeps talking while it works.** A lookup can take a minute, and a
  minute of silence on a phone line reads as a dead call. It now says what it is
  doing, keeps the line warm every ten or fifteen seconds, and answers you while
  it waits. It is also no longer allowed to *say* it is searching without
  searching: announcing a lookup and making it are one action, because the panel
  next to the words shows what really ran.
- **A call survives the server's limits.** Long calls used to die at ten minutes
  and again at twenty, both times looking like a network fault. The session now
  reconnects and carries on, and a close that blames the audio configuration
  drops the voice pin and retries rather than ending the call.
- **A second cloud provider, for when the first one falls over.** The router
  fails over to another configured cloud route before it falls back to the
  local engine, so one provider's bad ten minutes no longer ends the work.

### Fixed

- **Cinderpaw improves itself again, for the first time since 10 July.** The
  self-improvement loop had been running nightly and promoting nothing, on
  every install, and the reason was three graders, not the models. Tier 0 is the
  frozen sanity floor and one failure blocks all promotion: asked for the
  formula of water the model answered `H₂O` with a real subscript and was marked
  wrong against `h2o`; asked for JSON it wrapped the object in a code fence and
  was marked wrong for the wrapper; and the floor also held two speed limits and
  three token budgets, which measure the network, not the candidate. Correctness
  still vetoes absolutely. A limit the current champion also misses no longer
  does: that is the machine, not a regression. Measured after the fix on a
  cloud route: champion score 24.2 → 41.0, and `main` moved for the first time
  in five weeks.
- **Cinderpaw tells you when it is not dreaming.** Self-improvement is off by
  default when your model runs in the cloud, because dreaming costs money and it
  will not spend yours while you are away. That was the right default and an
  invisible one: the reason went to a log file, and everyone without a local
  model, which is most people, saw an empty panel, a "Dream now" button that
  did nothing, and no way to tell a switched-off feature from a broken one. The
  Dreams panel now says it in words, and has the switch, with your spend cap
  next to it.

## 2026.08.11

### Added

- **A task can now say what "done" means, and the world checks it.** Put a
  `done_when:` line on any message — `done_when: exists report.md`,
  `done_when: contains report.md "Q3"`, `done_when: run npm test` — and the run
  is a success only if that assertion passes, whatever the agent says about
  itself. Without one, the run is recorded as *unverified* rather than quietly
  as finished, because "I'm done" is the weakest evidence in the system: an
  agent that inventoried 9 files out of 250 and politely offered to continue
  used to have that accepted as an answer. Now it is sent back to work with the
  failure quoted at it.
- **Unattended work survives the process that started it.** A long task now
  keeps a durable record: every turn, what changed on disk, and what it still
  owes you. Kill the machine mid-task and the next boot picks the task back up
  where it was — or, if it cannot, tells you that instead of going silent. When
  it finishes, the report is delivered even if the process that produced it is
  long gone.
- **The agent keeps a notebook.** `remember` with a `note:` key writes something
  it will still have on hour six, rendered in full every turn rather than
  searched for. Search does not fix hour six: what it has forgotten it knows is
  exactly what it will not think to look for. The notebook is capped, so keeping
  it current is curation rather than hoarding.
- **A permanent scratchpad.** Its own workspace that survives restarts, and the
  desktop shows what it wrote there while it worked.
- **Every completion says what it cost.** A per-turn breakdown of where the
  tokens went — system prompt, tool schemas, the drawers, the conversation, tool
  output — in two accounts that are never mixed: what we measure and what the
  provider billed. `/tokens` on a chat surface prints the same thing.
- **Your own commands can run on the agent's events.** Hooks fire when a turn
  starts, when a tool runs, when a turn ends.
- **`feral migrate`** — brings an existing OpenClaw or Hermes Agent setup across.
  It finds the install itself (`--source` for unusual locations), then prints
  three sections before writing anything: what it will import, **what it could
  not** — every key in their config that no importer claimed, listed by name —
  and what it refused to overwrite. `--dry-run` stops after the report and
  `--json` gives the whole plan to a script. This release imports the persona
  markdown you wrote by hand (`SOUL.md`, `AGENTS.md`, `IDENTITY.md`); anything it
  replaces is copied into `~/.feral/migration/` first, so undo is one `cp`.
  Providers, connectors, secrets and cron jobs still show up in the "not
  imported" list — they arrive in later releases, and until then the report says
  so instead of leaving you to discover it. Your OpenClaw/Hermes install is only
  ever read, never written to.
- **`feral uninstall`** — removes Feral and **keeps `~/.feral`**: settings,
  memory, API keys and downloaded models survive, so changing your mind costs a
  reinstall rather than a fresh start. It prints exactly what it will delete
  (with sizes) and what it is keeping before asking. `--purge` deletes the data
  too, and says plainly that it is permanent. On npm/apt/dnf installs it hands
  you the package manager's own command instead of racing it, and it refuses
  outright to touch a git checkout you build from.

### Changed

- **Walk-away runs are sized for a working day, not eighty minutes.** The
  ceiling used to be 3 continuations of 20 minutes, and 80 minutes was recorded
  for weeks as an observed limit before anyone read the arithmetic. An unattended
  run now has an 8-hour deadline and a continuation budget sized to reach it; a
  scheduled job gets an hour instead of five minutes, which predated the agent
  doing multi-step work at all. The deadline is the term and the counter is the
  safety net — a wedged run stops on the clock rather than spending its whole
  budget.
- **A stuck run tries a different way in.** Proven no-progress — the same call
  returning the same result — no longer burns the rest of the budget. It gets one
  replan, is told plainly that the approach is refuted, and is allowed to answer
  "there is no other way in" and stop. An invented approach run for another hour
  is worse than an honest stop.

### Fixed

- **A provider's bad second no longer ends a night's work.** Only rate limits
  were retried; a 502, a dropped socket or a gateway restart threw on the first
  failure, and from there the turn was not continuable and the whole unattended
  run stopped with the error text delivered as the answer. Over eight hours
  against any cloud provider that is not a possibility, it is a certainty.
- **Answers about files nothing opened are marked as such.** A turn that
  describes a file, having made no tool calls at all, now carries one line
  saying so — and if it claims it went and looked ("I checked", "just now") when
  nothing ran, that is flagged too, because with zero tool calls that is not a
  doubtful claim but a false one. The same detector, pointed the other way, adds
  the one instruction the model actually obeys when your message names a file or
  asks for something to be checked.
- **A model that cannot see images says so.** Sending a photo to a text-only
  model produced either a shrug ("something went wrong") or, worse, a confident
  description assembled from the filename. The rejection is now named as an
  action, and the image itself carries an instruction to admit blindness rather
  than guess.
- **Tool calls in an unfamiliar dialect are read, not thrown away as prose.**
  Models fall back to other function-call formats mid-task; one namespaced
  variant slipped past the parser entirely and reached the user as raw markup
  with the task abandoned. Asking a model to switch syntax does not work —
  reading the format it actually speaks does.
- **Long conversations stop losing what they established.** Compaction used to
  summarize its own summaries, so a long session drifted into invention; the
  summary now carries exact facts forward verbatim and is never re-compressed.
  A separate treadmill — re-fetching the same numbers after every compaction —
  cost one task 117 file reads for 24 files without finishing.
- **`/new` works on Discord and Slack.** The escape hatch for a conversation that
  has gone wrong was unreachable on the two surfaces most likely to need it.
- **WhatsApp stops trying to pair by itself.** An unlinked connector spun through
  reconnect attempts — 47 in 90 seconds — and reported itself healthy while doing
  it. Pairing is something you start.
- **Shutdown takes a second, not thirty.** A reader's copy of the sender kept the
  channel open long after everything else had stopped.
- **Destructive commands aimed outside the workspace are refused**, and the agent
  can see the work it did in any configured root rather than only the first.
- **The live status message no longer eats the start of the answer** (Discord and
  Slack). While the agent worked, one message was edited to show what it was
  doing ("🔎 searching…"), then became the answer. Those status edits were sent
  without waiting and both platforms queue them behind a rate limiter, so one
  issued a moment before the answer could be applied a moment *after* it —
  overwriting the first 2000 characters. A long reply appeared to start
  mid-sentence, and nothing was logged. The more tools a turn used the likelier
  it got, so it hit exactly the long answers that could least afford it.
- **Research reports say what they could not confirm.** `deep_research` was told
  only "do not invent facts", which nothing checks. Now: specific values (file
  paths, config keys, version numbers, prices, benchmark figures) may only appear
  if a source actually contained them; a vendor's own repository outranks a blog
  or an AI-generated wiki, and a claim resting only on the latter says so where
  it is stated; and every report ends with **Not confirmed** — what the question
  asked that the sources do not answer. A report that reconstructs a
  plausible-looking config path reads exactly like one that researched it.
- **`feral update` works on a from-source install.** On a headless server the
  command did not merely fail, it pointed the wrong way: `update` lives in the
  npm launcher, so a server that built from source either had no such subcommand
  or was told to `npm install -g feral-agent@latest` — which installs a second,
  unrelated `feral` earlier on PATH and leaves the real one behind. Cinderpaw now
  detects how it was installed and runs that install's actual update: a git pull
  and rebuild from source, npm where npm applies, the installer elsewhere. The
  gateway restart still only fires if a gateway was already running, so the
  Discord/Slack connector lands on the new build.

## 2026.08.01

Reliability on long tasks. Every fix here is something you only hit after the
agent has been working for a while — which is exactly when it hurts most.

This is the first release measured against a walk-away benchmark: real tasks run
end to end, unattended, nine times each. It is why several of the entries below
name a number instead of a hunch.

It also closes out a hardening pass against the agent runtime, using two mature
agent runtimes as behavioural references. Most of what that pass produced is not
in this list, because most of it was evidence rather than repair: the four
capabilities most likely to fail a user quietly — surviving a restart, switching
provider mid-session, resuming memory, and writing memory — now have tests that
prove the behaviour instead of code that looks correct.

### Added

- **Cinderpaw stops when it is provably stuck.** If a tool returns byte-identical
  output for the same arguments twenty times over, repeating it cannot make
  progress, so the turn ends and says which tool got stuck — instead of quietly
  burning up to 500 iterations or your whole time budget on the same call. A
  tool whose output keeps changing (a build still running, a job still queued)
  is left alone: waiting is not looping.

- **`feral update`** — pulls the latest release and restarts the gateway, so a
  connector already running on Discord or Slack picks up the new build instead
  of quietly serving the old one until you notice. If npm's global directory
  isn't yours to write to — the usual Linux setup — it names that directory and
  gives you both ways out, instead of suggesting the command that just failed.

### Fixed

- **Web search works, with no setup.** It did not work at all before, on any
  install: the only real backend was a SearXNG server you had to host yourself,
  and both paths meant to cover its absence were dead — the no-backend fallback
  called a DuckDuckGo endpoint that answers definitions rather than searches,
  and the escalation to `deep_research` searched through a service that now
  requires a paid key. Three dead paths, so nearly every search failed, each
  time with a different-looking error.

  Search now runs keyless on DuckDuckGo out of the box, and it is **paced** —
  one query every 5 seconds, with parallel calls queuing rather than bursting.
  The pacing is the fix, not a precaution: DuckDuckGo throttles by rate, so a
  burst of 14 searches got 7 answered and then a ten-minute block, while the
  same 14 paced through the new limiter returned 14 for 14. If the limit is
  tripped anyway, Cinderpaw backs off and says so instead of reporting an empty web.
  A self-hosted SearXNG is still worth it — several engines, no rate limit, no
  pacing delay — and if it goes down, searches fall back to DuckDuckGo and say
  which backend answered.

- **A tool with a backup now actually falls back to it.** Tools can declare a
  standby to try when they fail. If that tool *also* declared a retry policy,
  the standby was skipped for exactly the failures it was meant to cover — a
  missing file, a bad argument — and you got the original error instead of the
  working result. The two code paths that handled this had drifted apart; they
  are now one path and cannot drift again.
- **A hung tool can no longer hang the whole agent.** One internal failure shape
  left a tool call waiting forever with its own timeout already switched off.
  Nothing could recover it short of restarting. It is now impossible to reach
  that state.

- **Parallel tool calls all run now, instead of just the first one.** When the
  model batched two actions into a single reply — "pause the losing campaign and
  raise the winner's budget" — only the first was executed, nothing recorded the
  loss, and the model reported both as done. Half a task, reported as finished.
  On the benchmark this failed 5 runs out of 17; after the fix, 0 out of 9. A
  call that genuinely can't be read is now counted and named back to the model,
  so it re-sends what's missing rather than assuming it landed.
- **A batch of calls no longer collapses into one.** Providers that omit the
  wire-format `index` had every call in a batch folded into the same slot, where
  names overwrote each other and arguments concatenated into garbage. Three lead
  imports became one; a "check the CRM, then write" dropped the check and
  duplicated a person already on file.
- **Tool calls in the format the model actually speaks.** Cinderpaw now reads the
  shapes models fall back to when they abandon the format they were asked for —
  `<function=…>`, `[tool:name]`, Harmony channels — instead of showing them to
  you as prose. Unrecognised tool names are rejected, never invented.
- **"No model loaded" no longer hides the real error.** On a cloud model, a
  failed request used to fall back to the local engine — which the app had
  deliberately unloaded when you switched to cloud — and report *its* complaint
  ("no model selected") instead of what actually went wrong. You now see the
  real cause: rate limit, expired key, or a conversation grown past the model's
  context. As a side effect, a single cloud hiccup no longer drags a multi-GB
  local model back into memory.
- **A tool call cut off mid-argument is retried instead of run blind.** When a
  reply hit its token limit while the model was still writing a tool call's
  arguments, the truncated JSON was silently treated as *no arguments at all* —
  so `write_file` ran with no path and no content, and nothing flagged it. Cinderpaw
  now recognises the truncation and asks the model to re-send the call.
- **Compressing a long conversation no longer throws away the recent half.**
  The summary that replaces older turns was built from only the first few
  thousand characters — the opening of the session — so every file path,
  command, and fix from the actual work was lost. That is why the agent forgot
  paths it had just written and repeated steps it had already done. The summary
  now covers both ends of what it replaces and is told to keep paths, commands,
  and outcomes verbatim.
- **Extension (MCP) tools are available on the very first message.** They
  connect in the background at startup, and a message sent in that window used
  to be answered with "I don't have a tool for that" for a server you could see
  was connected.
- **`shell_exec` tells the truth about its timeout,** and the 5-minute ceiling
  is now raisable (`FERAL_SHELL_MAX_TIMEOUT_MS`) for builds that legitimately
  run longer.
- **Discord DMs reach the agent.** They never had. The connector asked Discord
  for direct-message events but not for the one extra flag that lets an
  uncached DM channel through, so every DM was dropped before any Cinderpaw code
  ran — while the connector's own documentation said it always answers DMs.
  Confirmed against a live bot: two DMs arrived at a client carrying the flag
  and neither arrived at Cinderpaw's.
- **A bare @mention gets an answer instead of silence.** Mentioning the bot with
  no other text stripped down to an empty message, which was discarded without
  a reply, a reaction, or a log line — indistinguishable from a dead bot. It now
  acknowledges and asks what you need.
- **In a server, Cinderpaw answers you without an @mention by default.** Naming
  channels (`feral connectors set discord --channel …`) still narrows it to
  exactly those. The allowlist is unchanged and remains the real gate: only
  people you list are ever answered, so this means "answers you anywhere it can
  see you", not "joins every conversation".
- **`feral doctor` no longer reports a healthy sidecar as dead on Windows and
  macOS.** It contradicted itself in the same output — `api port` said the
  sidecar was alive, `sidecar` said it was DOWN and pointed you at the log to
  investigate a failure that had not happened. The liveness guess came from a
  PID-file check that only ever worked on Linux; everywhere else it answered
  "cannot tell" and the caller printed that as "dead". Liveness now comes from
  the gateway itself, which is the only thing that knows.
- **The endpoint allowlist stays an allowlist after you switch models.** If you
  pin the servers Cinderpaw is permitted to send your conversation to
  (`FERAL_TRUSTED_BASE_URLS`), that list used to be quietly thrown away and
  replaced the first time the model was changed — and the check that was
  supposed to enforce it then validated the new address against itself, so it
  could never refuse anything. The list now holds across model switches: a
  switch picks from it and cannot widen it. Unchanged if you never set the
  variable, which is the default.

## 2026.07.19

A big one. Cinderpaw can now split work across sub-agents, ask you a question
mid-task from any channel, and train a personal LoRA on your own machine. It
also installs in a single command on every platform, and a batch of local/cloud
model-selection bugs are gone.

### Added

- **Sub-agents.** The agent can now hand a piece of work to a fresh sub-agent
  (`delegate_task`), run several in parallel, and stream their progress back
  live. A depth guard stops an agent from recursively spawning itself into a
  fork bomb.
- **The agent can ask you a question mid-task — from anywhere.** If it hits a
  real fork in the road it stops and asks instead of guessing. This now works
  over the connectors (Discord/Slack/WhatsApp — the question comes back in the
  same channel) and in the `feral chat` TUI, not just the desktop app.
- **On-device LoRA trainer, bundled.** Cinderpaw can now fine-tune a personal
  adapter on your own hardware (Unsloth when available, with a graceful
  fallback), gated behind an A/B eval so a worse adapter never gets promoted.
  Requires an NVIDIA GPU to train.
- **Universal one-command installer.** A single command detects your OS and sets
  everything up — Windows, macOS, and Linux. Per-platform quick-install lines
  are now at the top of the README.
- **Per-connector persona.** Each connector can run with its own persona
  (`--persona`), so the same Cinderpaw can be a support bot in one channel and your
  personal agent in another.
- **The agent can see its own subsystems.** Every RSI layer now reports into
  self-health, so the agent can actually reason about the parts of itself that
  were previously running invisibly.

### Fixed

- **Replies are no longer cut off.** A phantom 4096-token cap on chat replies is
  gone — long answers finish.
- **A local model no longer shrinks your cloud model's context window.** A
  resident local GGUF was stealing the context window from an active cloud
  model (e.g. capping a 1M-context model at 8192). Local and cloud windows are
  now independent.
- **You pick the model — always.** Switching to a cloud model used to leave the
  local GGUF resident, and some paths let the API pick a model on its own. The
  model you choose is the model that runs, and switching away actually unloads
  the old one.
- **The Dream Cycle no longer runs with no model loaded.** Background
  self-improvement is gated on there being an active model.
- **`web_search` no longer reports success on an empty result.** An empty search
  is now treated as the failure it is, so the fallback path actually fires.
- **Cloud model settings** show only what applies (temperature, not local-only
  knobs), and folders start collapsed.
- **BYOK base URLs** are normalized on the plain-env path the same way the
  keychain path already did them.

## 2026.07.14

Hotfix. **Everyone on 2026.07.13 should take this update.**

### Fixed

- **A crashed sidecar could kill the app permanently.** If the sidecar ever went
  down hard, it left its lockfile behind with its process id in it. The guard
  that is supposed to recognise an abandoned lock asked only "does a process
  with this number still exist?" — and operating systems reuse process ids. On
  the report that surfaced this, Windows had handed the dead sidecar's id to
  `svchost`, a system process. The probe came back "exists, but you may not
  touch it", the lock was declared alive, and the sidecar refused to start on
  every launch from then on. The app was dead, and the only cure was deleting a
  file the user had never heard of.

  Two things were wrong. "You may not touch it" was read as *alive*, when it
  actually proves the opposite: the sidecar runs as you, so a process you cannot
  even signal cannot be it. And more fundamentally, **a process id is not an
  identity** — fix the first half and the next recycled id, this time landing on
  something you *do* own, would have looked alive and bricked the app just the
  same.

  So liveness is now something the sidecar has to *demonstrate*: a running one
  touches its lockfile every few seconds, and a lock nobody has touched in a
  minute is treated as abandoned, whatever id it claims. A dead process cannot
  keep touching a file, no matter who inherits its number. The case where the OS
  hands the *new* sidecar the dead one's id is closed too.

  If you are stuck on 2026.07.13 and cannot get past "Cinderpaw Agent went offline",
  delete `~/.feral/agent/.writer.lock` and restart — then update.

## 2026.07.13

First public release. Cinderpaw is source-available under the Business Source
License 1.1 (free for individuals and for organizations under $2M revenue;
each version converts to Apache 2.0 after four years). Windows and macOS
builds are **unsigned** — see the README for the SmartScreen and first-launch
steps.

Builds: Windows x64 and Linux x64 (Vulkan), macOS Apple Silicon (Metal), macOS
Intel (CPU — llama.cpp's Metal backend targets Apple GPUs, so an Intel Mac gets
the CPU engine, which is what it would have fallen back to anyway). An opt-in
NVIDIA CUDA build is published as a separate download for Windows and Linux;
it is deliberately excluded from the auto-updater, so it does not update itself.

### Cinderpaw in the terminal

- **A real terminal client.** `feral chat` opens a full TUI: streaming answers
  rendered at 30fps, tool calls as inline pills, a thinking panel you can fold
  away, and slash commands (`/think`, `/verbose`, `/usage`, `/restart`,
  `/compact`, `/model`, `/connectors`). Layout is borderless and flat, in the
  shape terminal users already know from Claude Code.
- **It behaves like a terminal program should.** `NO_COLOR` is honoured
  globally, there is an ASCII mode for terminals without glyph support, the
  mouse wheel scrolls, manual scrollback is not yanked away by an incoming
  stream, `Esc` interrupts the generation instead of quitting the app, `Ctrl+C`
  needs a second press, input history works, and a panic restores the terminal
  instead of leaving it wedged.
- **Failures are legible, not silent.** No model, runtime offline, runtime
  lost, rate-limited — each gets an error card explaining what happened, with an
  automatic retry countdown where retrying makes sense.
- **A setup wizard and a `--plain` mode** for scripting and for terminals where
  the full UI is not wanted.

### Cinderpaw without the desktop app

- **The runtime is no longer trapped inside the desktop app.** It has been
  extracted into a `feral-core` crate that both the desktop app and a headless
  gateway boot through the same way — one runtime, several faces.
- **A `feral` command-line tool.** Gateway lifecycle (`start`/`stop`/`status`),
  `feral doctor`, model management, logs, connectors, dreams, config, shell
  completions, and `--json` on everything for scripting. Plain `feral` in a
  terminal opens chat.
- **A public runtime HTTP API** on loopback: `/runtime/*` for reads and
  actions, `POST /runtime/chat` for streaming chat over SSE (cloud keys work
  headlessly), and `/events` as a live SSE feed of what the runtime is doing.
  Stability is declared per route — see the API stability contract below.
- **One `feral` to install.** The npm package now ships the Rust binary and the
  sidecar together, so there is no second thing to install and no drift between
  them.

### The model picks itself

- **Brain Stack: capability-routed model selection.** Instead of pinning one
  model to everything, the runtime classifies the task and routes it to a model
  that can actually do it, weighing cost and health. A cheap model handles cheap
  turns; the expensive one is spent where it earns its keep. `feral doctor`
  checks the routing config for you.

### Onboarding

- **Guided first run.** Cinderpaw now looks at your machine before asking you
  anything: an existing config, GGUF files already on disk, a hardware-tier
  model download, provider keys in the environment, a running Ollama, or an
  OpenClaw config to import. Each candidate is **verified with a real
  completion** before it is saved, so a route that is persisted is a route
  that works. Available in the desktop wizard, in `feral setup` (with
  `--classic` for the old wizard), and as a guided screen in the terminal
  client.
- **WhatsApp pairing without the terminal.** The pairing QR now renders in the
  desktop Connectors page with a live countdown to the next code, and in the
  TUI via `/connectors add whatsapp` and `/connectors qr`.

### Local models and GPU

- **Partial GPU offload.** Offload used to be all-or-nothing: if the model did
  not fit entirely in VRAM — including the KV cache — Cinderpaw dropped to *full
  CPU*. A card that missed by a few hundred MB ran the whole model on the CPU.
  Cinderpaw now fits as many layers as VRAM allows and leaves the rest on the CPU,
  sizing the budget from the model's real geometry rather than an estimate.
- **A GPU build no longer breaks the CPU fallback.** On some cards (verified on
  an RX 580) llama.cpp routed buffers through the Vulkan device even at zero
  offloaded layers, so when the GPU could not take the model the CPU fallback
  failed too and the model did not load *at all* — the GPU build was worse than
  the CPU build for those users. The last-resort CPU path now detaches the
  device.
- **You can see where the model is running.** A badge next to the model name
  and in Settings → Hardware shows the real outcome after the load
  (`GPU (vulkan, 24/32 layers)`, or CPU). If a GPU-capable build lands on the
  CPU anyway, Cinderpaw raises one notification explaining why and what to try.
- **NVIDIA CUDA build** as a separate, opt-in download. Vulkan stays the
  default for everyone (it runs on NVIDIA too). The CUDA assets are
  deliberately excluded from `latest.json` and do not auto-update.

### Agent and memory

- **Sessions survive a restart.** Working memory now rehydrates from the
  episodic store, so a conversation is not amnesiac after a restart or an
  eviction. Machine sessions (cron/RSI/dream) still start clean.
- **A provider error is now its own error.** The "local fallback" was a keyless
  copy of the boot-time cloud provider, so after switching providers an error
  on the new one silently re-called the old one — and the old one's failure was
  what you saw. The fallback target is now always loopback, and if no local
  engine is serving, there is no fallback.
- **MCP tools are callable.** They were discoverable but impossible to call:
  the tool schemas were snapshotted before the MCP servers finished connecting,
  so the tools appeared in the list and said "enabled" while the model had no
  function to call. The registry is versioned now and the agent loop rebuilds
  its prompt, grammar and schemas when it changes.
- **New `remember` tool**, so the agent can write to memory directly instead of
  waiting for the asynchronous extractor. `recall` searches facts too.
- **`FERAL_HOME` is honoured.** It was documented but ignored by eight modules
  (SOUL/IDENTITY, onboarding, the memory graph, the four RSI roots), so an
  isolated profile still read and wrote the real one.
- **Resume works.** `resume_get` always returned null — nothing ever recorded
  the current task.
- **Cloud transcripts get room to breathe.** The transcript budget on cloud
  providers is raised to 200k, and the agent is nudged to reach for `web_search`
  first rather than guessing from memory.

### Cinderpaw improves itself — and shows its work

This is the part of Cinderpaw that is not like other assistants: it evolves its own
configuration and, now, its own code. Every step of that is gated, journalled
and reversible, because an agent that can rewrite itself and cannot be audited
is not a feature.

- **Dream Cycle.** When you are idle, Cinderpaw runs a seven-stage cycle over what
  it learned, proposes changes to itself, and evaluates them. You can trigger it
  yourself ("Dream now") and watch which stage it is in.
- **Nothing is promoted on a hunch.** A statistical confidence gate decides
  whether a candidate actually beat the champion or merely got lucky;
  rejections are counted and shown rather than swallowed. A Tier 0 sanity floor
  is enforced at promotion, so a candidate that wins on the metric but fails the
  basics cannot be crowned.
- **An Evolution Journal with receipts.** Every episode is journalled with
  honest budget accounting and per-candidate fitness, surfaced in the Dreams
  panel. Champions are archived per niche (a "tree of champions") rather than a
  single global winner.
- **Code-level self-improvement, behind a wall.** Cinderpaw can now propose patches
  to its own source. They are parsed, checked against a patch policy wall on
  both sides of the boundary, and evaluated in a *disposable git worktree* — the
  candidate never runs in your working tree. A patch that passes still waits for
  **your** approval in the Dreams panel. On approval it is applied, the sidecar
  rebuilds and restarts, and a watchdog reverts it automatically if the new
  build crashes.

### Governance

- **A policy layer over what Cinderpaw is allowed to do to itself**, with a
  fail-closed loader: if the policy is missing, unparseable, or violates the
  ground rules, every governed action is refused rather than allowed.
- **The audit trail is hash-chained.** The evolution journal and the policy
  history are chained, and `governance verify` walks the chain and tells you
  which file or row broke it — so tampering is detectable, not merely
  discouraged.
- **Propose / approve / reject / rollback / freeze**, available from the CLI
  and from a Governance card in the desktop app with an approval inbox.

### Modules

- **Cinderpaw's internals are becoming swappable at named seams.** A module is a
  Bun subprocess with a manifest, run behind resource walls with a seeded RNG,
  speaking JSON-lines — so a replacement for a piece of Cinderpaw can be evaluated
  without being trusted.
- **Promotion is earned by a paired shadow evaluation** against the builtin,
  with floors it has to clear. A promoted module that misbehaves is
  auto-quarantined by a watchdog after repeated strikes and the seam falls back
  to the builtin. Visible from IPC, the API, the CLI, and an Architecture card.

### Personal adaptation (LoRA)

- **Cinderpaw can fine-tune itself to you, on your machine.** A dataset is built
  from your own interactions, a LoRA adapter is trained locally, and it is
  promoted only if it beats the base model on an eval gate — with provenance
  recorded and one-click rollback. Adapters, their measured resource cost, and
  the review queue live in a dashboard.

### Sandbox

- **Allow-by-default with a deny wall at call time.** `fetch_url` and
  `http_request` are always registered with open egress (behind an SSRF guard,
  a rate limit and an audit trail); `FERAL_FETCH_DOMAINS` /
  `FERAL_HTTP_DOMAINS` now *restrict* rather than enable. Workspace roots
  default to the launch directory plus your home, with a hard deny wall on
  `~/.feral` (except scratch), `~/.ssh` and anything in `FERAL_FS_DENY`.
- **New `connectors_manage` and `product_info` tools**, so the agent can
  configure its own connectors and answer questions about Cinderpaw itself.

### Security

- **The SSRF guard let IPv6 loopback through.** `fetch_url` / `http_request`
  refuse to contact loopback, private and link-local addresses. But on the Rust
  side the check parsed the hostname as an IP *with its brackets still on*
  (`[::1]`), which never parses — so the literal-IP check silently never ran
  for any IPv6 URL, and `http://[::1]/` reached the network. And on both sides,
  loopback was recognised by matching the literal text `::1`, so every other
  spelling of the same address walked through: `[0:0:0:0:0:0:0:1]` is the same
  address written out, and `[::ffff:127.0.0.1]` is IPv4 loopback wearing an
  IPv6 costume — including `::ffff:169.254.169.254`, the cloud metadata
  endpoint. Both halves now decode the address and compare numbers instead of
  strings.

  Found by the new Rust CI job on its first run: the guard's own test had been
  failing on Linux the whole time, and nothing ever compiled Rust on Linux
  before a release build.

- **Conversations were being written to the logs.** The cloud chat path logged
  the full outbound request body — your messages included — and every inbound
  chunk, at warning level, behind a comment that said "Remove after triage".
  Removed.

- **The npm auth token could have entered git history.** `.npmrc` is now
  ignored.

- **Dependency advisories:** `plist` 1.9 → 1.10 and `quick-xml` 0.39 → 0.41
  (two high-severity RUSTSEC advisories), `crossbeam-epoch` 0.9.18 → 0.9.20
  (RUSTSEC-2026-0204). CI fails the build on new advisories.

### Rate limits

- **Cinderpaw now stays under a provider's requests-per-minute cap instead of
  discovering it the expensive way.** NVIDIA NIM's free tier allows 40 requests
  a minute. Nothing counted requests, and an agent turn spends one request per
  tool round-trip — so the first genuinely multi-step task tripped the cap and
  every call after it came back 429, killing the task mid-run.

  A sliding 60-second window per endpoint now holds a request back when it
  would exceed the cap, waiting exactly long enough for the oldest one to age
  out — usually a couple of seconds, not a minute. It spends 90% of the
  published limit, because our minute and the provider's are not the same
  minute and aiming at exactly 40/40 produces 429s by construction. Endpoints
  with no published cap — the bundled local engine above all — are never
  throttled.

  A 429 that slips through anyway (the count is local, so a key also used
  outside Cinderpaw is invisible to it) is retried, honouring `Retry-After`, up to
  three times. A provider asking us to come back in ten minutes surfaces as an
  error rather than freezing the agent for ten minutes.

  Waits are announced as a `rate_limited` event, so a multi-second pause reads
  as a pause and not as a hang, and a stop cancels the wait instead of making
  the user sit through it. Override the cap with `FERAL_RATE_LIMIT_RPM` if you
  are on a paid tier or share one key with something outside Cinderpaw.

### Privacy

- The startup update check is **opt-out** (Settings → General) and contacts
  GitHub Releases only. Documented in the README's privacy section.

### Internals

Nothing here changes what Cinderpaw does, but it changes how fast it can be changed
safely.

- **The sidecar protocol is versioned and schema-checked**, and a test fails the
  build if the Rust and TypeScript halves of it drift apart.
- **One typed config module.** Every `FERAL_*` variable is declared in one
  place with a type and a default, and `docs/CONFIGURATION.md` is generated from
  it — a new variable that is not documented fails CI.
- **MCP is unified on the sidecar.** There were two MCP implementations; the
  Rust one (`rmcp`) is gone, and the agent gets MCP tools through the one that
  remains.
- **One provider record.** Provider id → family mapping was duplicated across
  several sites (three of which were missing `nvidia` and silently fell through
  to "custom"). It is now derived from a single source.
- **The two god files are split.** `lib.rs` and the sidecar's `index.ts` are
  now dispatch-only, with the work in `commands/` and `boot.ts`. The RSI code is
  subdivided by layer, and `sandbox/` — which was really about network egress —
  is now `egress/`.
- **CI builds and tests the Rust half**, on Linux and Windows, on every push.
  It used to be compiled for the first time *by the tagged release build*, which
  is how a broken `EXPECTED_COMMAND_COUNT` and a failing SSRF guard test both
  sat on `main` unnoticed. Both were caught the day the job landed.
- **Warnings are at zero** across the workspace, build and clippy. Among the
  ones that turned out not to be cosmetic: a `[profile.release]` in
  `src-tauri/Cargo.toml` that Cargo was ignoring outright (the root workspace
  wins), so those release settings had never taken effect.

### Safety smoke e2e tests (B5)

- **Four new `FERAL_E2E`-gated e2e files** in `CinderpawAgent/tests/`,
  one per safety path the marketing copy promises:
  - `l0-journal-tamper.e2e.test.ts` — flip one byte in a chained
    journal file, assert `verifyJournal` flags the row AND
    `defaultReadWindow` excludes the file (failure surfaced, not
    silent drop). Negative control: same window accepts the file
    after the tamper is reverted.
  - `l4-module-quarantine.e2e.test.ts` — promote a deliberately-
    broken module id, fail-spawn `maxStrikes` times, assert registry
    re-pointed to `builtin`, `module_quarantined` row lands in the
    chained audit, last history row's actor is `watchdog`, post-
    quarantine invokes never spawn. Negative control: builtin-active
    path makes zero spawn attempts even with a faulty spawn stub.
  - `l5-governance-fail-closed.e2e.test.ts` — drives `loadPolicy`
    through every failure mode (missing / unparseable / G0-violation
    / valid) and asserts `governanceCheck` refuses every action under
    the fail-closed builtin (per-layer frozen).
  - `l3-watchdog.e2e.test.ts` — `spawnSync`'s `cargo test -p
    feral-core -- watchdog` to wrap the 16 Rust watchdog unit tests
    into the e2e gate. The full Faza-3 rebuild cycle is out of scope
    per spec; the pure decision + persistence contracts are pinned.
  Default `bun test` skips all four (skip pattern mirrors
  `fractal-scale.test.ts`); run explicitly with
  `FERAL_E2E=1 bun test CinderpawAgent/tests/*.e2e.test.ts`.
  Granular tests already exist in `rsi-seam-adapter.test.ts`,
  `rsi-governance.test.ts`, `rsi-governance-integration.test.ts`,
  `rsi-journal-chain.test.ts`, and
  `crates/feral-core/src/rsi/watchdog.rs`; the e2e files are the
  assembled view a reviewer can read in 60 seconds.

### HTTP API stability contract (B1, unstable pre-2.0)

- **Per-response `X-Cinderpaw-Api-Stability: stable|unstable` header.**
  A single middleware in `crates/feral-core/src/api.rs`
  (`api_stability_header`) inspects the request path and tags every
  response. Stable prefixes are exclusively the third-party protocol
  compat: `/api/*` (Ollama) and `/v1/*` (OpenAI). Everything else
  — `/runtime/*`, `/meta/*`, `/governance/*`, `/modules/*`,
  `/system_info`, `/providers/test`, `/tokenize`, `/events`, the
  catalog reads — is `unstable` until v2.0. Header is set on 401s
  too, so clients can rely on it even before they auth.
  - 9 new unit tests in `crates/feral-core/tests/api_stability.rs`
    pin the contract: stable on `/api/*` + `/v1/*`, unstable on every
    other routed path, present on auth failures, behavior preserved
    for the dynamic `/runtime/models/download/:id` route.
- **`docs/API.md`** lists all 47 routes (47/47 — checked) grouped by
  operation class (read/evolve/govern) with stability tags.
- **`scripts/check-api-docs.mjs`** greps `api.rs::router()` for every
  `.route("/path", verb(...))` line, diffs against a fenced
  `feral-api-routes` block in `docs/API.md`, fails if any are
  missing. Wired into `bun test` via
  `CinderpawAgent/tests/api-docs.test.ts`.

### Architecture overview

- **New `ARCHITECTURE.md`** (B4 of
  `docs/2026-07-09-v1-architecture-hardening-spec.md`) at the repo
  root. The single map a senior contributor needs to self-orient:
  - The four runtimes (Desktop UI, Rust host, sidecar, TUI) and the
    three protocols (Tauri IPC, stdin JSON-lines, loopback HTTP).
  - L0–L6 layer model with file locations on both sides
    (`CinderpawAgent/src/rsi/`, `crates/feral-core/src/rsi/`,
    `src-tauri/src/rsi/`).
  - Faza ↔ L-layer ↔ spec doc ↔ code-path translation table,
    verified against `git log --grep="Faza"` on this branch.
  - Glossary of evocative terms (BRSI, ratchet, escape-time,
    recalcitrance, taste, champion-tree, FMS, seam, SandboxBounds,
    strikes, …) with owning file per term.
  - "Where do I add X" cheat sheet for provider / tool / connector /
    seam module / memory strategy.
  `docs/CONTRIBUTING.md` and `docs/CONTRIBUTOR_GUIDE.md` updated to
  link to the new file (no duplication of the runtime narrative).

### Configuration documentation

- **New `docs/CONFIGURATION.md`** (B2 of
  `docs/2026-07-09-v1-architecture-hardening-spec.md`). Catalogs all
  95 `FERAL_*` env vars that source code reads, grouped by domain,
  with type/default for every var and an explicit threat note for
  every security-critical knob (`FERAL_ENABLE_SHELL_EXEC`,
  `FERAL_ENABLE_CODE_EXEC`, `FERAL_ENABLE_DESKTOP_CONTROL`,
  `FERAL_DESKTOP_CONTROL_*`, `FERAL_DB_KEY`, `FERAL_AGENT_WORKSPACE`,
  `FERAL_WORKSPACE`, `FERAL_FETCH_DOMAINS`, `FERAL_HTTP_DOMAINS`,
  `FERAL_TRUSTED_BASE_URLS`, `FERAL_SHELL_WHITELIST`,
  `FERAL_PROACTIVE_ENABLED`, `FERAL_INNER_THOUGHTS_ENABLED`,
  `FERAL_JINA_API_KEY`, `FERAL_PII_REDACTION`). The
  `FERAL_WORKSPACE` (TS list) vs `FERAL_AGENT_WORKSPACE` (Rust single
  path) trap is called out in its own section.
- **`scripts/check-env-docs.mjs`** greps source for `FERAL_*` and
  diffs against a fenced `feral-env-vars` block in the doc. Wired
  into the bun suite via `CinderpawAgent/tests/env-docs.test.ts` — any
  new env var that isn't added to the doc fails CI.

### Repository hygiene

- **Removed committed graphify output.** `graphify-out/` (16 files:
  graph JSON, cached chunks, generated HTML report) is no longer
  tracked. `.gitignore` now ignores the whole directory instead of
  only the `cache/` subfolder — the dir is reproducible output of the
  `graphify` skill and should never be committed. The .gitignore
  patterns for `tui/target/`, `tui/feral-tui.exe`, `target-check/`,
  and `data/` were already in place; this commit closes the
  `graphify-out/` gap. No code or behavior changes; a fresh clone is
  a few hundred KB smaller.

### Removed

- **Auto-load of the last model on startup.** The Tauri host used to
  spawn a background task at app launch that read `settings.last_loaded_model`
  and reloaded the local model into RAM/VRAM before the user picked
  anything. For non-technical users this caused:
  - **Visible lag** at every app launch (model mmap takes seconds
    and consumes several GB; the machine visibly freezes).
  - **Random crashes** downstream — once the model was loaded at
    startup, PDF ingestion and longer messages had less RAM/VRAM
    headroom and hit OOM or Vulkan driver crashes.
  - **Panic + close** UX — users did not know why the app was frozen,
    so they killed it and reported Cinderpaw as unusable.

  Now: **the user picks a model explicitly from the Local Models tab
  (or the Onboarding wizard on first run).** No background load at
  startup. No automatic persistence of the last-loaded path. The
  `last_loaded_model` and `last_loaded_ctx` fields are removed from
  `Settings`; the startup `auto-reload` task is removed from `lib.rs`;
  the persistence write in `start_model_load` is removed; the
  clearing write in `unload_model` is removed. Files touched:
  `src-tauri/src/lib.rs`, `src-tauri/src/settings.rs`.

  This is a deliberate departure from the "remember so we don't bother
  the user" UX. For non-technical users, surprise is worse than
  friction: pick a model once per session, click Load, watch the
  progress bar.

## 2026.06.29.1

Hotfix for the v2026.06.29 release — completes the macOS Intel build that was
queued forever because the `macos-13` runner image is no longer available.

### Added

- **macOS Intel bundle** (`Feral_x64.dmg` + `Feral_x64.app.tar.gz`) — the
  `macos-13` runner image was deprecated; this hotfix bumps the Intel matrix
  entry to `macos-14` so the build picks up a current runner.

This release is otherwise identical to v2026.06.29. If you already have
v2026.06.29 installed on Linux, macOS Apple Silicon, or Windows, you do not
need to update — only macOS Intel users are affected.

## 2026.06.29

**Power-user preview — Windows, macOS (Apple Silicon + Intel), Linux.**

> **Looking for testers and contributors.** This is the first public preview
> of Cinderpaw's self-improvement engine (RSI) and the redesigned Memory view.
> Both are early-stage — see "Known issues" below for what to expect.

### Highlights

- **Memory Layers** — a clean, non-technical view of everything Cinderpaw
  remembers about you, grouped by recency (Today / This Week / This Month /
  Older). Live dream-cycle history and a status pill for the self-improvement
  engine live on the same page.
- **RSI — Recursive Self-Improvement (Faza 1).** Cinderpaw tunes its own
  parameters (temperature, system prompt, tool preferences, context budget)
  while you're away. An evolutionary algorithm evaluates candidate
  configurations against a frozen test suite and ratchets improvements to a
  git branch. Dream cycles run automatically during idle periods.
- **GPU acceleration that's actually reliable.** Vulkan on Windows/Linux and
  Metal on macOS, with automatic CPU fallback when the GPU is unavailable.
  CUDA detection on NVIDIA, Vulkan dev-launcher with auto-CPU-offload for
  embedding on AMD, and auto-reload of the last model on startup.
- **Inference deadlines.** Time-to-first-token, total, and stall timers with
  heartbeat progress. The streaming indicator now shows the prefill phase and
  live tok/s, so you always know if the model is loading or stuck.
- **Onboarding "Choose your brain".** Pick a provider during setup: OpenAI,
  Anthropic, Google Gemini, DeepSeek, Groq, Mistral, OpenRouter, Kimi, GLM,
  MiniMax, or any custom OpenAI-compatible endpoint. BYOK keys are stored
  locally and never proxied.
- **Token economy.** Tools are advertised only when needed (on-demand memory
  and skill drawers), so the system prompt doesn't waste tokens on capability
  you'll never invoke. Cloud fallback when no local model is available.

### Added

- **Memory Layers page** (`/memory-layers`) with recency grouping, a stats
  hero, an RSI status pill, and a "Cinderpaw's Dreams" panel showing recent
  self-improvement episodes with token counts and ratchet progress.
- **RSI engine (Faza 1)** — event bus, population manager, eval worker,
  ratchet handler, mutation grammar, selection handler, recalcitrance
  tracker, and GoalMode orchestrator, wired sidecar → Rust → UI.
- **Inference deadline enforcement** — TTFT, total, and stall timers with
  heartbeat progress; streaming indicator now shows prefill phase + tok/s.
- **GPU detection improvements** — CUDA feature auto-cap on the context
  pool, Vulkan dev launcher with auto-CPU-offload for the embedding model,
  auto-reload of the last model on startup.
- **Onboarding "Choose your brain" step** with provider selection (BYOK or
  local model).
- **On-demand tool drawers** for memory and skills — tools advertised only
  when needed, reducing prompt token waste.
- **Cloud fallback for inference** when local models aren't available.
- **Workspace scanner improvements** — detect hardcoded secrets, API keys,
  and code security anti-patterns.
- **Live smoke tests** for the dream-cycle pipeline and real-GGUF model
  load (`FERAL_SMOKE_GGUF`-gated).
- **Boot stability probe** — automated observation of startup panics and
  steady-state health.

### Fixed

- **lopdf CVE-2026-0187** (severity 7.5 high) — upgraded `pdf-extract` to
  0.12.0, which pulls `lopdf` 0.42.0 (fixes stack overflow in deeply nested
  PDF objects). `cargo audit` is now clean.
- **Memory Layers scrollbar** — the scroll area used to extend into the
  titlebar and overlap the window controls; now respects the AppShell
  titlebar spacer.
- **Memory Layers theme** — was hardcoded to a dark palette that clashed
  with light mode; now uses the project's theme tokens and adapts to
  light/dark automatically.
- **ControlsPopover visibility on light theme** — `bg-white/alpha` made it
  invisible; switched to theme tokens.
- **FractalMemory.clusterLeaves** — was silently dropped by the
  `feat/reactive-pixel-tree` merge; restored. Drill-down tests pass again.
- **Prune-emission contract** — `rebuild()` no longer emits prune events
  (eviction is a separate path); test aligned to match.
- **workspace-roots.test.ts** — fixed hardcoded `;` path separator that
  only worked on Windows; now uses `delimiter` from `node:path`.

### Changed

- **Memory Layers visualization simplified.** Three iterations of a
  painterly tree didn't match the hand-painted references, so we replaced
  the whole renderer with a clean tiered list view that surfaces what users
  actually care about: what Cinderpaw remembers, when, and how much it's
  improving. **Net −1,184 lines.**

### Known issues

- **RSI evals can return empty content** on cloud-hosted endpoints. Tracked
  as `emptyResponses` in `dream.jsonl`; the engine scores these as 0 and
  moves on, so RSI itself is not blocked. Local GGUF models (Qwen, Llama
  instruct) are unaffected.
- **RSI improves configuration, not weights.** Visible gains accumulate
  over many dream cycles, not overnight. The eval suite is intentionally
  basic (fact lookups, simple math, JSON format checks) — it will be
  expanded in a future release.
- **macOS is not Apple-notarized yet.** First launch on macOS requires
  `xattr -cr /Applications/Cinderpaw.app` from Terminal to clear the
  quarantine flag. We'll fix this once we have a Developer ID.
- **Windows ships `.exe` (NSIS) only** in this release. The `.msi` target
  is paused because WiX 3 rejects any product version whose major component
  exceeds 255, and our CalVer year (`2026`) trips that limit. We'll restore
  the `.msi` alongside a WiX 4 upgrade or a custom ProductVersion fragment.

### Internal

For contributors and reviewers:

- **`dream.jsonl` telemetry** now records `errors` (capped at 5 per cycle)
  and `emptyResponses` counts. Previously both were silently lost.
- **Bridge error logging** — `scoreGenome`, `fetchTier0`, and `invokeAgent`
  adapters log bridge failures to stderr with method, outcome count, and
  genome ID. Previously swallowed.
- **GoalMode error propagation** — failed-eval error messages are collected
  in `GoalResult.errors` and carried through the sidecar → dream-cycle →
  telemetry chain.
- **RSI candidate branch format** — `genome/<id>` was rejected by Rust's
  git validator (single-segment name required); now `genome-<id>` (dash).
- **Sidecar rebuild** — bundles the new engine modules and all fixes.
  Tests: 1255/1255 pass.

## 2026.06.17

*Security hardening release — Windows, macOS (Apple Silicon + Intel), and Linux.*

### Security

- **Sandboxed the agent's built-in tools.** Code execution is now off by default
  and runs with a minimal environment (it can no longer read app secrets); file
  read/write is confined to the agent workspace; and web requests are blocked
  from reaching local/private network addresses.
- **Encrypted sensitive memory at rest.** Facts the agent remembers about you are
  now encrypted on disk with a key kept in your operating system's secure
  keychain. High-confidence personal data (card numbers, IBANs, national IDs,
  emails, phone numbers) is automatically redacted before being stored.
- **Disk-encryption check.** Onboarding now tells you whether your disk is
  encrypted (BitLocker / FileVault) and nudges you to turn it on if it isn't.
- **Tamper-evident activity log.** The audit log is now hash-chained, so any
  after-the-fact edit or deletion is detectable.

### Changed

- Switched release versioning to the calendar-date format described above.

## v0.2.3

*Released 2026-06-14 — Windows, macOS (Apple Silicon + Intel), and Linux.*

### Added

- **GPU acceleration.** Cinderpaw now ships a GPU backend on every platform —
  Vulkan on Windows and Linux, Metal on macOS — and offloads the whole model
  to the GPU by default. Local models that previously ran CPU-only (slow,
  sometimes "not responding" for minutes) now use the graphics card. If the GPU
  can't be used — missing or old driver, no Vulkan runtime, or not enough VRAM
  for the model's context — Cinderpaw automatically falls back to CPU so the model
  still loads instead of failing.
- **Desktop control (opt-in).** The agent can now drive native applications
  through the OS accessibility tree — list windows, read controls, type, click,
  and send real keystrokes. Off by default; enable it under Settings → Agent,
  with a Safe mode (confirm every action) and a YOLO mode (no prompts). A hard
  denylist (password managers, system security dialogs, Cinderpaw itself) can never
  be controlled.
- **Configurable token budget.** The agent's conversation budget is now
  unlimited by default — no more hitting "budget exhausted" mid-task. Optional
  caps (1M/5M/20M/50M) are available under Settings → Agent for cost control.
- **Live context ring.** A live indicator of how full the model's context
  window is, so you can see when the conversation is approaching the limit.

### Fixed

- **Loading a model no longer crashes the machine.** Modern models advertise
  enormous training contexts (up to 256K), and the KV cache was sized to that
  full context and allocated up front — roughly 90 GB for a 4B model, which
  instantly exhausted memory (a kernel panic and reboot on macOS, a near-hang
  on Windows). The load-time context is now capped to a safe default (8192,
  raisable via `FERAL_MAX_CONTEXT`), clamped to what the model actually
  supports.

## v0.2.2

*Released 2026-06-13 — Windows, macOS (Apple Silicon + Intel), and Linux.*

### Fixed

- **The agent no longer stops mid-reply when it runs out of tokens.** Long
  writing sessions (reports, theses, articles) were cut off mid-sentence at
  the per-call token limit and silently presented as the final answer, forcing
  the user to type "continue" by hand. All inference providers now report why
  generation ended (`finish_reason` / `done_reason` / `stop_reason`), and on a
  mid-answer cutoff the agent automatically resumes exactly where it stopped —
  the reply streams on in the same bubble, up to 4 automatic continuations.
- **More malformed tool-call shapes are caught and retried.** The v0.2.1
  detector matched `name`/`tool` keys only; real-world transcripts showed
  models emitting `{"invoke name="write_file">` (a JSON/XML hybrid) and
  XML-style `<invoke name=...>`, which escaped detection — ending the turn
  mid-task with the garbage visible in chat. Both shapes are now scrubbed and
  trigger the corrective retry nudge.
- **`ask_user` validation errors teach the model the right shape.** Every
  rejection now includes a complete valid example call, so a model that got
  the structure wrong can self-correct on retry instead of failing the same
  way twice and giving up.

## v0.2.1

*Released 2026-06-12 — Windows, macOS (Apple Silicon + Intel), and Linux.*

### Fixed

- **Raw tool calls no longer leak into the chat.** Two holes closed: the
  inference providers streamed the re-encoded `<tool_call>{json}</tool_call>`
  tag to the UI as visible tokens, and the frontend only suppressed tool-call
  text at the *start* of a streamed answer — prose followed by a mid-message
  tool call (e.g. `<tool_call>{"name="memory_graph">`) was displayed verbatim.
  Tool calls now travel only through the parsed content channel, and the
  streaming view cuts tool-call text anywhere it appears (including a partial
  opener at the end of the buffer), keeping the prose before it visible.
- **The agent no longer stops mid-task on a malformed tool call.** When a
  model emitted a tool call with corrupted JSON, the parser scrubbed it but
  executed nothing, and the loop treated the turn as a final answer — the
  task silently died. The loop now detects the malformed attempt and feeds a
  corrective nudge back to the model so it can re-emit a valid call (bounded
  at 3 retries).
- **Parallel tool calls are no longer dropped.** All providers (OpenAI-
  compatible, Ollama, Anthropic) re-encoded only the *first* native tool call
  of a turn; any additional calls were silently discarded, leaving the model
  waiting on results that never arrived. Every call in the turn is now
  executed.
- **`ask_user` works reliably with native function calling.** The native tool
  schema declared `questions` as a bare array with no item structure, so
  models had to guess the nested `{question, options:[{label}]}` shape and
  most calls failed validation. Tools can now publish a full JSON Schema per
  parameter, and `ask_user` ships one — including option labels, descriptions,
  the `recommended` flag, and multi-select.

## v0.2.0

*Released 2026-06-12 — Windows, macOS (Apple Silicon + Intel), and Linux.*

### ⚠️ Migration notes from 0.1.x

- **Updater key rotation.** The original update-signing key was exposed in the
  public git history and has been rotated. Upgrading from **0.1.7 or older**
  requires either installing the transitional **0.1.8** release first (it
  carries the new verification key) or downloading the 0.2.0 installer
  manually one time. Full plan: `docs/UPDATER_KEY_MIGRATION.md`.
- Onboarding, conversations, models, and BYOK keys carry over unchanged.

### New

- **Vision — the agent can finally see your images.** Pasted screenshots
  (Ctrl+V) and uploaded image files now reach the model as real pixel data
  (base64 data URLs), not just a `[Image attached: …]` filename note. Works on
  both inference paths: direct chat (BYOK cloud via OpenAI `image_url` content
  parts) and the Cinderpaw Agent sidecar (OpenAI-compatible, Ollama `images`, and
  Anthropic base64 blocks). Local llama.cpp GGUF models remain text-only and
  keep the filename note.
- **Memory that actually carries over.** New conversations no longer start
  cold: the chat tab now injects a "[Memory context]" block (facts from the
  shared knowledge graph) into the system prompt on every send, and runs a
  background extraction pass after each completed turn that writes
  subject–predicate–object triples back into `~/.feral/memory-graph.json` —
  the same graph the agent sidecar maintains. The sidecar side recalls graph
  facts at every turn too, extracts from the very first assistant turn
  (previously only every 3rd — short chats never learned anything), and the
  previously-unregistered `memory_ops` / `memory_graph` tools are now live so
  "remember X" / "forget Y" take effect immediately.
- **Memory Graph page redesign.** Cognee-inspired dark visualization: glowing
  neon nodes on a near-black canvas, degree-scaled node sizes, a filter rail
  with per-type counts, relation chips, free-text node search, a labels
  toggle, and a click-to-inspect detail card showing a node's connections.
- **MCP Extensions (native connector).** Cinderpaw now consumes Model Context
  Protocol servers through the official `rmcp` Rust SDK, managed entirely in
  the Tauri host. New "Extensions" entry in the sidebar (under Skills) with an
  app-store style UI: curated catalog (File Access, Long-term Memory, GitHub,
  Web Search, Browser Automation, Deep Reasoning), one-click install, on/off
  toggle, "What can it do?" tool listing, and humanized errors. No transports,
  JSON-RPC, raw values, internal paths, or API keys ever reach the frontend;
  configs (including keys) live backend-side in `~/.feral/mcp.json`.
- **Drag & drop + paste attachments — any file type.** Files and images can
  be dropped onto the chat input, and screenshots paste straight from the
  clipboard (Ctrl+V). PDFs and Office documents (.docx, .pptx, .xlsx, .odt)
  are now parsed natively (new Rust `extract_file_text` command) so their
  text reaches the model; plain-text files of any extension work as before;
  and true binaries are attached as a path reference the agent can open with
  its file tools instead of becoming a dead "Unsupported format" chip. The
  agent path now receives every attachment too — previously files whose text
  couldn't be extracted were silently dropped and never reached the model.
- **macOS and Linux releases.** The release pipeline now builds and signs
  installers for Windows (.msi/.exe), macOS Apple Silicon + Intel (.dmg),
  and Linux (.deb/.rpm) from a single tag, updater manifest included.
  The agent sidecar resolves its per-platform binary on all five targets.
- **Mascot redesign — the real Cinderpaw monster.** The pixel companion is now
  the brand mascot itself: charcoal-black fluffy monster with orange horns,
  an orange face plate with big black eyes, tiny white fangs, and a round
  orange belly. 55 animated variants across all 22 states, composed from a
  single base sprite so the cast stays consistent (laptop typing, thought
  clouds and lightbulbs, magnifier searches, party hats, heart eyes, a real
  side-run cycle, dissolve-in spawning, and more). It also renders 26%
  larger at a crisp integer 3× pixel scale, so every state, variant, and
  effect is clearly readable without crowding the chat input. A procedural
  pixel-effects layer plays around it per state: confetti on celebrate,
  rising hearts, drifting Z's while sleeping, thought dots, an orbiting
  search ring, a drawn-in green check on done, flashing error cross, work
  sparks during tool calls.
- **Sonnet-style agent voice.** SOUL.md rewritten (super friendly + ultra
  useful), plus new bundled IDENTITY.md and AGENTS.md companions — each
  user-overridable at `~/.feral/<NAME>.md` — composed into the system prompt.
- **Contributor guide.** `docs/CONTRIBUTOR_GUIDE.md`: three-runtime
  architecture, IPC protocols, test matrix, build & release flow.

### Stability

- **macOS/Linux: cloud model selection works in agent mode.** The agent
  sidecar binary is now resolved next to the main executable
  (`Contents/MacOS/feral-agent` in the .app bundle, `/usr/bin/feral-agent`
  on deb/rpm installs) where Tauri actually places it — previously only the
  resource directory was checked, so the sidecar was silently dead on
  macOS/Linux production installs and picking a cloud (BYOK) model from the
  model selector did nothing. Model-switch failures (sidecar offline,
  provider disabled, missing key) now surface as error notifications
  instead of vanishing silently.
- **Agent stop actually stops (this release).** The Stop button's signal now
  travels the whole chain: new `feral_stop_generation` Tauri command → `stop`
  message over sidecar stdin → `AgentLoop.stop(sessionId)` aborts the
  in-flight inference fetch and any running tool. Previously the frontend
  called a Rust command that didn't exist, so agent generations were
  unstoppable.
- **Agent tasks survive chat/tab switches.** A live per-session mirror
  (`lib/feralLiveSession.ts`) accumulates streamed content, tool bubbles, and
  agent phase even while another chat is on screen; re-opening the in-flight
  conversation rehydrates all of it instead of showing the stale disk
  snapshot (which made tasks look reset during long tool runs).
- **Tool-call bubbles behave.** The mascot's tool-call stack now grows upward
  from above the mascot (it could previously extend down over the typing
  bar), and each finished bubble fades out on its own after 4s instead of
  piling up until the turn ended.

- **Unified stream stop (A2).** One stop entry point (`lib/streamControl.ts`)
  routes Stop to whichever path (chat backend / agent sidecar) actually owns
  the in-flight generation. Previously the Stop button in Agent mode told the
  idle chat backend to stop while the sidecar kept generating. Cinderpaw streams
  are stoppable per-session, and a new send interrupts the previous in-flight
  stream on both paths.
- **Sidecar supervision (#11).** The Tauri shell now watches the agent sidecar
  process, restarts it with backoff on crashes, and shows an "agent offline /
  restarting" banner. Before: a sidecar crash made Agent mode silently mute.
- **GGUF chat template (A4).** The prompt format is now read from the model's
  own GGUF metadata (`tokenizer.chat_template`) via llama.cpp's template
  engine; the filename-based guess is only a fallback. A renamed GGUF no
  longer gets a wrong template and corrupted output.
- **Real tokenizer endpoint (P3).** New `/tokenize` route on the local API
  backed by the loaded model's actual vocabulary; the agent's context
  accounting no longer relies on GPT-2 BPE guesses, and token counts are
  cached per message text.
- **Idle-timeout transparency (#13).** A stream that stalls for 300s is now
  reported as an explained error ("model stopped responding…") instead of
  silently ending in a fake "stopped by user" state.
- **No more mid-reasoning dead ends.** When a completion exhausts its
  per-call token limit while the model is still thinking, the agent loop now
  feeds the partial reasoning back and asks the model to finish — up to 4
  automatic continuations — instead of surfacing "(The model used all
  available tokens on reasoning and produced no answer)". Tasks complete
  end-to-end regardless of the Max Tokens slider.

### Error handling

- **Root React ErrorBoundary (#9).** A render exception now shows a recovery
  screen (try again / reload) instead of a blank window.
- **Humanized inference errors (#10).** Raw provider errors (401/429/network/
  context overflow…) are mapped to plain-English messages with a fix-it
  action (e.g. "key rejected → Open Cloud Keys"); the raw error stays
  available under "Technical details". Local-engine failures no longer leak
  `[Error: …]` text into the chat transcript.
- **Cron visibility (X3).** Scheduled jobs now run through the full agent
  loop (tools, memory, budgets) instead of a bare LLM call, and their results
  and failures surface as toasts. Failed runs emit a `cron_error` event.

### First-run experience

- **Zero-models flow (#14).** After the first model download finishes, it is
  loaded automatically (when nothing else is loaded), taking a fresh install
  from "empty app" to "ready to chat" without a manual Load click.
- **Hardware-aware recommendation (#15).** The onboarding wizard's final step
  now reads your RAM/VRAM/Vulkan detection and recommends a concrete model
  size + quantization to download.
- **Slow-start indicator (#16).** While a model loads (with %) or a long
  prompt prefills, the chat shows an explanatory status instead of silent
  dots.
- **Onboarding sequencing (#17).** The agent-creation flow now actually
  mounts (it was unreachable) and never stacks on top of the first-run
  wizard.

### UI

- **Tool-call bubbles (#18)** are interactive: finished calls expand to show
  the tool's output (or error), and long-running tools show live
  retry/progress notes.
- **Empty states (#19)**: HuggingFace browse now explains "no results" instead
  of rendering a blank list.
- **i18n groundwork (#20)**: typed EN/RO dictionary wired to the existing
  language setting; chat surface migrated first, the rest moves incrementally.
- **Accessibility (#21)**: the search overlay is a proper dialog (focus
  restore, Escape from anywhere, arrow-key navigation, combobox semantics).
- **Window dragging (#22)**: Models and Settings pages gained drag regions —
  the frameless window is now movable from every page, not just Chat.
- **Mascot (#23–26)**: reacts to ask_user prompts (curious) and sidecar
  downtime (asleep); can be disabled in Settings → Appearance; greets you in
  the onboarding wizard; single-animation states gained cadence variants so
  long sessions don't loop one identical animation.

### Docs

- README rewritten for 0.2.0 (install matrix, hardware requirements, BYOK
  quick start, honest privacy section, current screenshots).
- New: `SECURITY.md` (threat model + reporting), `docs/UPDATER_KEY_MIGRATION.md`,
  `docs/USER_GUIDE.md` (Agent vs Chat, tools, skills), `docs/CONTRIBUTING.md`
  (architecture, tests, builds).

## v0.1.7

### Agent

- **SOUL.md identity document.** Cinderpaw Agent now ships with a bundled `SOUL.md` that defines its identity, tone, communication style, epistemic standards, and ethical boundaries. The document is the source of truth for how the agent thinks, speaks, and acts — it is injected verbatim as the **first block** of the system prompt (highest priority, overrides vague or contradictory instructions elsewhere in the prompt chain). Concretely:
  - `CinderpawAgent/src/SOUL.md` — bundled default, version-controlled with the codebase, ships inside the sidecar binary.
  - `~/.feral/SOUL.md` — user override. Create this file to customize the agent's identity without recompiling; the loader prefers the user file when present.
  - `CinderpawAgent/src/core/soul-loader.ts` — `loadSoul()` (single read, returns `{ content, source, version, loadedAt, approxTokens }`), `watchSoul()` (debounced `fs.watch` on the user override, hot-reloads without restarting the agent), and `resolveSoulPaths()` for "edit your soul here" diagnostics.
  - `AgentLoop.buildSystemPrompt(registry, soul)` — the soul content is the first system-prompt block, separated from the mechanics (tool list, call format) by a `---` divider. Legacy opener is used as a backwards-compatible fallback when no soul is provided.
  - Hot-reload scope: only **new** sessions pick up SOUL changes mid-run. Active sessions keep their original system prompt so the conversation stays coherent.
  - Size guard: soft warning at >4K tokens, hard warning at >10K tokens. Catches accidentally-large edits that would inflate every LLM call.

### Security (process sandbox)

F0 hardening pass. Every tool that calls out to the host shell now has explicit regression tests for the most dangerous attack surfaces, and a latent escape was closed.

- **Symlink escape closed.** `resolveAllowedPath()` in `sandbox/tool-permissions.ts` now uses `realpathSync()` to follow symlinks before checking containment. A symlink inside an allowed root that points outside (e.g. `/allowed/escape → /etc/passwd`) is now rejected with `PermissionDeniedError`. Previously only `path.resolve()` was used, which normalized `..`/`.` but did NOT follow symlinks — a symlink-based containment bypass was possible. The check falls back to `path.resolve()` for paths that don't exist yet, so write-tools can target brand-new files inside the root.
- **`which()` helper unit tests.** Direct unit tests for the bare-name → absolute-path resolver. Confirms it finds real binaries, rejects names with path separators, and returns null for empty / unknown names.
- **Environment blocklist verified by test.** `LD_PRELOAD`, `LD_AUDIT`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`, `PYTHONPATH` are all stripped from caller-supplied env before reaching the child. A new regression test passes each of these through `run()` and asserts they do not reach the spawned process. `PATH` overrides from the caller are silently ignored (test confirms the process still completes without error).
- **Output truncation verified by test.** A regression test runs a runaway writer (`yes` on POSIX, `for /L` on Windows) and asserts the output cap kicks in, the result is marked `outputTruncated: true`, and the truncation marker is present. Runaway children can no longer fill the host's memory.
- **PATH-hijack guidance documented.** A test confirms the recommended hardening: when `allowedExecutables` uses **absolute paths** (e.g. `["/bin/sh"]`), a malicious `sh` placed earlier in `safeBaseEnv.PATH` cannot shadow the real one — the sandbox matches by path (Case B), not by basename+PATH-walk (Case C). Current `shell_exec` and `git_*` manifests still use bare names (`["sh"]`, `["git"]`) for cross-platform flexibility; a future hardening pass should resolve bare names to absolute paths at manifest registration time to close the last PATH-hijack window.

### Sidecar

- Rebuilt `feral-agent-x86_64-pc-windows-msvc.exe` to bundle the new SOUL loader, hardened `resolveAllowedPath`, and the new regression tests. Size delta: ~1.5K tokens of system prompt per call (negligible cost with prompt caching; uncached, ~$0.0045 per call on Anthropic).

## v0.1.6

### Skills

Cinderpaw's skill system was redesigned around the same "menu + on-demand body" pattern that powers Claude Code's tool guidance. The previous design dumped every installed skill's full `SKILL.md` into the agent's system prompt on the first turn of a session. That worked for 2–3 skills but degraded quickly — every additional skill added hundreds of tokens to the system prompt whether or not the user actually needed that skill's guidance for the current message.

- **Skill menu in the system prompt.** Rust now ships a `Vec<SkillMeta>` roster with every locally-installed skill (id, name, description, version, tags) on each `message` envelope. The agent renders the roster as a short "Available skills" system message in `WorkingMemory`, with one line per skill. The LLM reads the menu and decides which skill (if any) is relevant before doing any work.
- **`read_skill` tool loads skill bodies on demand.** New tool in `CinderpawAgent/src/tools/builtin/read-skill.ts`. The LLM calls it with a skill id; the tool reads `~/.feral/skills/<id>/SKILL.md` (validated id charset + path-traversal guard) and returns the raw markdown. Bodies are capped at 64 KB. After loading, the LLM follows the skill's instructions exactly.
- **Per-turn roster refresh.** Because Rust rebuilds the roster on every `feral_send_message`, installing a new skill from the Skills tab is reflected in the agent's available-menu on the very next message — no need to start a new chat, no need to reset the session.
- **Skills menu replaces first-session injection.** The previous "bake the skills into the system prompt on first session" hack in `AgentLoop.#memoryFor()` was removed. Skill install/remove mid-conversation now takes effect immediately.

### Agent

Two real bugs that affected the local-model experience were fixed.

- **Helpful message on empty thinking completions.** When a thinking model (Qwen 3, DeepSeek-R1, Gemma with thinking mode) is cut off mid-reasoning — most often because the model's `max_tokens` was exhausted during the chain-of-thought block — the previous code returned `"(no response)"` and the user saw a silent empty bubble. Worse, the dangling-`<think>` fallback in `stripThinking` discarded everything after the open tag, including the model's final answer if it followed the thinking. The agent loop now distinguishes two cases: if the raw completion contained any thinking tag, it returns a descriptive message explaining the cut-off and how to mitigate (shorter prompt, larger model, or increase `max_tokens`); otherwise it returns a generic "empty response" message. Either way the user gets an actionable explanation instead of silence.
- **`selectLocalAgent` routes through the model store.** In Agent mode, picking a local model from the chat header used to call `tauri.models.startLoad` directly, bypassing the `useModel` Zustand store. The store's `isLoading` and `loadProgress` were never set, so the ModelPill had no progress to display. The flow now goes through `store.load()` which sets up the `model-load-progress` event listener, updates the store, and lets the UI render. The ModelPill now shows a thin `role="progressbar"` bar at the bottom of the trigger that fills as the model loads — the user always knows whether the load is in progress or done.

### Deferred to v0.1.7

- **ChatGPT Subscription OAuth.** The architecture is researched (issuer `https://auth.openai.com`, PKCE S256, redirect `http://localhost:1455/auth/callback`, scope `openid profile email offline_access api.connectors.read api.connectors.invoke`, token-exchange grant to derive an API key from the OAuth token). The Codex CLI's `CLIENT_ID` is still missing from the public research; the OAuth UI and Rust flow will land in v0.1.7 once the client id is sourced.

## v0.1.5

### Mascot
- **8-bit animated mascot.** A 16×16 pixel-art fluffy black monster with orange horns, big eyes, and two fangs now lives permanently on the typing bar. Reacts to what you're doing: blinks while idle, looks down while you type, eyes dart side-to-side while thinking, scans down while calling a tool, hops happily when the model finishes.
- **Idle boredom run.** After 18 seconds of inactivity the mascot gets bored, switches to a side-profile silhouette, and runs across the full width of the typing bar — leaving small pixel dust puffs in its wake — then flips around and runs back. Any activity (typing, streaming) snaps it straight back to the perch.
- **Reduced-motion support.** All canvas animations respect `prefers-reduced-motion`.

### Agent
- **Token cap removed.** No more daily or per-conversation token budget. Feral Agent runs on BYOK (user pays own provider), so capping was pointless and caused agent sessions to silently stall. Budget can be re-enabled via `FERAL_BUDGET_DAY` / `FERAL_BUDGET_CONVERSATION` env vars if needed.
- **CI sidecar fix.** Release builds now compile the Feral Agent sidecar from the vendored `CinderpawAgent/` directory in the monorepo instead of cloning an outdated external repository. Eliminates a class of "agent not responding in production release" bugs.

### UI fixes
- **Real app version in sidebar.** The version badge now reads from the Tauri API instead of the previously hardcoded `v0.1.3` string.
- **Context ring in agent mode.** The ring no longer stays stale when using the agent. It now shows a comet-arc activity indicator during agent streaming (the sidecar doesn't emit live token counts, so the spinning arc is the honest signal).

## v0.1.4

### Agent mode
- **Native Cinderpaw Agent runtime.** Agents now run on a built-in Cinderpaw Agent sidecar (Bun/TS) wired directly into the chat stream — no external gateway process. A Chat/Agent toggle in the composer switches modes and auto-loads the selected local model into the agent engine.
- **DeepResearch & adaptive reasoning.** Dynamic max-iteration budgets for deep-research and complex tasks, model-fitness scoring, error-correcting control loop, and persistent agent memory.
- **Sturdier tool calls.** Parser now handles Gemma-style `<tool_call>`, bracket and bare-JSON formats, and the `arguments` key; adds silent tool calls and an empty-response fallback; raises token budgets for thinking models.

### Chat & UI
- **Live context ring.** Real token usage straight from the model — exact prompt tokens from llama.cpp locally, real usage stats from cloud providers — with a hover popover showing tokens used, free space and message count, and the model's true context window instead of an estimate.
- **Streaming polish.** Words fade in one-by-one as tokens stream, and a phase indicator shows Thinking / Calling tool / Processing.
- **Thinking blocks.** Support for multiple formats (`<think>`, `<thinking>`, `<|channel>`), a thinking timer, and blocks that now persist across chat and tab switches.
- **Response resilience.** Partial responses are always persisted, and responses survive navigating away and back, tab switches, and hot-swapping the active model.

### Stability & performance
- Fix a `GGML_ASSERT` crash on long agent prompts by chunking the prefill batch.
- Memoize message rendering so streaming no longer re-parses already-completed messages.
- Warning-free `cargo clippy` on the inference build, repo hygiene (`.gitattributes`, corrected `.gitignore`), and `unist-util-visit` pinned as a direct dependency.

## v0.1.3

Initial tracked release. See the GitHub release for details.
