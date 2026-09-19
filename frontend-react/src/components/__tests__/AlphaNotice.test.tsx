import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AlphaNotice, ALPHA_NOTICE_KEY, alphaNoticeWanted } from '../AlphaNotice';
import { useOnboarding } from '@/stores/onboarding';

vi.mock('@/stores/onboarding', () => ({ useOnboarding: vi.fn() }));

const mount = () => render(<MemoryRouter><AlphaNotice /></MemoryRouter>);

describe('the alpha notice', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(useOnboarding).mockImplementation((sel: any) => sel({ active: false }));
  });

  it('is on screen for a fresh install, with the two ways to help', () => {
    mount();
    expect(screen.getByText('Cinderpaw is in alpha')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Report a bug' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Become a contributor' })).toHaveAttribute('href', expect.stringContaining('github.com'));
  });

  it('the X closes it for this launch only', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText('Cinderpaw is in alpha')).toBeNull();
    expect(alphaNoticeWanted()).toBe(true);
  });

  it('the never-again button is remembered', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: "Don't show this again" }));
    expect(localStorage.getItem(ALPHA_NOTICE_KEY)).toBe('never');
    expect(alphaNoticeWanted()).toBe(false);
    const again = mount();
    expect(again.queryByText('Cinderpaw is in alpha')).toBeNull();
  });

  it('stays out of the way while the setup wizard is up', () => {
    vi.mocked(useOnboarding).mockImplementation((sel: any) => sel({ active: true }));
    mount();
    expect(screen.queryByText('Cinderpaw is in alpha')).toBeNull();
  });
});
