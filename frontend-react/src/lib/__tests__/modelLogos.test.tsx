import { describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { ModelLogo, logoKeyFor, makerOf, modelDisplayName, providerName } from '../modelLogos';
import { LOGOS, MAKER_TO_LOGO } from '../modelLogoData';

describe('a model as a person knows it', () => {
  it('names the model without its address', () => {
    // No catalog cached here, so this is the readable guess from the id itself.
    expect(modelDisplayName('meta/muse-spark-1.3-contributor')).toBe('Muse Spark 1.3 Contributor');
    expect(modelDisplayName('~z-ai/glm-4.6')).toBe('Glm 4.6');
  });

  it('finds the maker in the id, else falls back to the provider', () => {
    expect(makerOf('meta/muse-spark-1.3-contributor', 'openrouter')).toBe('meta');
    expect(makerOf('claude-sonnet-5', 'anthropic')).toBe('anthropic');
    expect(makerOf(undefined)).toBeNull();
  });

  it('names the route for the tooltip', () => {
    expect(providerName('openrouter')).toBe('OpenRouter');
    expect(providerName('some-new-provider')).toBe('some-new-provider');
  });

  it('has a mark for every maker with many models on OpenRouter', () => {
    // The makers with the most models on OpenRouter on 17 Sep 2026. A missing
    // one here is a pill full of initials for most people.
    for (const maker of ['openai', 'qwen', 'google', 'anthropic', 'mistralai', 'deepseek', 'z-ai', 'nvidia', 'minimax', 'moonshotai', 'x-ai', 'meta-llama', 'tencent', 'amazon', 'cohere', 'microsoft']) {
      const key = logoKeyFor(`${maker}/some-model`, 'openrouter', MAKER_TO_LOGO);
      expect(key && LOGOS[key], maker).toBeTruthy();
    }
  });

  it('a local file gets the Hugging Face mark; a named maker with no mark gets nothing to guess with', () => {
    expect(logoKeyFor('Qwen3-4B-Q4_K_M.gguf', 'local', MAKER_TO_LOGO)).toBe('huggingface');
    expect(logoKeyFor('sao10k/l3-euryale', 'openrouter', MAKER_TO_LOGO)).toBeNull();
  });

  it('renders the mark, and an initial when there is none', async () => {
    const openai = render(<ModelLogo modelId="openai/gpt-5" provider="openrouter" />);
    await waitFor(() => expect(openai.container.querySelector('svg title')?.textContent).toBe('OpenAI'));
    const small = render(<ModelLogo modelId="sao10k/l3-euryale" provider="openrouter" />);
    await waitFor(() => expect(small.container.textContent).toBe('s'));
  });
});
