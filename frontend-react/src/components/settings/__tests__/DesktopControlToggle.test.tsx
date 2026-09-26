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

  it('on macOS it can be turned on, and says what works there', () => {
    onSystem('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)');
    render(<DesktopControlToggle />);
    expect(screen.getByRole('switch', { name: 'Enable desktop control' })).toBeEnabled();
    expect(screen.getByText(/Accessibility permission/)).toBeInTheDocument();
    expect(screen.queryByText(/Windows only/)).toBeNull();
  });

  it('on Linux, one that is on can be turned off', () => {
    onSystem('Mozilla/5.0 (X11; Linux x86_64)');
    desktopOn = true;
    render(<DesktopControlToggle />);
    expect(screen.getByRole('switch', { name: 'Enable desktop control' })).toBeEnabled();
  });
});
