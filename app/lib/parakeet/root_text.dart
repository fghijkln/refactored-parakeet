// Parakeet: copy of 设置 › 系统权限 › Root. Kept out of the ARB files (it exists only
// in the Parakeet APKs, behind parakeetHostEngine). tooling/parakeet_locale.py
// rewrites this file in a prepared single-language tree so that only the build
// language's table is left (the other one becomes a copy of it), which keeps each
// APK one language (tooling/parakeet_apk_check.py).

import 'build_locale.dart';

// PARAKEET-ROOT-TEXT zh BEGIN
const Map<String, String> _zh = {
  'section': 'Root 权限',
  'title': '允许 AI 以 Root 身份运行',
  'subtitle': '授予后，AI 执行的每条命令都以 root（uid 0）运行，等同手机的 root 用户',
  'on': '已授予',
  'off': '未授予',
  'noSu': '未检测到 su（需要 KernelSU 或 Magisk）',
  'footer': 'Root = 完全控制整台设备：AI 可以读写系统文件、其他应用的数据和设备设置，普通 root 命令不再逐条确认。'
      '刷写或写入分区（/dev/block）、以读写方式挂载或修改 system / vendor / product / boot 等系统分区、'
      '格式化或清除 /data 与 /metadata 这类可能导致变砖的操作，仍会每次先请你确认一次。',
  'riskTitle': '让 AI 获得整台设备的 Root 权限？',
  'riskBody': 'AI 执行的所有命令都将以 root 运行，可以修改系统、删除任何数据，且不再逐条确认。'
      '只有刷写分区、改写系统分区、清除 /data 等可能变砖的操作会先问你。'
      '接下来 KernelSU / Magisk 会弹窗请你授权。',
  'riskAction': '授予 Root',
  'granted': '已授予 Root：AI 的命令将以 root 运行',
  'denied': '没有拿到 Root 授权',
  'revoked': '已收回 Root：AI 的命令以普通应用身份运行',
};
// PARAKEET-ROOT-TEXT zh END

// PARAKEET-ROOT-TEXT en BEGIN
const Map<String, String> _en = {
  'section': 'Root',
  'title': 'Let the AI run as root',
  'subtitle': "Once granted, every command the AI runs executes as root (uid 0), like the phone's root user",
  'on': 'Granted',
  'off': 'Not granted',
  'noSu': 'No su found (needs KernelSU or Magisk)',
  'footer': "Root = full access to the whole device: the AI can read and change system files, other apps' data "
      'and device settings, and ordinary root commands are no longer confirmed one by one. '
      'Operations that can brick the phone are still confirmed once, every time: flashing or writing partitions '
      '(/dev/block), mounting read-write or changing system partitions (system, vendor, product, boot, ...), '
      'and formatting or wiping /data and /metadata.',
  'riskTitle': 'Give the AI root access to the whole device?',
  'riskBody': 'Every command the AI runs will run as root: it can change the system and delete any data, without '
      'asking each time. Only operations that can brick the phone (flashing partitions, writing system '
      'partitions, wiping /data) ask you first. KernelSU or Magisk will ask you to allow it next.',
  'riskAction': 'Grant root',
  'granted': "Root granted: the AI's commands run as root",
  'denied': 'Root was not granted',
  'revoked': "Root revoked: the AI's commands run as the app",
};
// PARAKEET-ROOT-TEXT en END

/// The Root item's text in the build language.
String rootText(String key) => (parakeetEnglish ? _en : _zh)[key] ?? key;
