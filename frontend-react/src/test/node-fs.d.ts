/**
 * The two Node APIs the test suite uses, declared by hand.
 *
 * Vitest runs in Node, but this project has no `@types/node` and does not need
 * one for anything else — a whole dependency to type two functions is a worse
 * trade than these few lines. If `@types/node` is ever added for a
 * real reason, delete this file: the real declarations are a superset.
 */
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  /**
   * Node 22+. Typed as returning paths rather than Dirents because that is the
   * shape the no-options call returns, and it is the only call this suite
   * makes — a wider signature here would be a guess, not generosity.
   */
  export function globSync(pattern: string): string[];
}
