import { describe, it, expect, vi, beforeEach } from 'vitest';

const persistAsync = vi.fn(async () => true);
vi.mock('../onboardingPersistence', () => ({ persistAsync, loadPersistedAsync: vi.fn(async () => null) }));

const { useOnboarding } = await import('../onboarding');

beforeEach(() => persistAsync.mockClear());

describe('saveUserName (Settings > General)', () => {
  it('changes the name and keeps it once onboarding is done', () => {
    useOnboarding.setState({ hasOnboardedBefore: true, completedAt: 5, userName: 'Darius', agentName: 'Cinderpaw' });
    useOnboarding.getState().saveUserName('  Dari  ');
    expect(useOnboarding.getState().userName).toBe('Dari');
    expect(persistAsync).toHaveBeenCalledWith({ completed: true, completedAt: 5, userName: 'Dari', agentName: 'Cinderpaw' });
  });

  it('never writes a completed record before onboarding is done', () => {
    useOnboarding.setState({ hasOnboardedBefore: false, userName: '' });
    useOnboarding.getState().saveUserName('Ana');
    expect(useOnboarding.getState().userName).toBe('Ana');
    expect(persistAsync).not.toHaveBeenCalled();
  });
});
