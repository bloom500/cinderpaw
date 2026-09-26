/**
 * The self-improvement engine speaks in enum names ("CostBudgetExhausted",
 * "idle"). These are the same facts in words a person reads without a manual.
 * An unknown name passes through unchanged: better a raw word than a blank.
 */

const STOP_REASONS: Record<string, string> = {
  TargetReached: 'reached its goal',
  BudgetExhausted: 'used up its tries',
  CostBudgetExhausted: 'hit the spending limit',
  MaxIterations: 'used up its tries',
  PlateauPersistent: 'stopped getting better',
  WallClockExhausted: 'ran out of time',
  UserStopped: 'you stopped it',
  Converged: 'nothing left to try',
  RefillFailed: 'something broke, so it stopped',
  EvalHalted: 'a test failed, so it stopped',
};

const TRIGGERS: Record<string, string> = {
  idle: 'you were away',
  user: 'you asked',
  schedule: 'it was time',
  error: 'something went wrong',
  threshold: 'enough new chats',
  budget_available: 'money was free to spend',
};

export function stopReasonWords(reason: string): string {
  return STOP_REASONS[reason] ?? reason;
}

export function triggerWords(trigger: string): string {
  return TRIGGERS[trigger] ?? trigger;
}
