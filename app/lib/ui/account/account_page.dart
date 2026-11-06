import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../l10n/l10n.dart';
import '../../state/account_state.dart';
import '../../state/settings_state.dart';
import '../chat/balance_widgets.dart' show BalanceSettingsLine;
import '../common/app_dialog.dart';
import '../common/app_sheet.dart';
import '../onboarding/api_key_page.dart';
import '../settings/settings_widgets.dart';
import '../shell/page_frame.dart';
import '../theme/app_icons.dart';
import '../theme/theme.dart';

/// 账号: the DeepSeek account of the on-device engine (profile, wallets, top-up,
/// sign-out; the browser sign-in otherwise) and the API Key, the other way in.
class AccountPage extends ConsumerStatefulWidget {
  const AccountPage({super.key});

  @override
  ConsumerState<AccountPage> createState() => _AccountPageState();
}

class _AccountPageState extends ConsumerState<AccountPage> {
  late final AppLifecycleListener _lifecycle;

  /// A Platform page (top-up, usage) was opened: re-read wallets on return.
  bool _awaitingReturn = false;

  @override
  void initState() {
    super.initState();
    _lifecycle = AppLifecycleListener(onResume: _onResume);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final account = ref.read(accountProvider);
      if (account.signedIn && (account.profile == null || account.profileFailed)) {
        unawaited(ref.read(accountProvider.notifier).refreshProfile());
      }
    });
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    super.dispose();
  }

  void _onResume() {
    ref.read(accountProvider.notifier).noteAppResumed();
    if (_awaitingReturn) {
      _awaitingReturn = false;
      _refresh();
    }
  }

  void _refresh() {
    ref.invalidate(accountBalanceProvider);
    unawaited(ref.read(accountProvider.notifier).refreshProfile());
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final state = ref.watch(accountProvider);
    return AppPage.list(
      title: l10n.engineAccountTitle,
      actions: [
        if (state.signedIn)
          GlassIconButton(icon: AppIcons.refresh, tooltip: l10n.engineAccountRefresh, onPressed: _refresh),
      ],
      // Parakeet: no DeepSeek account sign-in; only the API key kept on this device.
      children: const [SizedBox(height: 8), ApiKeySection()],
    );
  }
}

// ── Signed in ────────────────────────────────────────────────────────────────

// ── Signing in ───────────────────────────────────────────────────────────────

// ── Signed out ───────────────────────────────────────────────────────────────

/// 「API Key」: the key saved in the app (replace / clear) and, when set, its
/// balance. The other way to use DeepSeek models besides the account.
class ApiKeySection extends ConsumerWidget {
  const ApiKeySection({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hasKey = ref.watch(settingsProvider.select((s) => s.hasApiKey));
    return SettingsSection(title: 'API Key', children: [const ApiKeyTile(), if (hasKey) const BalanceSettingsLine()]);
  }
}

/// The saved DeepSeek API Key, masked; opens "replace / clear", or the key page
/// when there is none.
class ApiKeyTile extends ConsumerWidget {
  const ApiKeyTile({super.key, this.tinted = false, this.tint = 0});

  final bool tinted;
  final int tint;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final settings = ref.watch(settingsProvider);
    final scheme = Theme.of(context).colorScheme;
    final colors = DshColors.of(context);
    return SettingsTile(
      icon: AppIcons.apiKey,
      tint: tint,
      tinted: tinted,
      title: 'DeepSeek API Key',
      value: settings.hasApiKey
          ? Text(maskApiKey(settings.apiKey), style: AppType.monoLabel(color: scheme.onSurfaceVariant))
          : Text(l10n.commonNotSet, style: TextStyle(color: colors.textTertiary)),
      onTap: () => manageApiKey(context, ref),
    );
  }
}

/// No key: the key page. A key: a sheet to replace or clear it.
Future<void> manageApiKey(BuildContext context, WidgetRef ref) async {
  final l10n = context.l10n;
  void push(Widget page) => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => page));
  if (!ref.read(settingsProvider).hasApiKey) {
    push(const ApiKeyPage(onboarding: false));
    return;
  }
  final action = await showAppSheet<String>(
    context,
    builder: (sheet) => SafeArea(
      top: false,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const SheetHeader('API Key'),
          SheetGroup(
            margin: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            children: [
              SettingsTile(
                icon: AppIcons.edit,
                tinted: false,
                title: l10n.engineAccountReplaceKey,
                chevron: false,
                onTap: () => Navigator.pop(sheet, 'replace'),
              ),
              SettingsTile(
                icon: AppIcons.delete,
                tinted: false,
                danger: true,
                title: l10n.commonClear,
                chevron: false,
                onTap: () => Navigator.pop(sheet, 'clear'),
              ),
            ],
          ),
        ],
      ),
    ),
  );
  if (!context.mounted) return;
  switch (action) {
    case 'replace':
      push(const ApiKeyPage(onboarding: false));
    case 'clear':
      final ok = await showAppDialog<bool>(
        context: context,
        builder: (dialog) => AlertDialog(
          title: Text(l10n.engineAccountClearKeyTitle),
          content: Text(l10n.engineAccountClearKeyBody),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialog, false), child: Text(l10n.commonCancel)),
            FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: DshColors.of(dialog).danger,
                foregroundColor: DshColors.of(dialog).onDanger,
              ),
              onPressed: () => Navigator.pop(dialog, true),
              child: Text(l10n.commonClear),
            ),
          ],
        ),
      );
      if (ok == true) await ref.read(settingsProvider.notifier).setApiKey('');
  }
}
