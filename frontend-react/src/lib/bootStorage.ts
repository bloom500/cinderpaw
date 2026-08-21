/**
 * Run the storage-key migration before anything can read those keys.
 *
 * This exists as its own module for one reason: **evaluation order**. ES module
 * imports are hoisted and fully evaluated before any top-level statement of the
 * importing module runs. So calling `migrateLocalStorage()` at the top of
 * `main.tsx` — which is what it used to do — happens AFTER `./App` and its
 * whole import graph, including every zustand store, has already been created
 * and rehydrated.
 *
 * That ordering is what made the migration useless on the machine that needed
 * it. `useUI` rehydrated from an empty `cinderpaw-ui`, wrote its defaults
 * there, and by the time the migration looked, the destination key existed —
 * so the copy was skipped, and the person's theme, language and chosen voice
 * engines stayed at defaults with the real values sitting one key away.
 *
 * Importing this module for its side effect, as the first import in
 * `main.tsx`, puts the migration ahead of that graph: sibling imports are
 * evaluated in source order, so this module's body runs before `./App`'s
 * subtree is touched.
 */

import { migrateLocalStorage } from './localStorageMigration';

migrateLocalStorage();
