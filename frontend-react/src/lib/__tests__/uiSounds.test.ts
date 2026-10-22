import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { playUiSound, stopUiSound, unlockUiSounds, holdUiSounds, UI_SOUNDS } from '../uiSounds';
import { useSoundSettings } from '@/stores/sounds';

const started = vi.fn();
const stopped = vi.fn();
class TestAudioContext {
  state = 'running';
  destination = {};
  resume = vi.fn(async () => { this.state = 'running'; });
  decodeAudioData = vi.fn(async () => ({ duration: 0.1 }));
  createGain = () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() });
  createBufferSource = () => ({ buffer: null, onended: null, connect: vi.fn(), disconnect: vi.fn(), start: started, stop: stopped });
}

describe('UI sound playback', () => {
  beforeEach(() => {
    vi.stubGlobal('AudioContext', TestAudioContext);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })));
    useSoundSettings.setState({ enabled: true, volume: 0.35 });
    stopUiSound();
    vi.clearAllMocks();
  });
  afterEach(() => { stopUiSound(); vi.unstubAllGlobals(); });

  it('ships all thirteen cues with bundled URLs', () => {
    expect(UI_SOUNDS).toHaveLength(13);
    expect(UI_SOUNDS.every((s) => s.url.endsWith('.wav'))).toBe(true);
  });
  it('does not create audio until an interaction unlocks it', async () => {
    expect(await playUiSound('tap')).toBe(false);
    expect(started).not.toHaveBeenCalled();
    unlockUiSounds();
    expect(await playUiSound('tap')).toBe(true);
    expect(started).toHaveBeenCalledOnce();
  });
  it('mute and zero volume silence events, while explicit audition works when muted', async () => {
    unlockUiSounds();
    useSoundSettings.setState({ enabled: false });
    expect(await playUiSound('toggle-on')).toBe(false);
    expect(await playUiSound('toggle-on', true)).toBe(true);
    stopUiSound();
    useSoundSettings.setState({ enabled: true, volume: 0 });
    expect(await playUiSound('toggle-on', true)).toBe(false);
  });
  it('suspends effects during spoken playback and restores them afterwards', async () => {
    unlockUiSounds();
    const release = holdUiSounds();
    expect(await playUiSound('notification')).toBe(false);
    release();
    expect(await playUiSound('notification')).toBe(true);
  });
  it('keeps effects out of the voice call overlay', async () => {
    unlockUiSounds();
    const call = document.createElement('div');
    call.setAttribute('data-call-overlay', '');
    document.body.append(call);
    expect(await playUiSound('error')).toBe(false);
    call.remove();
    expect(await playUiSound('error')).toBe(true);
  });
  it('keeps a completion audible when a decorative click arrives', async () => {
    unlockUiSounds();
    expect(await playUiSound('task-done')).toBe(true);
    expect(await playUiSound('tap')).toBe(false);
    expect(started).toHaveBeenCalledOnce();
  });
  it('cancels a pending decode when muted before playback can start', async () => {
    unlockUiSounds();
    const playing = playUiSound('audio-logo', true);
    stopUiSound();
    expect(await playing).toBe(false);
    expect(started).not.toHaveBeenCalled();
  });
});
