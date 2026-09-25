export const SAMPLE = `## Plan for the migration

Here is what I found after reading \`src/stores/chat.ts\` and the three hooks that feed it. The short version: the store is fine, the **render path** is not.

1. Tokens arrive one by one from the sidecar.
2. Each token rebuilds the last message object.
3. The whole message is parsed again as Markdown.

- First, a bullet with \`inline code\` and a [link](https://example.com).
- Second bullet, a little longer, so that it wraps on a narrow window and shows how the prose flows.
  - A nested bullet under the second one.
- Third bullet.

| Step | Cost per token | Notes |
|------|----------------|-------|
| Parse | O(n) | whole message |
| Highlight | O(code) | every block |
| Word fade | O(words) | every word |

\`\`\`ts
export function joinSegments(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;

  // Two segments meet at a blank line, never mid-sentence.
  return \`\${a.trimEnd()}\\n\\n\${b.trimStart()}\`;
}
\`\`\`

> A quote from the design notes: the transcript must never jump while the person is reading it.
> It follows the bottom only while they are at the bottom.

\`\`\`mermaid
flowchart LR
  A[Sidecar] --> B[Tauri event]
  B --> C[Store]
  C --> D[React render]
\`\`\`

### Numbers

The measured cost was **38 ms** per token on a long reply, which at 60 tokens per second is more than two full frames of work per second of reading. With blocks that are already complete rendered once and kept, only the paragraph that is still arriving is parsed again.

\`\`\`python
def throttle(fn, ms):
    last = 0
    def inner(*a):
        nonlocal last
        now = time.monotonic() * 1000
        if now - last >= ms:
            last = now
            return fn(*a)
    return inner
\`\`\`

That is all for now. Next I will measure the scroll follow and the window that opens late.
`;
