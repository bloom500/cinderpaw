import { describe, expect, test } from 'vitest';

/**
 * Tauri converts camelCase argument keys from JS into the Rust command's
 * snake_case parameters. Passing snake_case from JS therefore does NOT work:
 * the key arrives unconverted and the command rejects the call with
 * "missing required key <camelCase>".
 *
 * This is a test rather than a note because the failure is invisible until
 * someone clicks the button. Three human approval gates shipped broken this
 * way and stayed broken:
 *
 *   cinderpaw_code_patch_resolve      { patch_id: … }    — the L3 code-patch gate
 *   cinderpaw_lora_review_resolve     { card_id: … }     — the LoRA promotion gate
 *   cinderpaw_cowork_approval_resolve { request_id: … }  — the cowork approval gate
 *
 * Every one of them is a place where a person says yes or no to something the
 * agent wants to do, and every one of them silently could not be answered.
 * Nothing else in the app is affected: the rest of the file already passes
 * camelCase, which is why the convention was easy to break by copying the
 * Rust signature instead of a neighbouring call.
 *
 * Source text, not the module: this checks how the calls are WRITTEN, and
 * importing would only tell us they exist.
 */

// No @types/node in this package, so the dynamic import is cast the same way
// glass.test.ts does it. The path is relative to the vitest root
// (frontend-react), which is also why import.meta.url is not used: the
// browser-ish test environment does not give this file a file: URL.
const { readFileSync } = (await import('node:fs')) as unknown as {
  readFileSync: (path: string, encoding: string) => string;
};
const SOURCE = readFileSync('src/lib/tauri/index.ts', 'utf8');

/** `{ some_key: x }` or `{ some_key }` inside an invoke argument object. */
const SNAKE_KEY = /\b[a-z][a-z0-9]*_[a-z0-9_]+\s*[,:}]/;

describe('invoke() argument keys are camelCase', () => {
  test('no invoke passes a snake_case key', () => {
    const offenders: string[] = [];
    // One call can wrap across lines, so scan from each `invoke<` to the end
    // of its argument object rather than line by line.
    for (const m of SOURCE.matchAll(/invoke<[^>]*>\(\s*'([a-z_0-9]+)'\s*,\s*\{([^}]*)\}/g)) {
      const [, command, args] = m;
      if (SNAKE_KEY.test(args!)) offenders.push(`${command}: {${args!.trim()}}`);
    }
    expect(offenders).toEqual([]);
  });

  test('the pattern would actually catch one', () => {
    // A guard that cannot fail is not a guard.
    expect(SNAKE_KEY.test(' patch_id: patchId ')).toBe(true);
    expect(SNAKE_KEY.test(' patchId, action ')).toBe(false);
  });
});
