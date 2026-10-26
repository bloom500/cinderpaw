import { afterEach, describe, expect, it, vi } from 'vitest';
import { useNotifications } from '../notifications';

afterEach(() => { vi.useRealTimers(); useNotifications.setState({ toasts: [] }); });

describe('toasts', () => {
  it('an ordinary toast clears itself; a scheduled task result stays until closed', () => {
    vi.useFakeTimers();
    useNotifications.getState().push('info', 'Saved');
    useNotifications.getState().push('success', 'Scheduled task: Stretch', 'Stand up.', undefined, { sticky: true });
    vi.advanceTimersByTime(60_000);
    const left = useNotifications.getState().toasts;
    expect(left.map((t) => t.title)).toEqual(['Scheduled task: Stretch']);
    useNotifications.getState().dismiss(left[0]!.id);
    // It plays its way out first, then leaves the list.
    expect(useNotifications.getState().toasts[0]!.exiting).toBe(true);
    vi.advanceTimersByTime(600);
    expect(useNotifications.getState().toasts).toEqual([]);
  });
});
