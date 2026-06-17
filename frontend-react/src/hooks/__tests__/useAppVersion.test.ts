import { describe, expect, it } from 'vitest';
import { formatDisplayVersion } from '../useAppVersion';

describe('formatDisplayVersion (CalVer display padding)', () => {
  it('zero-pads month and day of a calendar version', () => {
    expect(formatDisplayVersion('2026.6.17')).toBe('2026.06.17');
    expect(formatDisplayVersion('2026.6.7')).toBe('2026.06.07');
    expect(formatDisplayVersion('2026.12.5')).toBe('2026.12.05');
  });

  it('leaves an already-padded version unchanged', () => {
    expect(formatDisplayVersion('2026.06.17')).toBe('2026.06.17');
  });

  it('leaves classic semver untouched', () => {
    expect(formatDisplayVersion('0.2.3')).toBe('0.2.3');
    expect(formatDisplayVersion('1.10.0')).toBe('1.10.0');
  });

  it('preserves a prerelease/build suffix', () => {
    expect(formatDisplayVersion('2026.6.1-beta')).toBe('2026.06.01-beta');
  });
});
