import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ModelLogo, makerOf, modelDisplayName, providerName } from '../modelLogos';

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

  it("shows the maker's mark, an initial for a maker without one, and nothing for a local file", () => {
    const meta = render(<ModelLogo modelId="meta/muse-spark-1.3-contributor" provider="openrouter" />);
    expect(meta.container.querySelector('svg title')?.textContent).toBe('Meta');
    const openai = render(<ModelLogo modelId="openai/gpt-5" provider="openrouter" />);
    expect(openai.container.textContent).toBe('o');
    const local = render(<ModelLogo modelId="qwen3-4b.gguf" provider="local" />);
    expect(local.container.innerHTML).toBe('');
  });
});
