import { describe, expect, it } from 'vitest';
import { humanizeError } from '../humanizeError';

describe('humanizeError', () => {
  it('an empty OpenAI account is a money problem, not "wait a minute"', () => {
    const openai = 'HTTP 429: {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota"}}';
    expect(humanizeError(openai).title).toBe('Your account with the provider is out of credit');
    expect(humanizeError('HTTP 400: Your credit balance is too low to access the Anthropic API').title).toBe('Your account with the provider is out of credit');
    expect(humanizeError('HTTP 402: Payment Required').action).toBe('settings');
  });

  it('a real rate limit, Google per-minute quota included, still says wait', () => {
    expect(humanizeError('HTTP 429: Too Many Requests').title).toBe('Too many requests right now');
    expect(humanizeError('HTTP 429 RESOURCE_EXHAUSTED: Quota exceeded for metric generate_content_requests per minute').title).toBe('Too many requests right now');
  });
});
