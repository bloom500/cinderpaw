import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null), convertFileSrc: (p: string) => p }));

const { repeatsLastSegment } = await import('../useCinderpaw');

describe('a status line said twice before two tools', () => {
  it('is kept once; a new sentence or a sentence said earlier is not dropped', () => {
    // 27 Oct, a real reply: the same sentence before read_skill and before ask_user.
    const said = 'Am înțeles - pregătesc postarea cu videoul.';
    expect(repeatsLastSegment(said, `${said}\n`)).toBe(true);
    expect(repeatsLastSegment(`Pornesc.\n\n${said}`, said)).toBe(true);
    expect(repeatsLastSegment(said, 'Deschid compunerea.')).toBe(false);
    expect(repeatsLastSegment(`${said}\n\nDeschid compunerea.`, said)).toBe(false);
    expect(repeatsLastSegment('', said)).toBe(false);
  });
});
