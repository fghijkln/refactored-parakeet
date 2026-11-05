#!/usr/bin/env node
/**
 * Post-install patches applied to the bundled DSH tree (idempotent).
 *
 * 1. @deepseek-ai/node-addon-system/lib/flock.js: the published module only
 *    knows linux/darwin prebuilds and throws ERR_FLOCK_UNSUPPORTED_PLATFORM on
 *    `android`. JSONL session persistence calls tryLockExclusive() for every
 *    session it opens, so without a fallback no session could be created.
 *    The fallback treats the lock as acquired when the native binding cannot
 *    be loaded. That is safe for Parakeet because exactly one DSH process owns
 *    $DSH_HOME on the device (the app's foreground service); it would NOT be
 *    safe for several DSH processes sharing one home.
 *
 * Usage: patch_runtime.mjs <runtime-root>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('usage: patch_runtime.mjs <runtime-root>');

const MARK = '/* parakeet: android flock fallback */';
const flock = join(root, 'node_modules/@deepseek-ai/node-addon-system/lib/flock.js');
if (!existsSync(flock)) throw new Error(`missing ${flock}`);
let src = readFileSync(flock, 'utf8');
if (!src.includes(MARK)) {
  const anchor = 'export async function tryLockExclusive(fd) {';
  if (!src.includes(anchor)) throw new Error('flock.js layout changed: tryLockExclusive anchor not found');
  src = src.replace(
    anchor,
    `${MARK}
let parakeetNoNativeFlock = false;
function parakeetCanLoad() {
    if (parakeetNoNativeFlock) return false;
    try {
        loadBinding();
        return true;
    }
    catch {
        parakeetNoNativeFlock = true;
        if (process.env.PARAKEET_DEBUG) process.stderr.write('parakeet: native flock unavailable on ' + process.platform + '; using single-process no-op lock\\n');
        return false;
    }
}
${anchor}
    if (!parakeetCanLoad()) return;`,
  );
  writeFileSync(flock, src);
  console.log('patched', flock);
} else {
  console.log('already patched', flock);
}
