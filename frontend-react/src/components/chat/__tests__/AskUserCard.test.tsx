/**
 * AskUserCard — component tests.
 *
 * The bug we're guarding against: when ask_user is called with >1
 * question, the user could only answer the first one — clicking an
 * option on Q1 immediately resolved the store Promise and the
 * answer went back to the agent before Q2 was ever visible. The fix
 * tracks every question's answer in local state and only calls
 * onSubmit once all slots are filled.
 *
 * These tests pin the multi-question contract:
 *   1. Single-question, single-select → still auto-submits on click
 *      (the old, snappy UX is preserved for the common case).
 *   2. Multi-question, single-select → only submits after every
 *      question is answered.
 *   3. Mixed multi/single-select → Submit on multi advances the
 *      card; final click on the last single-select submits.
 *   4. Re-answering a question updates the final answer (the user
 *      can change their mind before submitting).
 *   5. Skip calls onCancel without submitting.
 *   6. React.StrictMode does not cause a double-submit.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AskUserCard } from '../AskUserCard';
import type { AskUserQuestion } from '@/stores/askUser';

const SINGLE_Q: AskUserQuestion[] = [
  {
    question: 'Pick a database',
    options: [
      { label: 'PostgreSQL', recommended: true },
      { label: 'SQLite' },
    ],
    multiSelect: false,
  },
];

const TWO_SINGLE_Q: AskUserQuestion[] = [
  {
    question: 'Pick a database',
    options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }],
    multiSelect: false,
  },
  {
    question: 'Include migrations?',
    options: [{ label: 'Yes' }, { label: 'No' }],
    multiSelect: false,
  },
];

const MIXED_Q: AskUserQuestion[] = [
  {
    question: 'Pick frameworks (multi)',
    options: [{ label: 'React' }, { label: 'Vue' }, { label: 'Svelte' }],
    multiSelect: true,
  },
  {
    question: 'Use TypeScript?',
    options: [{ label: 'Yes' }, { label: 'No' }],
    multiSelect: false,
  },
];

describe('AskUserCard', () => {
  beforeEach(() => {
    // No-op; the component is fully self-contained.
  });

  it('auto-submits immediately for a single single-select question (preserves old UX)', async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();

    render(
      <AskUserCard
        requestId="req-1"
        questions={SINGLE_Q}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole('button', { name: /PostgreSQL/ }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith([
      { question: 'Pick a database', selected: ['PostgreSQL'] },
    ]);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('does NOT submit after the first question of a multi-question card', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    render(
      <AskUserCard
        requestId="req-2"
        questions={TWO_SINGLE_Q}
        onSubmit={onSubmit}
      />,
    );

    // Click the first option of Q1.
    await user.click(screen.getByRole('button', { name: /PostgreSQL/ }));

    // Bug regression: previously this would have resolved the store
    // Promise with an answers array of length 1, kicking the user out
    // before they could answer Q2. Now we wait.
    expect(onSubmit).not.toHaveBeenCalled();

    // The Q1 pick should still be visible (highlighted).
    const pgButton = screen.getByRole('button', { name: /PostgreSQL/ });
    expect(pgButton).toHaveAttribute('aria-pressed', 'true');
  });

  it('submits with all answers only after every question is answered (multi-question)', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    render(
      <AskUserCard
        requestId="req-3"
        questions={TWO_SINGLE_Q}
        onSubmit={onSubmit}
      />,
    );

    await user.click(screen.getByRole('button', { name: /PostgreSQL/ }));
    expect(onSubmit).not.toHaveBeenCalled();

    // Accessible name is "1Yes" (single-select prepends the index number),
    // so a substring match is what we need.
    await user.click(screen.getByRole('button', { name: /Yes/ }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith([
      { question: 'Pick a database', selected: ['PostgreSQL'] },
      { question: 'Include migrations?', selected: ['Yes'] },
    ]);
  });

  it('allows changing a single-select answer before the card is submitted', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    render(
      <AskUserCard
        requestId="req-4"
        questions={TWO_SINGLE_Q}
        onSubmit={onSubmit}
      />,
    );

    // Pick PostgreSQL, then change to SQLite on Q1.
    await user.click(screen.getByRole('button', { name: /PostgreSQL/ }));
    await user.click(screen.getByRole('button', { name: /SQLite/ }));
    expect(onSubmit).not.toHaveBeenCalled();

    // Finish Q2 — the submitted answers must reflect the LATEST Q1 pick.
    // Accessible name is "2No" (index + label), so use a substring match.
    await user.click(screen.getByRole('button', { name: /No/ }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith([
      { question: 'Pick a database', selected: ['SQLite'] },
      { question: 'Include migrations?', selected: ['No'] },
    ]);
  });

  it('handles mixed multi-select + single-select: submit advances, click finishes', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    render(
      <AskUserCard
        requestId="req-5"
        questions={MIXED_Q}
        onSubmit={onSubmit}
      />,
    );

    // Q1 is multi-select: click React and Vue, then Submit.
    await user.click(screen.getByRole('button', { name: /React/ }));
    await user.click(screen.getByRole('button', { name: /Vue/ }));
    await user.click(screen.getByRole('button', { name: /^Submit$/ }));
    expect(onSubmit).not.toHaveBeenCalled();

    // Q2 is single-select: click Yes (accessible name "1Yes" — index + label).
    await user.click(screen.getByRole('button', { name: /Yes/ }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith([
      { question: 'Pick frameworks (multi)', selected: ['React', 'Vue'] },
      { question: 'Use TypeScript?', selected: ['Yes'] },
    ]);
  });

  it('Skip calls onCancel without submitting', async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();

    render(
      <AskUserCard
        requestId="req-6"
        questions={TWO_SINGLE_Q}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Skip/ }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows a progress counter for multi-question cards', () => {
    render(
      <AskUserCard
        requestId="req-7"
        questions={TWO_SINGLE_Q}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByText('0 / 2')).toBeInTheDocument();
  });

  it('does not show a progress counter for a single-question card', () => {
    render(
      <AskUserCard
        requestId="req-8"
        questions={SINGLE_Q}
        onSubmit={() => {}}
      />,
    );
    expect(screen.queryByText(/\/ 1/)).not.toBeInTheDocument();
  });

  it('renders the compact "answered" summary once `answered` is provided', () => {
    render(
      <AskUserCard
        requestId="req-9"
        questions={TWO_SINGLE_Q}
        answered={[
          { question: 'Pick a database', selected: ['PostgreSQL'] },
          { question: 'Include migrations?', selected: ['Yes'] },
        ]}
        onSubmit={() => {}}
      />,
    );

    // Option buttons are gone (replaced by the summary line).
    expect(screen.queryByRole('button', { name: /PostgreSQL/ })).toBeNull();
    // Both summary lines are visible.
    expect(screen.getByText(/PostgreSQL/)).toBeInTheDocument();
    expect(screen.getByText(/Yes/)).toBeInTheDocument();
  });

  it('does not double-submit when rendered inside React.StrictMode', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    render(
      <StrictMode>
        <AskUserCard
          requestId="req-10"
          questions={SINGLE_Q}
          onSubmit={onSubmit}
        />
      </StrictMode>,
    );

    await user.click(screen.getByRole('button', { name: /PostgreSQL/ }));

    // StrictMode mounts → unmounts → re-mounts in dev. Without the
    // submittedRef guard, the auto-submit effect could fire twice
    // (once for each mount), sending two answers back to the agent.
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('does not submit when every question is unanswered (no clicks)', () => {
    const onSubmit = vi.fn();
    render(
      <AskUserCard
        requestId="req-11"
        questions={TWO_SINGLE_Q}
        onSubmit={onSubmit}
      />,
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('ignores no-op clicks (same single-select option twice)', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    render(
      <AskUserCard
        requestId="req-12"
        questions={SINGLE_Q}
        onSubmit={onSubmit}
      />,
    );

    await user.click(screen.getByRole('button', { name: /PostgreSQL/ }));
    await user.click(screen.getByRole('button', { name: /PostgreSQL/ }));

    // The dedup in handleAnswer means the second click is a no-op;
    // submit still fires exactly once.
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
