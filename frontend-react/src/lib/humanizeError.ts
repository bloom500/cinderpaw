/**
 * #10: map raw inference/stream errors to human-readable messages with a
 * suggested action. Raw provider errors ("HTTP 401: {json blob}",
 * "ECONNREFUSED", "tokenize: …") used to land verbatim in the chat UI.
 *
 * The raw error is preserved as `detail` so power users can still see it.
 */

export type ErrorAction = 'settings' | 'models' | null;

export interface HumanError {
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
  message: string;
  action: ErrorAction;
  actionLabel?: string;
}

const RULES: Rule[] = [
  {
    test: /\b401\b|unauthorized|invalid[_ ]api[_ ]key|incorrect api key|authentication/i,
    message: 'Your API key was rejected by the provider. Check that the key is correct and active.',
    action: 'settings',
    actionLabel: 'Open Cloud Keys',
  },
  {
    test: /\b403\b|forbidden|permission/i,
    message: 'The provider refused the request (forbidden). Your key may lack access to this model.',
    action: 'settings',
    actionLabel: 'Open Cloud Keys',
  },
  {
    test: /\b429\b|rate.?limit|too many requests/i,
    message: 'Rate limit reached. Wait a moment and try again, or switch to another model/provider.',
    action: null,
  },
  {
    test: /\b402\b|insufficient|quota|billing|credit/i,
    message: 'The provider reports a billing/quota problem. Check your account balance with them.',
    action: 'settings',
    actionLabel: 'Open Cloud Keys',
  },
  {
    test: /no model loaded/i,
    message: 'No local model is loaded. Load one from the Models page, or pick a cloud model.',
    action: 'models',
    actionLabel: 'Open Models',
  },
  {
    test: /stream stalled|stopped responding|idle.?timeout/i,
    message:
      'The model stopped responding mid-generation and the request was cancelled. ' +
      'Try again, or switch to a smaller/faster model.',
    action: null,
  },
  {
    test: /context|n_ctx|too (long|large)|exceeds? .*(window|length)|decode/i,
    message:
      'The conversation no longer fits the model’s context window. Start a new chat ' +
      'or switch to a model with a larger context.',
    action: null,
  },
  {
    test: /econnrefused|connection refused|fetch failed|enotfound|network|dns|timed?.?out|unreachable/i,
    message:
      'Could not reach the inference endpoint. Check your internet connection ' +
      '(for cloud models) or that the local engine is running.',
    action: null,
  },
  {
    test: /interrupted by a new message/i,
    message: 'This response was interrupted because a new message was sent.',
    action: null,
  },
  {
    test: /\b5\d{2}\b|internal server error|overloaded|unavailable/i,
    message: 'The provider had an internal error or is overloaded. Try again in a moment.',
    action: null,
  },
];

export function humanizeError(raw: string): HumanError {
  const detail = raw.trim();
  for (const rule of RULES) {
    if (rule.test.test(detail)) {
      return { message: rule.message, action: rule.action, actionLabel: rule.actionLabel, detail };
    }
  }
  return {
    message: 'Something went wrong while generating the response.',
    action: null,
    detail,
  };
}
