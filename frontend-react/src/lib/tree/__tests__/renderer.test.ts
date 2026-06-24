import { describe, it, expect } from 'vitest';
import { createTreeRenderer } from '../renderer';

describe('createTreeRenderer', () => {
  it('returns null when WebGL2 is unavailable', () => {
    const fake = { getContext: () => null } as unknown as HTMLCanvasElement;
    expect(createTreeRenderer(fake)).toBeNull();
  });
});
