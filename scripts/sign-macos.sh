#!/usr/bin/env bash
# Signs, notarizes and staples the macOS app, then zips it.
#
#   scripts/sign-macos.sh build/bin/tinier-todo.app dist/Tinier-Todo-macOS-universal.zip
#
# Needs these environment variables (GitHub Actions secrets):
#   APPLE_CERTIFICATE_P12       base64 of your "Developer ID Application" certificate (.p12)
#   APPLE_CERTIFICATE_PASSWORD  the password you set when exporting the .p12
#   APPLE_ID                    the Apple ID email of your developer account
#   APPLE_APP_PASSWORD          an app-specific password for that Apple ID
#   APPLE_TEAM_ID               your 10-character team ID
set -euo pipefail

APP="$1"
OUT="$2"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="${RUNNER_TEMP:-$(mktemp -d)}"

for var in APPLE_CERTIFICATE_P12 APPLE_CERTIFICATE_PASSWORD APPLE_ID APPLE_APP_PASSWORD APPLE_TEAM_ID; do
  if [[ -z "${!var:-}" ]]; then
    echo "Missing $var" >&2
    exit 1
  fi
done

# A throwaway keychain holding only the signing certificate.
KEYCHAIN="$TMP/signing.keychain-db"
KEYCHAIN_PASSWORD="$(openssl rand -hex 24)"
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings -lut 3600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
trap 'security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true' EXIT

echo "$APPLE_CERTIFICATE_P12" | base64 --decode > "$TMP/certificate.p12"
security import "$TMP/certificate.p12" -k "$KEYCHAIN" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign >/dev/null
rm -f "$TMP/certificate.p12"
security set-key-partition-list -S apple-tool:,apple: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null
# shellcheck disable=SC2046
security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')

IDENTITY="$(security find-identity -v -p codesigning "$KEYCHAIN" | grep -m1 "Developer ID Application" | sed -E 's/.*"(.*)"/\1/')"
if [[ -z "$IDENTITY" ]]; then
  echo "No 'Developer ID Application' certificate found in APPLE_CERTIFICATE_P12" >&2
  exit 1
fi
echo "Signing with: $IDENTITY"

codesign --force --options runtime --timestamp \
  --entitlements "$ROOT/build/darwin/entitlements.plist" \
  --keychain "$KEYCHAIN" \
  --sign "$IDENTITY" "$APP"
codesign --verify --strict --verbose=2 "$APP"

echo "Submitting for notarization (this usually takes a few minutes)…"
ditto -c -k --keepParent "$APP" "$TMP/notarize.zip"
RESULT="$(xcrun notarytool submit "$TMP/notarize.zip" \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" \
  --wait --output-format json)"
echo "$RESULT"
STATUS="$(echo "$RESULT" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))')"
if [[ "$STATUS" != "Accepted" ]]; then
  SUBMISSION="$(echo "$RESULT" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))')"
  echo "Notarization failed ($STATUS). Apple's log:" >&2
  xcrun notarytool log "$SUBMISSION" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" >&2 || true
  exit 1
fi

xcrun stapler staple "$APP"
spctl --assess --type execute --verbose "$APP"

rm -f "$OUT"
ditto -c -k --keepParent "$APP" "$OUT"
echo "Signed and notarized: $OUT"
