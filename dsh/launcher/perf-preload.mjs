/**
 * Parakeet boot-time preload (node --import). DSH's boot walks the whole
 * installation's dependency graph synchronously: on a Linux arm64 profile
 * ~3.4k readFileSync calls hit only ~1.2k distinct files and ~5.2k existsSync
 * calls hit ~2.4k distinct paths, almost all package.json probes under the
 * bundled node_modules. On a phone (f2fs + file-based encryption) every one of
 * those is a syscall round trip, and this is most of the cold-start time.
 *
 * The bundled runtime directory (PARAKEET_IMMUTABLE_ROOT, = filesDir/dsh) is
 * extracted once per app version and never written while DSH runs (plugins
 * and profiles live under DSH_HOME), so for paths under it the answers can be
 * memoised for the life of the process:
 *   - existsSync(path)                    -> boolean
 *   - readFileSync(path, 'utf8') of *.json -> the (immutable) string
 * Anything else, and every path outside the root, goes to the real fs.
 * Set PARAKEET_FS_MEMO=0 to turn it off.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve, sep } from 'node:path';

const rootEnv = process.env.PARAKEET_IMMUTABLE_ROOT;
if (rootEnv && process.env.PARAKEET_FS_MEMO !== '0') {
  const root = resolve(rootEnv) + sep;
  const realExists = fs.existsSync;
  const realRead = fs.readFileSync;
  const exists = new Map();
  const text = new Map();
  const under = (p) => typeof p === 'string' && (p.startsWith(root) ? !p.includes(`${sep}..`) : false);
  const pathOf = (p) => (typeof p === 'string' ? p : p instanceof URL && p.protocol === 'file:' ? decodeURIComponent(p.pathname) : undefined);
  const isUtf8 = (o) => o === 'utf8' || o === 'utf-8' || (o && typeof o === 'object' && (o.encoding === 'utf8' || o.encoding === 'utf-8') && !o.flag);

  fs.existsSync = function existsSync(p) {
    const s = pathOf(p);
    if (!under(s)) return realExists.call(this, p);
    let v = exists.get(s);
    if (v === undefined) { v = realExists.call(this, p); exists.set(s, v); }
    return v;
  };
  fs.readFileSync = function readFileSync(p, options) {
    const s = pathOf(p);
    if (!under(s) || !s.endsWith('.json') || !isUtf8(options)) return realRead.call(this, p, options);
    let v = text.get(s);
    if (v === undefined) { v = realRead.call(this, p, options); text.set(s, v); exists.set(s, true); }
    return v;
  };
  syncBuiltinESMExports();
}
