#!/usr/bin/env bash
# Parakeet: prepare the tree for a single-language APK (zh or en). Destructive to
# the working copy (CI runs it on a fresh checkout per language).
#
#   tooling/parakeet-locale.sh zh|en
#
#  - Flutter: only app_<lang>.arb stays (and lib/l10n/parts/*_<lang>.arb); strings
#    of removed features (DeepSeek account sign-in, feedback, usage statistics,
#    forum/QQ community, update checks, star prompt) are blanked; gen-l10n
#    regenerates lib/l10n/gen with that one locale.
#  - Android: res/values holds that language only (values-zh merged into values
#    for zh, dropped for en); BuildLocale.kt pins native text to it.
#  - DSH: runtime/out-<lang> (built by runtime/build-runtime.sh) becomes runtime/out.
set -euo pipefail
LANG_ID="${1:?zh or en}"
[[ "$LANG_ID" == zh || "$LANG_ID" == en ]] || { echo "zh or en" >&2; exit 2; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/app"
OTHER=$([[ "$LANG_ID" == zh ]] && echo en || echo zh)

python3 -I "$ROOT/tooling/parakeet_locale.py" "$ROOT" "$LANG_ID"

sed -i "s/^template-arb-file: .*/template-arb-file: app_${LANG_ID}.arb/" "$APP/l10n.yaml"
rm -f "$APP/lib/l10n/app_${OTHER}.arb" "$APP"/lib/l10n/parts/*_"${OTHER}".arb
rm -rf "$APP/lib/l10n/gen"
if [[ "${SKIP_GEN_L10N:-0}" != 1 ]]; then
  (cd "$APP" && flutter gen-l10n)
  ls "$APP/lib/l10n/gen"
fi

K="$APP/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/i18n/BuildLocale.kt"
sed -i "s/const val LOCALE = \"[a-z]*\"/const val LOCALE = \"$LANG_ID\"/" "$K"
grep -q "LOCALE = \"$LANG_ID\"" "$K"

if [[ -d "$ROOT/runtime/out-$LANG_ID" ]]; then
  rm -rf "$ROOT/runtime/out"
  cp -r "$ROOT/runtime/out-$LANG_ID" "$ROOT/runtime/out"
fi
echo "parakeet-locale: tree prepared for $LANG_ID"
