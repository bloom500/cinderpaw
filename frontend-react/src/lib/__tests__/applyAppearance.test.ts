import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

import { applyAppearance } from '../cinderpawAgentStream';
import { useUI } from '@/stores/ui';

describe('applyAppearance', () => {
  it('applies what set_appearance checked, and nothing from a refusal', () => {
    useUI.setState({ theme: 'light', chatTextSize: 'default' });
    applyAppearance({ ok: false, content: 'set_appearance: theme must be one of light, dark, system.' });
    expect(useUI.getState().theme).toBe('light');
    applyAppearance({ ok: true, data: { appearance: { theme: 'dark', chatTextSize: 'larger' } } });
    expect(useUI.getState().theme).toBe('dark');
    expect(useUI.getState().chatTextSize).toBe('larger');
  });
});
