// Parakeet ships two APKs: pure Chinese and pure English. The language is fixed
// at build time (tooling/parakeet-locale.sh strips the other language's strings
// and passes --dart-define=PARAKEET_LOCALE=zh|en); there is no language switcher.
const String parakeetLocale = String.fromEnvironment('PARAKEET_LOCALE', defaultValue: 'zh');

bool get parakeetEnglish => parakeetLocale == 'en';

/// Parakeet: share-as-link used upstream's share server; it is hidden (share cards and
/// files stay, they never leave the phone unless the user sends them).
const bool parakeetNoHostedShare = true;
