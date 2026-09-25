# Mozilla Readability

`Readability.js` is Mozilla's Readability, unmodified: the article extractor
Firefox's Reader View uses. The host compiles it into the binary
(`include_str!` in `src-tauri/src/browser.rs`) and runs it inside the page for
the reader view and `browser.read`.

- Upstream: https://github.com/mozilla/readability
- Version: 0.6.0, `Readability.js` from the `@mozilla/readability` npm package
- Licence: Apache-2.0, the same licence as Cinderpaw (see the root `LICENSE`).
  The copyright header in the file is upstream's and stays as it is.

To update: replace the file with the one from a newer npm package, change the
version above, and check the reader view on a few long articles.
