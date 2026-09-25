# Third-party notices

Cinderpaw is licensed under Apache-2.0 (see `LICENSE`). This file records third-party
work Cinderpaw builds on, and the notices that work requires.

It covers three things: designs we derived from, source we copied into this
tree, and the few package-manager dependencies whose licence asks for something
a lockfile cannot deliver.

Ordinary dependencies are not listed individually. **That is a judgement, not a
rule, and it is weaker for a binary than it looks here:** someone who installs
the `.exe` or the `.dmg` gets no Cargo registry and no `node_modules`, so "their
licence ships with them" is only true of a source checkout. Several permissive
licences require their notice to accompany a *binary* distribution. Closing that
properly means generating a full notice file at build time; until that exists,
this file carries the cases where the obligation is explicit.

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

## Apache ECharts — the charts inside `app` artifacts

**Copied verbatim into:** `CinderpawAgent/src/artifacts/vendor/echarts.min.js`

- **Source:** https://github.com/apache/echarts (v5.6.0, the published
  `dist/echarts.min.js`)
- **License:** Apache-2.0, full text in
  `CinderpawAgent/src/artifacts/vendor/LICENSE`
- **Copyright:** The Apache Software Foundation
- **Modifications:** none. Byte-for-byte the published bundle: 1,034,102 bytes,
  sha256 starting `bf4a2235`. `.gitattributes` marks it `-text` so line-ending
  normalisation cannot quietly make that sentence false.

Vendored rather than loaded from a CDN, and that is a product decision, not a
packaging one. An artifact that fetches its chart library at open time does not
work on a plane, and it tells a third party which of their own documents the
user just opened. The file is inlined into an exported `app` artifact at export
time, so the exported .html runs offline in any browser with nothing else
installed. Upgrading this file upgrades every artifact ever exported after it.

It is NOT in the desktop bundle: the React app never imports it, so the 1 MB is
paid once inside an exported file, by the people who asked for a chart.

---

## Noto Sans — the letters inside a PDF artifact

**Copied verbatim into:** `CinderpawAgent/src/artifacts/vendor/fonts/NotoSans-Regular.ttf`
and `NotoSans-Bold.ttf`

- **Source:** Google Fonts' static builds of Noto Sans v42 (weights 400 and 700)
- **License:** SIL Open Font License 1.1, full text in
  `CinderpawAgent/src/artifacts/vendor/fonts/OFL.txt`
- **Copyright:** The Noto Project Authors
- **Modifications:** none. Regular 556,328 bytes (sha256 starting `5be701a9`), Bold
  558,012 bytes (sha256 starting `9f0ce911`).

Bundled because the 14 standard PDF fonts only cover Windows-1252: without an
embedded font, the first PDF anyone makes in Romanian either fails or prints
boxes where "ă", "ș" and "ț" should be. It is embedded into each generated PDF as
a subset, which the OFL permits; the font is never sold on its own.

It IS in the sidecar binary (about 1.1 MB), which is why the licence file sits
beside it rather than only in this note.

---

## grapheme_to_phoneme and arpabet — pronouncing words the dictionary lacks

**Used in:** `crates/cinderpaw-core/src/tts/g2p.rs` (the `kokoro` feature)

Both are by Brandon Thomas and both are **BSD-4-Clause**. They replace
espeak-ng, which is GPLv3, as the source of pronunciations for words no
dictionary contains — the reason Kokoro can be shipped in an Apache-2.0 binary at
all.

They are listed here, unlike other Cargo dependencies, because BSD-4-Clause's
third clause is an obligation that no lockfile discharges:

> 3. All advertising materials mentioning features or use of this software must
>    display the following acknowledgement:
>
>    This product includes software developed by Brandon Thomas
>    (bt@brand.io, echelon@gmail.com).

**This binds marketing, not just the repository.** Any advertising material that
mentions Cinderpaw's on-device voice must carry that acknowledgement.

- https://github.com/echelon/grapheme_to_phoneme.rs
- https://crates.io/crates/arpabet

The notice follows in full.

```
Copyright (c) 2020, Brandon Thomas. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.

3. All advertising materials mentioning features or use of this software
   must display the following acknowledgement:

   This product includes software developed by Brandon Thomas
   (bt@brand.io, echelon@gmail.com).

4. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY COPYRIGHT HOLDER "AS IS" AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL COPYRIGHT HOLDER BE LIABLE FOR ANY DIRECT,
INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT,
STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN
ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

---

## Vulkan Loader — `vulkan-1.dll` in the Windows installer

- **What it is:** the Khronos/LunarG Vulkan loader, shipped next to
  `cinderpaw.exe` so the app starts on a Windows that has no GPU driver (and
  so no loader of its own). With no driver behind it the loader reports no
  devices and inference runs on the CPU.
- **Source:** https://github.com/KhronosGroup/Vulkan-Loader, the runtime
  build installed by the LunarG SDK on the release runner.
- **License:** Apache-2.0.
- **Copyright:** The Khronos Group Inc. and the Vulkan-Loader contributors.
- **Modifications:** none.

## The dependency tree, and one licence that does not fit

**Inventory:** `audit-out/openclaw-dependency-licences.md`, regenerated by
`python scripts/openclaw/license-inventory.py`. It reads the `_deps` blocks of
`scripts/openclaw/openclaw-channels.json` (the 21 OpenClaw connectors we may
still import), our own `CinderpawAgent/package.json`, and the packages actually
installed under `CinderpawAgent/node_modules`.

The 43 direct dependencies of the 21 connectors are all permissive: MIT,
Apache-2.0, and `nostr-tools`, which is Unlicense. None of them constrains which
connector we import next.

The transitive tree is a different answer, and it is the one that counts here.
Cinderpaw does not ship a `node_modules`. `bun build --compile` links the whole
tree into one executable, so every dependency is inside the binary a stranger
downloads.

**`libsignal` 6.0.0 is GPL-3.0.** It arrives through
`@whiskeysockets/baileys`, which `CinderpawAgent/src/transports/connectors.ts`
imports at the top level for the WhatsApp transport. That is not a theory about
the package graph: bundling `src/index.ts` inlines
`node_modules/libsignal/src/*.js` into the output, `SessionCipher`, `curve.js`
and all. Verify it in one command:

    cd CinderpawAgent && bun build src/index.ts --target=bun --outfile /tmp/probe.js
    grep -c "node_modules/libsignal" /tmp/probe.js     # expect: not zero

Cinderpaw is Apache-2.0, and the move from BSL 1.1 does not settle this. Apache-2.0
is one-way compatible with GPL-3.0: our code may be taken INTO a GPL-3.0 work,
but a GPL-3.0 dependency linked into our binary makes the combined work GPL-3.0,
which would put every downstream user of Cinderpaw under the GPL whether they
wanted it or not. It blocks release while WhatsApp is compiled in. The ways out are a product decision, not a packaging one: drop the
WhatsApp transport, move it behind a separate process the user installs and runs
themselves, or replace `baileys` with a client that does not carry libsignal.

**Decided 25 Sep 2026: downloaded on the person's request, never shipped.** Nothing
we distribute contains Baileys or libsignal. When someone turns WhatsApp on, the
agent asks first ("WhatsApp needs a one-time download"), and on yes the engine
fetches `@whiskeysockets/baileys@7.0.0-rc13` from the npm registry into
`~/.cinderpaw/whatsapp/`, pinned by the lockfile in
`CinderpawAgent/src/transports/whatsapp/bun.lock`, and packs it into
`whatsapp.js` there (`CinderpawAgent/src/transports/whatsapp-install.ts`). This
is how OpenClaw (MIT) ships WhatsApp too: their main package excludes
`dist/extensions/whatsapp/**`, and `@openclaw/whatsapp` is installed from npm
on request. The combination exists only on the person's own machine, which the
GPL does not restrict; we distribute only our own code. This is the widely held
reading, not legal advice: have it checked before relying on it commercially.

The same import drags in a second one. `sharp` is a peer dependency of
`baileys`, and bun inlines its JavaScript (`node_modules/sharp/dist/*.mjs`,
Apache-2.0) into the bundle. Its native half is the prebuilt
`@img/sharp-win32-x64`, declared **Apache-2.0 AND LGPL-3.0-or-later** because it
carries libvips. That one is a `.node` binary loaded at runtime rather than
inlined, so it is dynamic linking and the LGPL permits it, but only against its
own conditions: the notice must accompany the distribution and the user must be
able to replace the library. Neither is arranged today. Dropping WhatsApp
removes this question along with the GPL one.

`lightningcss` (MPL-2.0, pulled by `vite`) is build-time only. It is imported
nowhere under `CinderpawAgent/src` and does not appear in the bundle
(`grep -c lightningcss` over the output is 0), so it carries no obligation on
what we ship. Recorded so the next reader does not re-investigate it.

Everything else installed is MIT, Apache-2.0, BSD-3-Clause, ISC, BlueOak-1.0.0
or 0BSD. Their notices still have to accompany the binary, which is the open
obligation the top of this file describes; the inventory is the input to the
generated notice file that will close it.
