// Test-only preload (runtime/tests/root-exec-live.mjs): the host runtime's
// root-exec planner step over child_process, without the rest of the Android host
// preload (which needs an installed runtime tree). The planner is the same module
// the APK ships (runtime/direct/root-exec.mjs).
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createRootExec } from '../../direct/root-exec.mjs';

const plan = createRootExec({ log: (line) => process.stderr.write(`${line}\n`) });
const original = { spawn: cp.spawn, spawnSync: cp.spawnSync };
for (const name of ['spawn', 'spawnSync']) {
  cp[name] = function (file, args, options) {
    if (typeof file !== 'string' || !Array.isArray(args)) return original[name](...arguments);
    const p = plan({ file, args, options: options ?? {} });
    return original[name](p.file, p.args, p.options);
  };
}
syncBuiltinESMExports();
