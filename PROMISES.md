# What Cinderpaw promises you

Cinderpaw runs on your computer. That only matters if you can trust what it
does when you are not looking. So here is the list, in plain words.

Every promise below is something you can check yourself. If one of them is not
true, that is a bug, and we want to hear about it:
[open an issue](https://github.com/bloom500/cinderpaw/issues).

## The promises

**1. Your chats stay on your computer.**
If you use a model that runs on your machine, nothing you type leaves it. Not
the messages, not the files, not what the app remembers about you. All of it
sits in a folder on your disk called `.cinderpaw`, in your home folder.

**2. We have no servers, so we cannot read anything.**
There is no Cinderpaw account and no Cinderpaw cloud. Nothing you send passes
through us. This is not a policy we could change our minds about later. The
computers simply do not exist.

**3. If you use a cloud model, your words go to that company and nobody else.**
You can plug in your own key from OpenAI, Anthropic, Google and others. Then
your message goes straight from your computer to them, with your key. We are
not in the middle. What they do with it is covered by their rules, not ours.

**4. No tracking of any kind.**
No analytics. No crash reports. No ads. No profile of you. We do not count how
many people use the app, because counting would mean phoning home.

**5. Your keys are yours.**
Keys you paste in are stored on your own machine, in your operating system's
key store where there is one. The part of the app that draws the screen never
sees them, so a bad web page cannot steal them.

**6. Nothing is behind a paywall.**
No subscription, no locked features, no trial that runs out. You pay for cloud
models only if you choose to use them, and you pay the model company directly.

**7. Uninstalling does not throw away your things.**
Remove the app and your settings, memory, keys and downloaded models stay
where they are, so putting it back later picks up where you left off. When you
really want them gone, `cinderpaw uninstall --purge` deletes them for good.

**8. One phone call, and you can hang it up.**
Once each time it starts, Cinderpaw asks GitHub a single question: is there a
newer version? It sends no information about you. Turn it off in
**Settings → General** and the app never touches the network on its own again.

**9. We tell you what is switched on before you ask.**
Some things are on by default because the app would be useless otherwise. We
say so out loud instead of hiding it in a settings page. The list is in the
next section.

**10. When we do not know something, we say we do not know.**
Any speed or quality number we publish comes with how we measured it. If we
have not measured it, we say that instead of guessing.

## What we do not promise

This half of the page matters as much as the other half.

- **The agent can run commands on your computer out of the box.** That is how
  it does real work, and it is a real risk. Its own file tools refuse
  `~/.cinderpaw` and `~/.ssh` outright. A command it runs is a different thing:
  that program starts with your permissions, so it can read whatever you can
  read. Deleting things outside your working folders is refused, every command
  is written down, and `CINDERPAW_ENABLE_SHELL_EXEC=false` turns the whole
  ability off.
- **Windows and macOS will warn you the first time.** We have not paid for the
  certificates that make those warnings go away. The README shows what the
  warnings look like and what to click.
- **The Mac and Linux builds are still beta.** Windows is the version we test
  most. Bugs on the other two are likely, and worth reporting.
- **Cloud providers are not us.** Once your words reach OpenAI or anyone else,
  their promises apply, not these.
- **The self-improvement part is early.** It works, it is measured, and it is
  young.
- **We are a small project.** There is no support desk and no promise about
  how fast anything gets fixed.

## How to check any of this yourself

- **Read the code.** All of it is here, and the installers are built in public
  by GitHub, from this repository.
- **Look at the privacy page in the app**: **Settings → Privacy** lists exactly
  what is stored and what is not.
- **Cut the network.** Turn off your wifi, load a local model, and keep
  working. Nothing about the app stops.
- **Read the log.** Every tool the agent uses, every page it fetches and every
  command it runs is written down where you can read it.

## If we break one

- Something normal: [open an issue](https://github.com/bloom500/cinderpaw/issues).
- Something dangerous: read [SECURITY.md](SECURITY.md) and email us privately
  instead of posting it.
