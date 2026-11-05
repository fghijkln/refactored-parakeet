# Parakeet Agent — DeepSeek Harness on Android, with KernelSU root

[中文说明在下方 / Chinese below](#中文说明)

Parakeet is an Android app that **is** an AI agent. It runs the real
[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) on an
embedded Node.js 24 directly on the Android host — no container, no proot, no
chroot, no VM — and gives the agent a **root shell through KernelSU**. Any
vendor's model works: OpenAI-compatible endpoints, the Anthropic Messages API,
or DSH's native DeepSeek adapter. DSH plugins install and run unmodified.

> ⚠️ **A root agent can brick your device or erase your data.** Read
> [Security](#security) before granting root.

## Status — what is verified and what is not

| Claim | How it is verified |
|---|---|
| The shipped DSH tree (glibc/musl addons removed, JS fallbacks in place) boots `dsh web` and serves the UI | CI, Linux x86_64, Node 24 (`runtime/tests/smoke-linux.sh`) |
| A full agent turn: provider from app settings → model asks for `root_shell` → command runs through `su` (persistent session) → output returns to the model | CI, Linux, mock OpenAI-compatible server + fake `su` |
| With "require confirmation" ON and no approval channel, `root_shell` refuses (fails closed) | CI, Linux |
| Kotlin `su` wrapper, config validation, URL parsing | CI, JVM unit tests (incl. a real process via a fake `su` script) |
| Termux node/bash exec from `nativeLibraryDir` under Android W^X; `_tx.so` libraries resolve; DSH boots inside the app; web UI answers on 127.0.0.1 | CI, **x86_64 Android emulator (API 30)** using the x86_64 build of the same Termux packages (`runtime/tests/emulator-smoke.sh`) |
| arm64-v8a build on a real phone | **Not verified** — built and packaged by the same scripts, but never executed here |
| KernelSU grant flow, `su` as granted app, root commands on a real device | **Not verified** — no KernelSU device is available to CI. The code paths are unit-tested with a fake `su` |

See the CI run summary on the [Actions page](../../actions) and the APKs on the
[v0.1.0 release](../../releases/tag/v0.1.0).

## Architecture

```
┌──────────────────────── Android app (Kotlin, dev.parakeet.agent) ───────────────────────┐
│ MainActivity ── WebView ──► http://127.0.0.1:<port>/?token=…  (DSH web UI)              │
│   └ root status strip + "Check / request root (KernelSU)" button (Su.probe: su -c id)   │
│ SettingsActivity ── provider kind / base URL / model / API key / root toggles           │
│   ├ API key → EncryptedSharedPreferences (Android Keystore AES-256)                    │
│   └ writes dsh-home/parakeet-config.json (no secrets) + parakeet-settings.json          │
│ DshService (foreground) ── exec nativeLibraryDir/libnode_exec.so --expose-internals     │
│        filesDir/dsh/launch.mjs web --host 127.0.0.1 --port N                           │
│        env: LD_LIBRARY_PATH=nativeLibraryDir, DSH_HOME, PARAKEET_API_KEY, PATH=bin:… │
└─────────────────────────────────────────────────────────────────────────────────────────┘
            │
┌───────────▼──────────── Node 24 (Termux build, Bionic) running real DSH ───────────────┐
│ launch.mjs: config → --patch overlay (pi-ai provider route, Android sandbox policy,     │
│             root tool row) ; supplies bundled pnpm to `dsh plugin` / Plugins page        │
│ @deepseek-ai/dsh 0.2.2-rc.1 (base + web-app bundles, all stock plugins)                  │
│ @parakeet/dsh-plugin-root-shell (Cordis plugin): tools `root_shell`, `root_status`       │
│   persistent `su` session, DSH approval gate, always-confirm list for brick-class cmds   │
│ bash tool → `bash` = symlink to nativeLibraryDir/libbash_exec.so (Termux bash 5.3)       │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### Node ≥ 24 on Android (Bionic)

Options considered: (a) repackage Termux's prebuilt `nodejs-lts`, (b) cross-compile
Node with the NDK in CI, (c) nodejs-mobile. nodejs-mobile is still on Node 18, and a
Node 24 NDK cross-build is a 1–2 h CI job with its own patch set. **(a) was chosen**:
Termux maintains Node for Bionic continuously.

`runtime/scripts/fetch_termux.py` reads Termux's apt index, resolves
`nodejs-lts` + `bash` and their runtime dependencies (libc++, openssl, c-ares,
libicu, libsqlite, zlib, readline, ncurses, libiconv, libandroid-support),
extracts the `.deb`s in pure Python, and:

* ships executables as `libnode_exec.so` / `libbash_exec.so` (Android only
  extracts `lib*.so` from `lib/<abi>/`);
* renames every library to `lib<name>_tx.so` and rewrites `DT_NEEDED`/`SONAME`
  with patchelf — flat `lib*.so` names are required for packaging, and the
  suffix avoids collisions with Android's own `libz.so`, `libcrypto.so`,
  `libssl.so` (different builds);
* sets `RUNPATH=$ORIGIN`; the app also sets `LD_LIBRARY_PATH=nativeLibraryDir`.

**W^X (Android 10+):** apps targeting API 29+ cannot `execve` files in their data
dir. Executables therefore live in `nativeLibraryDir` (`android:extractNativeLibs="true"`,
`packaging.jniLibs.useLegacyPackaging = true`, `keepDebugSymbols` so AGP never strips
the patchelf'd ELFs). `filesDir/bin/{node,bash}` are **symlinks** into
`nativeLibraryDir` — execve checks the target inode, so this is allowed where a
shell-script shim would be refused. JS is data and is unzipped to `filesDir/dsh`.

### DSH native addons — what happens to each

| Addon | Used for | On Android |
|---|---|---|
| `node-addon-require-builtin` | DSH's profile resolver / plugin loader reach Node's internal module loader | **Replaced by a JS shim** over `node --expose-internals` (same capability; DSH's loader already tries the flag first). Required — DSH does not boot without it |
| `@deepseek-ai/node-addon-system` (flock) | exclusive lock on each JSONL session file | **JS fallback**: lock treated as acquired. Safe because exactly one DSH process owns `$DSH_HOME` on the device; not safe for several processes sharing one home |
| `@deepseek-ai/node-addon-system` (landlock-run) | confined bash sandbox | Not shipped (no Android build). The overlay sets sandbox mode `danger-full-access` with approval policy `ask` |
| `node-pty` | web terminal panel | prebuilds removed → terminal panel unavailable; the agent's `bash` tool is unaffected |
| `koffi`, `sharp`, `sherpa-onnx` | FFI (computer-use), image processing, speech | removed → those features unavailable |
| `@deepseek-ai/libreoffice-kit-wasm` (150 MB) | OOXML→PDF preview | assets removed (Linux-only package) → office preview unavailable |

Building these for android-arm64 with the NDK is the natural next step
(`node-pty` and the flock C source are small).

`process.platform` is reported honestly as `android`; DSH has almost no
`linux`-only branches (the ones found are desktop "open in app" helpers).

### Bundling DSH

DSH is consumed as its **published npm packages** (`@deepseek-ai/dsh@0.2.2-rc.1`,
pinned in `dsh/versions.json`) rather than a monorepo build: the npm tree is the
built JS. `runtime/scripts/build_dsh_bundle.sh` installs it with npm (plus `pnpm`, which DSH
needs for plugin installs), prunes native code / types / maps, applies `patch_runtime.mjs`, copies in
the root-shell plugin, and zips it to `assets/dsh-bundle.zip` (stored uncompressed in
the APK). The app extracts it once per app version.

## KernelSU setup

1. Install KernelSU (or KernelSU Next / SukiSU) on your device and its manager app.
2. Install the APK (`parakeet-agent-v0.1.0-arm64-v8a.apk`) and open it.
3. Tap **Check / request root (KernelSU)**. The app runs `su -c id`.
   If KernelSU is installed but this app is not granted, the button opens the
   manager: go to **Superuser**, find **Parakeet Agent**, allow it, and tap the
   button again. The strip shows `Root: granted (uid 0) via /system/bin/su`.
4. Without root the app still works; the strip says root is unavailable, the
   `root_shell` tool reports it, and the normal (non-root) `bash` tool is used.

Probing: `/system/bin/su`, `/system/xbin/su`, `/debug_ramdisk/su`, `/sbin/su`,
`/data/adb/ksu/bin/su`; KernelSU markers `/data/adb/ksu`, `/data/adb/ksud`
(readable only after a grant) and the manager packages (visible before). Magisk is
not a target but uses the same `su -c` contract and will likely work.

## Configure a model provider

Menu → **Settings**:

| Field | Example |
|---|---|
| Provider type | OpenAI-compatible (DeepSeek, OpenAI, Qwen/DashScope, Moonshot, SiliconFlow, OpenRouter, vLLM, Ollama…), Anthropic Messages API, DeepSeek (native DSH adapter), or None |
| Base URL | `https://api.deepseek.com/v1`, `https://api.openai.com/v1`, `https://api.anthropic.com` |
| Model | `deepseek-chat`, `gpt-4.1`, `claude-sonnet-4-5`, … |
| API key | stored only in EncryptedSharedPreferences |
| Protocol override | `openai-completions` / `openai-responses` / `anthropic-messages` |

Save restarts the runtime. The launcher turns the settings into a DSH overlay
(`$DSH_HOME/parakeet.patch.yml`) with a pi-ai route named `parakeet` whose
`apiKeyEnv: PARAKEET_API_KEY` — the key reaches DSH only as an environment variable
of its process, never a file. You can also leave the type at **None** and add
providers from the DSH web UI's Models page.

## Install DSH plugins

DSH's plugin system works unchanged; the app supplies its bundled pnpm to DSH as the
package manager (`packageManager: { command: <node>, args: [pnpm.mjs] }`).

* **Web UI:** open the Plugins page and install from npm.
* **Agent shell:** ask the agent, or run in its bash tool:
  `node "$HOME/dsh/launch.mjs" plugin --profile web add <npm-package>`
  then restart the runtime from the menu.
* Plugins with native addons need an android build of that addon. Git-hosted plugins
  (`github:owner/repo#ref&path:/.dsh-plugin`) need `git`, which the app does not ship yet.

## Security

* **Root is dangerous.** A model can be wrong, and prompt injection from a web page
  or file can steer it. With root it can delete `/data`, overwrite partitions, or
  soft-brick the device.
* **"Require confirmation before root commands" is ON by default** (Settings). Each
  `root_shell` call then goes through DSH's approval service and the web UI asks you
  to allow it, showing the command and the agent's stated reason. The toggle is
  re-read on every command.
* Some commands are **always** confirmed whatever the toggle says: writes to
  `/dev/block`, `dd … of=/dev/block/…`, `mkfs`, `fastboot`, `wipe`, `rm -rf` on
  `/system`, `/vendor`, `/data`, `/sdcard`, … (`DANGEROUS_PATTERNS` in
  `dsh/plugin-root-shell/lib/su.js`). This is a guard-rail, not a sandbox.
* If you switch DSH's permission preset to `danger-full-access` (approval `never`),
  approvals are auto-rejected, so root commands needing confirmation will fail.
* The non-root `bash` tool runs as the app's uid with full access to the app's own
  files (Android has no Landlock launcher, so DSH's file sandbox is off).
* The DSH web server binds 127.0.0.1 only and requires its per-launch token.
* DSH telemetry is disabled (`DSH_TELEMETRY_DISABLED=1`).
* The APK is signed with a **self-signed key committed to this repo** so CI builds
  upgrade over each other. It protects nothing; do not reuse it.

## Build

CI (`.github/workflows/android.yml`) does everything: build the DSH bundle and run the
Linux smoke test → repackage Termux node/bash for arm64-v8a and x86_64 → Gradle unit
tests + APKs → emulator smoke test → GitHub Release `v0.1.0`.

Locally (Linux, Node 24, JDK 17, Android SDK, Gradle 8.11, patchelf, zip):

```bash
runtime/scripts/build_dsh_bundle.sh /tmp/dsh-rt app/src/main/assets/dsh-bundle.zip
runtime/tests/smoke-linux.sh /tmp/dsh-rt
python3 runtime/scripts/fetch_termux.py app/src/main/jniLibs/arm64-v8a
gradle :app:testDebugUnitTest :app:assembleDebug
```

## Known limitations

* arm64 and KernelSU paths untested on hardware (see Status).
* Web terminal panel, computer-use, image processing, speech, office preview are
  off (native addons, see table). flock is a no-op (single process).
* First launch unzips ~200 MB into app storage.
* Termux removes old package versions from its repo; CI always takes the current
  `nodejs-lts`, so a rebuild may pick a newer Node 24.x.
* No `git` on device, so git-hosted DSH plugins cannot be installed yet.
* APK is large (~100 MB arm64) because of node + ICU data + the DSH tree.

## Next steps

1. Run the arm64 APK on a KernelSU device; confirm the grant flow and `root_shell`.
2. NDK builds of `node-pty` (terminal) and the flock addon; ship them as `lib*.so`.
3. Ship Termux `git` for git-hosted plugins.
4. A native Android approval dialog in addition to the web UI prompt.
5. Optional: stream DSH ACP over stdio for a Compose UI.

## License

MIT for this repository's code. Bundled components keep their licenses: DeepSeek
Harness (MIT), Node.js (MIT), Termux packages (bash GPL-3.0, readline GPL-3.0,
ncurses MIT-style, OpenSSL Apache-2.0, ICU Unicode, zlib, c-ares MIT, SQLite public
domain, libc++ Apache-2.0 with LLVM exception).

---

## 中文说明

Parakeet 是一个**本身就是 AI 代理**的 Android 应用。它在手机上直接运行内置的
Node.js 24 和真正的 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)
——**不用容器、proot、chroot 或虚拟机**——并通过 **KernelSU** 给代理一个 root shell。
支持任意厂商的模型 API(OpenAI 兼容、Anthropic Messages、DSH 原生 DeepSeek 适配器),
DSH 插件无需修改即可安装运行。

> ⚠️ **拥有 root 的代理可能让设备变砖或清空数据。** 授予 root 前请阅读「安全」一节。

### 验证情况

| 内容 | 验证方式 |
|---|---|
| 随 APK 发布的 DSH 运行树(已移除 glibc/musl 原生插件,使用 JS 回退)能启动 `dsh web` 并提供界面 | CI,Linux,Node 24 |
| 完整代理回合:应用设置中的供应商 → 模型调用 `root_shell` → 经 `su`(持久会话)执行 → 输出返回模型 | CI,Linux,模拟 OpenAI 兼容服务器 + 假 `su` |
| 开启"root 命令需确认"且无审批通道时,`root_shell` 拒绝执行 | CI,Linux |
| Kotlin `su` 封装、配置校验 | CI,JVM 单元测试 |
| Termux node/bash 在 W^X 限制下从 `nativeLibraryDir` 执行、依赖库可解析、应用内启动 DSH、127.0.0.1 上的网页界面可访问 | CI,**x86_64 Android 模拟器(API 30)**,使用同一 Termux 软件包的 x86_64 版本 |
| arm64 真机运行 | **未验证** |
| KernelSU 授权流程、真机 root 命令 | **未验证**(CI 没有 KernelSU 设备;代码路径用假 `su` 做了单元测试) |

### 架构要点

* **Node ≥ 24:** 采用 Termux 预编译的 `nodejs-lts`(Bionic libc)。`fetch_termux.py`
  解析 Termux 软件源、下载依赖、用 patchelf 把所有库改名为 `lib<名字>_tx.so`
  (避免与系统的 `libz.so`/`libcrypto.so`/`libssl.so` 冲突),可执行文件改名为
  `libnode_exec.so`/`libbash_exec.so`,放进 `jniLibs`。
* **W^X:** Android 10+ 禁止执行应用数据目录中的文件,所以可执行文件放在
  `nativeLibraryDir`(`extractNativeLibs=true` + legacy packaging),
  `filesDir/bin/{node,bash}` 是指向那里的符号链接。
* **DSH:** 直接使用 npm 上发布的 `@deepseek-ai/dsh@0.2.2-rc.1`(已是构建好的 JS),
  打包为 `assets/dsh-bundle.zip`,首次启动解压。
* **原生插件:** `node-addon-require-builtin` 用基于 `--expose-internals` 的 JS 垫片替代;
  flock 用单进程空操作回退;landlock、node-pty(网页终端)、koffi、sharp、sherpa-onnx、
  LibreOffice WASM 未打包,对应功能不可用。详见英文表格。
* **root 插件:** `@parakeet/dsh-plugin-root-shell` 是一个 Cordis 插件,注册
  `root_shell` 和 `root_status` 工具;使用持久 `su` 会话,经 DSH 审批服务确认。

### KernelSU 设置

1. 设备安装 KernelSU(或 KernelSU Next / SukiSU)及其管理器。
2. 安装 `parakeet-agent-v0.1.0-arm64-v8a.apk` 并打开。
3. 点击 **Check / request root (KernelSU)**(执行 `su -c id`)。若未授权,应用会打开管理器:
   在 **超级用户** 页找到 **Parakeet Agent** 并允许,再点一次按钮,状态栏显示
   `Root: granted (uid 0)`。
4. 没有 root 时应用照常工作,会明确显示 root 不可用,代理使用普通 shell。

### 配置模型供应商

菜单 → **Settings**:选择供应商类型(OpenAI 兼容 / Anthropic / DeepSeek / 无),
填写 Base URL(如 `https://api.deepseek.com/v1`)、模型名(如 `deepseek-chat`)、API Key。
API Key 只保存在 EncryptedSharedPreferences 中,仅以进程环境变量 `PARAKEET_API_KEY`
传给 DSH,不会写入任何文件。保存后运行时自动重启。也可以选"None",在 DSH 网页界面的
Models 页面添加供应商。

### 安装 DSH 插件

* 网页界面的 **Plugins** 页面直接从 npm 安装;
* 或在代理的 bash 中执行:`node "$HOME/dsh/launch.mjs" plugin --profile web add <npm 包名>`,
  然后在菜单中重启运行时。
* 含原生插件的 DSH 插件需要对应的 Android 构建;git 托管的插件需要 `git`,暂未内置。

### 安全

* root 代理可能误操作,网页或文件中的提示注入也可能诱导它。
* **"执行 root 命令前需确认"默认开启**:每条 `root_shell` 命令都会经 DSH 审批,在网页界面
  显示命令和理由,由你允许或拒绝;该开关每条命令都会重新读取。
* 写 `/dev/block`、`dd of=/dev/block/…`、`mkfs`、`fastboot`、`wipe`、对 `/system`
  `/data` `/sdcard` 等执行 `rm -rf` 的命令**无论开关如何都会询问**。这是护栏,不是沙箱。
* 若把 DSH 权限预设切到 `danger-full-access`(审批策略 never),需确认的 root 命令会被自动拒绝。
* 非 root 的 bash 工具以应用 uid 运行,DSH 文件沙箱在 Android 上关闭。
* DSH 网页服务只监听 127.0.0.1 并要求每次启动的令牌;遥测已关闭。
* APK 使用**提交在仓库中的自签名密钥**,不提供任何安全保证,请勿复用。

### 已知限制与后续工作

见英文部分 *Known limitations* 与 *Next steps*:真机/KernelSU 未验证;网页终端等依赖原生
插件的功能关闭;首次启动解压约 200 MB;下一步是在 KernelSU 真机上验证,并用 NDK 构建
node-pty 与 flock 原生插件。
