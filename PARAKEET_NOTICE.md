# Parakeet modification notice

Parakeet is a modified version of **DSH Go** by ccch1mneyyy
(<https://github.com/ccch1mneyyy/dsh-go>), forked from upstream commit `cf2f7c8`.
DSH Go is licensed under the GNU Affero General Public License v3.0 (see [LICENSE](LICENSE));
`sdk/` and `examples/` are MIT. Upstream copyright, license and third-party notices
([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)) are kept unchanged. Parakeet is
distributed under the same AGPL-3.0 terms, and its complete corresponding source is this
repository: <https://github.com/fghijkln/refactored-parakeet>.

The DSH Go name, logos and mascots are not licensed under AGPL-3.0; see [ASSETS.md](ASSETS.md).

## What Parakeet changed (since 2026-11-06)

- Host engine: DeepSeek Harness runs directly on Android through Termux's Bionic node and bash,
  shipped unmodified as native libraries (no Ubuntu rootfs, no PRoot). Since 0.2.1 the engine
  gets its own OpenSSL config and CA bundle so an installed Termux can't break it.
- Root: root_shell / root_status tools through su (KernelSU supported). Since 0.2.2 a Root item in
  Settings › System permissions makes root the agent's execution mode: once granted, every shell
  command the agent runs executes as uid 0 through su (runtime/direct/root-exec.mjs), and only
  brick-risk commands (runtime/plugins/parakeet-root-shell/lib/brick.js) ask for confirmation.
- Models: OpenAI-compatible, Anthropic and DeepSeek providers.
- Separate pure-Chinese and pure-English APKs (tooling/parakeet-locale.sh, tooling/parakeet_locale.py);
  /sdcard can be chosen as a workspace.
- Removed: feedback, DeepSeek account sign-in, telemetry/usage statistics, update checks,
  star prompt, forum/community entries, share links; upstream hosts rewritten to parakeet.invalid.
- applicationId dev.parakeet.dshgo, self-signed release key.

Per-change history: `git log` of this repository after upstream `cf2f7c8`.
