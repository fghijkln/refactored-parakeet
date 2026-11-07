// Parakeet root execution mode (runtime/direct/root-exec.mjs): the planner step
// that routes the agent's own shell commands through su when Root is granted.
// Runs on Linux CI with a fake su (no root needed): the fake su exec's sh -c, so
// what is checked is the plan (argv, environment carried across, cwd) and that
// only model shell commands are wrapped.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SU_CANDIDATES, createRootExec, findSu, isAgentShell, rootModeReader, suPlan } from '../../direct/root-exec.mjs';

const pluginSu = readFileSync(new URL('../../plugins/parakeet-root-shell/lib/su.js', import.meta.url), 'utf8');

test('su candidates match the root-shell plugin', () => {
  const m = /export const SU_CANDIDATES = \[([^\]]*)\]/.exec(pluginSu);
  assert.ok(m);
  const theirs = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.deepEqual(SU_CANDIDATES, theirs);
});

test('findSu honours PARAKEET_SU', () => {
  const saved = process.env.PARAKEET_SU;
  try {
    process.env.PARAKEET_SU = '/opt/fake/su';
    assert.equal(findSu((p) => p === '/opt/fake/su'), '/opt/fake/su');
    delete process.env.PARAKEET_SU;
    assert.equal(findSu((p) => p === '/sbin/su'), '/sbin/su');
    assert.equal(findSu(() => false), undefined);
  } finally {
    if (saved === undefined) delete process.env.PARAKEET_SU; else process.env.PARAKEET_SU = saved;
  }
});

test('rootModeReader: missing, true, false, broken, and re-read on change', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rootmode-'));
  const file = join(dir, 'parakeet-settings.json');
  try {
    const read = rootModeReader(file);
    assert.equal(read(), false, 'missing file: off');
    writeFileSync(file, JSON.stringify({ rootExec: true }));
    assert.equal(read(), true);
    writeFileSync(file, JSON.stringify({ rootExec: false, other: 1 }));
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.equal(read(), false);
    writeFileSync(file, '{not json');
    utimesSync(file, new Date(), new Date(Date.now() + 10000));
    assert.equal(read(), false, 'broken file: off');
    assert.equal(rootModeReader(undefined)(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only model shell commands (DSH_SHELL=1) are agent shells', () => {
  assert.equal(isAgentShell({ DSH_SHELL: '1' }), true);
  assert.equal(isAgentShell({ DSH_SHELL: '0' }), false);
  assert.equal(isAgentShell({}), false);
  assert.equal(isAgentShell(undefined), false);
});

test('createRootExec wraps only when on, an agent shell, and su exists', () => {
  const plan = { file: '/bin/bash', args: ['-c', 'id -u'], options: { env: { DSH_SHELL: '1', HOME: '/h' }, cwd: '/w' } };
  const lines = [];
  let on = false;
  let su = '/x/su';
  const hook = createRootExec({ rootMode: () => on, su: () => su, log: (l) => lines.push(l) });
  assert.strictEqual(hook(plan), plan, 'off: untouched');
  on = true;
  const wrapped = hook(plan);
  assert.equal(wrapped.file, '/x/su');
  assert.equal(wrapped.args[0], '-c');
  assert.match(wrapped.args[1], /exec '\/bin\/bash' '-c' 'id -u'$/);
  const internal = { file: '/bin/node', args: ['x.js'], options: { env: { HOME: '/h' } } };
  assert.strictEqual(hook(internal), internal, 'engine-internal children are never wrapped');
  su = undefined;
  assert.strictEqual(hook(plan), plan, 'no su: untouched (degrades to app uid)');
  assert.ok(lines.some((l) => l.includes('root execution mode on')));
  assert.ok(lines.some((l) => l.includes('no su binary')));
});

test('suPlan carries environment, cwd and argv verbatim across su', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fakesu-'));
  const su = join(dir, 'su');
  // A fake su: `su -c <script>` runs the script with sh, with an EMPTY environment
  // (the strictest su), so everything the command sees must come from the script.
  writeFileSync(su, '#!/bin/sh\n[ "$1" = -c ] || exit 9\nexec env -i /bin/sh -c "$2"\n');
  chmodSync(su, 0o755);
  try {
    const env = {
      DSH_SHELL: '1', HOME: '/home/x', TMPDIR: dir, PATH: '/usr/bin:/bin', LD_LIBRARY_PATH: '/lib/a:/lib/b',
      OPENSSL_CONF: `${dir}/openssl.cnf`, SSL_CERT_FILE: `${dir}/cert.pem`, QUOTED: "it's \"q\" $HOME `x`",
      PWD: '/elsewhere', 'BAD-NAME': 'skip',
    };
    const plan = suPlan({ file: '/bin/sh', args: ['-c', 'printf "%s|" "$HOME" "$TMPDIR" "$LD_LIBRARY_PATH" "$OPENSSL_CONF" "$SSL_CERT_FILE" "$QUOTED" "$(pwd)" "$DSH_SHELL"; printf "%s" "$1"', 'sh', "arg with 'quote'"], options: { env, cwd: dir } }, su);
    assert.equal(plan.file, su);
    const r = spawnSync(plan.file, plan.args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const [home, tmp, ld, ossl, cert, quoted, cwd, marker, arg] = r.stdout.split('|');
    assert.equal(home, '/home/x');
    assert.equal(tmp, dir);
    assert.equal(ld, '/lib/a:/lib/b');
    assert.equal(ossl, `${dir}/openssl.cnf`);
    assert.equal(cert, `${dir}/cert.pem`);
    assert.equal(quoted, "it's \"q\" $HOME `x`");
    assert.equal(cwd, dir);
    assert.equal(marker, '1');
    assert.equal(arg, "arg with 'quote'");
    assert.doesNotMatch(plan.args[1], /BAD-NAME|export PWD=/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
