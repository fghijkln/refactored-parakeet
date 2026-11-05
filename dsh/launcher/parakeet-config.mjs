/**
 * Turn the Android app's provider/runtime settings into a DSH `--patch`
 * overlay (a YAML patch list; JSON is valid YAML, so it is written as JSON).
 *
 * Input (`$PARAKEET_CONFIG`, written by the app; contains NO secrets):
 * {
 *   "provider": {
 *     "kind": "openai-compatible" | "anthropic" | "deepseek" | "none",
 *     "baseUrl": "https://api.example.com/v1",
 *     "model": "model-id",
 *     "displayName": "My Gateway",          // optional
 *     "api": "openai-completions" | "openai-responses" | "anthropic-messages", // optional override
 *     "contextWindow": 128000               // optional
 *   },
 *   "rootTool": true,                        // mount the KernelSU root_shell tool
 *   "workspaceRoot": "/data/user/0/<pkg>/files/workspace"
 * }
 * The API key travels only as the PARAKEET_API_KEY environment variable of
 * the DSH process; the overlay names that variable via `apiKeyEnv`, which DSH
 * resolves per request through its credential seam.
 */

export const PROVIDER_ROUTE = 'parakeet';
export const API_KEY_ENV = 'PARAKEET_API_KEY';

const DEFAULT_API = {
  'openai-compatible': 'openai-completions',
  anthropic: 'anthropic-messages',
};

/**
 * @param {any} cfg - parsed app config.
 * @returns {object[]} the DSH patch list.
 */
export function buildPatch(cfg = {}) {
  const patch = [];
  const workspaceRoot = typeof cfg.workspaceRoot === 'string' && cfg.workspaceRoot ? cfg.workspaceRoot : process.cwd();

  // No Landlock/bwrap launcher exists for Android, so every confined sandbox
  // mode would fail with SANDBOX_UNAVAILABLE. The device is the sandbox's
  // job here: full file access for the (non-root) app uid, approvals still on.
  patch.push({
    id: 'sandbox-policy',
    config: { mode: 'danger-full-access', workspaceRoot },
  });
  patch.push({
    id: 'permission',
    config: {
      presets: {
        'android-ask': {
          sandbox: 'danger-full-access',
          approval: 'ask',
          name: 'android (ask)',
          description: 'Full access as the app user; root commands and escalations ask for approval.',
        },
        'danger-full-access': {
          sandbox: 'danger-full-access',
          approval: 'never',
          name: 'danger-full-access',
          description: 'Full file access without approval prompts (root_shell confirmations are then rejected).',
        },
      },
      defaultPreset: 'android-ask',
    },
  });

  if (cfg.rootTool !== false) {
    patch.push({
      insert: [
        {
          id: 'parakeet-root-shell',
          name: '@parakeet/dsh-plugin-root-shell',
          config: { requireConfirm: true, persistent: true },
        },
      ],
    });
  }

  const p = cfg.provider ?? {};
  const kind = p.kind ?? 'none';
  if (kind === 'openai-compatible' || kind === 'anthropic') {
    if (!p.baseUrl || !p.model) throw new Error(`provider ${kind} needs baseUrl and model`);
    const api = p.api ?? DEFAULT_API[kind];
    const model = { id: String(p.model), name: String(p.model) };
    if (Number.isFinite(p.contextWindow)) model.contextWindow = p.contextWindow;
    patch.push({
      id: 'llm-pi-ai',
      config: {
        providers: {
          [PROVIDER_ROUTE]: {
            displayName: p.displayName || 'Parakeet provider',
            api,
            baseURL: String(p.baseUrl),
            apiKeyEnv: API_KEY_ENV,
            models: [model],
          },
        },
      },
    });
    patch.push({
      id: 'agent-default-model',
      config: { provider: PROVIDER_ROUTE, model: String(p.model) },
    });
  } else if (kind === 'deepseek') {
    // DSH's native DeepSeek adapter reads DEEPSEEK_API_KEY; the launcher maps
    // PARAKEET_API_KEY onto it. Model defaults to DSH's own default.
    if (p.model) {
      patch.push({ id: 'agent-default-model', config: { provider: 'deepseek-official', model: String(p.model) } });
    }
  } else if (kind !== 'none') {
    throw new Error(`unknown provider kind ${kind}`);
  }
  return patch;
}

/**
 * Insert `--patch <file>` right after the profile name in a dsh argv.
 * @param {string[]} argv - process.argv.slice(2).
 * @param {string} file
 * @returns {string[]}
 */
export function withPatchArg(argv, file) {
  if (argv.length === 0) return argv;
  if (argv[0] === 'plugin' || argv[0].startsWith('-')) return argv; // plugin/meta commands boot nothing
  return [argv[0], '--patch', file, ...argv.slice(1)];
}
