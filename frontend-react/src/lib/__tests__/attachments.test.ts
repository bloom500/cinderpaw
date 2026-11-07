import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  convertFileSrc: (p: string) => `http://asset.localhost/${encodeURIComponent(p)}`,
}));

import { attachmentFromDomFile, attachmentFromPath } from '../attachments';

// Braces: a function returned from beforeEach runs after the test, and mockReset returns the mock.
beforeEach(() => { invoke.mockReset(); });

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

  // 29 Oct 2026: a 45 MB video dragged from Explorer was read whole as text and
  // sent to Rust as 45 million numbers; the app froze and only its name was left.
  it('a dropped video is copied to a temp file, plays from it, and is never read as text', async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === 'stage_pasted_file' ? 'C:/Temp/cinderpaw-attachments/x-night.mp4' : undefined));
    const video = new File([new Uint8Array(8)], 'night.mp4', { type: 'video/mp4' });
    const text = vi.spyOn(video, 'text');
    const a = await attachmentFromDomFile(video);
    expect(text).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('stage_pasted_file', { data: expect.any(String), name: 'night.mp4' });
    expect(invoke).toHaveBeenCalledWith('allow_video_preview', { path: 'C:/Temp/cinderpaw-attachments/x-night.mp4' });
    expect(a).toMatchObject({ name: 'night.mp4', kind: 'binary', path: 'C:/Temp/cinderpaw-attachments/x-night.mp4', videoUrl: expect.stringContaining('asset.localhost') });
  });

  it('a dropped video still shows when the copy fails', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:video');
    invoke.mockRejectedValue('disk full');
    const a = await attachmentFromDomFile(new File([new Uint8Array(8)], 'night.mp4', { type: 'video/mp4' }));
    expect(a).toMatchObject({ kind: 'binary', videoUrl: 'blob:video' });
  });

  it('a big file that is not a document is copied for the agent, never read as text', async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === 'stage_pasted_file' ? 'C:/Temp/x-game.zip' : Promise.reject('binary: no text')));
    const big = new File([new Uint8Array(3 * 1024 * 1024)], 'game.zip', { type: 'application/zip' });
    const text = vi.spyOn(big, 'text');
    const a = await attachmentFromDomFile(big);
    expect(a).toMatchObject({ name: 'game.zip', kind: 'binary', path: 'C:/Temp/x-game.zip' });
    expect(text).not.toHaveBeenCalled();
  });

  it('plain text is still read on the spot, with no trip to disk', async () => {
    const a = await attachmentFromDomFile(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    expect(a.content).toBe('hello');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('a picked or dropped video', () => {
  it('gets a first-frame preview and is never read as text', async () => {
    invoke.mockResolvedValue(undefined);
    const a = await attachmentFromPath('C:/Users/x/Desktop/demo.MP4');
    expect(invoke).toHaveBeenCalledWith('allow_video_preview', { path: 'C:/Users/x/Desktop/demo.MP4' });
    expect(invoke).not.toHaveBeenCalledWith('extract_file_text', expect.anything());
    expect(a).toMatchObject({ name: 'demo.MP4', kind: 'binary', content: null, videoUrl: expect.stringContaining('asset.localhost') });
  });

  it('still attaches by path when the preview is refused', async () => {
    invoke.mockRejectedValue('Access denied');
    const a = await attachmentFromPath('C:/Users/x/demo.webm');
    expect(a).toMatchObject({ kind: 'binary', path: 'C:/Users/x/demo.webm' });
    expect(a.videoUrl).toBeUndefined();
  });
});

describe('a sent message read back', () => {
  it('keeps the path of a binary file, so a video can play in the bubble', async () => {
    const { parseUserAttachments } = await import('../attachmentDisplay');
    const { buildUserContent } = await import('@/hooks/useSendMessage');
    const sent = buildUserContent('look', [{ name: 'night.mp4', path: 'C:/v/night (2).mp4', content: null, kind: 'binary' }]);
    expect(parseUserAttachments(sent)).toEqual({ text: 'look', attachments: [{ name: 'night.mp4', kind: 'binary', path: 'C:/v/night (2).mp4' }] });
  });
});
