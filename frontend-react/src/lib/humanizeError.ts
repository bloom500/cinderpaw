/**
 * #10: map raw inference/stream errors to human-readable messages with a
 * suggested action. Raw provider errors ("HTTP 401: {json blob}",
 * "ECONNREFUSED", "tokenize: …") used to land verbatim in the chat UI.
 *
 * The raw error is preserved as `detail` so power users can still see it.
 */

export type ErrorAction = 'settings' | 'models' | null;

export interface HumanError {
  /** A few words for the card's heading ("The model stopped answering"). */
  title: string;
  /** Short, plain-English explanation of what went wrong. */
  message: string;
  /** Where a click can fix it: cloud keys live in Settings, models in Models. */
  action: ErrorAction;
  /** Label for the action button. */
  actionLabel?: string;
  /** The raw error, for the curious. */
  detail: string;
}

interface Rule {
  test: RegExp;
  title: string;
  message: string;
  action: ErrorAction;
  actionLabel?: string;
}

const RULES: Rule[] = [
  {
    test: /\b401\b|unauthorized|invalid[_ ]api[_ ]key|incorrect api key|authentication/i,
    title: 'Your API key was not accepted',
    message: 'Your API key was rejected by the provider. Check that the key is correct and active.',
    action: 'settings',
    actionLabel: 'Open Cloud Keys',
  },
  {
    test: /\b403\b|forbidden|permission/i,
    title: 'The provider said no',
    message: 'The provider refused the request (forbidden). Your key may lack access to this model.',
    action: 'settings',
    actionLabel: 'Open Cloud Keys',
  },
  {
    test: /\b429\b|rate.?limit|too many requests/i,
    title: 'Too many requests right now',
    message: 'Rate limit reached. Wait a moment and try again, or switch to another model/provider.',
    action: null,
  },
  {
    test: /\b402\b|insufficient|quota|billing|credit/i,
    title: 'A billing problem at the provider',
    message: 'The provider reports a billing/quota problem. Check your account balance with them.',
    action: 'settings',
    actionLabel: 'Open Cloud Keys',
  },
  {
    test: /no model loaded/i,
    title: 'No model is loaded',
    message: 'No local model is loaded. Load one from the Models page, or pick a cloud model.',
    action: 'models',
    actionLabel: 'Open Models',
  },
  {
    // The engine's 503 for "nothing chosen" carries a status code, so the 5xx rule
    // at the bottom used to call it "the provider is overloaded" and send people
    // to wait when the fix is to pick a model.
    test: /no model selected|model_not_ready/i,
    title: 'No model is chosen yet',
    message: 'Cinderpaw has no model to answer with. Pick one in the model switcher under the message box, or open Models.',
    action: 'models',
    actionLabel: 'Open Models',
  },
  {
    test: /stream stalled|stopped responding|idle.?timeout/i,
    title: 'The model stopped answering',
    message:
      'The model stopped responding mid-generation and the request was cancelled. ' +
      'Try again, or switch to a smaller/faster model.',
    action: null,
  },
  {
    test: /context|n_ctx|too (long|large)|exceeds? .*(window|length)|decode/i,
    title: 'This chat is too long for the model',
    message:
      'The conversation no longer fits the model’s context window. Start a new chat ' +
      'or switch to a model with a larger context.',
    action: null,
  },
  {
    test: /econnrefused|connection refused|fetch failed|enotfound|network|dns|timed?.?out|unreachable/i,
    title: 'Could not reach the model',
    message:
      'Could not reach the inference endpoint. Check your internet connection ' +
      '(for cloud models) or that the local engine is running.',
    action: null,
  },
  {
    test: /interrupted by a new message/i,
    title: 'Stopped for your new message',
    message: 'This response was interrupted because a new message was sent.',
    action: null,
  },
  {
    test: /\b5\d{2}\b|internal server error|overloaded|unavailable/i,
    title: 'The provider had a problem',
    message: 'The provider had an internal error or is overloaded. Try again in a moment.',
    action: null,
  },
];

export function humanizeError(raw: string): HumanError {
  const detail = raw.trim();
  for (const rule of RULES) {
    if (rule.test.test(detail)) {
      return { title: rule.title, message: rule.message, action: rule.action, actionLabel: rule.actionLabel, detail };
    }
  }
  return {
    title: 'Something went wrong',
    message: 'Something went wrong while generating the response.',
    action: null,
    detail,
  };
}
