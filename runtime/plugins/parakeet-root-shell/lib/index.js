/**
 * DSH (Cordis) plugin: Android root over KernelSU `su`.
 *
 * Root execution mode (设置 › 系统权限 › Root, v0.2.2): once the user grants root,
 * the app writes `rootExec: true` into the settings file below, and the host
 * runtime (runtime/direct/root-exec.mjs) runs every `bash` command of the agent
 * as uid 0. No per-command prompt — except for brick-risk commands
 * (lib/brick.js: partition writes, system partitions mounted rw or written,
 * /data or /metadata wiped or formatted, flashing, partition tables), which this
 * plugin confirms ONCE with the user through DSH's approval service before they
 * run (a `tools/pre-execute` gate on `bash`, and inside `root_shell`).
 *
 * Registers two model-facing tools on the host tool registry:
 *  - `root_shell`: run a shell command as uid 0 through a persistent `su`
 *    session (falls back to one-shot `su -c`). Gated by the DSH approval
 *    service when the app's "require confirmation before root commands"
 *    toggle is on (default ON), and ALWAYS gated for device-destroying
 *    command shapes (dd to /dev/block, mkfs, wipe, ...).
 *  - `root_status`: report whether root is available (KernelSU markers, su
 *    path, uid of `su -c id`).
 *
 * The toggle lives in a small JSON file the Android app writes
 * (`$PARAKEET_SETTINGS`, default `$DSH_HOME/parakeet-settings.json`) and is
 * re-read on every call, so flipping it in the app applies to the next command
 * without restarting DSH.
 *
 * @module @parakeet/dsh-plugin-root-shell
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { PersistentSu, findSu, isDangerous, probeRoot, runAsRoot } from './su.js';
import { brickRisk } from './brick.js';

export const name = 'parakeet-root-shell';
export const inject = ['tools'];

/** Tools whose `command` argument is a shell command run by the host runtime. */
export const SHELL_TOOLS = new Set(['bash']);

export const Config = z.object({
  /** Default for the confirmation gate when the settings file is absent. */
  requireConfirm: z.boolean().default(true),
  /** Use one long-lived su session (true) or `su -c` per command (false). */
  persistent: z.boolean().default(true),
  /** Default per-command timeout. */
  timeoutMs: z.natural().min(1000).default(120_000),
  /** Output cap per command (tail kept). */
  maxBytes: z.natural().min(1024).default(256 * 1024),
});

/**
 * Read the app-owned settings file.
 * @param {string | undefined} path
 * @returns {{requireRootConfirm?: boolean}}
 */
export function readAppSettings(path) {
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Decide whether a root command needs the user's approval.
 * @param {string} command
 * @param {boolean} requireConfirm - per-command confirmation (off once Root is granted).
 * @returns {{ask: boolean, reason?: string}}
 */
export function approvalNeed(command, requireConfirm) {
  if (isDangerous(command)) {
    const why = brickRisk(command).reason ?? 'potentially device-destroying';
    return { ask: true, reason: `brick-risk root command: ${why} (always confirmed)` };
  }
  if (requireConfirm) return { ask: true, reason: 'root command (confirmation enabled in app settings)' };
  return { ask: false };
}

/**
 * The brick-risk gate for the agent's `bash` tool while root execution mode is
 * on: a `tools/pre-execute` decision. Ordinary commands pass untouched; a
 * brick-risk one becomes ONE approval ask (merged with any ask a downstream
 * policy already raised).
 * @param {{name: string, arguments?: {command?: unknown}}} exec - the pending call.
 * @param {boolean} rootExec - the app's Root grant.
 * @returns {{kind: 'ask', reason: string, displayReason: string} | undefined} the ask, or undefined to pass.
 */
export function brickGate(exec, rootExec) {
  if (!rootExec || !SHELL_TOOLS.has(exec?.name)) return undefined;
  const command = typeof exec.arguments?.command === 'string' ? exec.arguments.command : '';
  const risk = brickRisk(command);
  if (!risk.risk) return undefined;
  return {
    kind: 'ask',
    reason: `brick-risk root command: ${risk.reason}: ${command}`,
    displayReason: `ROOT · ${risk.reason}\n\n# ${command}`,
  };
}

function settingsPath() {
  if (process.env.PARAKEET_SETTINGS) return process.env.PARAKEET_SETTINGS;
  if (process.env.DSH_HOME) return join(process.env.DSH_HOME, 'parakeet-settings.json');
  return undefined;
}

const DESCRIPTION =
  'Run a shell command as root (uid 0) on this Android device through su (KernelSU / Magisk). ' +
  'When the user granted Root in the app (Settings › System permissions › Root), the normal bash tool already ' +
  'runs every command as root and this tool is not needed; otherwise use it only for operations that need root ' +
  '(system files, /data, device properties, other apps, settings put, pm/am as root, mount, iptables, logcat of all processes). ' +
  'The shell is Android\'s /system/bin/sh (mksh/toybox), not bash. stdout and stderr are merged. ' +
  'Commands that can brick the device (writing /dev/block or partitions, flashing, mounting or writing /system, /vendor, ' +
  '/product and other system partitions, formatting or wiping /data or /metadata) always need the user\'s confirmation; ' +
  'never run them unless the user explicitly asked for exactly that.';

export async function apply(ctx, config) {
  const session = new PersistentSu();
  ctx.on?.('dispose', () => session.stop());
  const effective = (key, fallback) => {
    const v = typeof config?.[key]?.get === 'function' ? config[key].get() : config?.[key];
    return v ?? fallback;
  };

  // DSH_PARAKEET_ROOT=1 in the model's shell environment while Root is granted, so the
  // agent can tell (and the managed-variable list in its prompt says so).
  ctx.inject?.(['shellEnv'], (envCtx) => {
    envCtx.shellEnv.register({
      name: 'parakeet-root',
      variables: {
        DSH_PARAKEET_ROOT: {
          description: '"1" when the user granted Root in the app: every bash command runs as root (uid 0) through su; ' +
            'commands that can brick the device (partition writes, system partitions, wiping /data) ask the user first.',
        },
      },
      resolve: () => (readAppSettings(settingsPath()).rootExec === true ? { DSH_PARAKEET_ROOT: '1' } : {}),
    });
  });

  // Brick-risk gate on the agent's bash tool (root execution mode, v0.2.2).
  ctx.on?.('tools/pre-execute', async (exec, next) => {
    const gate = brickGate(exec, readAppSettings(settingsPath()).rootExec === true);
    const downstream = await next();
    if (gate === undefined) return downstream;
    // A downstream deny/cancel stands; an allow or another ask becomes this one ask.
    if (downstream?.kind === 'deny' || downstream?.kind === 'cancel') return downstream;
    return gate;
  });

  ctx.tools.register(
    defineTool({
      name: 'root_status',
      description:
        'Report whether root (KernelSU su) is available to this app on the Android device. ' +
        'Calling it may make the KernelSU manager show a grant prompt the first time.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            available: { type: 'boolean', required: true },
            kernelSu: { type: 'boolean', required: true },
            suPath: { type: 'string' },
            uid: { type: 'integer' },
            detail: { type: 'string' },
          },
        },
        render: (_a, v) => [
          {
            type: 'text',
            text: v.available
              ? `root available (uid ${v.uid}) via ${v.suPath}${v.kernelSu ? ', KernelSU detected' : ''}`
              : `root unavailable${v.kernelSu ? ' (KernelSU detected but not granted to this app)' : ''}: ${v.detail ?? ''}`,
          },
        ],
      },
      execute() {
        return Promise.resolve(probeRoot());
      },
      presentCall: () => ({ card: 'generic', title: 'Check root status', kind: 'other' }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'root_shell',
      description: DESCRIPTION,
      parameters: {
        description: {
          type: 'string',
          required: true,
          description: 'One short sentence telling the user what this root command does and why. Use the user\'s language.',
        },
        command: { type: 'string', required: true, description: 'The shell command to run as root.' },
        workdir: { type: 'string', description: 'Absolute working directory for the command.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 120000).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            output: { type: 'string', required: true },
            exitCode: { type: 'integer' },
            truncated: { type: 'boolean', required: true },
          },
        },
        render: (_a, v) => [
          {
            type: 'text',
            text: `${v.output}${v.truncated ? '\n[output truncated]' : ''}\n[exit code: ${v.exitCode ?? 'killed'}]`,
          },
        ],
      },
      async execute(args, exec) {
        const command = String(args.command ?? '');
        if (command.trim().length === 0) throw new Error('invalid command: expected a non-empty string');
        if (findSu() === undefined) {
          throw new Error('root unavailable: no su binary on this device. Install KernelSU and grant root to this app in the KernelSU manager, or use the bash tool.');
        }
        const appSettings = readAppSettings(settingsPath());
        // Root granted in the app (rootExec): root is the agent's normal mode, so only
        // brick-risk commands ask. Otherwise the older per-command toggle applies.
        const requireConfirm = appSettings.rootExec === true ? false
          : (appSettings.requireRootConfirm ?? effective('requireConfirm', true));
        const need = approvalNeed(command, requireConfirm);
        if (need.ask) {
          const approver = ctx.get?.('approval');
          if (approver === undefined || exec.agent === undefined) {
            throw new Error('root command needs user approval, but no approval channel is available; ask the user to disable confirmation in the app or approve interactively');
          }
          const outcome = await approver.request({
            agent: exec.agent,
            toolName: 'root_shell',
            callId: exec.callId,
            reason: `${need.reason}: ${command}`,
            displayReason: `${args.description}\n\n# ${command}`,
            ...(exec.signal ? { signal: exec.signal } : {}),
          });
          if (outcome !== 'allowed-once') {
            throw new Error(`the user did not approve this root command (${outcome}); do not retry it another way — stop and explain`);
          }
        }
        const timeoutMs = args.timeoutMs ?? effective('timeoutMs', 120_000);
        const maxBytes = effective('maxBytes', 256 * 1024);
        if (effective('persistent', true)) {
          try {
            return await session.run(command, { cwd: args.workdir, timeoutMs, maxBytes, signal: exec.signal });
          } catch (error) {
            if (/timed out|stopped/.test(String(error?.message))) throw error;
            ctx.logger?.warn?.(`root_shell: persistent su failed (${error?.message}); falling back to su -c`);
          }
        }
        const r = await runAsRoot(command, { cwd: args.workdir, timeoutMs, maxBytes, signal: exec.signal });
        const output = [r.stdout, r.stderr].filter((s) => s.length > 0).join(r.stdout.endsWith('\n') ? '' : '\n');
        return { output: output.replace(/\n$/, ''), exitCode: r.exitCode, truncated: r.truncated };
      },
      presentCall: (args) => ({
        card: 'terminal',
        title: `# ${args.command}`,
        description: args.description,
        ...(args.workdir !== undefined ? { cwd: args.workdir } : {}),
      }),
    }),
  );
  // One line in the engine log (the app's Logs screen): the root tools are registered.
  process.stderr.write('[parakeet-root-shell] registered root_shell, root_status, bash brick-risk gate\n');
}
