import { readLocal, writeLocal } from '@/lib/utils';

/**
 * The one paid-extra question (17 Oct 2026, Darius): which ONE paid extra
 * would someone want, and would they pay the price for it. Customer research,
 * not a store: Cinderpaw stays free, and the card says so before anything else.
 *
 * Asked once, to someone who has used Cinderpaw for real: 5 finished replies
 * that used a tool, or 7 days after this install first opened the app,
 * whichever comes first. Never while the usage question is still open, so
 * nobody gets two questions at once (PayIntentDialog checks that).
 *
 * Only an answer leaves: the extra picked, the price that was shown, and yes,
 * maybe or no. No id, no chat, no time of day. Closing the card sends nothing.
 */
export const INTEREST_URL = 'https://cinderpaw-bug-report.bloommediacorporation.workers.dev/interest';

export type ExtraId = 'apps' | 'packs' | 'always_on' | 'ai_included';
export type PayAnswer = 'yes' | 'maybe' | 'no';

// One price for everything (18 Oct 2026, Darius): one Pro plan, $35 the first
// month, $25 the second, $17 from the third while you stay. The card asks
// which extra would make someone take it. Each answer carries the `price` tag
// it was asked with, so a later price never mixes old answers with new ones.
export const PRO_STEPS = [
  { when: 'Month 1', price: '$35' },
  { when: 'Month 2', price: '$25' },
  { when: 'Then, every month', price: '$17' },
] as const;
export const EXTRAS: { id: ExtraId; label: string; body: string; price: string; note?: string }[] = [
  { id: 'apps', label: 'Premium apps inside Cinderpaw', body: 'Extra tools that live in the app, like photo and PDF editors.', price: '352517' },
  { id: 'packs', label: 'Gets better at your job every week', body: 'New lessons for your kind of work, tested before you get them.', price: '352517' },
  { id: 'always_on', label: 'Works while your PC is off', body: 'Your agent keeps answering and working while you sleep.', price: '352517' },
  { id: 'ai_included', label: 'No API key needed, AI included', body: 'Start right away, with no keys to set up.', price: '352517', note: 'AI use is included up to a monthly limit.' },
];

const KEY_DONE = 'cinderpaw.payIntent.done';
const KEY_TASKS = 'cinderpaw.payIntent.tasks';
const KEY_FIRST = 'cinderpaw.payIntent.firstSeen';
const TASKS_BEFORE_ASKING = 5;
const DAYS_BEFORE_ASKING = 7;
const DAY_MS = 86_400_000;

/** A reply finished and used at least one tool: research, a file, an automation. */
export function recordRealTask(): void {
  writeLocal(KEY_TASKS, String((Number(readLocal(KEY_TASKS)) || 0) + 1));
}

/** True once, until answered or closed. The first call starts the 7-day clock. */
export function shouldAskPayIntent(now = Date.now()): boolean {
  if (readLocal(KEY_DONE)) return false;
  let first = Number(readLocal(KEY_FIRST));
  if (!first) {
    first = now;
    writeLocal(KEY_FIRST, String(now));
  }
  return (Number(readLocal(KEY_TASKS)) || 0) >= TASKS_BEFORE_ASKING || now - first >= DAYS_BEFORE_ASKING * DAY_MS;
}

/** Closed without an answer: never asked again, nothing sent. */
export function closePayIntent(): void {
  writeLocal(KEY_DONE, '1');
}

/** The answer, the only thing that leaves. `none` = "No thanks, I'll stay on free". */
export function payIntentBody(extra: ExtraId | 'none', answer: PayAnswer | 'none') {
  const price = EXTRAS.find((e) => e.id === extra)?.price ?? '0';
  return { extra, price, answer };
}

export function sendPayIntent(extra: ExtraId | 'none', answer: PayAnswer | 'none'): void {
  closePayIntent();
  // no-cors: a plain-text POST needs no preflight and the reply is not read.
  // A failure is dropped: the question was a favour, not a duty.
  void fetch(INTEREST_URL, { method: 'POST', mode: 'no-cors', keepalive: true, body: JSON.stringify(payIntentBody(extra, answer)) }).catch(() => {});
}
