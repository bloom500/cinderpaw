import { describe, expect, it } from 'vitest';
import { finishActivity, startActivity } from '@/hooks/useLiveToolActivity';
import { writtenFiles } from '../WrittenFiles';

// 31 Oct: a CSV saved to Documents showed only as a path inside the reply.
describe('writtenFiles', () => {
  const wrote = (path: string, extra: Record<string, unknown> = {}) =>
    finishActivity(startActivity('write_file', { path }), { ok: true, data: { path, bytes: 10, ...extra } });

  it('lists each file the reply wrote once, and skips reads, failures and scratch notes', () => {
    const csv = 'C:\\Users\\d\\Documents\\orase.csv';
    const activity = [
      wrote(csv),
      wrote(csv),
      wrote('C:\\Users\\d\\.cinderpaw\\scratch\\notes.md', { scratch: true }),
      finishActivity(startActivity('read_file', { path: 'a.txt' }), { ok: true, data: { path: 'a.txt', lines: 1, bytes: 1 } }),
      finishActivity(startActivity('write_file', { path: 'b.txt' }), { ok: false, error: 'denied' }),
    ];
    expect(writtenFiles(activity)).toEqual([csv]);
  });
});
