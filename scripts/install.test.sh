#!/usr/bin/env bash
# Unit checks for install.sh's helpers. Run: bash scripts/install.test.sh
set -euo pipefail
CINDERPAW_INSTALL_LIB=1 source "$(dirname "$0")/install.sh"

fails=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got '$2' want '$3'"; fails=$((fails+1)); fi; }

check "linux x64"      "$(asset_for Linux x86_64)"  "cinderpaw-linux-x64.tar.gz"
check "mac arm"        "$(asset_for Darwin arm64)"  "cinderpaw-macos-arm64.tar.gz"
check "mac intel"      "$(asset_for Darwin x86_64)" "cinderpaw-macos-x64.tar.gz"
check "linux arm"      "$(asset_for Linux aarch64)" ""
check "freebsd"        "$(asset_for FreeBSD amd64)" ""

check "glibc 2.35 ok"  "$(glibc_ok 'ldd (Ubuntu GLIBC 2.35-0ubuntu3) 2.35' && echo y || echo n)" "y"
check "glibc 2.39 ok"  "$(glibc_ok 'ldd (GNU libc) 2.39' && echo y || echo n)" "y"
check "glibc 2.31 no"  "$(glibc_ok 'ldd (Debian GLIBC 2.31-13) 2.31' && echo y || echo n)" "n"
check "musl no"        "$(glibc_ok 'musl libc (x86_64) Version 1.2.4' && echo y || echo n)" "n"

sums='aaa  cinderpaw-linux-x64.tar.gz
bbb  cinderpaw-macos-arm64.tar.gz'
check "sum lookup"     "$(sum_for "$sums" cinderpaw-macos-arm64.tar.gz)" "bbb"
check "sum missing"    "$(sum_for "$sums" cinderpaw-windows-x64.zip)" ""

[ "$fails" -eq 0 ] || { echo "$fails failed"; exit 1; }
