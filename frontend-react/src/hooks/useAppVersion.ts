import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';

/**
 * Zero-pad a CalVer version for display: `2026.6.17` → `2026.06.17`.
 *
 * The internal version must stay valid semver (which forbids leading zeros, so
 * the build/updater store `2026.6.17`), but users should see the padded date
 * form everywhere. Padding applies only when the first segment looks like a
 * 4-digit year; classic semver such as `0.2.3` is returned unchanged.
 */
export function formatDisplayVersion(v: string): string {
  const m = v.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})(.*)$/);
  if (!m) return v;
  const [, year, minor, patch, rest] = m;
  return `${year}.${minor.padStart(2, '0')}.${patch.padStart(2, '0')}${rest}`;
}

/**
 * The real version of the running binary (from tauri.conf.json), the same value
 * the updater compares against, formatted for display (CalVer is zero-padded).
 * Use this instead of the persisted `settings.version`, which goes stale after
 * the first run.
 */
export function useAppVersion() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void getVersion()
      .then((v) => setVersion(formatDisplayVersion(v)))
      .catch(() => {});
  }, []);
  return version;
}
