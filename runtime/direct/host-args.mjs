// Parakeet host engine: guest spellings in child argv/env (v0.2.3).
//
// In host mode the engine runs on Android's own `/`. The runtime tree keeps
// dsh-Go's guest layout under <rootfs> (/opt, /var, /root, /tmp, /usr/local),
// and host-preload.mjs maps guest spellings at the typed boundaries: module
// paths, cwd, executables, HOME/TMPDIR-style env. Arguments and other env values
// were handed to children verbatim, so a guest path in an MCP server row
// (phone.patch.yml: `args: [/opt/dsh-app/phone/relay.cjs,
// /var/lib/dsh-app/phone/bridge.json]`) reached the child as a path that does
// not exist on Android: the relay got ENOENT and DSH reported the `phone`
// server as disconnected while every app-side check was green.
//
// This mapper rewrites a whole argument (or the value of `--flag=/path`) or a
// whole env value only when it is unambiguously a runtime-tree path:
//
//   - a non-identity mount (guest != host, e.g. /root/手机存储 → /storage/...)
//     always maps, as it does for cwd;
//   - an identity mount (/system, /data, /sdcard, /storage, /proc, /dev, ...)
//     never maps: those are the real device;
//   - otherwise the path must sit under a runtime-owned prefix (/var, /opt,
//     /root, /tmp, /usr/local), must NOT exist on the host, its own parent must
//     not exist on the host either (a real host tree such as Linux's /tmp wins),
//     and the runtime-tree counterpart's parent must exist.
//
// Anything else (relative paths, shell text, URLs, real host paths) is left as
// it is. Shell command strings are never parsed.
import fs from 'node:fs';
import { posix } from 'node:path';

export const OWNED_PREFIXES = Object.freeze(['/var', '/opt', '/root', '/tmp', '/usr/local']);

const within = (value, root) => value === root || value.startsWith(`${root}/`);
const FLAG = /^(-{1,2}[A-Za-z0-9][A-Za-z0-9_.-]*=)(\/.*)$/su;

/**
 * @param {object} options
 * @param {string} options.rootfs - the runtime root (absolute, not '/').
 * @param {{host: string, guest: string}[]} [options.mounts] - config.json mounts.
 * @param {(path: string) => boolean} [options.exists] - injection point for tests.
 * @param {readonly string[]} [options.prefixes] - runtime-owned guest prefixes.
 */
export function createHostArgs({ rootfs, mounts = [], exists = fs.existsSync, prefixes = OWNED_PREFIXES }) {
  if (typeof rootfs !== 'string' || !rootfs.startsWith('/') || rootfs === '/') {
    throw new Error('host args: rootfs must be a non-root absolute directory');
  }
  const root = rootfs.replace(/\/+$/u, '');
  const byGuest = [...mounts].sort((a, b) => b.guest.length - a.guest.length);
  const safeExists = (p) => { try { return exists(p); } catch { return false; } };

  /** One absolute path: its host spelling, or the same string. */
  function mapPath(value) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0') || value.includes('\n')) return value;
    if (within(value, root)) return value;
    const mount = byGuest.find((entry) => within(value, entry.guest));
    if (mount) return mount.host === mount.guest ? value : mount.host + value.slice(mount.guest.length);
    if (!prefixes.some((prefix) => within(value, prefix))) return value;
    const normal = posix.normalize(value);
    if (normal.split('/').includes('..')) return value;
    if (safeExists(value)) return value;
    const parent = posix.dirname(normal);
    if (parent !== '/' && safeExists(parent)) return value;
    const mapped = root + normal;
    return safeExists(posix.dirname(mapped)) ? mapped : value;
  }

  /** A whole argument, or the path value of `--flag=/path`. */
  function mapArg(value) {
    if (typeof value !== 'string') return value;
    if (value.startsWith('/')) return mapPath(value);
    const flag = FLAG.exec(value);
    if (flag) {
      const mapped = mapPath(flag[2]);
      return mapped === flag[2] ? value : flag[1] + mapped;
    }
    return value;
  }

  function mapArgs(args) {
    if (!Array.isArray(args)) return args;
    let changed = false;
    const out = args.map((a) => { const m = mapArg(a); if (m !== a) changed = true; return m; });
    return changed ? out : args;
  }

  function mapEnv(env) {
    if (env == null || typeof env !== 'object') return env;
    let out;
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== 'string' || !value.startsWith('/')) continue;
      const mapped = mapPath(value);
      if (mapped !== value) (out ??= { ...env })[key] = mapped;
    }
    return out ?? env;
  }

  /** Planner hook (processes.mjs installCommands): runs before root-exec's su wrap. */
  function plan(p) {
    const args = mapArgs(p.args);
    const env = p.options?.env === undefined ? undefined : mapEnv(p.options.env);
    if (args === p.args && env === p.options?.env) return p;
    return { file: p.file, args, options: env === p.options?.env ? p.options : { ...p.options, env } };
  }

  return { root, mapPath, mapArg, mapArgs, mapEnv, plan };
}
