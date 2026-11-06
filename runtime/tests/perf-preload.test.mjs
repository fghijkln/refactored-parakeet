// Unit test for dsh/launcher/perf-preload.mjs: memoises existsSync and utf8
// .json reads under PARAKEET_IMMUTABLE_ROOT only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const preload = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../../dsh/launcher/perf-preload.mjs')).href;

test('memoises under the root, passes through outside it', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-root-'));
  const other = mkdtempSync(join(tmpdir(), 'pk-other-'));
  mkdirSync(join(root, 'pkg'));
  writeFileSync(join(root, 'pkg/package.json'), '{"v":1}');
  writeFileSync(join(other, 'package.json'), '{"v":1}');
  const script = `
    import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
    const r = ${JSON.stringify(root)}, o = ${JSON.stringify(other)};
    const out = {};
    out.a1 = readFileSync(r + '/pkg/package.json', 'utf8');
    writeFileSync(r + '/pkg/package.json', '{"v":2}');
    out.a2 = readFileSync(r + '/pkg/package.json', 'utf8');           // memoised
    out.aBuf = readFileSync(r + '/pkg/package.json').toString();      // not utf8 -> real
    out.e1 = existsSync(r + '/missing');
    writeFileSync(r + '/missing', 'x');
    out.e2 = existsSync(r + '/missing');                              // memoised false
    out.b1 = readFileSync(o + '/package.json', 'utf8');
    writeFileSync(o + '/package.json', '{"v":2}');
    out.b2 = readFileSync(o + '/package.json', 'utf8');               // outside root -> real
    out.dotdot = existsSync(r + '/../' + o.split('/').pop() + '/package.json');
    console.log(JSON.stringify(out));`;
  const res = spawnSync(process.execPath, ['--import', preload, '--input-type=module', '-e', script], {
    env: { ...process.env, PARAKEET_IMMUTABLE_ROOT: root }, encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.a1, '{"v":1}');
  assert.equal(out.a2, '{"v":1}');
  assert.equal(out.aBuf, '{"v":2}');
  assert.equal(out.e1, false);
  assert.equal(out.e2, false);
  assert.equal(out.b1, '{"v":1}');
  assert.equal(out.b2, '{"v":2}');
  assert.equal(out.dotdot, true);
});

test('PARAKEET_FS_MEMO=0 disables it', () => {
  const root = mkdtempSync(join(tmpdir(), 'pk-root-'));
  writeFileSync(join(root, 'a.json'), '1');
  const script = `import { readFileSync, writeFileSync } from 'node:fs';
    const p = ${JSON.stringify(join(root, 'a.json'))};
    readFileSync(p, 'utf8'); writeFileSync(p, '2'); console.log(readFileSync(p, 'utf8'));`;
  const res = spawnSync(process.execPath, ['--import', preload, '--input-type=module', '-e', script], {
    env: { ...process.env, PARAKEET_IMMUTABLE_ROOT: root, PARAKEET_FS_MEMO: '0' }, encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), '2');
});
