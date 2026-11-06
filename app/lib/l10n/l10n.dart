// The one import for UI text: `import '../../l10n/l10n.dart';`
//
//  - In widgets: `context.l10n.chatComposerHint`.
//  - Without a BuildContext (state, services, error mapping): `appL10n.xxx`,
//    which always follows the language the app is showing.
//
// Strings live in lib/l10n/parts/<area>_{zh,en}.arb; tool/l10n_merge.py
// merges them and regenerates lib/l10n/gen/.

import 'package:flutter/widgets.dart';

import '../parakeet/build_locale.dart';
import 'gen/app_localizations.dart';

export 'gen/app_localizations.dart';

/// The language the app shows: what [AppLocale.resolve] picked from the
/// user's choice and the system languages.
abstract final class AppLocale {
  static const zhCN = Locale('zh', 'CN');
  static const en = Locale('en');

  /// Parakeet: the one locale this APK was built with (see build_locale.dart).
  static const Locale build = parakeetLocale == 'en' ? en : zhCN;

  /// Locales MaterialApp offers: only the build's language. zh_CN (not bare
  /// zh) keeps CJK glyphs Chinese on non-Chinese systems.
  static const supported = [build];

  static Locale _locale = build;
  static L10n _l10n = lookupL10n(build);

  /// The locale in use (zh_CN until the app resolves one; tests keep it).
  static Locale get current => _locale;

  static bool get isEnglish => _locale.languageCode == 'en';

  static L10n get l10n => _l10n;

  /// Switches [appL10n] to [locale] (zh_CN or en).
  static void use(Locale locale) {
    const next = build;
    if (next == _locale) return;
    _locale = next;
    _l10n = lookupL10n(next);
  }

  /// Chinese for any Chinese system language, English for everything else.
  /// Parakeet: always the build's language, whatever the system or a stale choice says.
  static Locale resolve(Locale? chosen, List<Locale>? system) => build;
}

/// UI text for code without a BuildContext. Follows the app language.
L10n get appL10n => AppLocale.l10n;

extension L10nContext on BuildContext {
  /// UI text in the app language. Falls back to [appL10n] where the tree has
  /// no L10n delegate (bare MaterialApps in tests).
  L10n get l10n => Localizations.of<L10n>(this, L10n) ?? AppLocale.l10n;
}

extension L10nFormat on L10n {
  /// 「3月5日」/「Mar 5」.
  String monthDay(DateTime d) => commonMonthDay('${d.month}', d.day);
}
