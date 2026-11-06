// Parakeet: one flow for "let the agent use the phone's storage" (/sdcard), used by
// 设置 › 权限 › 访问手机文件 and by the workspace picker's 手机存储 row.
//
// The host engine sees Android's real /sdcard and /storage (identity paths, no
// PRoot bind), so the only thing between a picked /sdcard folder and the agent is
// Android's own grant:
//  - the classic READ/WRITE_EXTERNAL_STORAGE prompt (enough while the app keeps
//    legacy external storage, targetSdk 28);
//  - on Android 11+ when that is not enough (denied, or legacy storage ignored by
//    the ROM) the system 「所有文件访问」 (MANAGE_EXTERNAL_STORAGE) page, after
//    which the grant is read again once the user comes back to the app.
import 'dart:async';

import 'package:flutter/widgets.dart';

import '../runtime/runtime_bridge.dart';

/// How long to wait for the user to come back from the 「所有文件访问」 page.
const _allFilesTimeout = Duration(minutes: 3);

/// Asks Android for shared-storage access; true once the app can read and write /sdcard.
Future<bool> requestPhoneStorageAccess(RuntimeBridge bridge) async {
  var access = await bridge.storageStatus();
  if (access.granted) return true;
  access = await bridge.requestStorage();
  if (access.granted) return true;
  // Android 11+ (or a ROM without legacy storage): the 「所有文件访问」 page.
  final resumed = Completer<void>();
  final listener = AppLifecycleListener(onResume: () {
    if (!resumed.isCompleted) resumed.complete();
  });
  try {
    final opened = await bridge.openAllFilesAccess();
    if (!opened) return false;
    await resumed.future.timeout(_allFilesTimeout, onTimeout: () {});
  } finally {
    listener.dispose();
  }
  access = await bridge.storageStatus();
  return access.granted;
}
