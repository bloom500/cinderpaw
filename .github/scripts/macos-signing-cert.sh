#!/usr/bin/env bash
# Puts Cinderpaw's own code-signing certificate where codesign finds it, and
# tells Tauri its name. Why: an ad-hoc signature ("-") is new with every build,
# so the Mac keychain no longer recognises the updated app and asks for the
# person's password once per stored key, after every update. The same
# certificate on every build keeps the app's identity, so one "Always Allow"
# lasts. It is self-signed, not Apple's: Gatekeeper still asks on first open.
#
# Not passed to Tauri as APPLE_CERTIFICATE: Tauri only accepts certificates
# whose name starts with an Apple prefix ("Developer ID Application:" ...), so
# it gets the identity name instead and calls `codesign -s Cinderpaw` itself.
#
# Without the secrets (a fork) the build stays ad-hoc signed, as before.
set -euo pipefail

if [ -z "${MACOS_SIGNING_P12:-}" ] || [ -z "${MACOS_SIGNING_P12_PASSWORD:-}" ]; then
  echo "::warning::MACOS_SIGNING_P12 is not set: this Mac build is ad-hoc signed, and every update asks for the keychain password again"
  exit 0
fi

# A secret set from Windows PowerShell arrives with a CRLF on the end, which
# macOS base64 refuses and which would become part of the password. Neither
# value can hold whitespace, so it all goes.
MACOS_SIGNING_P12=$(printf %s "$MACOS_SIGNING_P12" | tr -d ' \r\n\t')
MACOS_SIGNING_P12_PASSWORD=$(printf %s "$MACOS_SIGNING_P12_PASSWORD" | tr -d '\r\n')

keychain="$RUNNER_TEMP/cinderpaw-signing.keychain-db"
keychain_password=$(openssl rand -hex 16)
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
printf %s "$MACOS_SIGNING_P12" | base64 --decode > "$RUNNER_TEMP/cinderpaw-signing.p12"
security import "$RUNNER_TEMP/cinderpaw-signing.p12" -k "$keychain" -f pkcs12 \
  -P "$MACOS_SIGNING_P12_PASSWORD" -T /usr/bin/codesign
rm -f "$RUNNER_TEMP/cinderpaw-signing.p12"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" > /dev/null
# Added to the search list, existing keychains kept, so codesign finds it by name.
# shellcheck disable=SC2046
security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
security find-identity -p codesigning "$keychain"

echo "APPLE_SIGNING_IDENTITY=Cinderpaw" >> "$GITHUB_ENV"
