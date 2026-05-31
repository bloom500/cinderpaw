import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';

/**
 * The real version of the running binary (from tauri.conf.json), the same value
 * the updater compares against. Use this instead of the persisted `settings.version`,
 * which goes stale after the first run.
 */
export function useAppVersion() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void getVersion().then(setVersion).catch(() => {});
  }, []);
  return version;
}
