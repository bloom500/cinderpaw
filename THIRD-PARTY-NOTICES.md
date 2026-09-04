# Third-party notices

Cinderpaw is licensed under BUSL-1.1 (see `LICENSE`). This file records third-party
work Cinderpaw builds on, and the notices that work requires.

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
