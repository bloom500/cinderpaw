import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CallPill } from '../CallPill';
import type { CallPillState } from '@/lib/callPill';

const emit = vi.fn().mockResolvedValue(undefined);
let push: ((e: { payload: CallPillState }) => void) | null = null;
vi.mock('@tauri-apps/api/event', () => ({
  emit: (...a: unknown[]) => emit(...a),
  listen: vi.fn((_: string, cb: (e: { payload: CallPillState }) => void) => {
    push = cb;
    return Promise.resolve(() => {});
  }),
}));

const state = (over: Partial<CallPillState> = {}): CallPillState => ({
  phase: 'listening', heard: '', said: '', muted: false, canMute: true, ask: null, working: null, ...over,
});

describe('CallPill', () => {
  beforeEach(() => { emit.mockClear(); push = null; });

  it('asks for the state on mount, then shows the transcript it is sent', () => {
    render(<CallPill />);
    expect(emit).toHaveBeenCalledWith('call-pill://hello');
    act(() => push?.({ payload: state({ heard: 'open the calendar' }) }));
    expect(screen.getByText('open the calendar')).toBeInTheDocument();
    act(() => push?.({ payload: state({ phase: 'speaking', said: 'Opening it now.' }) }));
    expect(screen.getByText('Opening it now.')).toBeInTheDocument();
    expect(screen.getByText('Cinder is speaking')).toBeInTheDocument();
  });

  it('every control is an event to the main window', () => {
    render(<CallPill />);
    act(() => push?.({ payload: state({ phase: 'speaking' }) }));
    fireEvent.click(screen.getByLabelText('Mute microphone'));
    expect(emit).toHaveBeenCalledWith('call-pill://mute', { muted: true });
    fireEvent.click(screen.getByLabelText('Stop the answer'));
    expect(emit).toHaveBeenCalledWith('call-pill://interrupt');
    fireEvent.click(screen.getByLabelText('End call'));
    expect(emit).toHaveBeenCalledWith('call-pill://end');
    fireEvent.click(screen.getByRole('status'));
    expect(emit).toHaveBeenCalledWith('call-pill://open');
  });

  it('names the tool at work while a call is parked, and gives way to Cinder speaking', () => {
    render(<CallPill />);
    act(() => push?.({ payload: state({ said: 'One moment.', working: 'weather in Cluj' }) }));
    expect(screen.getByText('Working')).toBeInTheDocument();
    expect(screen.getByText('weather in Cluj')).toBeInTheDocument();
    act(() => push?.({ payload: state({ phase: 'speaking', said: 'It is sunny.', working: 'weather in Cluj' }) }));
    expect(screen.getByText('Cinder is speaking')).toBeInTheDocument();
    expect(screen.getByText('It is sunny.')).toBeInTheDocument();
    act(() => push?.({ payload: state({ said: 'It is sunny.' }) }));
    expect(screen.getByText('Listening')).toBeInTheDocument();
  });

  it('says why mute is unavailable instead of going quiet', () => {
    render(<CallPill />);
    act(() => push?.({ payload: state({ canMute: false }) }));
    const mute = screen.getByLabelText('Mute microphone');
    expect(mute).toBeDisabled();
    expect(mute).toHaveAttribute('title', 'This call engine has no microphone switch');
  });
});
