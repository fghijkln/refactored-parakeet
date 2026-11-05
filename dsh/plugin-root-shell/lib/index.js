/**
 * DSH (Cordis) plugin: Android root shell over KernelSU `su`.
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

export const name = 'parakeet-root-shell';
export const inject = ['tools'];

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
 * @param {boolean} requireConfirm - the user's toggle.
 * @returns {{ask: boolean, reason?: string}}
 */
export function approvalNeed(command, requireConfirm) {
  if (isDangerous(command)) {
    return { ask: true, reason: 'potentially device-destroying root command (always confirmed)' };
  }
  if (requireConfirm) return { ask: true, reason: 'root command (confirmation enabled in app settings)' };
  return { ask: false };
}

function settingsPath() {
  if (process.env.PARAKEET_SETTINGS) return process.env.PARAKEET_SETTINGS;
  if (process.env.DSH_HOME) return join(process.env.DSH_HOME, 'parakeet-settings.json');
  return undefined;
}

const DESCRIPTION =
  'Run a shell command as root (uid 0) on this Android device through su (KernelSU). ' +
  'Use it only for operations that need root (system files, /data, device properties, other apps, ' +
  'settings put, pm/am as root, mount, iptables, logcat of all processes). Prefer the normal bash tool ' +
  'for everything else. The shell is Android\'s /system/bin/sh (mksh/toybox), not bash. stdout and stderr are merged. ' +
  'The user may be asked to approve each command. Never run commands that can brick the device ' +
  '(writing to /dev/block, flashing partitions, wiping data) unless the user explicitly asked for exactly that.';

export async function apply(ctx, config) {
  const session = new PersistentSu();
  ctx.on?.('dispose', () => session.stop());
  const effective = (key, fallback) => {
    const v = typeof config?.[key]?.get === 'function' ? config[key].get() : config?.[key];
    return v ?? fallback;
  };

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
        const requireConfirm = appSettings.requireRootConfirm ?? effective('requireConfirm', true);
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
}
