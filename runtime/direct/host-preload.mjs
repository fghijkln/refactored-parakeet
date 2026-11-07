// Parakeet host engine preload (modified from dsh-Go's direct preload.mjs).
//
// DSH runs on Android itself: Termux's Bionic Node from the APK's
// nativeLibraryDir, no PRoot, no Ubuntu, no glibc loader. The runtime tree
// (opt/dsh, root/, tmp/, etc/) keeps dsh-Go's guest layout so saved paths
// such as /root/workspace stay meaningful; Android's own trees (/system,
// /data, /sdcard, /storage, /proc, ...) are identities, so the agent sees and
// edits the real device. Configuration holds paths/argv only; credentials and
// caller environments are never written into it.
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPaths } from './paths.mjs';
import { installCommands } from './processes.mjs';
import { createRootExec } from './root-exec.mjs';
import { createHostArgs } from './host-args.mjs';

const self = fileURLToPath(import.meta.url);
const rootfs = self.replace(/\/opt\/dsh-go\/direct\/host-preload\.mjs$/u, '');
try {
  if (rootfs === self) throw new Error('host preload is outside its runtime path');
  const config = JSON.parse(fs.readFileSync(`${rootfs}/opt/dsh-app/direct/config.json`, 'utf8'));
  if (config.schema !== 2 || config.engine !== 'host' || config.rootfs !== rootfs) {
    throw new Error('host launch configuration does not match this runtime');
  }
  const paths = createPaths(rootfs, config.mounts);
  // Parakeet: with Root granted, the agent's shell commands run as uid 0 (root-exec.mjs).
  // Already root (a command that itself started node): nothing to wrap.
  const rootExec = process.getuid?.() === 0 ? undefined
    : createRootExec({ rootfs, log: (line) => process.stderr.write(`${line}\n`) });
  // Guest paths in child argv/env (MCP server rows, plugin configs) → runtime tree,
  // before the su wrap so a root command carries the mapped spelling (host-args.mjs).
  const hostArgs = createHostArgs({ rootfs, mounts: config.mounts });
  const plan = rootExec === undefined ? hostArgs.plan : (p) => rootExec(hostArgs.plan(p));
  const processes = installCommands(config, paths, { plan, args: hostArgs.mapArgs });
  globalThis[Symbol.for('dsh.go.direct')] = Object.freeze({ ...paths, ...processes, hostArgs });
  // Guest-spelled absolute module paths (plugin rows such as
  // /opt/dsh-go/dsh-go-bridge/lib/index.js) resolve inside the runtime tree.
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('file:')) {
        const url = new URL(specifier);
        const mapped = paths.toHost(fileURLToPath(url));
        if (mapped !== fileURLToPath(url)) {
          const replacement = pathToFileURL(mapped);
          replacement.search = url.search; replacement.hash = url.hash;
          specifier = replacement.href;
        }
      } else if (specifier.startsWith('/')) {
        specifier = paths.toHost(specifier);
      }
      return nextResolve(specifier, context);
    },
  });
  process.env.pnpm_config_package_import_method = 'copy';
  process.env.npm_config_package_import_method = 'copy';
  const main = process.env.DSH_GO_DIRECT_MAIN === '1';
  delete process.env.DSH_GO_DIRECT_MAIN;
  if (main) {
    fs.writeFileSync(`${rootfs}/tmp/dsh-web.pid`, `${process.pid}\n`, { mode: 0o600 });
    await import(pathToFileURL(`${rootfs}/opt/dsh-go/boot-cache.mjs`).href);
  }
} catch (error) {
  console.error(`[parakeet-host] launch failed: ${error instanceof Error ? error.message : String(error)}`);
  throw error;
}
