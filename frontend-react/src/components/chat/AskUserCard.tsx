/**
 * AskUserCard — Claude.ai-style interactive question card.
 *
 * Renders 1-4 AskUserQuestion blocks, each with 2-4 options. The user
 * picks one (or many, for multiSelect), optionally types an "Other"
 * custom answer, and the answers are submitted back to the agent once
 * EVERY question has an answer.
 *
 * Why "wait for all questions" instead of auto-submitting on the first
 * click of a single-select option:
 *   - When the model asks 2-4 questions at once, the user must be able
 *     to answer all of them before the answer goes back. Auto-submitting
 *     on the first click of Q1 (the previous behaviour) meant the agent
 *     saw an answer of length 1, the pending Promise resolved, and Q2-Q4
 *     were never visible / answerable.
 *   - For the common 1-question case the behaviour is identical: there
 *     is only one slot, so it is "filled" on the first click and the
 *     auto-submit effect fires the same way it did before.
 *
 * The component is fully keyboard navigable: Tab between options, 1-9
 * to quick-select, Enter to submit multi-select.
 *
 * Once the user has submitted (or the request was cancelled), the card
 * collapses into a compact "Answered" summary so it does not keep
 * re-rendering in the message scroll.
 *
 * Props:
 *   - questions:  the questions to render
 *   - answered:   the user's answers, or undefined while pending
 *   - onSubmit:   called with the assembled answers when every question
 *                 has been answered. Called exactly once per card.
 *   - onCancel:   called when the user dismisses the card without answering
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Circle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AskUserAnswer, AskUserOption, AskUserQuestion } from '@/stores/askUser';

interface AskUserCardProps {
  requestId: string;
  questions: AskUserQuestion[];
  answered?: AskUserAnswer[];
  onSubmit: (answers: AskUserAnswer[]) => void;
  onCancel?: () => void;
}

export function AskUserCard({
  requestId,
  questions,
  answered,
  onSubmit,
  onCancel,
}: AskUserCardProps) {
  const isAnswered = answered !== undefined;

  // One slot per question, in the same order. null = unanswered.
  // After every slot is filled, the auto-submit effect below calls
  // onSubmit(answers) exactly once. Using a sparse array (rather than
  // appending/popping) keeps question order stable when the user
  // changes an earlier answer before finishing.
  const [answers, setAnswers] = useState<(AskUserAnswer | null)[]>(() =>
    new Array(questions.length).fill(null),
  );
  // Guard against double-submit (React StrictMode runs effects twice in
  // dev, and the parent may pass a fresh onSubmit closure on every
  // re-render which would otherwise re-fire the effect).
  const submittedRef = useRef(false);

  const handleAnswer = useCallback((index: number, answer: AskUserAnswer) => {
    setAnswers((prev) => {
      const existing = prev[index];
      // No-op if the answer is identical (same labels + customText) so we
      // do not re-run the auto-submit effect on no-op clicks.
      if (
        existing &&
        existing.question === answer.question &&
        existing.customText === answer.customText &&
        existing.selected.length === answer.selected.length &&
        existing.selected.every((s, i) => s === answer.selected[i])
      ) {
        return prev;
      }
      const next = [...prev];
      next[index] = answer;
      return next;
    });
  }, []);

  // Auto-submit when every question has an answer. Fires exactly once
  // per card thanks to submittedRef.
  useEffect(() => {
    if (isAnswered || submittedRef.current) return;
    if (answers.length !== questions.length) return;
    if (answers.some((a) => a === null)) return;
    submittedRef.current = true;
    onSubmit(answers as AskUserAnswer[]);
  }, [answers, isAnswered, onSubmit, questions.length]);

  return (
    <div
      className="rounded-xl border border-border-default bg-bg-elevated/40 p-4 my-2 space-y-4"
      data-ask-user-card={requestId}
      role="group"
      aria-label="Agent question"
    >
      <div className="text-[11px] uppercase tracking-wider text-text-muted font-medium">
        Feral needs your input
        {questions.length > 1 && (
          <span className="ml-2 font-mono text-text-muted/70 normal-case tracking-normal">
            {answers.filter((a) => a !== null).length} / {questions.length}
          </span>
        )}
      </div>
      {questions.map((q, i) => (
        <QuestionBlock
          key={i}
          index={i}
          question={q}
          // Prefer the parent's authoritative answer (post-submit); fall
          // back to the in-progress local answer while the user is still
          // filling the card.
          answer={answered?.[i] ?? answers[i] ?? undefined}
          disabled={isAnswered}
          onAnswerSingle={(selection) => {
            handleAnswer(i, { question: q.question, selected: [selection] });
          }}
          onAnswerMulti={(selections) => {
            handleAnswer(i, { question: q.question, selected: selections });
          }}
        />
      ))}
      {!isAnswered && onCancel && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded transition-colors"
          >
            Skip
          </button>
        </div>
      )}
    </div>
  );
}

interface QuestionBlockProps {
  index: number;
  question: AskUserQuestion;
  /** Authoritative answer from the parent. Drives the visual "selected" state. */
  answer?: AskUserAnswer;
  /** When true, render the compact "Answered" summary instead of options. */
  disabled: boolean;
  /** Single-select: one label. Updates the parent's answer slot only. */
  onAnswerSingle: (label: string) => void;
  /** Multi-select: N labels. Updates the parent's answer slot only. */
  onAnswerMulti: (labels: string[]) => void;
}

function QuestionBlock({
  index,
  question,
  answer,
  disabled,
  onAnswerSingle,
  onAnswerMulti,
}: QuestionBlockProps) {
  // Local multi-select state — the selection the user is currently
  // building. Single-select questions are fully controlled by the
  // parent's `answer` prop (a click is the answer; no in-progress
  // state is needed).
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(answer?.selected ?? []),
  );
  const [otherText, setOtherText] = useState(answer?.customText ?? '');
  const [otherOpen, setOtherOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // When the parent hands us a new answer (e.g. the user re-answered
  // this question), keep the in-progress multi-select state in sync so
  // the option highlights reflect the latest answer.
  useEffect(() => {
    if (question.multiSelect) {
      setSelected(new Set(answer?.selected ?? []));
      setOtherText(answer?.customText ?? '');
    }
  }, [answer, question.multiSelect]);

  // Auto-submit the first question when the user has not yet selected
  // anything. The agent loop is blocked until the user answers, so a
  // single click should feel instant for single-select questions.
  const handleSelect = (opt: AskUserOption) => {
    if (disabled) return;
    if (question.multiSelect) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(opt.label)) next.delete(opt.label);
        else next.add(opt.label);
        return next;
      });
    } else {
      // Single-select: hand the answer up to the parent. The parent
      // decides when the full card is ready to submit (see useEffect
      // in AskUserCard) — for a 1-question card this fires immediately,
      // for a multi-question card it waits for every slot to fill.
      onAnswerSingle(opt.label);
    }
  };

  const handleSubmitMulti = () => {
    const labels = Array.from(selected);
    if (otherText.trim()) {
      labels.push(otherText.trim());
    }
    if (labels.length === 0) return;
    onAnswerMulti(labels);
  };

  // Keyboard nav: 1-9 quick-select on single-select; Enter submits multi.
  const handleKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === 'Enter' && question.multiSelect) {
      e.preventDefault();
      handleSubmitMulti();
      return;
    }
    if (e.key === 'Escape' && !question.multiSelect) {
      e.preventDefault();
      setOtherOpen(true);
      return;
    }
    const num = Number(e.key);
    if (Number.isInteger(num) && num >= 1 && num <= question.options.length) {
      const opt = question.options[num - 1];
      if (opt) handleSelect(opt);
    }
  };

  // For multi-select, the "Other" input is inline.
  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKey}
      className="space-y-2 outline-none"
      data-question-index={index}
    >
      <div className="flex items-baseline gap-2">
        {question.header && (
          <span className="text-[10px] uppercase tracking-wider text-text-muted font-mono">
            {question.header}
          </span>
        )}
        <p className="text-sm text-text-primary font-medium">{question.question}</p>
      </div>

      {/* Answered: compact summary */}
      {disabled && answer && (
        <div className="text-xs text-text-muted flex items-center gap-1.5">
          <Check size={12} className="text-green-500 shrink-0" />
          <span>
            {answer.selected.join(', ')}
            {answer.customText ? ` (${answer.customText})` : ''}
          </span>
        </div>
      )}

      {/* Pending: render options */}
      {!disabled && (
        <div className="space-y-1.5">
          {question.options.map((opt, i) => {
            // For single-select, the visual highlight is driven by the
            // parent (so the user sees their pick even before the card
            // is fully submitted). For multi-select, the in-progress
            // selection is local until Submit.
            const isSelected = question.multiSelect
              ? selected.has(opt.label)
              : answer?.selected.includes(opt.label) ?? false;
            const isAnswer = answer?.selected.includes(opt.label) ?? false;
            return (
              <button
                key={opt.label}
                type="button"
                onClick={() => handleSelect(opt)}
                disabled={disabled}
                className={cn(
                  'w-full text-left px-3 py-2 rounded-lg border transition-all',
                  'flex items-start gap-2.5 group',
                  'focus:outline-none focus:ring-2 focus:ring-brand/50',
                  'border-border-default bg-bg-primary hover:bg-bg-elevated hover:border-brand/50',
                  isSelected && 'border-brand bg-brand/10',
                  'disabled:opacity-50 disabled:cursor-default',
                )}
                aria-pressed={isSelected || isAnswer}
              >
                <span className="mt-0.5 shrink-0 text-text-muted">
                  {question.multiSelect ? (
                    isSelected || isAnswer ? (
                      <Check size={14} className="text-brand" />
                    ) : (
                      <Circle size={14} />
                    )
                  ) : (
                    <span className="text-[10px] font-mono">{i + 1}</span>
                  )}
                </span>
                <span className="flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="text-sm text-text-primary">{opt.label}</span>
                    {opt.recommended && (
                      <span className="text-[10px] uppercase tracking-wider text-green-600 dark:text-green-400 font-medium">
                        recommended
                      </span>
                    )}
                  </span>
                  {opt.description && (
                    <span className="block text-xs text-text-muted mt-0.5 leading-snug">
                      {opt.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}

          {/* "Other" — implicit 5th option. Opens a text input. */}
          {!question.multiSelect && (
            <OtherInput
              open={otherOpen}
              value={otherText}
              onChange={setOtherText}
              onOpen={() => setOtherOpen(true)}
              onSubmit={() => {
                const text = otherText.trim();
                if (!text) return;
                onAnswerSingle(text);
              }}
            />
          )}

          {/* Multi-select: submit + Other text inline */}
          {question.multiSelect && (
            <div className="flex items-center gap-2 pt-1">
              <input
                type="text"
                placeholder="Other (optional)…"
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                className="flex-1 text-xs px-2 py-1.5 rounded border border-border-default bg-bg-primary text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-brand/50"
              />
              <button
                type="button"
                onClick={handleSubmitMulti}
                disabled={selected.size === 0 && otherText.trim().length === 0}
                className="text-xs px-3 py-1.5 rounded bg-brand text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-brand/90 transition-colors"
              >
                Submit
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface OtherInputProps {
  open: boolean;
  value: string;
  onChange: (v: string) => void;
  onOpen: () => void;
  onSubmit: () => void;
}

function OtherInput({ open, value, onChange, onOpen, onSubmit }: OtherInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  if (!open) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="w-full text-left px-3 py-1.5 rounded-lg border border-dashed border-border-subtle text-xs text-text-muted hover:border-text-muted hover:text-text-primary transition-colors"
      >
        Other…
      </button>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="flex items-center gap-2"
    >
      <input
        ref={inputRef}
        type="text"
        placeholder="Type your answer…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 text-sm px-2 py-1.5 rounded border border-border-default bg-bg-primary text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-brand/50"
      />
      <button
        type="submit"
        disabled={!value.trim()}
        className="text-xs px-3 py-1.5 rounded bg-brand text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-brand/90 transition-colors"
      >
        Send <ChevronDown size={12} className="inline -mt-0.5" />
      </button>
    </form>
  );
}
