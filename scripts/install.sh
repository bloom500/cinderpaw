#!/usr/bin/env bash
#
# Cinderpaw universal installer — one command, OS auto-detected:
#
#   curl -fsSL https://raw.githubusercontent.com/bloom500/cinderpaw/main/scripts/install.sh | bash
#
# What it picks per platform:
#   Linux + display        → latest .deb / .rpm desktop app (apt/dnf)
#   Linux headless (VPS)   → builds the `cinderpaw` CLI + gateway from source
#                            (no llama.cpp / GPU toolchain needed)
#   macOS                  → latest .dmg, mounted and copied to /Applications,
#                            quarantine flag cleared
#   Windows                → not this script; see the PowerShell one-liner in
#                            the README (or run this under WSL for the CLI)
#
# Flags (pass after `bash -s --`):
#   --desktop    force the desktop install on Linux
#   --headless   force the from-source CLI install on Linux
#
set -euo pipefail

# The canonical name, not the pre-rename one. GitHub redirects the old path,
# but a redirect is only good until somebody registers the freed-up name — and
# an installer that clones whatever now lives at the old address is an
# installer that runs a stranger's code on a trusted machine.
REPO="bloom500/cinderpaw"
API="https://api.github.com/repos/${REPO}/releases/latest"

say()  { printf '\033[1;32m[cinderpaw]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[cinderpaw]\033[0m %s\n' "$*" >&2; exit 1; }

MODE="auto"
for arg in "$@"; do
  case "$arg" in
    --desktop)  MODE="desktop" ;;
    --headless) MODE="headless" ;;
    *) fail "unknown flag: $arg (use --desktop or --headless)" ;;
  esac
done

command -v curl >/dev/null || fail "curl is required"

# Resolve a release asset URL by filename pattern (no jq dependency).
asset_url() {
  curl -fsSL "$API" | sed -n 's/.*"browser_download_url": "\([^"]*'"$1"'\)".*/\1/p' | head -1
}

# ── macOS ────────────────────────────────────────────────────────────────────
install_macos() {
  local arch pattern url dmg mnt
  arch="$(uname -m)"
  case "$arch" in
    arm64) pattern='aarch64\.dmg' ;;
    *)     pattern='x64\.dmg' ;;
  esac
  url="$(asset_url "$pattern")"
  [ -n "$url" ] || fail "could not find a .dmg for $arch in the latest release"
  dmg="$(mktemp -d)/cinderpaw.dmg"
  say "downloading $(basename "$url")…"
  curl -fL --progress-bar -o "$dmg" "$url"
  mnt="$(hdiutil attach "$dmg" -nobrowse | awk '/\/Volumes\// { print $NF; exit }')"
  say "installing to /Applications…"
  rm -rf /Applications/Cinderpaw.app
  cp -R "$mnt"/Cinderpaw.app /Applications/
  hdiutil detach "$mnt" -quiet
  # Clear the quarantine flag (Cinderpaw isn't Apple-notarized yet).
  xattr -cr /Applications/Cinderpaw.app || true
  say "done — launch Cinderpaw from /Applications."
}

# ── Linux desktop (.deb / .rpm) ──────────────────────────────────────────────
install_linux_desktop() {
  local sudo_cmd=""
  [ "$(id -u)" -eq 0 ] || sudo_cmd="sudo"
  local url tmp
  if command -v apt-get >/dev/null; then
    url="$(asset_url 'amd64\.deb')"
    [ -n "$url" ] || fail "no .deb asset found in the latest release"
    tmp="$(mktemp -d)/$(basename "$url")"
    say "downloading $(basename "$url")…"
    curl -fL --progress-bar -o "$tmp" "$url"
    say "installing (apt)…"
    $sudo_cmd apt-get install -y "$tmp"
  elif command -v dnf >/dev/null; then
    url="$(asset_url 'x86_64\.rpm')"
    [ -n "$url" ] || fail "no .rpm asset found in the latest release"
    tmp="$(mktemp -d)/$(basename "$url")"
    say "downloading $(basename "$url")…"
    curl -fL --progress-bar -o "$tmp" "$url"
    say "installing (dnf)…"
    $sudo_cmd dnf install -y "$tmp"
  else
    fail "no apt or dnf found — use --headless for the from-source CLI install"
  fi
  say "done — launch Cinderpaw from your app menu (or run: cinderpaw)."
}

# ── Linux headless (build the CLI + gateway from source) ────────────────────
install_linux_headless() {
  # System deps: skip entirely if they're already present (so an unprivileged
  # user can run this after an admin installed them once). Only reach for
  # root/sudo when something is actually missing.
  if command -v apt-get >/dev/null; then
    local missing=()
    for pkg in build-essential pkg-config libssl-dev libdbus-1-dev cmake git unzip ca-certificates; do
      dpkg -s "$pkg" &>/dev/null || missing+=("$pkg")
    done
    if [ "${#missing[@]}" -gt 0 ]; then
      if [ "$(id -u)" -eq 0 ]; then
        say "installing build dependencies: ${missing[*]}"
        apt-get update -qq
        apt-get install -y --no-install-recommends "${missing[@]}"
      elif sudo -n true 2>/dev/null; then
        say "installing build dependencies (sudo): ${missing[*]}"
        sudo apt-get update -qq
        sudo apt-get install -y --no-install-recommends "${missing[@]}"
      else
        fail "missing system packages: ${missing[*]}
Run this once as root, then re-run the installer as this user:
  apt-get install -y ${missing[*]}"
      fi
    else
      say "build dependencies already present — skipping"
    fi
  elif command -v dnf >/dev/null; then
    local sudo_cmd=""
    [ "$(id -u)" -eq 0 ] || sudo_cmd="sudo"
    say "installing build dependencies…"
    $sudo_cmd dnf install -y gcc gcc-c++ make pkgconf-pkg-config openssl-devel dbus-devel cmake git unzip ca-certificates
  else
    fail "unsupported distro (need apt or dnf)"
  fi

  if ! command -v cargo >/dev/null && [ ! -x "$HOME/.cargo/bin/cargo" ]; then
    say "installing Rust (rustup, minimal profile)…"
    curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
  fi
  # shellcheck disable=SC1091
  [ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"

  if ! command -v bun >/dev/null && [ ! -x "$HOME/.bun/bin/bun" ]; then
    say "installing Bun…"
    curl -fsSL https://bun.sh/install | bash
  fi

  # Go toolchain: the terminal chat/setup UI (cinderpaw-tui) is a Go/Bubble Tea app.
  # Ubuntu's apt Go is too old for tui/go.mod (needs 1.26+), so fetch the
  # official tarball into ~/.local/go when no new-enough `go` is on PATH.
  local go_version="1.26.4"
  if ! command -v go >/dev/null && [ ! -x "$HOME/.local/go/bin/go" ]; then
    local goarch
    case "$(uname -m)" in
      x86_64)        goarch="amd64" ;;
      aarch64|arm64) goarch="arm64" ;;
      *) fail "unsupported CPU for Go: $(uname -m)" ;;
    esac
    say "installing Go ${go_version} (for the chat TUI)…"
    mkdir -p "$HOME/.local"
    rm -rf "$HOME/.local/go"
    curl -fsSL "https://go.dev/dl/go${go_version}.linux-${goarch}.tar.gz" | tar -xz -C "$HOME/.local"
  fi
  export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/.local/go/bin:$PATH"

  local src="$HOME/src/cinderpaw"
  mkdir -p "$HOME/src"
  if [ -d "$src/.git" ]; then
    say "updating existing checkout…"
    # A machine that has been running the agent has a DIRTY checkout, and not by
    # accident: code-RSI edits its own sources in place, so `agent-loop.ts` and
    # friends are modified on exactly the installs that have been working
    # longest. `git pull` refuses, prints git's own message about committing or
    # stashing, and the update simply never happens again on that machine.
    #
    # So park the changes instead of demanding the user does. Stashed, never
    # discarded: some of that diff is the agent's own work, and an installer
    # that throws it away to save itself a step is an installer that eats what
    # the product produced.
    if [ -n "$(git -C "$src" status --porcelain)" ]; then
      local stamp; stamp="$(date +%Y%m%d-%H%M%S)"
      say "local changes found — parking them in a stash before updating"
      if git -C "$src" stash push --include-untracked -m "cinderpaw installer $stamp" >/dev/null; then
        say "  restore later with: git -C $src stash list   (then: git -C $src stash pop)"
      else
        fail "could not stash local changes in $src — commit or move them, then re-run"
      fi
    fi
    # An existing checkout still points at the pre-rename URL and only works
    # through GitHub's redirect. Pin it to the canonical one, for the same
    # reason REPO is pinned above.
    local origin; origin="$(git -C "$src" remote get-url origin 2>/dev/null || true)"
    case "$origin" in
      *bloom500/cinderpaw*)
        say "repointing origin to ${REPO} (the repo was renamed)"
        git -C "$src" remote set-url origin "https://github.com/${REPO}"
        ;;
    esac
    if ! git -C "$src" pull --ff-only; then
      # Diverged, not merely behind: fast-forward is impossible and merging
      # somebody's checkout from a shell script is how a repo gets mangled.
      fail "$src has diverged from ${REPO} and cannot fast-forward.
       Inspect it (git -C $src status), or move it aside and re-run to clone fresh."
    fi
  else
    say "cloning ${REPO}…"
    git clone --depth 1 "https://github.com/${REPO}" "$src"
  fi

  say "building the sidecar (cinderpaw-agent)…"
  ( cd "$src/CinderpawAgent" && bun install --frozen-lockfile && bun run build )

  # --no-default-features: the CLI's default `inference` feature pulls in
  # llama.cpp (heavy build, needs clang). Headless gateways use a cloud
  # provider via CINDERPAW_BASE_URL/CINDERPAW_API_KEY/CINDERPAW_MODEL instead.
  say "building the CLI (cinderpaw) — no local inference engine…"
  ( cd "$src" && cargo build --release -p cinderpaw-cli --no-default-features )

  # The terminal chat/setup UI. `cinderpaw chat` and `cinderpaw setup --classic`
  # look for `cinderpaw-tui` next to the CLI binary; without it those commands
  # error out.
  say "building the chat TUI (cinderpaw-tui)…"
  ( cd "$src/tui" && go build -o cinderpaw-tui . )

  # The sidecar + TUI binaries MUST live next to the CLI (find_binary contract).
  mkdir -p "$HOME/.local/bin"
  install -m 0755 "$src/target/release/cinderpaw-cli"        "$HOME/.local/bin/cinderpaw"
  install -m 0755 "$src/CinderpawAgent/dist/cinderpaw-agent" "$HOME/.local/bin/cinderpaw-agent"
  install -m 0755 "$src/tui/cinderpaw-tui"                   "$HOME/.local/bin/cinderpaw-tui"

  # The command used to be called `feral`. A machine that has been running it
  # for months has that name in systemd units, cron lines and shell history, and
  # a rename that turns all of those into "command not found" is a rename that
  # broke the install. The alias costs one symlink.
  ln -sfn "$HOME/.local/bin/cinderpaw" "$HOME/.local/bin/feral"

  # Self-source bundle (code-RSI): the supervisor probes <exe>/../share/cinderpaw
  # for CinderpawAgent/package.json and provisions ~/.cinderpaw/self-src from it —
  # same flow as the desktop app's Tauri resources. `git archive` gives a
  # clean tracked-files-only tree (no node_modules/target). This also ships
  # scripts/ (rebuild + LoRA trainer setup) to headless users.
  say "bundling self-sources (code-RSI)…"
  local share="$HOME/.local/share/cinderpaw"
  rm -rf "$share/CinderpawAgent" "$share/scripts"
  mkdir -p "$share"
  git -C "$src" archive HEAD CinderpawAgent scripts | tar -x -C "$share"

  say "installed: $HOME/.local/bin/cinderpaw (+ cinderpaw-agent, cinderpaw-tui, self-src bundle, and a feral alias)"
  # Persist ~/.local/bin on PATH for future logins (idempotent — a fresh SSH
  # session otherwise loses the export and `cinderpaw` becomes "command not found").
  if ! grep -qs 'HOME/.local/bin' "$HOME/.bashrc" 2>/dev/null; then
    printf '\n# Added by Cinderpaw installer\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME/.bashrc"
    say "added ~/.local/bin to PATH in ~/.bashrc (takes effect on next login)"
  fi
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) say "NOTE: for THIS shell, run:  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac

  "$HOME/.local/bin/cinderpaw" doctor || true
  say "next steps:"
  say "  1. cloud key (example):  export CINDERPAW_BASE_URL=https://api.minimax.io/v1 CINDERPAW_API_KEY=… CINDERPAW_MODEL=…"
  say "  2. start the gateway:    cinderpaw gateway start"
  say "  3. systemd service:      see docs/HEADLESS.md"
}

# ── Dispatch ─────────────────────────────────────────────────────────────────
case "$(uname -s)" in
  Darwin)
    install_macos
    ;;
  Linux)
    if [ "$MODE" = "desktop" ]; then
      install_linux_desktop
    elif [ "$MODE" = "headless" ]; then
      install_linux_headless
    elif [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
      say "display detected → desktop install (use --headless to override)"
      install_linux_desktop
    else
      say "no display detected → headless CLI install (use --desktop to override)"
      install_linux_headless
    fi
    ;;
  *)
    fail "unsupported OS: $(uname -s). On Windows, use the PowerShell one-liner in the README."
    ;;
esac
