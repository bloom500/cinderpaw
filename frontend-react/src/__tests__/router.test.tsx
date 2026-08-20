import { describe, it, expect, vi } from 'vitest';

// Importing the router pulls in the whole shell, and several stores call
// `listen()` at module scope. Outside a Tauri window those reject, and an
// unhandled rejection fails the run even though every assertion passed.
vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));
import { isValidElement } from 'react';
import { router } from '@/router';
import { CATS } from '@/pages/SettingsPage';

/**
 * Phase 5 S1. `/extensions`, `/connectors` and `/memory-layers` used to be
 * pages whose ONLY entry point was the sidebar, which Phase 5 deletes. They
 * are Settings categories now, and the old paths stay alive as redirects.
 *
 * Both halves are checked here because each fails silently on its own: a
 * missing route renders a blank page under the shell, and a redirect to a
 * category that does not exist quietly falls back to General — no error, no
 * crash, just the wrong screen with no way to tell.
 */

const children = router.routes[0].children ?? [];
const routeFor = (path: string) => children.find((r) => r.path === path);

const MOVED: Record<string, string> = {
  extensions: 'capabilities',
  connectors: 'accounts',
  'memory-layers': 'memory',
  'memory-graph': 'memory',
};

describe('the routes the sidebar used to own', () => {
  for (const [path, cat] of Object.entries(MOVED)) {
    it(`/${path} redirects to Settings -> ${cat}`, () => {
      const route = routeFor(path);
      expect(route, `/${path} has no route at all`).toBeDefined();
      const el = route!.element;
      expect(isValidElement(el)).toBe(true);
      const props = (el as React.ReactElement<{ to: string; replace?: boolean }>).props;
      expect(props.to).toBe(`/settings?cat=${cat}`);
      // Without `replace`, Back returns to the redirect and bounces forward again.
      expect(props.replace).toBe(true);
    });

    it(`Settings actually has a "${cat}" category`, () => {
      expect(CATS.map((c) => c.id)).toContain(cat);
    });
  }

  it('keeps chat, models and settings as real pages', () => {
    for (const path of ['chat', 'models', 'settings']) {
      expect(routeFor(path), `/${path} disappeared`).toBeDefined();
    }
  });
});
