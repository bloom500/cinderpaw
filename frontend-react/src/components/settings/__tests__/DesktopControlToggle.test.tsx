import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

let desktopOn = false;
vi.mock('@/stores/settings', () => ({
  useSettings: (sel: (s: unknown) => unknown) =>
    sel({
      settings: { desktop_control_enabled: desktopOn, desktop_control_yolo: false },
      setDesktopControl: vi.fn(async () => {}),
      setDesktopControlYolo: vi.fn(async () => {}),
    }),
}));

import { DesktopControlToggle } from '../AgentSettingsTab';

const realAgent = navigator.userAgent;
function onSystem(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => ua });
}

afterEach(() => {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => realAgent });
  desktopOn = false;
});

describe('the desktop control switch', () => {
  it('on Windows it can be turned on', () => {
    onSystem('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    render(<DesktopControlToggle />);
    expect(screen.getByRole('switch', { name: 'Enable desktop control' })).toBeEnabled();
    expect(screen.queryByText(/Windows only/)).toBeNull();
  });

  it('elsewhere it says Windows only and cannot be turned on', () => {
    onSystem('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)');
    render(<DesktopControlToggle />);
    expect(screen.getByRole('switch', { name: 'Enable desktop control' })).toBeDisabled();
    expect(screen.getByText(/Windows only for now/)).toBeInTheDocument();
  });

  it('elsewhere, one left on by an earlier build can still be turned off', () => {
    onSystem('Mozilla/5.0 (X11; Linux x86_64)');
    desktopOn = true;
    render(<DesktopControlToggle />);
    expect(screen.getByRole('switch', { name: 'Enable desktop control' })).toBeEnabled();
  });
});
