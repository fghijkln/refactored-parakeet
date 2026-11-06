// 隐私与分享: what leaves this phone — the links you shared, a configuration
// to share, anonymous usage statistics, and (when the host has it) the chat
// log upload to DeepSeek.


import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../l10n/l10n.dart';
import '../../state/engine_settings_state.dart';
import '../engine_settings/namespace_copy.dart';
import '../engine_settings/schema_form.dart';
import '../shell/page_frame.dart';
import 'settings_widgets.dart';

class PrivacyPage extends ConsumerWidget {
  const PrivacyPage({super.key});

  static const logNamespace = 'session-log-deepseek';

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final engine = ref.watch(engineSettingsProvider).value;
    return AppPage.list(
      title: l10n.hubPrivacy,
      children: [
        // Parakeet: hosted share links (upstream share server) removed.
        // Parakeet: anonymous usage statistics removed.
        if (engine != null && engine.served(logNamespace))
          ...schemaFormGroups([
            SchemaFormSection(
              title: l10n.engineGeneralData,
              fields: [
                SchemaFieldSpec(logNamespace, const ['enabled'], copy: copyOf(logNamespace, const ['enabled'])),
              ],
            ),
          ], settings: engine),
      ],
    );
  }
}
