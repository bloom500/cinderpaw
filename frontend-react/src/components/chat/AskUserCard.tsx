/**
 * AskUserCard — Claude.ai-style interactive question card.
 *
 * Renders 1-4 AskUserQuestion blocks, each with 2-4 options. The user
 * picks one (or many, for multiSelect), optionally types an "Other"
 * custom answer, and clicks Submit. The component is fully keyboard
 * navigable: Tab between options, 1-9 to quick-select, Enter to submit.
 *
 * Once the user has submitted (or the request was cancelled), the card
 * collapses into a compact "Answered" summary so it does not keep
 * re-rendering in the message scroll.
 *
 * Props:
 *   - questions:  the questions to render
 *   - answered:   the user's answers, or undefined while pending
 *   - onSubmit:   called with the assembled answers when the user submits
 *   - onCancel:   called when the user dismisses the card without answering
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
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

  return (
    <div
      className="rounded-xl border border-border-default bg-bg-elevated/40 p-4 my-2 space-y-4"
      data-ask-user-card={requestId}
      role="group"
      aria-label="Agent question"
    >
      <div className="text-[11px] uppercase tracking-wider text-text-muted font-medium">
        Feral needs your input
      </div>
      {questions.map((q, i) => (
        <QuestionBlock
          key={i}
          question={q}
          answer={answered?.[i]}
          disabled={isAnswered}
          onSubmitSingle={(selection) => {
            // For single-question cards, build a full answers array and submit.
            onSubmit([{ question: q.question, selected: [selection] }]);
          }}
          onSubmitMulti={(selections) => {
            onSubmit([{ question: q.question, selected: selections }]);
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
  question: AskUserQuestion;
  answer?: AskUserAnswer;
  disabled: boolean;
  /** Single-select: one label. */
  onSubmitSingle: (label: string) => void;
  /** Multi-select: N labels. */
  onSubmitMulti: (labels: string[]) => void;
}

function QuestionBlock({
  question,
  answer,
  disabled,
  onSubmitSingle,
  onSubmitMulti,
}: QuestionBlockProps) {
  // Local state — the selection the user is currently building.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [otherText, setOtherText] = useState('');
  const [otherOpen, setOtherOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

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
      // Single-select: submit immediately on click.
      onSubmitSingle(opt.label);
    }
  };

  const handleSubmitMulti = () => {
    const labels = Array.from(selected);
    if (otherText.trim()) {
      labels.push(otherText.trim());
    }
    if (labels.length === 0) return;
    onSubmitMulti(labels);
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
            const isSelected = selected.has(opt.label);
            const isAnswer = answer?.selected.includes(opt.label);
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
                onSubmitSingle(text);
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
