import { describe, it, expect, vi, beforeEach } from 'vitest';

const sent: Array<{ title: string; body: string }> = [];
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => 'granted',
  sendNotification: (n: { title: string; body: string }) => sent.push(n),
}));

import { notifyIfBackground, preview } from '../systemNotify';

describe('system notifications', () => {
  beforeEach(() => { sent.length = 0; });

  it('stay silent while the window is in the foreground', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    expect(await notifyIfBackground('t', 'b')).toBe(false);
    expect(sent).toEqual([]);
  });

  it('are sent when the window is in the background', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    expect(await notifyIfBackground('Cinderpaw finished', 'done')).toBe(true);
    expect(sent).toEqual([{ title: 'Cinderpaw finished', body: 'done' }]);
  });

  it('preview keeps one plain line, without markdown or code', () => {
    expect(preview('```ts\nx\n```\n\n## **Done**: three _files_ written\nmore')).toBe('Done: three files written');
    expect(preview('a'.repeat(200)).length).toBe(120);
  });
});
