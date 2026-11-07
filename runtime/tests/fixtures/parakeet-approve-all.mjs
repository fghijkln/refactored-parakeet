// Test-only approval answerer: answers every approval ask with allowed-once and
// prints one line per ask, so root-exec-live.mjs can see the brick guard asked.
export const name = 'parakeet-approve-all';
export function apply(ctx) {
  ctx.on('approval/request', (request) => {
    process.stderr.write(`[parakeet-test] approval asked: ${request.toolName}: ${String(request.reason ?? '').slice(0, 120)}\n`);
    return 'allowed-once';
  });
}
