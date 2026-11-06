import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../parakeet/host_engine.dart';

enum VoiceMode { auto, system, engine }

/// The modes this build offers. Parakeet: the host engine ships no sherpa-onnx, so an
/// APK only has the phone's own recognition service.
const List<VoiceMode> availableVoiceModes = parakeetHostEngine ? [VoiceMode.system] : VoiceMode.values;

/// What a run uses when nothing (or something unavailable) was chosen.
const VoiceMode defaultVoiceMode = parakeetHostEngine ? VoiceMode.system : VoiceMode.auto;

class VoiceSettingsController extends Notifier<VoiceMode> {
  static const preferenceKey = 'voice_recognition_mode';
  late Future<void> _loaded;

  @override
  VoiceMode build() {
    _loaded = _load();
    return defaultVoiceMode;
  }

  Future<void> _load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (!ref.mounted) return;
      final stored = prefs.getString(preferenceKey);
      state = availableVoiceModes.firstWhere((mode) => mode.name == stored, orElse: () => defaultVoiceMode);
    } catch (_) {
      // Unreadable preferences: stay on auto for this run.
    }
  }

  Future<VoiceMode> ready() async {
    await _loaded;
    return ref.mounted ? state : defaultVoiceMode;
  }

  Future<void> setMode(VoiceMode mode) async {
    await _loaded;
    if (!ref.mounted || !availableVoiceModes.contains(mode)) return;
    state = mode;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(preferenceKey, mode.name);
  }
}

final voiceSettingsProvider = NotifierProvider<VoiceSettingsController, VoiceMode>(VoiceSettingsController.new);
