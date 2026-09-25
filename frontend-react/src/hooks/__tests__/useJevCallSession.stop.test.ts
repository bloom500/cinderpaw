import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { decide, stopCinder, stopSpeech } = vi.hoisted(() => ({
  decide: vi.fn(),
  stopCinder: vi.fn(async (_sid: string) => {}),
  stopSpeech: vi.fn(),
}));

vi.mock('../useSpeechPlayer', () => ({
  useSpeechPlayer: () => ({ beginSpeech: vi.fn(async () => {}), feedSpeech: vi.fn(), endSpeech: vi.fn(async () => {}), stop: stopSpeech }),
}));
vi.mock('@/lib/audio', () => ({ chime: vi.fn() }));
vi.mock('@/lib/cinderpawAgentStream', () => ({ requestCinderpawStop: (sid: string) => stopCinder(sid) }));
vi.mock('@/lib/jev', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/jev')>()),
  decide: (text: string) => decide(text),
}));

import { useJevCallSession } from '../useJevCallSession';

/** What Jev answers for each sentence of these tests. */
function plans(byText: Record<string, string>) {
  decide.mockImplementation(async (text: string) => ({
    plan: { action: byText[text] ?? 'none', confidence: 0.95 },
    ms: 1, compound: false, compoundScore: 0, addressed: true, desktop: false,
  }));
}

beforeEach(() => {
  decide.mockReset();
  stopCinder.mockClear();
  stopSpeech.mockClear();
});

describe('"stop" on a Jev call is the brake on Cinder, never the hang-up', () => {
  it('with Cinder idle it says so, and the call goes on', async () => {
    plans({ stop: 'stop' });
    const { result } = renderHook(() => useJevCallSession(async () => {}));
    await act(async () => { result.current.say('stop'); await new Promise((r) => setTimeout(r, 0)); });
    expect(result.current.said).toBe('Cinder is not working on anything.');
    expect(stopSpeech).not.toHaveBeenCalled();
    expect(stopCinder).not.toHaveBeenCalled();
  });

  it('with Cinder working it stops Cinder, and the call goes on', async () => {
    plans({ 'summarise this page': 'none', stop: 'stop' });
    let finish: () => void = () => {};
    const handed = new Promise<void>((r) => { finish = r; });
    const { result } = renderHook(() => useJevCallSession(() => handed));
    await act(async () => { result.current.say('summarise this page'); await new Promise((r) => setTimeout(r, 0)); });
    expect(result.current.said).toBe('Cinder is on it.');
    await act(async () => { result.current.say('stop'); await new Promise((r) => setTimeout(r, 0)); });
    expect(stopCinder).toHaveBeenCalledTimes(1);
    expect(result.current.said).toBe('Stopped Cinder.');
    expect(stopSpeech).not.toHaveBeenCalled();
    await act(async () => { finish(); await new Promise((r) => setTimeout(r, 0)); });
  });

  it('"hang up" ends the call', async () => {
    plans({ 'hang up': 'hang_up' });
    const { result } = renderHook(() => useJevCallSession(async () => {}));
    await act(async () => { result.current.say('hang up'); await new Promise((r) => setTimeout(r, 0)); });
    expect(stopSpeech).toHaveBeenCalled();
    expect(result.current.phase).toBe('idle');
    expect(stopCinder).not.toHaveBeenCalled();
  });
});
