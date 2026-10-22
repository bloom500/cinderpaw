import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ListenButton } from '../ListenButton';
import { cubbyVoiceUrl } from '@/voice/cubbyVoice';
import { useAudioPlayer } from '@/hooks/useAudioPlayer';

vi.mock('@/voice/cubbyVoice', () => ({ cubbyVoiceUrl: vi.fn() }));
vi.mock('@/hooks/useAudioPlayer', () => ({ useAudioPlayer: vi.fn() }));

const toggle = vi.fn();
const player = (over: Partial<ReturnType<typeof useAudioPlayer>> = {}) =>
  vi.mocked(useAudioPlayer).mockReturnValue({ playing: false, progress: 0, toggle, error: null, ...over });

beforeEach(() => {
  vi.mocked(cubbyVoiceUrl).mockReset();
  toggle.mockReset();
  player();
});

describe('ListenButton', () => {
  it('shows nothing when the line has no current audio', () => {
    vi.mocked(cubbyVoiceUrl).mockReturnValue(null);
    const { container } = render(<ListenButton line="onboarding.welcome" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('plays on click, and is a real, named, focusable button', () => {
    vi.mocked(cubbyVoiceUrl).mockReturnValue('/a.mp3');
    render(<ListenButton line="onboarding.welcome" />);
    const btn = screen.getByRole('button', { name: 'Listen to Cubby' });
    btn.focus();
    expect(btn).toHaveFocus();
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(btn);
    expect(toggle).toHaveBeenCalledOnce();
    expect(vi.mocked(useAudioPlayer)).toHaveBeenCalledWith('/a.mp3');
  });

  it('turns into Stop while Cubby talks', () => {
    vi.mocked(cubbyVoiceUrl).mockReturnValue('/a.mp3');
    player({ playing: true });
    render(<ListenButton line="onboarding.welcome" />);
    expect(screen.getByRole('button', { name: 'Stop' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('says so on screen when the sound cannot play', () => {
    vi.mocked(cubbyVoiceUrl).mockReturnValue('/a.mp3');
    player({ error: 'EncodingError: Unable to decode audio data' });
    render(<ListenButton line="onboarding.welcome" />);
    expect(screen.getByText("Sound can't play on this computer.")).toBeInTheDocument();
  });
});

describe('leaving the step', () => {
  it('stops the sound when the button goes away', async () => {
    const { useAudioPlayer: realHook } = await vi.importActual<typeof import('@/hooks/useAudioPlayer')>('@/hooks/useAudioPlayer');
    vi.mocked(useAudioPlayer).mockImplementation(realHook);
    vi.mocked(cubbyVoiceUrl).mockReturnValue('/a.mp3');

    const stop = vi.fn();
    const close = vi.fn(async () => {});
    const node = { buffer: null, connect: vi.fn(), start: vi.fn(), stop, onended: null };
    class FakeCtx {
      state = 'running';
      currentTime = 0;
      destination = {};
      createBufferSource = () => node;
      decodeAudioData = async () => ({ duration: 3 });
      resume = async () => {};
      close = close;
    }
    vi.stubGlobal('AudioContext', FakeCtx);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))));
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const { unmount } = render(<ListenButton line="onboarding.welcome" />);
    fireEvent.click(screen.getByRole('button', { name: 'Listen to Cubby' }));
    await screen.findByRole('button', { name: 'Stop' });
    unmount();
    expect(stop).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
