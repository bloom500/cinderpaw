import { describe, it, expect } from 'vitest';
import { migrateLocalStorage } from '@/lib/localStorageMigration';

/** A Storage that behaves like the real one, without needing a browser. */
function fakeStore(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { map.set(k, v); },
  } as Storage;
}

describe('migrateLocalStorage', () => {
  it('carries the old keys across and clears them', () => {
    const store = fakeStore({ 'feral-ui': '{"state":{"theme":"light"}}' });
    const result = migrateLocalStorage(store);
    expect(result.moved).toBe(1);
    expect(store.getItem('cinderpaw-ui')).toBe('{"state":{"theme":"light"}}');
    expect(store.getItem('feral-ui')).toBeNull();
  });

  /**
   * The one that cost somebody their settings.
   *
   * A destination key can exist for a reason nobody wants: a store module that
   * rehydrated and wrote its defaults before this ran. The copy is correctly
   * skipped — the app has been writing to the new key — but deleting the old
   * one on the way past destroys the only real copy of what the person had.
   */
  it('does not delete the old key when it skipped the copy', () => {
    const store = fakeStore({
      'feral-ui': '{"state":{"theme":"light","sttProvider":"groq"}}',
      'cinderpaw-ui': '{"state":{"theme":"dark","sttProvider":null}}',
    });
    const result = migrateLocalStorage(store);

    expect(result.moved).toBe(0);
    expect(store.getItem('cinderpaw-ui')).toBe('{"state":{"theme":"dark","sttProvider":null}}');
    expect(store.getItem('feral-ui')).not.toBeNull();
  });

  it('runs once and then stands down', () => {
    const store = fakeStore({ 'feral-model': 'x' });
    expect(migrateLocalStorage(store).alreadyDone).toBe(false);

    const second = migrateLocalStorage(store);
    expect(second.alreadyDone).toBe(true);
    expect(second.moved).toBe(0);
  });

  it('is a no-op on a fresh install', () => {
    const store = fakeStore();
    expect(migrateLocalStorage(store).moved).toBe(0);
  });

  it('never refuses to start when storage throws', () => {
    const hostile = {
      getItem: () => { throw new Error('storage disabled'); },
      setItem: () => { throw new Error('storage disabled'); },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } as unknown as Storage;
    expect(() => migrateLocalStorage(hostile)).not.toThrow();
  });
});
