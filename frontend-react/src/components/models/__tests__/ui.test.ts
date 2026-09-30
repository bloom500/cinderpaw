import { describe, it, expect } from 'vitest';
import { billionsOf, makerFor, paramsOf, prettyModelName } from '../ui';
import { kindsOf } from '../BrowseTab';
import type { HfModelSummary } from '@/lib/tauri';

describe('model names', () => {
  it('reads a GGUF filename the way a person says the model', () => {
    expect(prettyModelName('Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf')).toBe('Meta Llama 3.1 8B Instruct');
    expect(prettyModelName('Phi-3-mini-4k-instruct-q4.gguf')).toBe('Phi 3 Mini 4k Instruct');
    expect(prettyModelName('bge-m3-Q8_0.gguf')).toBe('BGE m3');
  });

  it('finds the parameter count, and only a real one', () => {
    expect(paramsOf('Qwen2.5-7B-Instruct')).toBe('7B');
    expect(paramsOf('Mixtral-8x7B-v0.1')).toBe('8x7B');
    expect(paramsOf('qwen2.5-0.5b-instruct')).toBe('0.5B');
    expect(paramsOf('bge-small-en-v1.5')).toBeNull();
    expect(billionsOf('Mixtral-8x7B')).toBe(56);
    expect(billionsOf('gte-335M')).toBeCloseTo(0.335);
  });

  it('knows who made the common families', () => {
    expect(makerFor('Meta-Llama-3.1-8B')?.label).toBe('Meta');
    expect(makerFor('Qwen2.5-7B')?.label).toBe('Alibaba');
    expect(makerFor('Phi-3-mini')?.label).toBe('Microsoft');
    expect(makerFor('some-unknown-model')).toBeNull();
  });
});

describe('Hub filters', () => {
  const repo = (id: string, tags: string[]): HfModelSummary =>
    ({ id, author: '', downloads: 0, likes: 0, last_modified: '', tags });

  it('sorts repos by what they are for, from their tags and name', () => {
    expect(kindsOf(repo('Qwen/Qwen2.5-7B-Instruct-GGUF', ['text-generation']))).toEqual(new Set(['text']));
    expect(kindsOf(repo('BAAI/bge-small-en-v1.5-gguf', ['feature-extraction'])).has('embed')).toBe(true);
    expect(kindsOf(repo('ggerganov/whisper-small', [])).has('audio')).toBe(true);
    expect(kindsOf(repo('Qwen/Qwen2.5-1.5B-Instruct-GGUF', ['text-generation'])).has('small')).toBe(true);
  });
});
