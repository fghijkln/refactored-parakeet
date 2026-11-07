// Parakeet v0.2.3: the phone MCP server reaches "connected" under the host engine.
//
//   DSH_PREFIX=<dsh tree> node runtime/tests/phone-mcp-host-live.mjs
//
// v0.2.2 on a real phone: the engine runs on Android's own `/` (host-preload.mjs),
// phone.patch.yml handed the MCP relay the guest path
// /var/lib/dsh-app/phone/bridge.json, MCP stdio children get no guest→host
// mapping, the relay died with ENOENT and DSH reported `phone` as "server is
// disconnected" while the app's toggle/accessibility/bridge checks were green.
//
// This runs a real `dsh headless` turn through the runtime's own host-preload.mjs
// (a host-engine tree is assembled from runtime/direct unless
// PARAKEET_LIVE_ROOTFS names a real one, e.g. the emulator's), with:
//   - the relay the app writes (RELAY_JS, extracted from PhoneGuest.kt),
//   - a fake phone bridge on an abstract unix socket that speaks the app's
//     hello + MCP (initialize, tools/list, tools/call), and
//   - a mock model that asserts `mcp__phone__screen` is among its tools and calls it.
//
// Cases (each its own engine):
//   guest-paths  the v0.2.2 row (/opt/..., /var/... guest spellings): host-args.mjs
//                maps them for the MCP child (and the relay's own fallback would too)
//   host-paths   the row the app writes from v0.2.3 under the host engine
//   relay-alone  the relay without any preload, handed the guest path: its own
//                fallback finds <rootfs>/var/... and reaches the bridge
// On a host where /var/lib/dsh-app exists the guest path would be a real host
// path; the test refuses to run there rather than pass for the wrong reason.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(here, '../..');
const prefix = resolve(process.env.DSH_PREFIX ?? '');
assert.ok(prefix && existsSync(join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js')), 'DSH_PREFIX must be a built dsh tree');
assert.ok(existsSync(join(prefix, 'node_modules/@deepseek-ai/dsh-mcp-client')), 'DSH_PREFIX has no @deepseek-ai/dsh-mcp-client');
assert.ok(!existsSync('/var/lib/dsh-app'), '/var/lib/dsh-app exists on this host: the guest-path case would not test the mapping');

/** RELAY_JS exactly as the APK writes it (a Kotlin raw string with no `$`). */
function relaySource() {
  const kt = process.env.PARAKEET_LIVE_PHONE_GUEST ??
    join(repo, 'app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/phone/PhoneGuest.kt');
  const text = readFileSync(kt, 'utf8');
  const m = /const val RELAY_JS = """([\s\S]*?)"""/u.exec(text);
  assert.ok(m, 'RELAY_JS not found in PhoneGuest.kt');
  return m[1];
}

/** A host-engine tree like HostLaunch.kt writes, or the one named by PARAKEET_LIVE_ROOTFS. */
function hostTree(base) {
  if (process.env.PARAKEET_LIVE_ROOTFS) {
    const R = resolve(process.env.PARAKEET_LIVE_ROOTFS);
    return { R, bin: `${R}/opt/dsh-app/direct/bin`, preload: `${R}/opt/dsh-go/direct/host-preload.mjs`, real: true };
  }
  const R = join(base, 'rootfs');
  const direct = join(R, 'opt/dsh-go/direct');
  const owned = join(R, 'opt/dsh-app/direct');
  const bin = join(owned, 'bin');
  for (const d of [direct, bin, join(R, 'tmp'), join(R, 'root'), join(R, 'var/lib')]) mkdirSync(d, { recursive: true });
  for (const f of readdirSync(join(repo, 'runtime/direct'))) if (f.endsWith('.mjs')) copyFileSync(join(repo, 'runtime/direct', f), join(direct, f));
  const preload = join(direct, 'host-preload.mjs');
  // Identity mounts, as the manifest's `-b` rows are on a phone: the DSH tree and this
  // test's scratch directory are real host paths (everything else absolute maps into R).
  const mounts = [...new Set([prefix, base, dirname(process.execPath)])].map((p) => ({ host: p, guest: p }));
  const config = { schema: 2, engine: 'host', rootfs: R, bin, loader: '', libraryPath: '', node: process.execPath, hostShell: '/bin/sh', mounts };
  writeFileSync(join(owned, 'config.json'), `${JSON.stringify(config)}\n`);
  const w = (name, body) => { writeFileSync(join(bin, name), body); chmodSync(join(bin, name), 0o700); };
  w('node', `#!/bin/sh\nunset DSH_GO_DIRECT_MAIN\nexport DSH_GO_RUNTIME_ROOT='${R}' DSH_GO_DIRECT_ROOTFS='${R}'\nexec '${process.execPath}' --expose-internals '--import=${preload}' "$@"\n`);
  w('guest', '#!/bin/sh\nf="$1"; shift\nif [ -f "$f" ] && [ -x "$f" ]; then exec "$f" "$@"; fi\nexec "${f##*/}" "$@"\n');
  w('bash', '#!/bin/sh\nexec bash "$@"\n');
  w('sh', '#!/bin/sh\nexec /bin/sh "$@"\n');
  return { R, bin, preload, real: false };
}

/** The app's bridge, reduced to what DSH's MCP client needs: hello + token, then MCP lines. */
function fakeBridge(token) {
  const name = `parakeet-live-${randomBytes(6).toString('hex')}`;
  const seen = { hellos: 0, badHello: 0, methods: [], calls: [] };
  const server = net.createServer((sock) => {
    let buf = '';
    let authed = false;
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      buf += chunk;
      let at;
      while ((at = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, at); buf = buf.slice(at + 1);
        if (!authed) {
          let ok = false;
          try { const h = JSON.parse(line); ok = h.dshPhone === 1 && h.token === token; } catch {}
          if (!ok) { seen.badHello++; sock.destroy(); return; }
          authed = true; seen.hellos++; continue;
        }
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.method) seen.methods.push(msg.method);
        if (msg.id === undefined) continue;
        const reply = (result) => sock.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
        if (msg.method === 'initialize') reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'dsh-phone-fake', version: '0' } });
        else if (msg.method === 'tools/list') reply({ tools: [{ name: 'screen', description: 'Read the current screen.', inputSchema: { type: 'object', properties: {} } }] });
        else if (msg.method === 'tools/call') { seen.calls.push(msg.params?.name); reply({ content: [{ type: 'text', text: 'PARAKEET_SCREEN_OK' }] }); }
        else if (msg.method === 'ping') reply({});
        else sock.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no such method' } })}\n`);
      }
    });
  });
  return { name, seen, server };
}

function writePhone(R, token, abstractName) {
  mkdirSync(join(R, 'opt/dsh-app/phone'), { recursive: true });
  mkdirSync(join(R, 'var/lib/dsh-app/phone'), { recursive: true, mode: 0o700 });
  writeFileSync(join(R, 'opt/dsh-app/phone/relay.cjs'), relaySource());
  writeFileSync(join(R, 'var/lib/dsh-app/phone/bridge.json'), `${JSON.stringify({ v: 1, abstract: abstractName, tcpPort: null, token })}\n`, { mode: 0o600 });
}

/** phone.patch.yml as PhoneGuest.patchYaml writes it. */
const phoneYaml = (relay, config) => `- insert:
    - id: dsh-app-phone
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: phone
        transport: stdio
        command: !!js process.execPath
        args:
          - ${relay}
          - ${config}
        toolCallTimeoutMs: 660000
        failOnStartupError: false
`;

async function runEngineCase(c, base, tree) {
  const token = randomBytes(16).toString('hex');
  const bridge = fakeBridge(token);
  bridge.server.listen({ path: `\0${bridge.name}` });
  await once(bridge.server, 'listening');
  writePhone(tree.R, token, bridge.name);
  const work = await mkdtemp(join(base, `${c.name}-`));
  const home = join(work, 'home'); const workspace = join(work, 'workspace');
  mkdirSync(home, { recursive: true }); mkdirSync(workspace, { recursive: true }); mkdirSync(join(work, 'tmp'), { recursive: true });
  const requests = [];
  let sawPhoneTool = false;
  const model = createServer(async (req, res) => {
    const chunks = []; for await (const b of req) chunks.push(b);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const names = (body.tools ?? []).map((t) => t.name);
    const first = requests.length === 1;
    if (first) sawPhoneTool = names.includes('mcp__phone__screen');
    const frames = [{ type: 'message_start', message: { id: `pk-${requests.length}`, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], usage: { input_tokens: 3, output_tokens: 0 } } }];
    if (first && sawPhoneTool) {
      frames.push(
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-1', name: 'mcp__phone__screen', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'content_block_stop', index: 0 });
    } else {
      frames.push(
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: first ? `no phone tool; tools=${names.join(',')}` : 'done' } },
        { type: 'content_block_stop', index: 0 });
    }
    frames.push({ type: 'message_delta', delta: { stop_reason: first && sawPhoneTool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } }, { type: 'message_stop' });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(''));
  });
  try {
    model.listen(0, '127.0.0.1'); await once(model, 'listening');
    const patch = ['session-title-llm', 'llm-pi-ai', 'llm-deepseek-account', 'session-telemetry-otel', 'desktop-product-telemetry', 'web-search-deepseek', 'web-deepseek-api', 'web-fetch-http', 'tool-web'].map((id) => ({ id, disabled: true }));
    patch.push(
      { id: 'llm-deepseek', config: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKeyEnv: 'PARAKEET_FIXTURE_KEY', thinking: 'disabled', maxTokens: 2048 } },
      { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
      { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
      { id: 'sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: workspace } },
      { id: 'permission', config: { defaultPreset: 'danger-full-access' } },
      { id: 'fs-sandbox', config: { cwd: workspace } },
    );
    writeFileSync(join(work, 'patch.json'), JSON.stringify(patch));
    const phonePatch = join(work, 'phone.patch.yml');
    writeFileSync(phonePatch, c.host
      ? phoneYaml(`${tree.R}/opt/dsh-app/phone/relay.cjs`, `${tree.R}/var/lib/dsh-app/phone/bridge.json`)
      : phoneYaml('/opt/dsh-app/phone/relay.cjs', '/var/lib/dsh-app/phone/bridge.json'));
    const passEnv = ['PATH', 'LANG', 'LC_ALL', ...(process.env.PARAKEET_LIVE_PASS_ENV ?? '').split(',').filter(Boolean)];
    const env = Object.fromEntries(passEnv.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
    Object.assign(env, { HOME: home, DSH_HOME: home, TMPDIR: join(work, 'tmp'), DSH_TELEMETRY_DISABLED: '1', PARAKEET_FIXTURE_KEY: 'synthetic-local-only',
      PATH: `${tree.bin}:${env.PATH ?? '/usr/bin:/bin'}`, DSH_GO_RUNTIME_ROOT: tree.R, DSH_GO_DIRECT_ROOTFS: tree.R });
    const child = spawn(process.execPath, ['--expose-internals', `--import=${tree.preload}`,
      join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'headless', '--patch', join(work, 'patch.json'), '--patch', phonePatch,
      '--approval-policy', 'never', 'Read the phone screen.'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (t) => { stdout += t; }); child.stderr.on('data', (t) => { stderr += t; });
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 120_000);
    const [code] = await once(child, 'close');
    clearTimeout(watchdog);
    const relayStatus = existsSync(join(tree.R, 'opt/dsh-app/phone/relay-status.json'))
      ? JSON.parse(readFileSync(join(tree.R, 'opt/dsh-app/phone/relay-status.json'), 'utf8')) : null;
    const diag = `\nbridge=${JSON.stringify(bridge.seen)} relay=${JSON.stringify(relayStatus)}\nstderr:\n${stderr.slice(-3000)}\nstdout:\n${stdout.slice(-1500)}`;
    assert.equal(code, 0, `headless exited ${code}${diag}`);
    assert.ok(bridge.seen.hellos >= 1, `${c.name}: the relay never reached the bridge${diag}`);
    assert.ok(bridge.seen.methods.includes('initialize') && bridge.seen.methods.includes('tools/list'), `${c.name}: MCP handshake incomplete${diag}`);
    assert.equal(sawPhoneTool, true, `${c.name}: mcp__phone__screen not offered to the model${diag}`);
    assert.deepEqual(bridge.seen.calls, ['screen'], `${c.name}: tools/call did not reach the bridge${diag}`);
    const results = requests[1]?.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result') ?? [];
    const text = JSON.stringify(results);
    assert.match(text, /PARAKEET_SCREEN_OK/, `${c.name}: tool result ${text}${diag}`);
    assert.equal(relayStatus?.ok, true, `${c.name}: relay status ${JSON.stringify(relayStatus)}`);
    assert.equal(relayStatus.config, `${tree.R}/var/lib/dsh-app/phone/bridge.json`, `${c.name}: relay read ${relayStatus.config}`);
    console.log(JSON.stringify({ case: c.name, status: 'PASS', realTree: tree.real, mcp: 'connected', methods: [...new Set(bridge.seen.methods)], calls: bridge.seen.calls, config: relayStatus.config }));
  } finally {
    model.closeAllConnections?.();
    if (model.listening) await new Promise((r) => model.close(r));
    bridge.server.close();
  }
}

async function runRelayAlone(base, tree) {
  const token = randomBytes(16).toString('hex');
  const bridge = fakeBridge(token);
  bridge.server.listen({ path: `\0${bridge.name}` });
  await once(bridge.server, 'listening');
  writePhone(tree.R, token, bridge.name);
  // No preload at all: plain node, guest path argument.
  const child = spawn(process.execPath, [join(tree.R, 'opt/dsh-app/phone/relay.cjs'), '/var/lib/dsh-app/phone/bridge.json'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', (t) => { err += t; });
  const got = new Promise((ok) => child.stdout.on('data', (t) => { out += t; if (out.includes('\n')) ok(); }));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } })}\n`);
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try {
    await Promise.race([got, once(child, 'close')]);
    assert.match(out, /"serverInfo"/, `relay-alone: no initialize reply; stderr=${err} bridge=${JSON.stringify(bridge.seen)}`);
    console.log(JSON.stringify({ case: 'relay-alone', status: 'PASS', hellos: bridge.seen.hellos }));
  } finally {
    clearTimeout(timer); child.kill(); bridge.server.close();
  }
}

const base = await mkdtemp(join(process.env.PARAKEET_LIVE_TMP ?? tmpdir(), 'parakeet-phone-mcp-'));
const tree = hostTree(base);
const CASES = [{ name: 'guest-paths', host: false }, { name: 'host-paths', host: true }];
const only = (process.env.PARAKEET_LIVE_CASES ?? '').split(',').filter(Boolean);
let failed = 0; let ran = 0;
try {
  for (const c of CASES) {
    if (only.length && !only.includes(c.name)) continue;
    ran++;
    try { await runEngineCase(c, base, tree); } catch (e) { failed++; console.error(JSON.stringify({ case: c.name, status: 'FAIL', error: String(e.stack ?? e).slice(0, 4000) })); }
  }
  if (!only.length || only.includes('relay-alone')) {
    ran++;
    try { await runRelayAlone(base, tree); } catch (e) { failed++; console.error(JSON.stringify({ case: 'relay-alone', status: 'FAIL', error: String(e.stack ?? e).slice(0, 2000) })); }
  }
} finally {
  if (!tree.real) await rm(base, { recursive: true, force: true });
}
console.log(JSON.stringify({ cases: ran, passed: ran - failed, failed }));
assert.equal(failed, 0, 'phone MCP under the host engine');
