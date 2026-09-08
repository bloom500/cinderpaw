# Third-party notices

Cinderpaw is split-licensed per directory (see `LICENSE`): the agent runtime
is Apache-2.0, the app and adaptive core are BSL 1.1. This file records third-party
work Cinderpaw builds on, and the notices that work requires.

It covers two things: designs we derived from, and source we copied into this
tree. Package-manager dependencies are not listed here — with ONE exception
below. Those ship with their
own licenses and are resolved at install time; this file is for work that would
otherwise look like ours.

---

## Prime Agent / pi — the notebook design

**Used in:** `CinderpawAgent/src/rlm/`

Cinderpaw's persistent notebook (`src/rlm/repl.ts`) and the doctrine the model is
given about it (`src/rlm/prompt.ts`) are derived from the **RLM (Recursive
Language Model)** design in Prime Agent, specifically `packages/coding-agent/src/core/prompts/rlm.ts`
and `packages/coding-agent/src/core/rlm-runtime.ts`, read at commit `965941c`.

- Prime Agent: https://github.com/PrimeIntellect-ai/prime-agent
- Upstream framework (`pi-mono`): https://github.com/badlogic/pi-mono
- RLM concept: https://www.primeintellect.ai/blog/rlm

**What is derived:** the idea of giving an agent a long-lived interpreter rather
than a one-tool-per-turn loop, and the structure of the doctrine that makes it
work — bind results to variables, do not treat the interpreter as the native
environment of the system under study, be explicit about which state survives
between cells.

**What is not:** no source file is copied. Their interpreter is IPython, driven
over a Python kernel; ours is a `node:vm` JavaScript context, because the
sidecar already runs on Bun. The Python-specific doctrine (`%%bash` cells,
`%cd`, `os.environ`, pre-imported skill modules, subshell state warnings) has no
analogue here and was rewritten rather than translated. Recursive subagent
spawning (`rlm()`) is not implemented.

The upstream work is MIT licensed. Its notice follows in full.

```
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## OpenClaw - tool-call repair scanner

**Copied verbatim into:** `CinderpawAgent/src/vendor/tool-call-repair/grammar.ts`,
`CinderpawAgent/src/vendor/tool-call-repair/payload.ts`

- **Source:** https://github.com/openclaw/openclaw
  (`packages/tool-call-repair/src/`)
- **License:** MIT, full text in
  `CinderpawAgent/src/vendor/tool-call-repair/LICENSE`
- **Copyright:** Copyright (c) 2026 OpenClaw Foundation
- **Modifications:** one import specifier changed from `./grammar.js` to
  `./grammar.ts` to match our module resolver. Otherwise verbatim.

Used to recover tool calls emitted in formats other than the one we ask models
for. See `CinderpawAgent/src/vendor/tool-call-repair/README.md` for what it
covers, what it does not, and why the rest of that package was left behind.

---

## libsignal — bundled into the sidecar binary (exception to the rule above)

**Embedded in:** every shipped sidecar binary (`dist/`, npm platform
packages, Tauri bundle) via the WhatsApp transport:
`CinderpawAgent/src/transports/connectors.ts` statically imports
`@whiskeysockets/baileys`, which statically imports `libsignal`
(`Utils/crypto.js`: `import * as curve from 'libsignal/src/curve.js'`), so
`bun build --compile` bakes it in. Verified 2026-09-08 against
`libsignal@6.0.0` in `CinderpawAgent/node_modules`.

- **Source:** https://github.com/signalapp/libsignal
- **License:** GPL-3.0. The combined binary is therefore GPL-covered for
  the libsignal portion: redistributing the binary requires the GPL-3.0
  notices, which this entry provides, and source availability, which this
  repo (plus the dependency's own published source) satisfies. The
  Apache-2.0 CinderpawAgent *source files* remain Apache-2.0; copyleft
  attaches to the compiled combination, not to the sources.
- **Consequence for the split:** the Apache-licensed `transports/` sources
  cannot be distributed *in binary form together with the WhatsApp path*
  under Apache-only terms. Removing or externalising that transport is
  tracked work, not part of this commit.
