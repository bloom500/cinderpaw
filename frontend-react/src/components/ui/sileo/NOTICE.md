# Sileo (vendored)

Source: https://github.com/hiaaryan/sileo, `packages/sileo/src`, commit b70fd826537d (24 Oct 2026).
License: MIT (declared in the package's package.json), (c) Aaryan.

Vendored, not installed: the package depends on `motion`, and the app already has the same library
as `framer-motion` 12. The only changes are that import, and dropping the `"use client"` lines
(a Next.js directive with no meaning in Vite). Keep it that way so an update stays a copy.
