import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PersistentSu, findSu, isDangerous, parseUid, probeRoot, runAsRoot, suArgv } from '../lib/su.js';
import { approvalNeed } from '../lib/index.js';

function fakeSu(body) {
  const dir = mkdtempSync(join(tmpdir(), 'fakesu-'));
  const p = join(dir, 'su');
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return { path: p, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ROOT_SU = '#!/bin/sh\nif [ "$1" = "-c" ]; then shift; exec /bin/sh -c "$*"; fi\nexec /bin/sh\n';

test('parseUid', () => {
  assert.equal(parseUid('uid=0(root) gid=0(root)'), 0);
  assert.equal(parseUid('uid=10123(u0_a123)'), 10123);
  assert.equal(parseUid('Permission denied'), undefined);
});

test('suArgv keeps the command as one argv element and refuses blanks', () => {
  assert.deepEqual(suArgv('/system/bin/su', "echo 'a b' && id"), ['/system/bin/su', '-c', "echo 'a b' && id"]);
  assert.throws(() => suArgv('/system/bin/su', '  '));
  assert.throws(() => suArgv('/system/bin/su', 'id', { user: 'shell' }));
});

test('findSu honours preference order and the PARAKEET_SU override', () => {
  const present = new Set(['/data/adb/ksu/bin/su', '/system/xbin/su']);
  const saved = process.env.PARAKEET_SU;
  delete process.env.PARAKEET_SU;
  try {
    assert.equal(findSu((p) => present.has(p)), '/system/xbin/su');
    assert.equal(findSu(() => false), undefined);
    process.env.PARAKEET_SU = '/opt/su';
    assert.equal(findSu((p) => p === '/opt/su' || present.has(p)), '/opt/su');
  } finally {
    if (saved === undefined) delete process.env.PARAKEET_SU;
    else process.env.PARAKEET_SU = saved;
  }
});

test('probeRoot: granted, denied, missing', () => {
  const ok = probeRoot({ suPath: '/x/su', runner: () => ({ stdout: 'uid=0(root) gid=0(root)\n', stderr: '', status: 0 }) });
  assert.equal(ok.available, true);
  assert.equal(ok.uid, 0);
  const denied = probeRoot({ suPath: '/x/su', runner: () => ({ stdout: '', stderr: 'Permission denied\n', status: 1 }) });
  assert.equal(denied.available, false);
  assert.equal(denied.detail, 'Permission denied');
  const err = probeRoot({ suPath: '/x/su', runner: () => ({ error: new Error('ENOENT') }) });
  assert.equal(err.available, false);
});

test('runAsRoot runs through su -c and collects output and exit code', async () => {
  const su = fakeSu(ROOT_SU);
  try {
    const r = await runAsRoot('echo hello; echo oops >&2; exit 3', { suPath: su.path });
    assert.equal(r.stdout.trim(), 'hello');
    assert.equal(r.stderr.trim(), 'oops');
    assert.equal(r.exitCode, 3);
  } finally {
    su.cleanup();
  }
});

test('PersistentSu: sequential commands, quoting, cwd, exit codes, one process', async () => {
  const su = fakeSu(ROOT_SU);
  const s = new PersistentSu({ suPath: su.path });
  try {
    const a = await s.run('echo "it\'s $((1+2))"; printf "no-newline"');
    assert.equal(a.output, "it's 3\nno-newline");
    assert.equal(a.exitCode, 0);
    const pid1 = (await s.run('echo $PPID')).output;
    const b = await s.run('pwd', { cwd: tmpdir() });
    assert.ok(b.output.endsWith(tmpdir().split('/').pop()));
    const c = await s.run('echo err >&2; false');
    assert.equal(c.output, 'err');
    assert.equal(c.exitCode, 1);
    const pid2 = (await s.run('echo $PPID')).output;
    assert.equal(pid1, pid2, 'commands share one su session');
    // concurrent callers are serialised, not interleaved
    const [x, y] = await Promise.all([s.run('sleep 0.2; echo X'), s.run('echo Y')]);
    assert.equal(x.output, 'X');
    assert.equal(y.output, 'Y');
  } finally {
    s.stop();
    su.cleanup();
  }
});

test('PersistentSu: a timed-out command kills and restarts the session', async () => {
  const su = fakeSu(ROOT_SU);
  const s = new PersistentSu({ suPath: su.path });
  try {
    await assert.rejects(s.run('sleep 5', { timeoutMs: 300 }), /timed out/);
    const r = await s.run('echo back');
    assert.equal(r.output, 'back');
  } finally {
    s.stop();
    su.cleanup();
  }
});

test('dangerous commands are always confirmed, others follow the toggle', () => {
  for (const cmd of [
    'dd if=/sdcard/boot.img of=/dev/block/by-name/boot',
    'mkfs.ext4 /dev/block/sda1',
    'rm -rf /system/app',
    'rm -rf /data',
    'cat x > /dev/block/mmcblk0',
    'fastboot flash boot boot.img',
  ]) {
    assert.ok(isDangerous(cmd), cmd);
    assert.equal(approvalNeed(cmd, false).ask, true, cmd);
  }
  for (const cmd of ['id', 'ls /data/data', 'getprop ro.build.version.release', 'rm -rf /data/local/tmp/x/']) {
    assert.equal(isDangerous(cmd), false, cmd);
  }
  assert.equal(approvalNeed('id', true).ask, true);
  assert.equal(approvalNeed('id', false).ask, false);
});
