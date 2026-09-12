#!/usr/bin/env python3
"""Extract the declarative channel and provider manifests from an OpenClaw checkout.

OpenClaw (MIT, https://github.com/openclaw/openclaw) describes every channel
and model provider in data rather than in code: a `openclaw.channel` block in
each extension's package.json, and an `openclaw.plugin.json` beside it. That
data is the part of their work we can take wholesale, because it has no
coupling to their runtime at all. Their *implementations* are ~417k lines
written against their own host and are not portable; see
docs/openclaw-import.md.

Run it against a local clone:

    python scripts/openclaw/extract-manifests.py --repo /path/to/openclaw

It writes two JSON files next to this script and prints a summary. Re-running
against a newer clone is how we find out what upstream changed: the output is
committed, so `git diff` after a re-run IS the drift report. That is the thing
we did not have for `src/vendor/tool-call-repair`, where the README still
claimed a verbatim copy after the file had diverged.
"""

import argparse
import json
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent

# The six channels OpenClaw ships that are not third-party platforms: their own
# agent-to-agent protocol, their own chat products, and a QA harness. Listed by
# name rather than detected, because "is this a real platform" is a judgement
# and a silent heuristic would quietly drop a real one the day they rename it.
NOT_PLATFORMS = {"a2a", "buzz", "clickclack", "qa-channel", "raft", "reef"}


def upstream_commit(repo: pathlib.Path) -> str | None:
    """The exact commit the extraction came from, so drift is answerable."""
    try:
        out = subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True,
        )
        return out.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def read_json(path: pathlib.Path) -> dict:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def extract(repo: pathlib.Path) -> tuple[dict, dict]:
    extensions = repo / "extensions"
    if not extensions.is_dir():
        sys.exit(f"not an OpenClaw checkout: {extensions} does not exist")

    channels: dict[str, dict] = {}
    providers: dict[str, dict] = {}
    for entry in sorted(extensions.iterdir()):
        if not entry.is_dir():
            continue
        package = read_json(entry / "package.json")
        manifest = read_json(entry / "openclaw.plugin.json")

        channel = (package.get("openclaw") or {}).get("channel")
        if channel and entry.name not in NOT_PLATFORMS:
            # Their npm dependencies ride along: this is the list that decides
            # whether a platform can be shipped in a closed-source product, and
            # it is the one thing here that is expensive to discover late.
            channel = dict(channel)
            channel["_deps"] = package.get("dependencies") or {}
            channels[entry.name] = channel

        if manifest.get("providers") or manifest.get("modelCatalog"):
            providers[entry.name] = manifest

    return channels, providers


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repo", required=True, type=pathlib.Path,
                    help="path to a local OpenClaw clone")
    args = ap.parse_args()

    channels, providers = extract(args.repo)
    header = {
        "_source": "https://github.com/openclaw/openclaw",
        "_license": "MIT, Copyright (c) 2026 OpenClaw Foundation",
        "_upstreamCommit": upstream_commit(args.repo),
    }

    for name, data in (("channels", channels), ("providers", providers)):
        path = HERE / f"openclaw-{name}.json"
        with path.open("w", encoding="utf-8", newline="\n") as fh:
            json.dump({**header, name: data}, fh, indent=1, ensure_ascii=False)
            fh.write("\n")
        print(f"{len(data):3} {name} -> {path.name}")

    secrets = sum(
        1
        for c in channels.values()
        for f in ((c.get("setup") or {}).get("fields") or [])
        if f.get("sensitive")
    )
    print(f"{secrets} sensitive setup fields across {len(channels)} platforms")


if __name__ == "__main__":
    main()
