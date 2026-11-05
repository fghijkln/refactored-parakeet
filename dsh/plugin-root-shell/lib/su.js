/**
 * Root detection and `su` execution for Android, aimed at KernelSU.
 *
 * KernelSU hooks the kernel so that a `su` binary is visible to apps the user
 * granted root to in the KernelSU manager; `ksud` and /data/adb/ksu are the
 * manager-side markers. Magisk is not a target but tends to work, because the
 * only contract used here is "there is an su on PATH that accepts `-c`".
 *
 * Nothing in this module is Android-only at the language level, so it is unit
 * testable on Linux CI with a fake `su` on PATH.
 *
 * @module @parakeet/dsh-plugin-root-shell/su
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Candidate absolute paths of an `su` binary, most standard first. */
export const SU_CANDIDATES = [
  '/system/bin/su',
  '/system/xbin/su',
  '/debug_ramdisk/su',
  '/sbin/su',
  '/data/adb/ksu/bin/su',
];

/** Markers that KernelSU is installed on this device (independently of a grant). */
export const KSU_MARKERS = [
  '/data/adb/ksu',
  '/data/adb/ksud',
  '/data/adb/ksu/bin/ksud',
  '/system/bin/ksud',
];

/**
 * Find an `su` binary.
 * @param {(p: string) => boolean} [exists] - injection point for tests.
 * @returns {string | undefined} the first existing candidate path.
 */
export function findSu(exists = existsSync) {
  return SU_CANDIDATES.find((p) => exists(p));
}

/**
 * Whether KernelSU appears installed, which is a different question from
 * whether this app was granted root: a device can show markers and still deny.
 * @param {(p: string) => boolean} [exists] - injection point for tests.
 * @returns {boolean} true when any KernelSU marker path exists.
 */
export function kernelSuPresent(exists = existsSync) {
  return KSU_MARKERS.some((p) => exists(p));
}

/**
 * Parse the output of `id` into its uid.
 * @param {string} text - raw `id` output, e.g. `uid=0(root) gid=0(root) ...`.
 * @returns {number | undefined} the uid, or undefined when unparseable.
 */
export function parseUid(text) {
  const m = /uid=(\d+)/.exec(text ?? '');
  return m === null ? undefined : Number(m[1]);
}

/**
 * Probe for usable root: runs `su -c id` and checks for uid 0.
 *
 * The first call on a KernelSU device makes the manager show its grant
 * prompt; a denied or absent grant returns `{ available: false }` with the
 * binary's own message as `detail`, never throws.
 *
 * @param {object} [opts]
 * @param {string} [opts.suPath] - explicit `su` path; defaults to {@link findSu}.
 * @param {number} [opts.timeoutMs] - probe timeout, default 10s (a grant
 *   dialog the user ignores must not hang the app forever).
 * @param {typeof spawnSync} [opts.runner] - injection point for tests.
 * @returns {{available: boolean, suPath?: string, uid?: number, detail?: string, kernelSu: boolean}}
 */
export function probeRoot(opts = {}) {
  const runner = opts.runner ?? spawnSync;
  const kernelSu = kernelSuPresent();
  const suPath = opts.suPath ?? findSu();
  if (suPath === undefined) {
    return { available: false, kernelSu, detail: 'no su binary found on this device' };
  }
  const res = runner(suPath, ['-c', 'id'], {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 10_000,
  });
  if (res.error) {
    return { available: false, kernelSu, suPath, detail: String(res.error.message ?? res.error) };
  }
  const uid = parseUid(`${res.stdout ?? ''}${res.stderr ?? ''}`);
  if (uid === 0) return { available: true, kernelSu, suPath, uid };
  return {
    available: false,
    kernelSu,
    suPath,
    ...(uid === undefined ? {} : { uid }),
    detail: (res.stderr || res.stdout || `su exited with ${res.status}`).toString().trim(),
  };
}

/**
 * Build the argv that runs one shell command as root.
 *
 * `su -c <command>` is the portable spelling: KernelSU, Magisk and classic
 * su all accept it, and it keeps the command a single argv element so no
 * word splitting happens before the root shell sees it.
 *
 * @param {string} suPath - the su binary.
 * @param {string} command - the shell command text.
 * @param {object} [opts]
 * @param {string} [opts.user] - refused: a root tool that could silently drop
 *   to another uid is a footgun, so target-user switching is not offered.
 * @returns {string[]} argv, su binary first.
 */
export function suArgv(suPath, command, opts = {}) {
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new Error('root command must be a non-empty string');
  }
  if (opts.user !== undefined) throw new Error('suArgv: target user switching is not supported');
  return [suPath, '-c', command];
}

/**
 * Run one command as root and collect its output.
 * @param {string} command - shell command text.
 * @param {object} [opts]
 * @param {string} [opts.suPath]
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutMs] - default 120s.
 * @param {number} [opts.maxBytes] - output cap per stream, default 256 KiB.
 * @param {AbortSignal} [opts.signal]
 * @param {Record<string,string>} [opts.env]
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number|null, signal: string|null, truncated: boolean}>}
 */
export function runAsRoot(command, opts = {}) {
  const suPath = opts.suPath ?? findSu();
  if (suPath === undefined) return Promise.reject(new Error('root unavailable: no su binary found'));
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const argv = suArgv(suPath, command);
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let truncated = false;
    const cap = (acc, chunk) => {
      if (acc.length >= maxBytes) {
        truncated = true;
        return acc;
      }
      const next = acc + chunk;
      if (next.length > maxBytes) {
        truncated = true;
        return next.slice(0, maxBytes);
      }
      return next;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      out = cap(out, c);
    });
    child.stderr.on('data', (c) => {
      err = cap(err, c);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 120_000);
    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ stdout: out, stderr: err, exitCode: code, signal: sig, truncated });
    });
  });
}

/**
 * Commands that are very likely to brick a device or wipe user data. The tool
 * always asks before these, even when the user turned confirmation off, since
 * "I trust the agent with my phone" is not the same as "overwrite my boot
 * partition without telling me".
 */
export const DANGEROUS_PATTERNS = [
  /\bdd\b[^\n]*\bof=\/dev\/block\//,
  /\bmkfs(\.\w+)?\b/,
  /\bwipe\b/,
  /\bfastboot\b/,
  /\bformat\s+\/(data|system)\b/,
  /\brm\s+(-[a-zA-Z]*\s+)*\/(system|vendor|data|dev\/block)(\/|\s|$)/,
  /\bflash_image\b/,
  /\brecovery\s+--wipe_data\b/,
  />\s*\/dev\/block\//,
];

/**
 * Whether a command matches a known device-destroying shape.
 * @param {string} command - the command text.
 * @returns {boolean} true when it looks destructive.
 */
export function isDangerous(command) {
  return DANGEROUS_PATTERNS.some((re) => re.test(command));
}

/**
 * A persistent root shell: one long-lived `su` process fed commands over
 * stdin, so the agent does not fork a new su (and, on some managers, show a
 * new toast) per command. Commands run one at a time; each is shipped
 * base64-encoded and `eval`ed in a subshell, so no quoting of the command
 * text is ever needed, and an end marker carrying the exit status delimits
 * its output. stdout and stderr are merged (2>&1) in this mode.
 *
 * A command that outlives its timeout kills the whole session; the next
 * command starts a fresh one. Callers fall back to {@link runAsRoot} when the
 * session cannot start.
 */
export class PersistentSu {
  /**
   * @param {object} [opts]
   * @param {string} [opts.suPath]
   * @param {typeof spawn} [opts.spawner] - injection point for tests.
   * @param {string[]} [opts.shellArgs] - argv after the su binary; default none
   *   (su with no arguments starts an interactive root shell reading stdin).
   */
  constructor(opts = {}) {
    this.suPath = opts.suPath;
    this.spawner = opts.spawner ?? spawn;
    this.shellArgs = opts.shellArgs ?? [];
    this.child = undefined;
    this.buffer = '';
    this.pending = undefined;
    this.queue = Promise.resolve();
    this.seq = 0;
  }

  start() {
    if (this.child !== undefined) return;
    const suPath = this.suPath ?? findSu();
    if (suPath === undefined) throw new Error('root unavailable: no su binary found');
    const child = this.spawner(suPath, this.shellArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const onData = (chunk) => {
      this.buffer += chunk;
      this.drain();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const onGone = (why) => {
      if (this.child !== child) return;
      this.child = undefined;
      const p = this.pending;
      this.pending = undefined;
      p?.reject(new Error(`root shell exited: ${why}`));
    };
    child.on('error', (e) => onGone(String(e?.message ?? e)));
    child.on('close', (code, sig) => onGone(`code=${code} signal=${sig}`));
    child.stdin.on('error', () => {});
  }

  drain() {
    const p = this.pending;
    if (p === undefined) return;
    const idx = this.buffer.indexOf(p.marker);
    if (idx === -1) {
      if (this.buffer.length > p.maxBytes * 2) {
        p.truncated = true;
        this.buffer = this.buffer.slice(-p.maxBytes);
      }
      return;
    }
    const after = this.buffer.slice(idx + p.marker.length);
    const nl = after.indexOf('\n');
    if (nl === -1) return;
    const code = Number.parseInt(after.slice(0, nl).trim(), 10);
    let output = this.buffer.slice(0, idx);
    this.buffer = after.slice(nl + 1);
    if (output.endsWith('\n')) output = output.slice(0, -1);
    let truncated = p.truncated;
    if (output.length > p.maxBytes) {
      output = output.slice(-p.maxBytes);
      truncated = true;
    }
    this.pending = undefined;
    p.resolve({ output, exitCode: Number.isNaN(code) ? null : code, truncated });
  }

  /** Kill the current session (used on timeout/abort and by the plugin's dispose). */
  stop() {
    const child = this.child;
    this.child = undefined;
    try {
      child?.kill('SIGKILL');
    } catch {
      // already gone
    }
    const p = this.pending;
    this.pending = undefined;
    p?.reject(new Error('root shell stopped'));
  }

  /**
   * Run one command in the persistent root shell.
   * @param {string} command
   * @param {object} [opts]
   * @param {string} [opts.cwd]
   * @param {number} [opts.timeoutMs] - default 120s.
   * @param {number} [opts.maxBytes] - default 256 KiB (tail kept).
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<{output: string, exitCode: number|null, truncated: boolean}>}
   */
  run(command, opts = {}) {
    if (typeof command !== 'string' || command.trim().length === 0) {
      return Promise.reject(new Error('root command must be a non-empty string'));
    }
    const job = this.queue.then(() => this.runNow(command, opts));
    this.queue = job.catch(() => {});
    return job;
  }

  runNow(command, opts) {
    this.start();
    const id = `${process.pid}_${Date.now()}_${++this.seq}`;
    const marker = `__PARAKEET_END_${id}__ `;
    const b64 = Buffer.from(command, 'utf8').toString('base64');
    const cd = opts.cwd ? `cd '${String(opts.cwd).replace(/'/g, `'\\''`)}' 2>/dev/null; ` : '';
    // `printf '\n'` guarantees the marker starts a line even after output
    // without a trailing newline; drain() strips that one extra newline.
    const line = `( ${cd}eval "$(echo '${b64}' | base64 -d)" ) </dev/null 2>&1; __pk=$?; printf '\\n%s%s\\n' '${marker}' "$__pk"\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stop();
        reject(new Error(`root command timed out after ${opts.timeoutMs ?? 120_000} ms (session restarted)`));
      }, opts.timeoutMs ?? 120_000);
      const onAbort = () => {
        this.stop();
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const done = (fn) => (v) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        fn(v);
      };
      this.pending = {
        marker,
        maxBytes: opts.maxBytes ?? 256 * 1024,
        truncated: false,
        resolve: done(resolve),
        reject: done(reject),
      };
      this.child.stdin.write(line);
    });
  }
}
