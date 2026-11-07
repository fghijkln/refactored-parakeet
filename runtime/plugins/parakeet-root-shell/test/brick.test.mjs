import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BRICK_PATTERNS, brickRisk, isBrickRisk } from '../lib/brick.js';
import { approvalNeed, brickGate } from '../lib/index.js';
import { isDangerous } from '../lib/su.js';

// Device-level destructive shapes: always confirmed once, even with Root granted.
const BRICK = [
  'dd if=/sdcard/boot.img of=/dev/block/by-name/boot',
  'dd if=/dev/zero of=/data/local/tmp/fake/dev/block/sda bs=1 count=1',
  'cat boot.img > /dev/block/mmcblk0p1',
  'echo x | tee /dev/block/sda',
  'cp img /dev/block/by-name/vbmeta',
  'mkfs.ext4 /dev/block/sda1',
  'make_ext4fs /dev/block/x',
  'mke2fs -t ext4 /dev/block/dm-3',
  'fastboot flash boot boot.img',
  'fastboot erase userdata',
  'mount -o rw,remount /system',
  'mount -o remount,rw /',
  'mount -o remount,rw /vendor',
  'mount /system -o rw,remount',
  'mount --rw /product',
  'magisk --remount-rw',
  'remount',
  'rm -rf /system/app',
  'rm -rf /data',
  'rm -rf /data/*',
  'rm -rf /metadata',
  'rm -rf /vendor/lib64',
  'echo 1 > /system/build.prop',
  'cp foo /system/bin/foo',
  'mv a /product/app/x',
  'chmod 777 /system/bin/sh',
  'sed -i s/a/b/ /system/build.prop; echo ok',
  'sgdisk --zap-all /dev/block/sda',
  'parted /dev/block/sda rm 3',
  'dmsetup remove system',
  'recovery --wipe_data',
  'wipe data',
  'avbctl disable-verification',
  'cd /tmp && dd if=x.img of=/dev/block/bootdevice/by-name/recovery',
];

// Ordinary root work: never asked about.
const ORDINARY = [
  'id', 'id -u', 'ls -la /system/bin', 'cat /system/build.prop', 'getprop ro.build.version.release',
  'ls /dev/block/by-name', 'rm -rf /data/local/tmp/x/', 'rm -rf /data/data/com.foo/cache', 'pm list packages',
  'mount', 'mount | grep system', 'cat /proc/mounts', 'settings put global adb_enabled 1', 'echo hi > /sdcard/x.txt',
  'cp /system/bin/sh /data/local/tmp/sh', 'dd if=/dev/block/by-name/boot of=/sdcard/boot.img', 'logcat -d',
  'iptables -L', 'find /system -name "*.apk"', 'du -sh /data', 'grep -r foo /vendor/etc',
  'cat /dev/block/sda | head -c 10 | xxd', 'am force-stop com.example', 'chmod 755 /data/local/tmp/tool',
  'echo 3 > /proc/sys/vm/drop_caches', 'cmd package compile -m speed -f com.x', 'ls /data/data',
];

test('brick-risk shapes are classified', () => {
  for (const cmd of BRICK) {
    const r = brickRisk(cmd);
    assert.equal(r.risk, true, `not flagged: ${cmd}`);
    assert.ok(r.reason, cmd);
    assert.equal(isDangerous(cmd), true, cmd);
  }
});

test('ordinary root commands are not', () => {
  for (const cmd of ORDINARY) assert.equal(isBrickRisk(cmd), false, `flagged: ${cmd} (${brickRisk(cmd).reason})`);
  assert.equal(isBrickRisk(''), false);
  assert.equal(isBrickRisk(undefined), false);
});

test('every pattern has a reason and a regex', () => {
  for (const [reason, re] of BRICK_PATTERNS) {
    assert.equal(typeof reason, 'string');
    assert.ok(re instanceof RegExp);
  }
});

test('bash gate: asks for brick-risk only, and only in root mode', () => {
  const dd = { name: 'bash', arguments: { command: 'dd if=/dev/zero of=/dev/block/sda' } };
  const ask = brickGate(dd, true);
  assert.equal(ask.kind, 'ask');
  assert.match(ask.reason, /brick-risk/);
  assert.match(ask.displayReason, /# dd if=\/dev\/zero/);
  assert.equal(brickGate(dd, false), undefined, 'root mode off: the app uid cannot write block devices');
  assert.equal(brickGate({ name: 'bash', arguments: { command: 'id -u' } }, true), undefined);
  assert.equal(brickGate({ name: 'read_file', arguments: { command: 'dd of=/dev/block/sda' } }, true), undefined);
});

test('root_shell: Root granted means no per-command ask, brick-risk still asks', () => {
  assert.equal(approvalNeed('id', false).ask, false);
  assert.equal(approvalNeed('mount -o rw,remount /system', false).ask, true);
  assert.match(approvalNeed('mount -o rw,remount /system', false).reason, /remounts a system partition/);
});
