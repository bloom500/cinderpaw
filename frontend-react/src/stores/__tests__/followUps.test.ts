import { beforeEach, expect, it } from 'vitest';
import { useFollowUps } from '../followUps';

beforeEach(() => useFollowUps.setState({ enabled: true, card: null, dismissed: [] }));
const card = { id: 'run-1', sessionId: 'chat-1', mission: 'Finish the launch checklist' };

it('keeps a single actionable suggestion and does not restore a dismissed one', () => {
  useFollowUps.getState().receive(card);
  expect(useFollowUps.getState().card).toEqual(card);
  useFollowUps.getState().dismiss();
  useFollowUps.getState().receive(card);
  expect(useFollowUps.getState().card).toBeNull();
});

it('respects the opt-out and validates untrusted event payloads', () => {
  useFollowUps.getState().setEnabled(false);
  useFollowUps.getState().receive(card);
  expect(useFollowUps.getState().card).toBeNull();
  useFollowUps.getState().setEnabled(true);
  for (const value of [null, {}, { ...card, mission: 1 }, { ...card, id: '' }]) {
    useFollowUps.getState().receive(value);
    expect(useFollowUps.getState().card).toBeNull();
  }
});

it('clears a suggestion when that conversation resumes and expires stored cards', () => {
  useFollowUps.getState().receive(card);
  useFollowUps.getState().clearSession('another-chat');
  expect(useFollowUps.getState().card).toEqual(card);
  useFollowUps.getState().clearSession('chat-1');
  expect(useFollowUps.getState().card).toBeNull();
  const merge = useFollowUps.persist.getOptions().merge!;
  const restored = merge({ card, enabled: true, expiresAt: Date.now() - 1, dismissed: [] }, useFollowUps.getState());
  expect(restored.card).toBeNull();
});
