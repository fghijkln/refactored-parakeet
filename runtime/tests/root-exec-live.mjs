// Parakeet root execution mode, end to end through a real DSH agent turn.
//
//   DSH_PREFIX=<dsh tree> node runtime/tests/root-exec-live.mjs
//
// A mock DeepSeek Messages endpoint drives one `bash` tool call per case; DSH runs
// headless out of the built tree, with the host preload installed so
// runtime/direct/root-exec.mjs plans the commands, and PARAKEET_SU pointing at a
// fake su that marks what it ran and reports uid 0.
//
// Cases:
//   granted-uid0  Root on  → the command runs through su, `id -u` answers 0
//   off-no-su     Root off → the command runs as this uid, su is never used
//   brick-asks    Root on  → `dd ... of=/dev/block/...` is NOT executed; the brick
//                 guard turns it into an approval ask, which --approval-policy never
//                 rejects, so the tool result is an error and nothing ran
//   brick-allowed Root on  → the same command, with approval answered allow, runs
//   ordinary-no-ask Root on → an ordinary root command raises no approval at all
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const prefix = resolve(process.env.DSH_PREFIX ?? '');
assert.ok(prefix && existsSync(join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js')), 'DSH_PREFIX must be a built dsh tree');
const here = fileURLToPath(new URL('.', import.meta.url));
const approvalPlugin = join(here, 'fixtures', 'parakeet-approve-all.mjs');

/**
 * A test su. With passwordless sudo (GitHub runners) it is a REAL root: the
 * script runs under `sudo -n`, so `id -u` answers 0 from the kernel. Without sudo
 * (a dev box) it reports uid 0 through BASH_ENV, which the root script never
 * re-exports (root-exec.mjs leaves BASH_ENV out), defining `id`. Either way it
 * records every script it was handed.
 */
function fakeSu(dir) {
  const su = join(dir, 'su');
  const rc = join(dir, 'fake-root.rc');
  writeFileSync(rc, 'id() { if [ "$1" = -u ]; then echo 0; else echo "uid=0(root) gid=0(root)"; fi; }\n');
  const sudo = spawnSync('sudo', ['-n', 'true']).status === 0;
  writeFileSync(su, [
    '#!/bin/sh',
    `printf '%s\\n' "$2" >> ${JSON.stringify(join(dir, 'su-calls.txt'))}`,
    '[ "$1" = -c ] || exit 9',
    sudo ? 'exec sudo -n /bin/sh -c "$2"' : `BASH_ENV=${JSON.stringify(rc)} exec /bin/sh -c "$2"`,
  ].join('\n') + '\n');
  chmodSync(su, 0o755);
  return { su, real: sudo };
}

const CASES = [
  { name: 'granted-uid0', root: true, approve: false, command: 'id -u; echo PARAKEET_MARK', expectSu: true, expectRan: true, expectOutput: /^0$/m },
  { name: 'off-no-su', root: false, approve: false, command: 'id -u; echo PARAKEET_MARK', expectSu: false, expectRan: true },
  { name: 'brick-asks', root: true, approve: false, command: 'dd if=/dev/zero of="$TMPDIR/parakeet/dev/block/sda" bs=1 count=1; echo PARAKEET_MARK', expectSu: false, expectRan: false },
  { name: 'brick-allowed', root: true, approve: true, command: 'echo would-flash > "$TMPDIR/parakeet/dev/block/fake" 2>/dev/null; echo PARAKEET_MARK', expectSu: true, expectRan: true },
  { name: 'ordinary-no-ask', root: true, approve: false, command: 'echo ordinary; echo PARAKEET_MARK', expectSu: true, expectRan: true },
];

async function runCase(c) {
  const root = await mkdtemp(join(tmpdir(), 'parakeet-rootexec-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const suDir = join(root, 'su');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(suDir, { recursive: true });
  const { su, real } = fakeSu(suDir);
  const settings = join(home, 'parakeet-settings.json');
  writeFileSync(settings, JSON.stringify({ rootExec: c.root }));
  const requests = [];
  let serverError;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const bytes of req) chunks.push(bytes);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      const first = requests.length === 1;
      const frames = [{ type: 'message_start', message: { id: `pk-${requests.length}`, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], usage: { input_tokens: 3, output_tokens: 0 } } }];
      if (first) {
        frames.push(
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-1', name: 'bash', input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ description: 'parakeet root exec probe', command: c.command }) } },
          { type: 'content_block_stop', index: 0 },
        );
      } else {
        frames.push(
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
          { type: 'content_block_stop', index: 0 },
        );
      }
      frames.push({ type: 'message_delta', delta: { stop_reason: first ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } }, { type: 'message_stop' });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(''));
    } catch (error) {
      serverError = error;
      res.writeHead(500);
      res.end('fixture failure');
    }
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const patch = ['session-title-llm', 'llm-pi-ai', 'llm-deepseek-account', 'session-telemetry-otel', 'desktop-product-telemetry', 'web-search-deepseek', 'web-deepseek-api', 'web-fetch-http', 'tool-web'].map((id) => ({ id, disabled: true }));
    patch.push(
      { id: 'llm-deepseek', config: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'PARAKEET_FIXTURE_KEY', thinking: 'disabled', maxTokens: 2048 } },
      { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
      { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
      { id: 'sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: workspace } },
      { id: 'permission', config: { defaultPreset: 'danger-full-access' } },
      { id: 'fs-sandbox', config: { cwd: workspace } },
      { insert: [{ id: 'parakeet-root-shell', name: join(prefix, 'node_modules/@parakeet/dsh-plugin-root-shell/lib/index.js') }] },
    );
    // The approval answerer: without one every ask fails closed (which is the
    // brick-asks case). `approve` mounts one that allows, for brick-allowed.
    if (c.approve) patch.push({ insert: [{ id: 'parakeet-approve-all', name: approvalPlugin }] });
    const patchFile = join(root, 'patch.json');
    writeFileSync(patchFile, JSON.stringify(patch));
    const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
    Object.assign(env, {
      HOME: home,
      DSH_HOME: home,
      TMPDIR: join(root, 'tmp'),
      DSH_TELEMETRY_DISABLED: '1',
      PARAKEET_FIXTURE_KEY: 'synthetic-local-only',
      PARAKEET_SETTINGS: settings,
      PARAKEET_SU: su,
    });
    mkdirSync(join(root, 'tmp'), { recursive: true });
    const child = spawn(process.execPath, ['--expose-internals',
      `--import=${join(here, 'fixtures', 'root-exec-preload.mjs')}`,
      join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'headless', '--patch', patchFile, '--approval-policy', c.approve ? 'ask' : 'never',
      'Run the probe command with bash.',
    ], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (t) => { stdout += t; });
    child.stderr.on('data', (t) => { stderr += t; });
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 90_000);
    const [code] = await once(child, 'close');
    clearTimeout(watchdog);
    if (serverError) throw serverError;
    assert.equal(code, 0, `headless exited ${code}\n${stderr}`);
    assert.equal(requests.length, 2, 'one tool round plus the final turn');

    const suCalls = existsSync(join(suDir, 'su-calls.txt')) ? readFileSync(join(suDir, 'su-calls.txt'), 'utf8') : '';
    const results = requests[1].messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result');
    assert.equal(results.length, 1, 'exactly one tool result');
    const text = (Array.isArray(results[0].content) ? results[0].content : []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

    assert.equal(/\bsu\b/.test(suCalls) || suCalls.length > 0, c.expectSu, `${c.name}: su ${c.expectSu ? 'should' : 'should not'} have run; calls=${JSON.stringify(suCalls)}`);
    assert.equal(text.includes('PARAKEET_MARK'), c.expectRan, `${c.name}: command ${c.expectRan ? 'should' : 'should not'} have run; result=${text}`);
    if (!c.expectRan) {
      assert.equal(results[0].is_error, true, `${c.name}: a refused brick-risk command must be an error result`);
      assert.match(text, /approval|approve|reject/i, `${c.name}: the refusal must name the approval; got ${text}`);
    }
    if (c.expectOutput) assert.match(text, c.expectOutput, `${c.name}: ${text}`);
    // Only the agent's one command crosses su: none of the engine's own children.
    if (c.expectSu) assert.equal((suCalls.match(/^exec /gm) ?? []).length, 1, `${c.name}: su scripts ${suCalls}`);
    if (c.name === 'ordinary-no-ask') {
      // An ordinary command under --approval-policy never: if anything had asked,
      // it would have been rejected and PARAKEET_MARK would be missing.
      assert.ok(text.includes('ordinary'), text);
    }
    console.log(JSON.stringify({ case: c.name, status: 'PASS', realRoot: real, suScripts: (suCalls.match(/^exec /gm) ?? []).length, result: text.slice(0, 160) }));
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  }
}

let failed = 0;
for (const c of CASES) {
  try {
    await runCase(c);
  } catch (error) {
    failed++;
    console.error(JSON.stringify({ case: c.name, status: 'FAIL', error: String(error.stack ?? error).slice(0, 1500) }));
  }
}
console.log(JSON.stringify({ cases: CASES.length, passed: CASES.length - failed, failed }));
assert.equal(failed, 0, 'parakeet root execution mode live cases');
