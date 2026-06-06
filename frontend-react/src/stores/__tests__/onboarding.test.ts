import { describe, it, expect, beforeEach } from 'vitest';
import { useOnboarding } from '@/stores/onboarding';

const reset = () =>
  useOnboarding.setState({
    active: false,
    step: 0,
    userName: '',
    agentName: 'Feral',
    skipped: false,
    completedAt: null,
    hasOnboardedBefore: false,
  });

describe('useOnboarding', () => {
  beforeEach(reset);

  it('starts inactive with empty user / default agent name', () => {
    const s = useOnboarding.getState();
    expect(s.active).toBe(false);
    expect(s.step).toBe(0);
    expect(s.userName).toBe('');
    expect(s.agentName).toBe('Feral');
  });

  it('start() activates the wizard at step 0', () => {
    useOnboarding.getState().start();
    expect(useOnboarding.getState().active).toBe(true);
    expect(useOnboarding.getState().step).toBe(0);
  });

  it('next() / prev() walk through the steps', () => {
    useOnboarding.getState().start();
    useOnboarding.getState().next();
    expect(useOnboarding.getState().step).toBe(1);
    useOnboarding.getState().next();
    expect(useOnboarding.getState().step).toBe(2);
    useOnboarding.getState().prev();
    expect(useOnboarding.getState().step).toBe(1);
  });

  it('next() clamps to totalSteps - 1', () => {
    useOnboarding.getState().start();
    for (let i = 0; i < 99; i++) useOnboarding.getState().next();
    expect(useOnboarding.getState().step).toBe(useOnboarding.getState().totalSteps - 1);
  });

  it('prev() clamps to 0', () => {
    useOnboarding.getState().start();
    useOnboarding.getState().prev();
    expect(useOnboarding.getState().step).toBe(0);
  });

  it('setUserName trims whitespace', () => {
    useOnboarding.getState().setUserName('  Darius  ');
    expect(useOnboarding.getState().userName).toBe('Darius');
  });

  it('setAgentName falls back to "Feral" on empty input', () => {
    useOnboarding.getState().setAgentName('  Bob  ');
    expect(useOnboarding.getState().agentName).toBe('Bob');
    useOnboarding.getState().setAgentName('');
    expect(useOnboarding.getState().agentName).toBe('Feral');
    useOnboarding.getState().setAgentName('   ');
    expect(useOnboarding.getState().agentName).toBe('Feral');
  });

  it('skip() deactivates and records the dismissal', () => {
    useOnboarding.getState().start();
    useOnboarding.getState().skip();
    const s = useOnboarding.getState();
    expect(s.active).toBe(false);
    expect(s.skipped).toBe(true);
    expect(s.hasOnboardedBefore).toBe(true);
    expect(s.completedAt).toBeGreaterThan(0);
  });

  it('finish() deactivates and records completion (without persisting on test env)', async () => {
    useOnboarding.getState().setUserName('Darius');
    useOnboarding.getState().setAgentName('Bob');
    useOnboarding.getState().start();
    await useOnboarding.getState().finish();
    const s = useOnboarding.getState();
    expect(s.active).toBe(false);
    expect(s.skipped).toBe(false);
    expect(s.hasOnboardedBefore).toBe(true);
    expect(s.userName).toBe('Darius');
    expect(s.agentName).toBe('Bob');
  });

  it('reopen() reactivates the wizard from step 0', () => {
    useOnboarding.getState().setUserName('X');
    useOnboarding.getState().reopen();
    expect(useOnboarding.getState().active).toBe(true);
    expect(useOnboarding.getState().step).toBe(0);
    // userName is preserved across reopen
    expect(useOnboarding.getState().userName).toBe('X');
  });
});
