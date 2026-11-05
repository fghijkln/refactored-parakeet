import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_KEY_ENV, PROVIDER_ROUTE, buildPatch, withPatchArg } from '../../dsh/launcher/parakeet-config.mjs';

const row = (patch, id) => patch.find((r) => r.id === id);
const inserted = (patch, id) => patch.flatMap((r) => r.insert ?? []).find((r) => r.id === id);

test('openai-compatible provider becomes a pi-ai route keyed by env, never by value', () => {
  const p = buildPatch({ provider: { kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }, workspaceRoot: '/w' });
  const route = row(p, 'llm-pi-ai').config.providers[PROVIDER_ROUTE];
  assert.equal(route.api, 'openai-completions');
  assert.equal(route.baseURL, 'https://api.deepseek.com/v1');
  assert.equal(route.apiKeyEnv, API_KEY_ENV);
  assert.deepEqual(route.models, [{ id: 'deepseek-chat', name: 'deepseek-chat' }]);
  assert.deepEqual(row(p, 'agent-default-model').config, { provider: PROVIDER_ROUTE, model: 'deepseek-chat' });
  assert.doesNotMatch(JSON.stringify(p), /sk-/);
});

test('anthropic defaults to anthropic-messages; api override wins', () => {
  const a = buildPatch({ provider: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-x' } });
  assert.equal(row(a, 'llm-pi-ai').config.providers[PROVIDER_ROUTE].api, 'anthropic-messages');
  const o = buildPatch({ provider: { kind: 'openai-compatible', baseUrl: 'https://x/v1', model: 'm', api: 'openai-responses' } });
  assert.equal(row(o, 'llm-pi-ai').config.providers[PROVIDER_ROUTE].api, 'openai-responses');
});

test('deepseek kind keeps the native adapter; none adds no model rows', () => {
  const d = buildPatch({ provider: { kind: 'deepseek' } });
  assert.equal(row(d, 'llm-pi-ai'), undefined);
  assert.equal(row(d, 'agent-default-model'), undefined);
  const n = buildPatch({});
  assert.equal(row(n, 'llm-pi-ai'), undefined);
});

test('android sandbox policy and approval-ask preset are always set', () => {
  const p = buildPatch({ workspaceRoot: '/w' });
  assert.deepEqual(row(p, 'sandbox-policy').config, { mode: 'danger-full-access', workspaceRoot: '/w' });
  const perm = row(p, 'permission').config;
  assert.equal(perm.defaultPreset, 'android-ask');
  assert.equal(perm.presets['android-ask'].approval, 'ask');
});

test('root tool row is inserted unless disabled, with the given entry path', () => {
  assert.equal(inserted(buildPatch({}, { rootPluginEntry: '/rt/x.js' }), 'parakeet-root-shell').name, '/rt/x.js');
  assert.equal(inserted(buildPatch({ rootTool: false }), 'parakeet-root-shell'), undefined);
});

test('invalid provider settings throw', () => {
  assert.throws(() => buildPatch({ provider: { kind: 'openai-compatible', model: 'm' } }));
  assert.throws(() => buildPatch({ provider: { kind: 'carrier-pigeon' } }));
});

test('withPatchArg inserts after the profile name only for booting commands', () => {
  assert.deepEqual(withPatchArg(['web', '--port', '1'], '/p.yml'), ['web', '--patch', '/p.yml', '--port', '1']);
  assert.deepEqual(withPatchArg(['plugin', '--profile', 'web', 'add', 'x'], '/p.yml'), ['plugin', '--profile', 'web', 'add', 'x']);
  assert.deepEqual(withPatchArg(['--help'], '/p.yml'), ['--help']);
});
