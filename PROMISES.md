# What Cinderpaw promises you

Cinderpaw runs on your computer. That only matters if you can trust what it
does when you are not looking. So here is the list, in plain words.

This page describes current behavior and names limits that earlier versions
overstated. Stronger guarantees about network isolation, credential isolation,
and complete audit coverage are design goals, not fully enforced promises.
Report a mismatch:
[open an issue](https://github.com/bloom500/cinderpaw/issues).

## The promises

**1. Local inference runs on your computer.**
Conversation history and memory have local storage. A local model does not
disable web tools, connectors, downloads, or other configured network services.
Those features can send queries, files, or conversation content outside the machine.

**2. The runtime does not require a Cinderpaw account or conversation relay.**
Inference requests go from your machine to the configured local or cloud API.
This describes the shipped request paths, not a claim about all external infrastructure.

**3. Cloud requests use provider APIs directly.**
You can supply a provider key. Fallback routes and configured background work
can also call providers; requests are not limited to pressing Send. The
September 6 audit found recipient-boundary gaps in fallback and redirect paths.
An exclusive chosen-provider guarantee is not yet established across all paths.

**4. No automatic analytics or crash-report uploads in the audited runtime.**
Local logs and user memory do exist. Online features make their own requests;
public-journal publication requires explicit configuration and invocation.

**5. Your keys are yours.**
Supported credential paths use the operating system's key store. This is not
complete renderer isolation: key-entry UI handles keys, and the September 6
audit found additional credential exposure and migration gaps. Do not assume
every credential stays out of renderer memory, files, or diagnostics.

**6. Nothing is behind a paywall.**
The runtime has no Cinderpaw subscription or trial gate. Cloud provider charges
are separate and paid to the provider. Background work and fallbacks may incur
usage; stopping the display is not proof that every remote request stopped.

**7. Uninstalling does not throw away your things.**
Remove the app and your settings, memory, keys and downloaded models stay
where they are, so putting it back later picks up where you left off. When you
want the profile directory removed, `cinderpaw uninstall --purge` removes it.
It does not clear credentials from the OS key store or promise secure erasure
of backups or previously deleted disk data.

**8. Automatic update checks can be disabled.**
The desktop's **Settings → General** switch controls its startup update check.
It does not control missing embedding-model or toolchain downloads, connectors,
or other configured network activity. It is not a global offline switch.

**9. Defaults are documented.**
Shell execution, the notebook, recall injection, and public-host web access are
enabled by default. See [CONFIGURATION.md](docs/CONFIGURATION.md) for their
individual controls. No single switch disables every process or network path.

**10. Measured results should be distinguishable from estimates.**
This is a presentation requirement, not a guarantee that every existing number
meets it. The September 6 audit found simulated loading phases and mismatched
GPU-control units. Model fit scores are estimates, not measured inference speed.

## What we do not promise

This half of the page matters as much as the other half.

- **The agent can run commands on your computer out of the box.** That is how
  it does real work. File tools have root and protected-path checks, with a
  scratch exception; these do not sandbox programs the agent starts. Processes
  run with your permissions. `CINDERPAW_ENABLE_SHELL_EXEC=false` unregisters
  that tool, not every process-capable tool. Audit writes are best-effort and
  can fail; the log is not proof that every action was captured.
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
- **Look at the privacy page in the app**: **Settings → Privacy** summarizes
  local storage and online features.
- **Cut the network.** Turn off your wifi, load a local model, and keep
  using local inference. Features that require external services will be unavailable.
- **Read the log.** It records audited operations; write failures can leave gaps.

## If we break one

- Something normal: [open an issue](https://github.com/bloom500/cinderpaw/issues).
- Something dangerous: read [SECURITY.md](SECURITY.md) and email us privately
  instead of posting it.
