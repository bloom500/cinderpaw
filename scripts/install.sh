#!/usr/bin/env bash
#
# Feral universal installer — one command, OS auto-detected:
#
#   curl -fsSL https://raw.githubusercontent.com/bloom500/feral/main/scripts/install.sh | bash
#
# What it picks per platform:
#   Linux + display        → latest .deb / .rpm desktop app (apt/dnf)
#   Linux headless (VPS)   → builds the `feral` CLI + gateway from source
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

REPO="bloom500/feral"
API="https://api.github.com/repos/${REPO}/releases/latest"

say()  { printf '\033[1;32m[feral]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[feral]\033[0m %s\n' "$*" >&2; exit 1; }

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
  dmg="$(mktemp -d)/feral.dmg"
  say "downloading $(basename "$url")…"
  curl -fL --progress-bar -o "$dmg" "$url"
  mnt="$(hdiutil attach "$dmg" -nobrowse | awk '/\/Volumes\// { print $NF; exit }')"
  say "installing to /Applications…"
  rm -rf /Applications/Feral.app
  cp -R "$mnt"/Feral.app /Applications/
  hdiutil detach "$mnt" -quiet
  # Clear the quarantine flag (Feral isn't Apple-notarized yet).
  xattr -cr /Applications/Feral.app || true
  say "done — launch Feral from /Applications."
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
  say "done — launch Feral from your app menu (or run: feral)."
}

# ── Linux headless (build the CLI + gateway from source) ────────────────────
install_linux_headless() {
  local sudo_cmd=""
  [ "$(id -u)" -eq 0 ] || sudo_cmd="sudo"

  say "installing build dependencies…"
  if command -v apt-get >/dev/null; then
    $sudo_cmd apt-get update -qq
    $sudo_cmd apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev libdbus-1-dev cmake git unzip ca-certificates
  elif command -v dnf >/dev/null; then
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
  export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"

  local src="$HOME/src/feral"
  mkdir -p "$HOME/src"
  if [ -d "$src/.git" ]; then
    say "updating existing checkout…"
    git -C "$src" pull --ff-only
  else
    say "cloning ${REPO}…"
    git clone --depth 1 "https://github.com/${REPO}" "$src"
  fi

  say "building the sidecar (feral-agent)…"
  ( cd "$src/FeralAgent" && bun install --frozen-lockfile && bun run build )

  # --no-default-features: the CLI's default `inference` feature pulls in
  # llama.cpp (heavy build, needs clang). Headless gateways use a cloud
  # provider via FERAL_BASE_URL/FERAL_API_KEY/FERAL_MODEL instead.
  say "building the CLI (feral) — no local inference engine…"
  ( cd "$src" && cargo build --release -p feral-cli --no-default-features )

  # The sidecar binary MUST live next to the CLI (find_binary contract).
  mkdir -p "$HOME/.local/bin"
  install -m 0755 "$src/target/release/feral-cli"    "$HOME/.local/bin/feral"
  install -m 0755 "$src/FeralAgent/dist/feral-agent" "$HOME/.local/bin/feral-agent"

  say "installed: $HOME/.local/bin/feral (+ feral-agent)"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) say "NOTE: add ~/.local/bin to PATH:  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac

  "$HOME/.local/bin/feral" doctor || true
  say "next steps:"
  say "  1. cloud key (example):  export FERAL_BASE_URL=https://api.minimax.io/v1 FERAL_API_KEY=… FERAL_MODEL=…"
  say "  2. start the gateway:    feral gateway start"
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
