// Parakeet host engine: guest paths in child argv/env (runtime/direct/host-args.mjs).
// v0.2.2 on a real phone: phone.patch.yml handed the MCP relay
// /var/lib/dsh-app/phone/bridge.json, which does not exist on Android, so the
// `phone` MCP server stayed disconnected. These cases use an injected `exists`
// that models an Android host (no /var, /opt, /root, /tmp, /usr), plus one real
// filesystem case and one end-to-end spawn through the planner.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHostArgs } from '../../direct/host-args.mjs';
import { createPaths } from '../../direct/paths.mjs';
import { createCommands } from '../../direct/processes.mjs';
import { createRootExec, suPlan } from '../../direct/root-exec.mjs';

const R = '/data/user/0/dev.parakeet.dshgo/files/runtime/rootfs';
const MOUNTS = [
  { host: '/system', guest: '/system' }, { host: '/data', guest: '/data' }, { host: '/sdcard', guest: '/sdcard' },
  { host: '/storage', guest: '/storage' }, { host: '/proc', guest: '/proc' }, { host: '/dev', guest: '/dev' },
  { host: '/storage/emulated/0', guest: '/root/手机存储' },
];
// What exists on this modelled phone: Android's own trees and the runtime tree's dirs.
const HOST = new Set(['/', '/system', '/system/bin', '/system/bin/sh', '/data', '/data/local', '/data/local/tmp', '/sdcard',
  '/sdcard/Download', '/storage', '/storage/emulated', '/storage/emulated/0', '/proc', '/proc/self', '/dev', '/etc',
  R, `${R}/var`, `${R}/var/lib`, `${R}/var/lib/dsh-app`, `${R}/var/lib/dsh-app/phone`, `${R}/opt`, `${R}/opt/dsh-app`,
  `${R}/opt/dsh-app/phone`, `${R}/opt/dsh-app/phone/relay.cjs`, `${R}/root`, `${R}/root/.dsh`, `${R}/tmp`, `${R}/usr`, `${R}/usr/local`,
  `${R}/usr/local/lib`]);
const android = (p) => HOST.has(p);
const mapper = () => createHostArgs({ rootfs: R, mounts: MOUNTS, exists: android });

test('guest runtime paths map into the rootfs (the phone MCP row)', () => {
  const m = mapper();
  assert.equal(m.mapPath('/var/lib/dsh-app/phone/bridge.json'), `${R}/var/lib/dsh-app/phone/bridge.json`);
  assert.equal(m.mapPath('/opt/dsh-app/phone/relay.cjs'), `${R}/opt/dsh-app/phone/relay.cjs`);
  assert.equal(m.mapPath('/root/.dsh/config.json'), `${R}/root/.dsh/config.json`);
  assert.equal(m.mapPath('/tmp/out.txt'), `${R}/tmp/out.txt`);
  assert.equal(m.mapPath('/usr/local/lib/x'), `${R}/usr/local/lib/x`);
  assert.deepEqual(m.mapArgs(['/opt/dsh-app/phone/relay.cjs', '/var/lib/dsh-app/phone/bridge.json']),
    [`${R}/opt/dsh-app/phone/relay.cjs`, `${R}/var/lib/dsh-app/phone/bridge.json`]);
  assert.equal(m.mapArg('--config=/var/lib/dsh-app/phone/bridge.json'), `--config=${R}/var/lib/dsh-app/phone/bridge.json`);
});

test('real Android paths are never rewritten', () => {
  const m = mapper();
  for (const p of ['/system/bin/sh', '/system/etc/hosts', '/data/local/tmp/x', '/data/data/com.termux/files/usr/bin/bash',
    '/sdcard/Download/a.txt', '/sdcard/new-file', '/storage/emulated/0/DCIM', '/proc/self/status', '/dev/block/sda', '/etc/hosts',
    '/apex/com.android.conscrypt/cacerts', '/vendor/lib64']) {
    assert.equal(m.mapPath(p), p, p);
  }
  // Already host spellings, relative paths, text, URLs, flags without paths.
  for (const a of [`${R}/var/lib/dsh-app/phone/bridge.json`, 'relay.cjs', './x', '-c', 'echo /var/x', 'https://x/var', '--port=8080', '', '/']) {
    assert.equal(m.mapArg(a), a, a);
  }
  // No counterpart parent in the rootfs: left alone (nothing to point at).
  assert.equal(m.mapPath('/var/nowhere/deep/file'), '/var/nowhere/deep/file');
  // Parent traversal is never guessed at.
  assert.equal(m.mapPath('/tmp/../system/bin/sh'), '/tmp/../system/bin/sh');
});

test('non-identity mounts map like cwd does; identity mounts stay', () => {
  const m = mapper();
  assert.equal(m.mapPath('/root/手机存储/notes.md'), '/storage/emulated/0/notes.md');
  assert.equal(m.mapPath('/sdcard'), '/sdcard');
});

test('a host that really has the guest tree keeps its own path (Linux /tmp)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hostargs-'));
  try {
    const root = join(dir, 'rootfs');
    mkdirSync(join(root, 'var/lib/dsh-app/phone'), { recursive: true });
    mkdirSync(join(root, 'tmp'), { recursive: true });
    const m = createHostArgs({ rootfs: root, mounts: [] });
    // /tmp exists on this Linux host: a new file in it is a host path.
    assert.equal(m.mapPath('/tmp/parakeet-hostargs-new-file'), '/tmp/parakeet-hostargs-new-file');
    // /var/lib/dsh-app does not exist on a CI host: the rootfs owns it.
    assert.equal(m.mapPath('/var/lib/dsh-app/phone/bridge.json'), join(root, 'var/lib/dsh-app/phone/bridge.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('env values: whole absolute values map, real paths and lists stay', () => {
  const m = mapper();
  const env = { BRIDGE: '/var/lib/dsh-app/phone/bridge.json', PATH: '/usr/local/bin:/system/bin', SHELL: '/system/bin/sh', N: '3' };
  const out = m.mapEnv(env);
  assert.equal(out.BRIDGE, `${R}/var/lib/dsh-app/phone/bridge.json`);
  assert.equal(out.PATH, env.PATH);
  assert.equal(out.SHELL, '/system/bin/sh');
  assert.equal(out.N, '3');
  assert.equal(env.BRIDGE, '/var/lib/dsh-app/phone/bridge.json', 'input not mutated');
  const same = { A: '/system/bin' };
  assert.equal(m.mapEnv(same), same, 'nothing to map: same object');
});

test('planner: MCP stdio child gets host paths; root-exec su wrap carries them', () => {
  const m = mapper();
  const config = { bin: `${R}/opt/dsh-app/direct/bin`, node: '/apk/libnode_exec.so', rootfs: R, hostShell: '/system/bin/sh' };
  const paths = createPaths(R, MOUNTS);
  const commands = createCommands(config, paths);
  const mcp = m.plan(commands.command(`${config.bin}/node`, ['/opt/dsh-app/phone/relay.cjs', '/var/lib/dsh-app/phone/bridge.json'],
    { env: { PHONE_CONFIG: '/var/lib/dsh-app/phone/bridge.json' } }));
  assert.equal(mcp.file, `${config.bin}/node`);
  assert.deepEqual(mcp.args, [`${R}/opt/dsh-app/phone/relay.cjs`, `${R}/var/lib/dsh-app/phone/bridge.json`]);
  assert.equal(mcp.options.env.PHONE_CONFIG, `${R}/var/lib/dsh-app/phone/bridge.json`);
  // A guest-exec'd server (`command: /usr/local/bin/x`, args with guest paths).
  const other = m.plan(commands.command('/usr/local/bin/some-mcp', ['--db=/root/.dsh/db.sqlite', '/sdcard/Download'], { env: {} }));
  assert.equal(other.file, `${config.bin}/guest`);
  assert.deepEqual(other.args, [`${R}/usr/local/bin/some-mcp`, `--db=${R}/root/.dsh/db.sqlite`, '/sdcard/Download']);
  // Root mode: the agent's command is wrapped after mapping, so the su script has host paths.
  const rootExec = createRootExec({ rootMode: () => true, su: () => '/system/bin/su' });
  const agent = rootExec(m.plan(commands.command(`${config.bin}/bash`, ['-c', 'cat "$1"', 'x', '/var/lib/dsh-app/phone/bridge.json'],
    { env: { DSH_SHELL: '1' } })));
  assert.equal(agent.file, '/system/bin/su');
  assert.match(agent.args[1], new RegExp(`'${R.replaceAll('.', '\\.')}/var/lib/dsh-app/phone/bridge\\.json'`));
  assert.doesNotMatch(agent.args[1], /'\/var\/lib/);
  assert.equal(suPlan(m.plan({ file: '/system/bin/ls', args: ['/system'], options: {} }), '/su').args[1].includes("'/system'"), true);
});

test('end to end: a spawned child reads a file named by its guest path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hostargs-e2e-'));
  try {
    const root = join(dir, 'rootfs');
    mkdirSync(join(root, 'var/lib/dsh-app/phone'), { recursive: true });
    writeFileSync(join(root, 'var/lib/dsh-app/phone/bridge.json'), '{"v":1}');
    const m = createHostArgs({ rootfs: root, mounts: [] });
    const p = m.plan({ file: process.execPath, args: ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))', '/var/lib/dsh-app/phone/bridge.json'], options: {} });
    const r = spawnSync(p.file, p.args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '{"v":1}');
    // Unmapped, the same child fails the way the v0.2.2 relay did.
    const raw = spawnSync(process.execPath, p.args.slice(0, 2).concat('/var/lib/dsh-app/phone/bridge.json'), { encoding: 'utf8' });
    assert.notEqual(raw.status, 0);
    assert.match(raw.stderr, /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
