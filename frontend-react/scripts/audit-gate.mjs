#!/usr/bin/env node
/**
 * Frontend dependency audit gate.
 *
 * Replaces a bare `npm audit --omit=dev --audit-level=high` in CI. Same
 * verdict, with one addition: advisories listed in ALLOWED below are reported
 * and skipped instead of failing the build.
 *
 * Why this exists rather than a plain `npm audit`: npm's only remediation is
 * "install the version that has no advisory", which is not always the safer
 * version. When the sole `npm audit fix --force` path is a DOWNGRADE that
 * re-opens advisories which do affect us, in exchange for closing one that
 * cannot, a bare audit gate forces the wrong trade. This file makes that
 * decision explicit, reviewable, and dated instead of silent.
 *
 * Rules for adding an entry:
 *   - the advisory must be unreachable in this app, with the reason written
 *     down in terms of what this app actually does, not "low risk";
 *   - `recheck` is a date, not a hope — when a fixed version ships, delete
 *     the entry and upgrade;
 *   - anything not listed here still fails the build. This is an allowlist,
 *     never a severity threshold.
 *
 * Stdlib only, no dependency: the audit gate must not itself add supply chain.
 */

import { execSync } from "node:child_process";

/** @type {Array<{id: string, package: string, why: string, recheck: string}>} */
const ALLOWED = [
  {
    id: "GHSA-qwww-vcr4-c8h2",
    package: "react-router",
    why:
      "RSC Mode CSRF: an action can run before the 400 response when React " +
      "Router serves React Server Components. This app is a Tauri desktop SPA " +
      "that routes with createMemoryRouter (src/router.tsx) — no server, no " +
      "SSR, no RSC renderer, and no HTTP request ever reaches the router. " +
      "The affected range is 7.12.0-8.2.0 and react-router-dom has no release " +
      "above it (7.18.1 is latest), so npm's only remediation is a downgrade " +
      "to 7.11.0. That would re-open GHSA-wrjc-x8rr-h8h6 (open redirect via " +
      "backslash in <Link>/useNavigate), GHSA-h8fp-f39c-q6mh, " +
      "GHSA-337j-9hxr-rhxg and GHSA-chx6-hx7r-mcp5 — the first of which does " +
      "apply to client-side routing. Staying on 7.18.1 is the safer position.",
    recheck: "2026-09-01",
  },
];

/**
 * A fixed literal command, not an argv array: `npm` is `npm.cmd` on Windows
 * and Node 24 refuses to spawn a .cmd without a shell, while passing an argv
 * array THROUGH a shell is unescaped concatenation (DEP0190). A constant
 * string with no interpolation sidesteps both — there is no user input here
 * to escape.
 */
const AUDIT_CMD = "npm audit --omit=dev --audit-level=high --json";

const raw = (() => {
  try {
    // npm audit exits non-zero whenever it finds anything; the JSON on stdout
    // is still the payload we want, so this script owns the verdict.
    return execSync(AUDIT_CMD, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  } catch (err) {
    if (typeof err.stdout === "string" && err.stdout.trim()) return err.stdout;
    throw err;
  }
})();

const report = JSON.parse(raw);
const advisoriesOf = (vuln) =>
  (vuln.via ?? [])
    .filter((v) => typeof v === "object" && v.url)
    .map((v) => ({ id: String(v.url).split("/").pop(), title: v.title, url: v.url }));

const blocking = [];
const waived = [];

for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  if (vuln.severity !== "high" && vuln.severity !== "critical") continue;
  for (const adv of advisoriesOf(vuln)) {
    const allow = ALLOWED.find((a) => a.id === adv.id);
    if (allow) waived.push({ ...adv, package: name, allow });
    else blocking.push({ ...adv, package: name, severity: vuln.severity });
  }
}

for (const w of waived) {
  console.log(`WAIVED  ${w.id}  ${w.package} — ${w.title}`);
  console.log(`        recheck by ${w.allow.recheck}`);
}

// An entry that no longer matches anything is stale: the advisory was fixed,
// re-scoped, or the dependency is gone. Say so — a waiver nobody revisits is
// how an allowlist rots into a severity threshold.
for (const a of ALLOWED) {
  if (!waived.some((w) => w.id === a.id)) {
    console.log(`STALE   ${a.id} (${a.package}) no longer reported — remove it from ALLOWED.`);
  }
}

if (blocking.length > 0) {
  console.error(`\n${blocking.length} unwaived high/critical advisory(ies):`);
  for (const b of blocking) console.error(`  ${b.severity}  ${b.id}  ${b.package} — ${b.title}\n    ${b.url}`);
  console.error("\nFix the dependency, or add a justified entry to ALLOWED in this file.");
  process.exit(1);
}

console.log(`\nAudit gate passed (${waived.length} waived, 0 blocking).`);
