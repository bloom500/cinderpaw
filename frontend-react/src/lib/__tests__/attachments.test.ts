import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { attachmentFromDomFile } from '../attachments';

beforeEach(() => invoke.mockReset());

describe('a pasted or browser-dropped file', () => {
  // 6 Oct 2026: a pasted CV reached the agent as "binary, no extractable text".
  it('a PDF goes through the same text extractor as a picked file', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'stage_pasted_file' ? 'C:/Temp/cinderpaw-attachments/x-CV.pdf' : 'DARIUS RETEGHI\nAI Workflow Automation');
    const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff])], 'CV.pdf', { type: 'application/pdf' });

    const a = await attachmentFromDomFile(pdf);

    expect(invoke).toHaveBeenCalledWith('stage_pasted_file', expect.objectContaining({ name: 'CV.pdf' }));
    expect(invoke).toHaveBeenCalledWith('extract_file_text', { path: 'C:/Temp/cinderpaw-attachments/x-CV.pdf' });
    expect(a).toMatchObject({ name: 'CV.pdf', path: 'C:/Temp/cinderpaw-attachments/x-CV.pdf', content: expect.stringContaining('DARIUS') });
  });

  it('plain text is still read on the spot, with no trip to disk', async () => {
    const a = await attachmentFromDomFile(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    expect(a.content).toBe('hello');
    expect(invoke).not.toHaveBeenCalled();
  });
});
