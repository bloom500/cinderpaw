#!/usr/bin/env python3
"""Licence inventory for the OpenClaw connector dependencies.

Answers one question before we import a connector: what licence does it drag
in? Reads the `_deps` blocks of `openclaw-channels.json`, asks the npm registry
for each package's declared licence, and writes a table to `audit-out/`.

Copyleft (GPL / AGPL / LGPL) is called out separately because it is the only
answer that can change whether a connector may be imported at all: Cinderpaw
ships as ONE `bun build --compile` binary, so a dependency is not "next to" our
code, it is linked into the same executable.

stdlib only, no network beyond registry.npmjs.org. Re-runnable:

    python scripts/openclaw/license-inventory.py
"""

import json
import os
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CHANNELS = os.path.join(ROOT, "scripts", "openclaw", "openclaw-channels.json")
AGENT_PKG = os.path.join(ROOT, "CinderpawAgent", "package.json")
NODE_MODULES = os.path.join(ROOT, "CinderpawAgent", "node_modules")
OUT = os.path.join(ROOT, "audit-out", "openclaw-dependency-licences.md")

# Matched against the SPDX string, lowercased.
#
# Strong copyleft reaches the whole work it is linked into, so it decides
# whether we may ship at all. `(?<![a-z])a?gpl` deliberately matches GPL and
# AGPL while NOT matching LGPL: the L is the entire difference between "this
# blocks the release" and "this is a notice plus a relinking obligation".
STRONG = re.compile(r"(?<![a-z])a?gpl|sspl|\bosl\b")
WEAK = ("lgpl", "mpl", "epl", "cddl", "cc-by-sa")

# Packages that are installed but deliberately NOT linked into the shipped
# executable, with the reason, because "installed" stopped meaning "shipped".
#
# This list exists because the report used to say GPL-3.0 `libsignal` blocked
# the release, kept saying it after the block was removed, and had no way to
# know the difference. An inventory that cries wolf forever gets read once and
# ignored afterwards, which is worse than one that never ran.
#
# The exclusion is NOT proof, and nothing in this file looks at the binary.
# `CinderpawAgent/tests/compiled-no-libsignal.test.ts` compiles the real entry
# point and scans its bytes; that test is the gate. This list only explains why
# the report is quiet.
NOT_BUNDLED = {
    "@whiskeysockets/baileys":
        "WhatsApp is loaded at runtime from a bundle the user builds and points "
        "CINDERPAW_WHATSAPP_MODULE at, so neither it nor its GPL-3.0 libsignal "
        "dependency is linked into our executable.",
    "vitest":
        "The test runner. It is never imported by src/index.ts, so nothing it "
        "drags in — vite, and vite's MPL-2.0 lightningcss — reaches the binary. "
        "The direct-dependency table above already skipped it for the same "
        "reason; this is that decision applied to its tree.",
}


def not_bundled_closure(installed, pulled_by):
    """Everything that left the binary when the packages in NOT_BUNDLED did.

    A dependency reached ONLY through an excluded package leaves with it, and
    that is the point: `libsignal` and `sharp` are not named in the list, they
    fall out because `baileys` was their only way in. Anything a second package
    also pulls in stays, because it is still linked.

    Computed to a fixpoint rather than in one pass, since the chain can be
    several deep. Returns a set of package names.
    """
    excluded = {n for n in NOT_BUNDLED if n in installed}
    changed = True
    while changed:
        changed = False
        for name in installed:
            if name in excluded:
                continue
            parents = pulled_by.get(name)
            # No parents means a top-level install: reached directly, so it
            # never leaves with somebody else.
            if not parents:
                continue
            if all(p in excluded for p in parents):
                excluded.add(name)
                changed = True
    return excluded


def fetch_licence(name, version):
    """Declared licence of one package version, or a reason we could not tell."""
    url = "https://registry.npmjs.org/%s/%s" % (name.replace("/", "%2F"), version)
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            doc = json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return "NOT PUBLISHED (%s@%s)" % (name, version)
        return "LOOKUP FAILED (HTTP %d)" % e.code
    except Exception as e:  # noqa: BLE001 - the reason is for a human, not a retry
        return "LOOKUP FAILED (%s)" % type(e).__name__
    lic = doc.get("license") or doc.get("licenses")
    if isinstance(lic, list):
        lic = " OR ".join(x.get("type", str(x)) if isinstance(x, dict) else str(x) for x in lic)
    elif isinstance(lic, dict):
        lic = lic.get("type", json.dumps(lic))
    return lic or "UNDECLARED"


def classify(lic):
    low = lic.lower()
    if lic.startswith(("LOOKUP FAILED", "NOT PUBLISHED")) or lic == "UNDECLARED":
        return "unknown"
    if STRONG.search(low):
        return "strong"
    if any(tag in low for tag in WEAK):
        return "weak"
    return "permissive"


MARK = {"strong": "**COPYLEFT (strong)**", "weak": "**COPYLEFT (weak)**", "unknown": "**UNKNOWN**", "permissive": ""}


def normalise(lic):
    if isinstance(lic, list):
        return " OR ".join(x.get("type", str(x)) if isinstance(x, dict) else str(x) for x in lic)
    if isinstance(lic, dict):
        return lic.get("type", "UNDECLARED")
    return str(lic) if lic else "UNDECLARED"


def scan_installed():
    """Every package present in node_modules, with its declared licence.

    This is the transitive truth, and it is the one that matters: `_deps` lists
    direct dependencies only, while `bun build --compile` links the whole tree
    into a single executable we then hand to strangers.

    Returns (packages, pulled_by) where packages maps name -> (version, licence)
    and pulled_by maps name -> sorted list of packages that declare it.
    """
    packages = {}
    pulled_by = {}
    if not os.path.isdir(NODE_MODULES):
        return packages, pulled_by
    for dirpath, _dirs, files in os.walk(NODE_MODULES):
        if "package.json" not in files:
            continue
        # Only real installs, i.e. `.../node_modules/name` or `.../node_modules/@scope/name`.
        # Without this, fixture packages inside a dependency's own test suite
        # (pino ships one called `transport`) land in the report as undeclared.
        parts = os.path.normpath(dirpath).replace("\\", "/").split("/")
        if len(parts) < 2 or (parts[-2] != "node_modules" and not (
                len(parts) >= 3 and parts[-3] == "node_modules" and parts[-2].startswith("@"))):
            continue
        try:
            with open(os.path.join(dirpath, "package.json"), encoding="utf-8") as fh:
                doc = json.load(fh)
        except Exception:  # noqa: BLE001 - a malformed manifest is not our problem to fix
            continue
        name, version = doc.get("name"), doc.get("version")
        if not name or not version:
            continue
        packages.setdefault(name, (version, normalise(doc.get("license") or doc.get("licenses"))))
        # peer and optional count too: `sharp` reaches us only as a peer
        # dependency of baileys, and reading `dependencies` alone reported it
        # as top level, which sent the first pass of this audit the wrong way.
        for block in ("dependencies", "optionalDependencies", "peerDependencies"):
            for child in (doc.get(block) or {}):
                pulled_by.setdefault(child, set()).add(name)
    return packages, {k: sorted(v) for k, v in pulled_by.items()}


def main():
    channels = json.load(open(CHANNELS, encoding="utf-8"))["channels"]

    # package -> {version -> set(connector ids)}
    wanted = {}
    for cid, chan in sorted(channels.items()):
        for name, ver in sorted((chan.get("_deps") or {}).items()):
            wanted.setdefault((name, ver), set()).add(cid)

    # What we already bundle today. `bun build --compile` inlines these, so they
    # carry the same obligation as a runtime dependency regardless of the block
    # they are declared in.
    agent = json.load(open(AGENT_PKG, encoding="utf-8"))
    shipped = {}
    for block in ("dependencies", "devDependencies"):
        for name, spec in (agent.get(block) or {}).items():
            if name.startswith("@types/") or name in ("typescript", "vitest"):
                continue
            ver = re.sub(r"^[\^~>=<\s]*", "", spec)
            if ver and ver != "latest":
                shipped[(name, ver)] = block

    keys = sorted(set(wanted) | set(shipped))
    with ThreadPoolExecutor(max_workers=8) as pool:
        licences = dict(zip(keys, pool.map(lambda k: fetch_licence(*k), keys)))

    rows = []
    for key in keys:
        name, ver = key
        lic = licences[key]
        kind = classify(lic)
        users = sorted(wanted.get(key, ()))
        where = ", ".join(users) if users else "—"
        rows.append((name, ver, lic, kind, where, shipped.get(key)))

    flagged = [r for r in rows if r[3] in ("strong", "weak", "unknown")]

    installed, pulled_by = scan_installed()
    excluded = not_bundled_closure(installed, pulled_by)
    # A name in NOT_BUNDLED that is no longer installed is a stale entry, and a
    # stale exclusion is how a real blocker walks back in unnoticed.
    stale_exclusions = sorted(n for n in NOT_BUNDLED if n not in installed)
    by_licence = {}
    installed_flagged = []
    left_the_binary = []
    for name, (ver, lic) in sorted(installed.items()):
        kind = classify(lic)
        if name in excluded:
            # Not counted in the licence table either: that table is headed
            # "what the compiled binary actually contains".
            if kind in ("strong", "weak", "unknown"):
                left_the_binary.append((name, ver, lic, kind))
            continue
        by_licence.setdefault(lic, []).append(name)
        if kind in ("strong", "weak", "unknown"):
            installed_flagged.append((name, ver, lic, kind))

    # Per-connector verdict: a connector is only as clean as its dirtiest dep.
    verdict = {}
    for cid in sorted(channels):
        deps = sorted((channels[cid].get("_deps") or {}).items())
        kinds = [classify(licences[(n, v)]) for n, v in deps]
        worst = "clean"
        for k in ("unknown", "strong", "weak"):
            if k in kinds:
                worst = k
                break
        bad = [n for (n, v), k in zip(deps, kinds) if k in ("strong", "weak", "unknown")]
        verdict[cid] = (worst, len(deps), bad)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        w = f.write
        w("# OpenClaw connector dependencies: licence inventory\n\n")
        w("Generated by `scripts/openclaw/license-inventory.py`. Licences are the\n")
        w("`license` field each package version declares on the npm registry, which is\n")
        w("what its author asserts, not an audit of the files inside the tarball.\n\n")
        w("Cinderpaw ships as one `bun build --compile` binary. A dependency is linked\n")
        w("into that executable, so a copyleft dependency is a question about the whole\n")
        w("binary, not about one folder.\n\n")
        w("- direct dependencies surveyed: %d\n" % len(rows))
        w("- of those, needing a decision (copyleft or unknown): %d\n" % len(flagged))
        w("- declared by our own `package.json` today: %d\n" % len(shipped))
        w("- packages actually installed (transitive): %d\n" % len(installed))
        w("- of those, kept out of the executable on purpose: %d\n" % len(excluded))
        w("- of the rest, copyleft or undeclared: %d\n\n" % len(installed_flagged))

        w("## Needs a decision\n\n")
        if flagged:
            w("| package | version | licence | class | wanted by |\n|---|---|---|---|---|\n")
            for name, ver, lic, kind, where, ship in flagged:
                w("| `%s` | %s | %s | %s | %s |\n" % (name, ver, lic, MARK[kind], where))
        else:
            w("None. Every dependency below is permissive.\n")
        w("\n")

        w("## Connectors, by worst dependency\n\n")
        w("| connector | deps | verdict | offenders |\n|---|---|---|---|\n")
        for cid, (worst, n, bad) in sorted(verdict.items(), key=lambda kv: (kv[1][0] == "clean", kv[0])):
            label = {"clean": "clean", "weak": "**COPYLEFT (weak)**", "strong": "**COPYLEFT (strong)**", "unknown": "**UNKNOWN**"}[worst]
            w("| %s | %d | %s | %s |\n" % (cid, n, label, ", ".join("`%s`" % b for b in bad) or "—"))
        w("\n")
        w("**\"clean\" here means the direct dependencies are clean, and that is not\n")
        w("the same as safe.** `whatsapp` reads clean because `baileys` is MIT, while\n")
        w("`baileys` in turn pulls `libsignal`, which is GPL-3.0. A connector can only\n")
        w("be checked transitively once it is installed, so read the next section\n")
        w("before importing any of these.\n\n")

        w("## What the compiled binary actually contains\n\n")
        if not installed:
            w("`CinderpawAgent/node_modules` is not installed, so this section is empty.\n")
            w("Run `bun install` there and re-run this script before trusting the report.\n\n")
        else:
            w("The transitive tree, read from `CinderpawAgent/node_modules` (%d packages).\n" % len(installed))
            w("The section above is direct dependencies only; this one is what `bun build\n")
            w("--compile` links into the executable we hand to a stranger.\n\n")
            w("| licence | packages |\n|---|---|\n")
            for lic, names in sorted(by_licence.items(), key=lambda kv: -len(kv[1])):
                kind = classify(lic)
                note = (" " + MARK[kind]) if MARK[kind] else ""
                sample = ", ".join("`%s`" % n for n in sorted(names)[:6])
                if len(names) > 6:
                    sample += ", and %d more" % (len(names) - 6)
                w("| %s%s | %d — %s |\n" % (lic, note, len(names), sample))
            w("\n")
            if installed_flagged:
                w("### Copyleft and undeclared, in the tree we ship\n\n")
                w("| package | version | licence | pulled in by |\n|---|---|---|---|\n")
                for name, ver, lic, kind in installed_flagged:
                    parents = pulled_by.get(name) or ["(top level)"]
                    w("| `%s` | %s | %s %s | %s |\n" % (
                        name, ver, lic, MARK[kind], ", ".join("`%s`" % p for p in parents)))
                w("\n")

        w("## Kept out of the executable on purpose\n\n")
        if not excluded:
            w("Nothing. Every installed package is linked into the binary.\n\n")
        else:
            w("These are installed — for tests, and for anyone who opts in — but they\n")
            w("are NOT linked into the executable a stranger downloads, so their\n")
            w("licences are not a question about our binary. Each root is listed with\n")
            w("the reason; everything under it left because that root was its only way\n")
            w("in.\n\n")
            for root in sorted(NOT_BUNDLED):
                w("- `%s` — %s\n" % (root, NOT_BUNDLED[root]))
            w("\n")
            if left_the_binary:
                w("| package | version | licence | left with |\n|---|---|---|---|\n")
                for name, ver, lic, kind in left_the_binary:
                    parents = pulled_by.get(name) or ["(top level)"]
                    w("| `%s` | %s | %s %s | %s |\n" % (
                        name, ver, lic, MARK[kind], ", ".join("`%s`" % p for p in parents)))
                w("\n")
            w("**This section is an explanation, not a proof.** Nothing in this script\n")
            w("opens the binary. `CinderpawAgent/tests/compiled-no-libsignal.test.ts`\n")
            w("compiles the real entry point and scans its bytes, and that test is what\n")
            w("actually holds this true. If it is deleted, this section becomes a claim\n")
            w("nobody is checking.\n\n")
        if stale_exclusions:
            w("### Stale exclusions\n\n")
            w("Named as not-bundled but not installed at all. Remove them from\n")
            w("`NOT_BUNDLED`, or the next package to take that name inherits a pass:\n\n")
            for name in stale_exclusions:
                w("- `%s`\n" % name)
            w("\n")

        w("## Every package\n\n")
        w("| package | version | licence | wanted by | bundled today |\n|---|---|---|---|---|\n")
        for name, ver, lic, kind, where, ship in rows:
            w("| `%s` | %s | %s%s | %s | %s |\n" % (
                name, ver, lic, (" " + MARK[kind]) if MARK[kind] else "", where, ship or "no"))

    print("wrote %s" % OUT)
    print("direct: %d packages, %d need a decision" % (len(rows), len(flagged)))
    for name, ver, lic, kind, where, ship in flagged:
        print("  %-42s %-12s %-20s %s" % (name, ver, lic, where))
    print("installed: %d packages, %d kept out of the binary, %d copyleft or undeclared in it" % (
        len(installed), len(excluded), len(installed_flagged)))
    for name, ver, lic, kind in installed_flagged:
        print("  %-42s %-12s %-28s via %s" % (
            name, ver, lic, ", ".join(pulled_by.get(name) or ["(top level)"])))
    for name, ver, lic, kind in left_the_binary:
        print("  (not bundled) %-28s %-12s %s" % (name, ver, lic))
    for name in stale_exclusions:
        print("  STALE EXCLUSION: %s is in NOT_BUNDLED but is not installed" % name)
    # A stale exclusion still needs a human: it is the one way this file can
    # start lying on its own.
    return 1 if installed_flagged or flagged or stale_exclusions else 0


def self_check():
    """The one thing worth testing here: which licences block a release.

    Run with `python scripts/openclaw/license-inventory.py --self-check`.
    No network, no node_modules.
    """
    cases = {
        "MIT": "permissive",
        "Apache-2.0": "permissive",
        "BSD-3-Clause": "permissive",
        "ISC": "permissive",
        "Unlicense": "permissive",          # nostr-tools, the cheapest connector
        "BlueOak-1.0.0": "permissive",
        "0BSD": "permissive",
        "GPL-3.0": "strong",                # libsignal, via baileys
        "GPL-2.0-only": "strong",
        "AGPL-3.0-or-later": "strong",
        "SSPL-1.0": "strong",
        "LGPL-3.0-or-later": "weak",        # the L is the whole difference
        "Apache-2.0 AND LGPL-3.0-or-later": "weak",   # @img/sharp-win32-x64
        "MPL-2.0": "weak",                  # lightningcss
        "(MIT OR GPL-3.0)": "strong",       # err toward asking a human
        "UNDECLARED": "unknown",
        "LOOKUP FAILED (HTTP 500)": "unknown",
    }
    for lic, want in cases.items():
        got = classify(lic)
        assert got == want, "classify(%r) = %r, expected %r" % (lic, got, want)

    # The second thing worth testing: what leaves the binary when a root does.
    # Shaped like the real tree — baileys pulls libsignal and sharp, sharp
    # pulls a platform binary, and `ws` is also pulled by something we DO ship.
    installed = dict.fromkeys(
        ["@whiskeysockets/baileys", "libsignal", "sharp", "@img/sharp-win32-x64",
         "ws", "discord.js", "typescript"], ("0.0.0", "MIT"))
    pulled_by = {
        "libsignal": ["@whiskeysockets/baileys"],
        "sharp": ["@whiskeysockets/baileys"],
        "@img/sharp-win32-x64": ["sharp"],
        "ws": ["@whiskeysockets/baileys", "discord.js"],
    }
    gone = not_bundled_closure(installed, pulled_by)
    # Two deep: the platform binary leaves because sharp left because baileys did.
    for name in ("@whiskeysockets/baileys", "libsignal", "sharp", "@img/sharp-win32-x64"):
        assert name in gone, "%s should have left the binary with baileys" % name
    # Still linked: discord.js pulls it too, so it is in the executable and its
    # licence is still our problem.
    assert "ws" not in gone, "ws has a second parent we ship and must stay counted"
    # A top-level install is reached directly and never leaves with anyone.
    assert "discord.js" not in gone and "typescript" not in gone

    print("self-check ok: %d licence strings classified, %d packages leave with baileys"
          % (len(cases), len(gone)))


if __name__ == "__main__":
    if "--self-check" in sys.argv:
        self_check()
        sys.exit(0)
    sys.exit(main())
