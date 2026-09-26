import { useEffect, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { useBrowser } from '@/stores/browser';
import { DownloadsCard } from './DownloadsCard';

/**
 * The downloads card in its own window, over the browser's native page (see
 * `src-tauri/src/downloads_card.rs` for why it is a window).
 *
 * The two windows talk over Tauri events, which reach every window:
 *   card -> main  `downloads-card://hello`   (mounted; send the list)
 *                 `downloads-card://closed`  (gone; un-press the button)
 *   main -> card  `downloads-card://data`    { downloads }
 *
 * It closes the way a menu does: on Escape, or the moment it loses focus,
 * which is also what a click on the Downloads button again does.
 */

type Downloads = ReturnType<typeof useBrowser.getState>['downloads'];

/** Height the window needs for this many rows: header, rows, padding. */
export function cardHeight(rows: number): number {
  return rows === 0 ? 150 : 52 + Math.min(rows, 6) * 50 + 14;
}

export function DownloadsPopup() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const unData = listen<{ downloads: Downloads }>('downloads-card://data', (e) => {
      useBrowser.setState({ downloads: e.payload.downloads });
      setReady(true);
    });
    void emit('downloads-card://hello');
    const close = () => {
      void emit('downloads-card://closed');
      void invoke('downloads_card_close').catch(() => {});
    };
    const unFocus = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) close();
    });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      void unData.then((u) => u());
      void unFocus.then((u) => u());
    };
  }, []);

  // Nothing until the list has arrived: an empty card that fills a beat later
  // reads as "no downloads" and then changes its mind.
  return ready ? <DownloadsCard floating /> : null;
}
