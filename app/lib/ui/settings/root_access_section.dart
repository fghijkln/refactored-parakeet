// Parakeet: the Root item of 设置 › 系统权限 (APK builds only, parakeetHostEngine).
//
// On: a high-level risk notice (full device access, brick-risk operations still
// confirmed), then the native grant — `su -c id`, which is where KernelSU or Magisk
// asks the user — and only a uid-0 answer is stored. From then on every shell
// command of the agent runs as root (runtime/direct/root-exec.mjs); brick-risk
// commands ask once each (runtime/plugins/parakeet-root-shell/lib/brick.js).
// Off: stored at once, no prompt.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../parakeet/root_text.dart';
import '../../runtime/runtime_bridge.dart';
import '../../runtime/runtime_state.dart';
import '../common/risk_notice.dart';
import '../theme/app_icons.dart';
import 'settings_widgets.dart';

/// The notice shown before a grant (每次确认).
RiskNotice get rootRiskNotice => RiskNotice(
  id: 'parakeet.root',
  level: RiskLevel.high,
  title: rootText('riskTitle'),
  body: rootText('riskBody'),
  action: rootText('riskAction'),
);

class RootAccessSection extends ConsumerStatefulWidget {
  const RootAccessSection({super.key});

  @override
  ConsumerState<RootAccessSection> createState() => _RootAccessSectionState();
}

class _RootAccessSectionState extends ConsumerState<RootAccessSection> {
  RootAccessStatus? _status;
  bool _busy = false;
  late final AppLifecycleListener _lifecycle;

  RuntimeBridge get _bridge => ref.read(runtimeBridgeProvider);

  @override
  void initState() {
    super.initState();
    _lifecycle = AppLifecycleListener(onResume: () => unawaited(_read()));
    unawaited(_read());
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    super.dispose();
  }

  Future<void> _read() async {
    final status = await _bridge.rootStatus();
    if (mounted) setState(() => _status = status);
  }

  void _toast(String text) => ScaffoldMessenger.maybeOf(context)
    ?..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(text)));

  Future<void> _change(bool on) async {
    if (_busy) return;
    if (on && !await confirmRisk(context, rootRiskNotice)) return;
    if (!mounted) return;
    setState(() => _busy = true);
    final status = await _bridge.requestRoot(on);
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (status != null) _status = status;
    });
    if (status == null) return;
    if (!on) {
      _toast(rootText('revoked'));
    } else if (status.enabled) {
      _toast(rootText('granted'));
    } else {
      final detail = status.detail;
      _toast(detail == null || detail.isEmpty ? rootText('denied') : '${rootText('denied')}: $detail');
    }
  }

  @override
  Widget build(BuildContext context) {
    final status = _status;
    if (status == null) return const SizedBox.shrink();
    final enabled = status.enabled;
    final subtitle = status.suPath == null && !enabled ? rootText('noSu') : rootText('subtitle');
    return SettingsSection(
      key: const ValueKey('access-section-root'),
      title: rootText('section'),
      footer: Text(rootText('footer')),
      children: [
        SettingsSwitchTile(
          key: const ValueKey('access-item-root'),
          icon: AppIcons.securityWarning,
          tinted: false,
          title: rootText('title'),
          subtitle: subtitle,
          value: enabled,
          onChanged: _busy ? null : (next) => unawaited(_change(next)),
        ),
      ],
    );
  }
}
