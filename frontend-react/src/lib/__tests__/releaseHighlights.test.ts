import { describe, it, expect } from 'vitest';
import { releaseHighlights } from '../releaseHighlights';

const NOTES = `> Version numbers in the build now read \`2026.09.18\`.

### Added

**Getting started**
- **Sign in with OpenRouter** instead of pasting a key: one button.
- On a small machine, setup recommends a cloud model first.

**The chat**
- A built-in **browser** beside the chat, with tabs.
- **Artifacts**: documents, PDFs and small apps.
- Delete a chat with **Undo** instead of "Are you sure?".`;

describe('releaseHighlights', () => {
  it("takes each bullet's first bold phrase, skipping headings and quotes", () => {
    expect(releaseHighlights(NOTES)).toEqual(['Sign in with OpenRouter', 'browser', 'Artifacts']);
  });

  it('is empty for no notes or notes with no bold bullets', () => {
    expect(releaseHighlights(null)).toEqual([]);
    expect(releaseHighlights('Bug fixes.')).toEqual([]);
  });
});
