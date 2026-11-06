// Parakeet ships two APKs: pure Chinese and pure English. The language is fixed
// at build time: tooling/parakeet-locale.sh strips the other language's strings and
// writes [parakeetTreeLocale] below; the APK build also passes
// --dart-define=PARAKEET_LOCALE=zh|en. There is no language switcher in an APK.
//
// The unprepared source tree (flutter test, flutter analyze) still carries both
// languages; there [parakeetLocaleFixed] is false and the upstream zh/en switching
// stays, so the upstream tests keep exercising both.

/// Set by tooling/parakeet-locale.sh ('' in the unprepared tree).
const String parakeetTreeLocale = '';

const String parakeetLocale =
    String.fromEnvironment('PARAKEET_LOCALE', defaultValue: parakeetTreeLocale == '' ? 'zh' : parakeetTreeLocale);

/// True in a single-language build: the UI language never changes.
const bool parakeetLocaleFixed = parakeetTreeLocale != '' || bool.hasEnvironment('PARAKEET_LOCALE');

bool get parakeetEnglish => parakeetLocale == 'en';

/// Parakeet: share-as-link used upstream's share server; it is hidden (share cards and
/// files stay, they never leave the phone unless the user sends them).
const bool parakeetNoHostedShare = true;
