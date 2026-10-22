import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

/**
 * Long chats scroll at 60 fps: @shadcn/react 0.3.1's MessageScroller, made to
 * read the size of a few rows per scroll instead of every row.
 *
 * On every scroll event the scroller asked the browser where EACH message sits,
 * three times over: once for the bottom of the content, once for the first row
 * on screen, once for the current question. At 600 messages that is ~1,500
 * reads, 3.5 ms of a 16 ms frame, and scrolling dropped to ~45 fps (22 ms
 * frames, Edge, production build; 17 ms after this). Our rows are a plain
 * column, top to bottom, so:
 *   - the bottom of the content is the bottom of the LAST row,
 *   - the first row on screen and the current question are found by halving
 *     the list (binary search), about 10 reads instead of 600.
 *
 * Applied to the library's own file as it is loaded, so `npm ci` (the release
 * build) and `bun install` (dev) both get it; a lockfile patch would only reach
 * bun. If the library changes and a line is no longer there, the build stops
 * with the reason instead of shipping the slow version quietly.
 * Test: src/components/chat/__tests__/MessageScrollerScroll.test.tsx.
 */
export function fastMessageScroller(): Plugin {
  const edits: Array<[find: string, replace: string]> = [
    // A helper: the first index where `past(i)` is true, for a list sorted top
    // to bottom.
    ['function ee(e,t){',
      'function __firstPast(n,past){let lo=0,hi=n;while(lo<hi){let m=(lo+hi)>>1;past(m)?hi=m:lo=m+1;}return lo}function ee(e,t){'],
    // getContentBottom: the last row's bottom, not the lowest of all rows (a
    // hidden last row has no box, so it walks back to one that has).
    ['for(let b of n){let v=b.getBoundingClientRect();o=Math.max(o,v.bottom-c.top+S+l.end);}return o}',
      'for(let i=n.length-1;i>=0;i--){let v=n[i].getBoundingClientRect();o=Math.max(o,v.bottom-c.top+S+l.end);if(v.width||v.height)break}return o}'],
    // getFirstVisibleMessageItem: jump to the first row whose bottom is below
    // the viewport's top, then walk on to the first message there.
    ['let n=r.getBoundingClientRect();for(let l of ee(e,t)){if(!l.dataset.messageId)continue;let c=l.getBoundingClientRect();if(c.bottom>n.top&&c.top<n.bottom)return l}return null}',
      'let n=r.getBoundingClientRect(),k=ee(e,t);for(let i=__firstPast(k.length,j=>k[j].getBoundingClientRect().bottom>n.top);i<k.length;i++){let l=k[i];if(!l.dataset.messageId)continue;let c=l.getBoundingClientRect();if(c.bottom>n.top&&c.top<n.bottom)return l;if(c.top>=n.bottom)break}return null}'],
    // getMessageScrollerVisibilityState, when an IntersectionObserver tracks
    // which rows are visible (every real browser): the current question is the
    // last question whose top has reached the reading line; find the last row
    // above the line by halving, then step back to the nearest question. The
    // no-observer fallback below is left as it was.
    ['let S=l.getBoundingClientRect(),o=S.top+t+r,b=typeof IntersectionObserver>"u",v=[],m=null;for(let L of ee(e,n)){',
      'let S=l.getBoundingClientRect(),o=S.top+t+r,b=typeof IntersectionObserver>"u",v=[],m=null,K=ee(e,n);if(!b){for(let L of K){let R=L.dataset.messageId;R&&c.has(R)&&v.push(R);}for(let i=__firstPast(K.length,j=>K[j].getBoundingClientRect().top>o+J)-1;i>=0;i--){let L=K[i];if(L.dataset.messageId&&L.dataset.scrollAnchor==="true"){m=L.dataset.messageId;break}}return v.length===0&&m===null?Q:{currentAnchorId:m,visibleMessageIds:v}}for(let L of K){'],
  ];
  return {
    name: 'cinderpaw:fast-message-scroller',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').includes('/@shadcn/react/dist/message-scroller/index.js')) return null;
      for (const [find, replace] of edits) {
        if (!code.includes(find)) {
          throw new Error(
            `fastMessageScroller (vite.config.ts): @shadcn/react's MessageScroller changed and this line is gone:\n  ${find}\n` +
            'Long chats would scroll slowly again. Check whether the new version still reads every row on scroll, then update or remove the plugin.',
          );
        }
        code = code.replace(find, replace);
      }
      return { code, map: null };
    },
  };
}

export default defineConfig({
  plugins: [fastMessageScroller(), react()],
  resolve: {
    alias: { '@': resolve(__dirname, './src') },
  },
  // Pre-bundled dependencies skip plugins, so `vite` (dev) would run the slow
  // scroller while the release ran the fast one.
  optimizeDeps: { exclude: ['@shadcn/react'] },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
  },
});
