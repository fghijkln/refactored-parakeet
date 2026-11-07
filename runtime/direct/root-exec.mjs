// Parakeet root execution mode: with Root granted (设置 › 系统权限 › Root), every
// shell command the agent runs executes as uid 0.
//
// The app writes `{"rootExec": true}` into its settings file once the user grants
// root (KernelSU, or any other su); this module re-reads that file (cheaply, by
// mtime) and the host runtime's command planner (processes.mjs) routes the
// model's shell commands through `su -c` while the engine itself keeps running as
// the app's uid — a root engine would leave root-owned files all over the app's
// private directory.
//
// Only the agent's own shell commands are wrapped: they carry DSH_SHELL=1, the
// trusted marker `@deepseek-ai/dsh-shell-env` injects into every model shell call.
// The engine's internal children (node, pnpm, ripgrep) are never wrapped.
//
// Environment crosses the su boundary explicitly: `su -c` on Android starts a new
// shell whose environment is the caller's only on some managers, and the host
// engine depends on HOME/TMPDIR/PATH/LD_LIBRARY_PATH plus the OpenSSL and CA
// settings HostLaunch.kt computes (v0.2.1: Termux's compiled-in paths must stay
// out). Every variable of the planned child is re-exported inside the root shell.
//
// Brick-risk commands are not handled here: they are confirmed with the user by
// the DSH approval service before the command ever reaches execution
// (runtime/plugins/parakeet-root-shell, lib/brick.js).
import fs from 'node:fs';

/**
 * su binaries, most standard first. Kept identical to SU_CANDIDATES in
 * runtime/plugins/parakeet-root-shell/lib/su.js (asserted by
 * runtime/tests/root-exec.test.mjs); this file cannot import that one, which
 * lives inside the DSH tree rather than the preload tree.
 */
export const SU_CANDIDATES = [
  '/system/bin/su',
  '/system/xbin/su',
  '/debug_ramdisk/su',
  '/sbin/su',
  '/data/adb/ksu/bin/su',
];

/** Shell-managed names that must not be carried across the su boundary. */
const NOT_EXPORTED = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'IFS', 'PS1', 'PS2', 'PS4', 'BASH_ENV', 'ENV', 'LD_PRELOAD']);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

/**
 * Find an su binary.
 * @param {(p: string) => boolean} [exists] - injection point for tests.
 * @returns {string | undefined} the first existing candidate path.
 */
export function findSu(exists = fs.existsSync) {
  // PARAKEET_SU: explicit override, set by the app for an unusual su location
  // and by CI for a fake su. Only the app controls this process environment.
  const override = process.env.PARAKEET_SU;
  if (override && exists(override)) return override;
  return SU_CANDIDATES.find((p) => exists(p));
}

/**
 * The app's settings file: `$PARAKEET_SETTINGS`, else `$DSH_HOME/parakeet-settings.json`,
 * else the runtime tree's own DSH home.
 * @param {string} [rootfs] - the runtime root, for the last fallback.
 * @returns {string | undefined} the path, when one can be formed.
 */
export function settingsPath(rootfs) {
  if (process.env.PARAKEET_SETTINGS) return process.env.PARAKEET_SETTINGS;
  if (process.env.DSH_HOME) return `${process.env.DSH_HOME}/parakeet-settings.json`;
  return rootfs === undefined ? undefined : `${rootfs}/root/.dsh/parakeet-settings.json`;
}

/**
 * Read `{rootExec: boolean}` from the app's settings file, re-reading only when
 * the file changed. A missing or broken file means root mode is off: the agent
 * then runs as the app's uid, exactly as before Root was offered.
 * @param {string | undefined} path - the settings file.
 * @returns {() => boolean} a cheap predicate for the planner's hot path.
 */
export function rootModeReader(path) {
  let stamp = '';
  let value = false;
  return () => {
    if (path === undefined) return false;
    let next;
    try {
      const s = fs.statSync(path);
      next = `${s.mtimeMs}:${s.size}`;
    } catch {
      stamp = '';
      value = false;
      return false;
    }
    if (next === stamp) return value;
    stamp = next;
    try {
      value = JSON.parse(fs.readFileSync(path, 'utf8'))?.rootExec === true;
    } catch {
      value = false;
    }
    return value;
  };
}

/**
 * Whether this planned child is one of the agent's own shell commands, which is
 * what root mode covers. `DSH_SHELL=1` is set by `@deepseek-ai/dsh-shell-env` for
 * every model shell call and by nothing else; the subprocess service strips
 * ambient `DSH_*` from inherited environments, so it cannot be spoofed by a
 * command's own exports.
 * @param {Record<string, string | undefined> | undefined} env - the planned child environment.
 * @returns {boolean} true for a model shell command.
 */
export function isAgentShell(env) {
  return env?.DSH_SHELL === '1';
}

/**
 * Re-plan one child so it runs as uid 0 through `su -c`.
 *
 * The original argv is exec'd verbatim inside the root shell, after the child's
 * whole environment is re-exported and its working directory entered, so the
 * command sees exactly what it would have seen without root but with uid 0.
 * @param {{file: string, args: string[], options: object}} plan - the planned child.
 * @param {string} suPath - the su binary.
 * @returns {{file: string, args: string[], options: object}} the root plan.
 */
export function suPlan(plan, suPath) {
  const env = plan.options?.env ?? process.env;
  const exports = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !NAME.test(key) || NOT_EXPORTED.has(key)) continue;
    exports.push(`export ${key}=${quote(value)}`);
  }
  const cwd = plan.options?.cwd;
  const script = [
    ...exports,
    ...(cwd === undefined ? [] : [`cd ${quote(cwd)} || exit 1`]),
    `exec ${[plan.file, ...plan.args].map(quote).join(' ')}`,
  ].join('\n');
  return { file: suPath, args: ['-c', script], options: plan.options };
}

/**
 * The planner hook used by processes.mjs: wraps a planned child in `su` when
 * root mode is on, the child is a model shell command, and an su binary exists.
 * Without su the plan is untouched, so a revoked or lost grant degrades to
 * ordinary app-uid execution instead of failing every command.
 * @param {object} [options]
 * @param {string} [options.rootfs] - the runtime root (settings fallback).
 * @param {() => boolean} [options.rootMode] - injection point for tests.
 * @param {() => (string | undefined)} [options.su] - injection point for tests.
 * @param {(message: string) => void} [options.log] - one line when the mode flips.
 * @returns {(plan: {file: string, args: string[], options: object}) => {file: string, args: string[], options: object}}
 */
export function createRootExec({ rootfs, rootMode, su, log } = {}) {
  const enabled = rootMode ?? rootModeReader(settingsPath(rootfs));
  const locate = su ?? (() => findSu());
  let announced;
  return (plan) => {
    if (!enabled()) {
      if (announced === true) log?.('[parakeet-root] root execution mode off: commands run as the app');
      announced = false;
      return plan;
    }
    if (!isAgentShell(plan.options?.env)) return plan;
    const suPath = locate();
    if (suPath === undefined) {
      if (announced !== 'nosu') log?.('[parakeet-root] root granted but no su binary is present: commands run as the app');
      announced = 'nosu';
      return plan;
    }
    if (announced !== true) log?.(`[parakeet-root] root execution mode on: agent commands run as uid 0 through ${suPath}`);
    announced = true;
    return suPlan(plan, suPath);
  };
}
