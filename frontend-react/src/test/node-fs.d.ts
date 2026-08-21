/**
 * The one Node API the test suite uses, declared by hand.
 *
 * Vitest runs in Node, but this project has no `@types/node` and does not need
 * one for anything else — a whole dependency to type a single `readFileSync`
 * is a worse trade than these four lines. If `@types/node` is ever added for a
 * real reason, delete this file: the real declarations are a superset.
 */
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
