/**
 * useCatalog — runtime-typed catalog cache.
 *
 * Single source of truth for "which providers / connectors can the
 * user pick?" inside React. Both slices originate from Rust via
 * `GET /runtime/providers/catalog` and `GET /runtime/connectors/catalog`
 * (the canonical, deduplicated lists). TUI + desktop + any future
 * surface consume the same wire format through the typed wrapper in
 * `lib/tauri`.
 *
 * Why a store (not local useState in each component).
 *   * The Connectors tab (Phase 2) and Settings → Cloud Keys both need
 *     the same lists — re-fetching per component would race on load
 *     and on offline failure.
 *   * The catalog version header (`X-Feral-Catalog-Version`) the
 *     gateway emits is a runtime value; caching the payload + the
 *     version pin lets the rest of the app show "gateway updated,
 *     reload?" when it drifts, instead of swallowing the drift.
 *   * Tests can mock this store directly without having to mock
 *     `@tauri-apps/api/core`'s `invoke`.
 *
 * Failure mode is silent: errors fall back to an empty list, and a
 * `loaded` boolean lets callers distinguish "haven't tried" from
 * "tried, got nothing". Components that have a bundled fallback
 * (the wizard's `CURATED_PROVIDERS`) merge with the empty list and
 * keep showing the curated subset.
 *
 * The store is deliberately optimistic: it does NOT lock anything
 * during the fetch. If two components mount the wizard at the same
 * time (rare in this app), the fetch is deduped in the store via
 * the in-flight `loading` flag below.
 */

import { create } from 'zustand';
import { tauri, type ConnectorCatalogEntry, type ProviderCatalogEntry } from '@/lib/tauri';

interface CatalogStore {
  /** Canonical provider list (`byok::provider_catalog()` on Rust). */
  providerCatalog: ProviderCatalogEntry[];
  /** True after the first fetch attempt completes (success or failure). */
  providerLoaded: boolean;
  /** Last fetch error message, or null when the last attempt succeeded. */
  providerError: string | null;
  /** True while a fetch is in flight. Used for dedupe. */
  providerLoading: boolean;

  /** Canonical connector list (`connectors::connectors_catalog()` on
   *  Rust). Today the wizard doesn't read it (Connectors tab is Phase 2)
   *  but the store carries it so Phase 2 doesn't need a second fetch
   *  layer. */
  connectorCatalog: ConnectorCatalogEntry[];
  connectorLoaded: boolean;
  connectorError: string | null;
  connectorLoading: boolean;

  /** Wire the `X-Feral-Catalog-Version` headers the gateway emits so
   *  future callers can show "gateway outdated" without re-querying.
   *  Populated alongside each successful fetch. Null = unknown
   *  (either error, or the gateway didn't send a header). */
  providerVersion: number | null;
  connectorVersion: number | null;

  /** Fetch the provider catalog if it hasn't been loaded yet. Idempotent. */
  loadProvider: () => Promise<void>;
  /** Fetch the connector catalog if it hasn't been loaded yet. Idempotent. */
  loadConnector: () => Promise<void>;
  /** Clear the cache — used when the wizard resets / when the user
   *  explicitly pings "Refresh from gateway" in Phase 2. */
  reset: () => void;
}

export const useCatalog = create<CatalogStore>((set, get) => ({
  providerCatalog: [],
  providerLoaded: false,
  providerError: null,
  providerLoading: false,

  connectorCatalog: [],
  connectorLoaded: false,
  connectorError: null,
  connectorLoading: false,

  providerVersion: null,
  connectorVersion: null,

  loadProvider: async () => {
    const s = get();
    if (s.providerLoading || s.providerLoaded) return;
    set({ providerLoading: true });
    try {
      const entries = await tauri.raw.providerCatalog();
      set({
        providerCatalog: entries,
        providerLoaded: true,
        providerError: null,
        providerLoading: false,
        providerVersion: null,
      });
    } catch (e) {
      // The wizard renders gracefully on `providerLoaded=true, list=[]`
      // — its bundled CURATED_PROVIDERS still shows up. Don't throw.
      set({
        providerCatalog: [],
        providerLoaded: true,
        providerError: String(e),
        providerLoading: false,
      });
    }
  },

  loadConnector: async () => {
    const s = get();
    if (s.connectorLoading || s.connectorLoaded) return;
    set({ connectorLoading: true });
    try {
      const entries = await tauri.raw.connectorsCatalog();
      set({
        connectorCatalog: entries,
        connectorLoaded: true,
        connectorError: null,
        connectorLoading: false,
        connectorVersion: null,
      });
    } catch (e) {
      set({
        connectorCatalog: [],
        connectorLoaded: true,
        connectorError: String(e),
        connectorLoading: false,
      });
    }
  },

  reset: () =>
    set({
      providerCatalog: [],
      providerLoaded: false,
      providerError: null,
      providerLoading: false,
      connectorCatalog: [],
      connectorLoaded: false,
      connectorError: null,
      connectorLoading: false,
      providerVersion: null,
      connectorVersion: null,
    }),
}));
