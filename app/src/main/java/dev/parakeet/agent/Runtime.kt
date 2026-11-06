package dev.parakeet.agent

import android.content.Context
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipInputStream

/**
 * Lays out the on-device runtime and starts DSH.
 *
 * Android 10+ refuses to exec anything from the app's writable data dir
 * (W^X). The only executable location an app owns is `nativeLibraryDir`,
 * which the package manager populates from the APK's `lib/<abi>/` entries —
 * hence node and bash ship as `libnode_exec.so` / `libbash_exec.so` with
 * `android:extractNativeLibs="true"` and legacy packaging. JS, by contrast,
 * is data: the DSH tree is unzipped into `filesDir/dsh` and read by node.
 */
object Runtime {
    const val TAG = "parakeet"
    private const val BUNDLE_ASSET = "dsh-bundle.zip"
    private const val STAMP = ".bundle-stamp"

    fun nodeBinary(ctx: Context) = File(ctx.applicationInfo.nativeLibraryDir, "libnode_exec.so")
    fun bashBinary(ctx: Context) = File(ctx.applicationInfo.nativeLibraryDir, "libbash_exec.so")
    fun runtimeDir(ctx: Context) = File(ctx.filesDir, "dsh")
    fun homeDir(ctx: Context) = File(ctx.filesDir, "dsh-home")
    fun workspaceDir(ctx: Context) = File(ctx.filesDir, "workspace")
    fun launcher(ctx: Context) = File(runtimeDir(ctx), "launch.mjs")
    fun configFile(ctx: Context) = File(homeDir(ctx), "parakeet-config.json")
    fun pluginSettingsFile(ctx: Context) = File(homeDir(ctx), "parakeet-settings.json")
    fun logFile(ctx: Context) = File(ctx.filesDir, "dsh.log")
    fun timingsFile(ctx: Context) = File(ctx.filesDir, "boot-timings.txt")
    fun libLinkDir(ctx: Context) = File(ctx.filesDir, "termux-lib")

    /**
     * The Termux ELFs ship unmodified, so they still ask for their original
     * sonames (libz.so.1, libc++_shared.so, libicuuc.so.78 ...) while the APK
     * can only carry flat `lib*_tx.so` names. Create `filesDir/termux-lib/<soname>`
     * symlinks into nativeLibraryDir and put that dir first on LD_LIBRARY_PATH.
     * The linker follows the symlink and maps the target, which lives in the
     * (executable) nativeLibraryDir, so W^X is not involved.
     */
    fun ensureLibLinks(ctx: Context): File {
        val dir = libLinkDir(ctx).apply { mkdirs() }
        val nativeDir = File(ctx.applicationInfo.nativeLibraryDir)
        val links = sonameLinks(ctx, nativeDir)
        dir.listFiles()?.forEach { if (it.name !in links) it.delete() }
        for ((soname, flat) in links) {
            val target = File(nativeDir, flat)
            if (!target.isFile) continue
            val link = File(dir, soname)
            try {
                val cur = try { android.system.Os.readlink(link.absolutePath) } catch (_: Exception) { null }
                if (cur == target.absolutePath) continue
                link.delete()
                android.system.Os.symlink(target.absolutePath, link.absolutePath)
            } catch (e: Exception) {
                Log.w(TAG, "lib link $soname -> $flat failed: $e")
            }
        }
        return dir
    }

    /** soname -> flat file name, from the manifest packaged for this ABI. */
    fun sonameLinks(ctx: Context, nativeDir: File): Map<String, String> {
        val candidates = abiCandidates(nativeDir.name)
        for (abi in candidates) {
            val text = try {
                ctx.assets.open("termux-manifest-$abi.json").bufferedReader().use { it.readText() }
            } catch (_: Exception) { continue }
            return parseSonames(text).filterValues { File(nativeDir, it).isFile }
        }
        return emptyMap()
    }

    /** nativeLibraryDir ends in the install ABI's short name (arm64, x86_64, arm). */
    fun abiCandidates(dirName: String): List<String> = when (dirName) {
        "arm64" -> listOf("arm64-v8a")
        "x86_64" -> listOf("x86_64")
        "arm" -> listOf("armeabi-v7a")
        "x86" -> listOf("x86")
        else -> listOf(dirName, "arm64-v8a", "x86_64")
    }

    fun parseSonames(manifestJson: String): Map<String, String> {
        val obj = org.json.JSONObject(manifestJson).optJSONObject("sonames") ?: return emptyMap()
        val out = linkedMapOf<String, String>()
        for (k in obj.keys()) {
            val v = obj.getString(k)
            // Only plain file names: never let a manifest entry escape the dirs.
            if ('/' in k || '/' in v || k.startsWith(".")) continue
            out[k] = v
        }
        return out
    }

    /** True when the packaged node binary is present for this device's ABI. */
    fun nodePresent(ctx: Context) = nodeBinary(ctx).canExecute()

    /**
     * What the extracted tree must match. The install time is part of it, so
     * a reinstall of the same version (dev builds, CI) still re-extracts, but
     * an ordinary launch never touches the 13k-file tree.
     */
    fun bundleStamp(versionName: String, versionCode: Int, lastUpdateTime: Long) = "$versionName:$versionCode:$lastUpdateTime"

    private fun currentStamp(ctx: Context): String {
        val updated = try { ctx.packageManager.getPackageInfo(ctx.packageName, 0).lastUpdateTime } catch (_: Exception) { 0L }
        return bundleStamp(BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE, updated)
    }

    /** True when the extracted runtime matches this install (cheap: one small file read). */
    fun runtimeCurrent(ctx: Context): Boolean {
        val stamp = File(runtimeDir(ctx), STAMP)
        return stamp.isFile && launcher(ctx).isFile && stamp.readText() == currentStamp(ctx)
    }

    /**
     * Unzip `assets/dsh-bundle.zip` into `filesDir/dsh` once per install.
     * Returns true when extraction ran (first launch or upgrade).
     *
     * Extracts into `dsh.tmp` and renames, so a kill mid-way never leaves a
     * half tree that looks current; the previous tree is renamed aside and
     * deleted on a background thread instead of blocking boot. Directories are
     * created once each, and [onProgress] gets 0..100 from compressed bytes read.
     */
    fun ensureRuntime(ctx: Context, force: Boolean = false, onProgress: (Int) -> Unit = {}): Boolean {
        val dir = runtimeDir(ctx)
        if (!force && runtimeCurrent(ctx)) return false
        val want = currentStamp(ctx)
        Log.i(TAG, "extracting DSH runtime -> $dir")
        val tmp = File(ctx.filesDir, "dsh.tmp")
        tmp.deleteRecursively()
        tmp.mkdirs()
        val root = tmp.canonicalPath + File.separator
        val total = try { ctx.assets.openFd(BUNDLE_ASSET).use { it.length } } catch (_: Exception) { -1L }
        val made = HashSet<String>()
        val buf = ByteArray(256 * 1024)
        var lastPct = -1
        ctx.assets.open(BUNDLE_ASSET).use { raw ->
            val counted = CountingInputStream(raw.buffered(256 * 1024))
            ZipInputStream(counted).use { zip ->
                while (true) {
                    val entry = zip.nextEntry ?: break
                    val target = File(tmp, entry.name).canonicalFile
                    // Zip-slip guard: an entry must stay under the extraction dir.
                    if (!target.path.startsWith(root)) {
                        throw SecurityException("bundle entry escapes runtime dir: ${entry.name}")
                    }
                    if (entry.isDirectory) {
                        if (made.add(target.path)) target.mkdirs()
                    } else {
                        val parent = target.parentFile!!
                        if (made.add(parent.path)) parent.mkdirs()
                        FileOutputStream(target).use { out ->
                            while (true) {
                                val n = zip.read(buf)
                                if (n < 0) break
                                out.write(buf, 0, n)
                            }
                        }
                    }
                    if (total > 0) {
                        val pct = (counted.count * 100 / total).toInt().coerceIn(0, 100)
                        if (pct != lastPct) { lastPct = pct; onProgress(pct) }
                    }
                }
            }
        }
        File(tmp, STAMP).writeText(want)
        val old = File(ctx.filesDir, "dsh.old-${System.nanoTime()}")
        if (dir.exists() && !dir.renameTo(old)) dir.deleteRecursively()
        if (!tmp.renameTo(dir)) throw java.io.IOException("could not move extracted runtime into place")
        // Old trees (this one and any left by a kill) go away off the boot path.
        Thread({
            ctx.filesDir.listFiles()?.filter { it.name.startsWith("dsh.old-") }?.forEach { it.deleteRecursively() }
        }, "parakeet-cleanup").apply { priority = Thread.MIN_PRIORITY }.start()
        return true
    }

    private class CountingInputStream(inner: java.io.InputStream) : java.io.FilterInputStream(inner) {
        @Volatile var count = 0L
        override fun read(): Int = super.read().also { if (it >= 0) count++ }
        override fun read(b: ByteArray, off: Int, len: Int): Int = super.read(b, off, len).also { if (it > 0) count += it }
        override fun skip(n: Long): Long = super.skip(n).also { count += it }
    }

    /** Write the two JSON files DSH and the root plugin read. */
    fun writeConfig(ctx: Context, cfg: AgentConfig) {
        homeDir(ctx).mkdirs()
        workspaceDir(ctx).mkdirs()
        configFile(ctx).writeText(cfg.toLauncherJson(workspaceDir(ctx).absolutePath).toString(2))
        pluginSettingsFile(ctx).writeText(cfg.toPluginSettingsJson().toString())
    }

    /**
     * The environment every DSH process gets.
     *
     * LD_LIBRARY_PATH = termux-lib (soname symlinks, see [ensureLibLinks]) then
     * nativeLibraryDir, so the unmodified Termux libraries resolve; PATH puts it first so
     * `bash` and `node` are found by name from inside the agent's own shell
     * commands. TMPDIR must be app-private: /tmp does not exist on Android.
     */
    fun env(ctx: Context, apiKey: String?): MutableMap<String, String> {
        val nativeDir = ctx.applicationInfo.nativeLibraryDir
        val home = homeDir(ctx)
        val bin = File(ctx.filesDir, "bin")
        val env = mutableMapOf(
            "HOME" to ctx.filesDir.absolutePath,
            "TMPDIR" to File(ctx.cacheDir, "tmp").apply { mkdirs() }.absolutePath,
            "PATH" to listOf(bin.absolutePath, nativeDir, "/system/bin", "/system/xbin").joinToString(":"),
            "LD_LIBRARY_PATH" to "${libLinkDir(ctx).absolutePath}:$nativeDir",
            "DSH_HOME" to home.absolutePath,
            "PARAKEET_CONFIG" to configFile(ctx).absolutePath,
            "PARAKEET_SETTINGS" to pluginSettingsFile(ctx).absolutePath,
            "DSH_TELEMETRY_DISABLED" to "1",
            "LANG" to "C.UTF-8",
            "TERM" to "xterm-256color",
            "ANDROID_DATA" to "/data",
            "ANDROID_ROOT" to "/system",
            "BASH_ENV" to bashEnvFile(ctx).absolutePath,
            "PARAKEET_NODE" to nodeBinary(ctx).absolutePath,
            // Android's CA store is hashed-PEM, readable by OpenSSL directly.
            "SSL_CERT_DIR" to "/system/etc/security/cacerts",
            // V8 code cache for every module DSH loads; reused across boots
            // and invalidated by Node per file content. Lives in cacheDir, so
            // the system may clear it under storage pressure (it is rebuilt).
            "NODE_COMPILE_CACHE" to File(ctx.cacheDir, "node-compile-cache").absolutePath,
            // Read-only bundle root for dsh/launcher/perf-preload.mjs.
            "PARAKEET_IMMUTABLE_ROOT" to runtimeDir(ctx).absolutePath,
            "PARAKEET_TIMING" to "1",
        )
        if (!apiKey.isNullOrBlank()) env["PARAKEET_API_KEY"] = apiKey
        return env
    }

    /**
     * `bin/node` and `bin/bash` are symlinks into nativeLibraryDir, so the
     * agent's shell (and DSH's `bash -c`) find them by name. A symlink works
     * where a shell-script shim would not: execve checks the *target* inode,
     * which carries the executable apk_data_file label, whereas any regular
     * file in the data dir is app_data_file and refused by W^X.
     *
     * JS tools (pnpm) cannot be symlinked, so they are bash functions in a
     * BASH_ENV file, which non-interactive bash sources before every command.
     */
    fun ensureShims(ctx: Context) {
        val bin = File(ctx.filesDir, "bin").apply { mkdirs() }
        val nativeDir = ctx.applicationInfo.nativeLibraryDir
        mapOf("node" to "libnode_exec.so", "bash" to "libbash_exec.so").forEach { (name, lib) ->
            val link = File(bin, name)
            val target = File(nativeDir, lib).absolutePath
            val cur = try { android.system.Os.readlink(link.absolutePath) } catch (_: Exception) { null }
            if (cur == target) return@forEach
            link.delete()
            try {
                android.system.Os.symlink(target, link.absolutePath)
            } catch (e: Exception) {
                Log.w(TAG, "symlink $name failed: $e")
            }
        }
        val pnpm = File(runtimeDir(ctx), "node_modules/pnpm/bin/pnpm.mjs").absolutePath
        bashEnvFile(ctx).writeText(
            """
            # generated by Parakeet: helpers for the agent's non-interactive bash
            pnpm() { "${'$'}{PARAKEET_NODE}" "$pnpm" "${'$'}@"; }
            pnpx() { pnpm dlx "${'$'}@"; }
            npx() { pnpm dlx "${'$'}@"; }
            """.trimIndent() + "\n",
        )
    }

    fun bashEnvFile(ctx: Context) = File(ctx.filesDir, "parakeet-bashenv.sh")

    /**
     * V8 old-space cap for the DSH process, from the device's RAM: a quarter
     * of it, clamped to 768..2048 MB. V8's own default scales with physical
     * memory and lets an idle agent sit on a large heap, which on a phone
     * means memory pressure (kswapd, LMK kills of other apps) and long
     * full-GC pauses on the server the UI is talking to.
     */
    fun heapLimitMb(totalMemBytes: Long): Int {
        if (totalMemBytes <= 0) return 1024
        return (totalMemBytes / (1024L * 1024L) / 4).toInt().coerceIn(768, 2048)
    }

    fun deviceHeapLimitMb(ctx: Context): Int {
        val am = ctx.getSystemService(android.app.ActivityManager::class.java)
        val mi = android.app.ActivityManager.MemoryInfo()
        return heapLimitMb(runCatching { am.getMemoryInfo(mi); mi.totalMem }.getOrDefault(0L))
    }

    /** Node flags shared by the server and the self-test. */
    fun nodeFlags(ctx: Context, heapMb: Int): List<String> {
        val preload = File(runtimeDir(ctx), "perf-preload.mjs")
        return buildList {
            add("--expose-internals")
            add("--max-old-space-size=$heapMb")
            if (preload.isFile) { add("--import"); add(preload.toURI().toString()) }
        }
    }

    /**
     * Run node a little below the app's UI (nice +[NICE]), through toybox's
     * `nice`, so a busy agent never competes on equal terms with the WebView
     * renderer and the UI thread for the CPU. Children (bash, su) inherit it.
     */
    const val NICE = 4
    fun nicePrefix(exists: (String) -> Boolean = { File(it).canExecute() }): List<String> =
        if (exists("/system/bin/nice")) listOf("/system/bin/nice", "-n", NICE.toString()) else emptyList()

    /** Build the argv that boots the DSH web server on loopback. */
    fun webArgv(ctx: Context, port: Int, heapMb: Int = deviceHeapLimitMb(ctx)): List<String> =
        nicePrefix() + listOf(nodeBinary(ctx).absolutePath) + nodeFlags(ctx, heapMb) + listOf(
        launcher(ctx).absolutePath,
        "web",
        "--no-open",
        "--host", "127.0.0.1",
        "--port", port.toString(),
    )

    /** Build the argv for the one-shot self test (`node -v`-class health check). */
    fun selfTestArgv(ctx: Context): List<String> = listOf(
        nodeBinary(ctx).absolutePath,
        "--expose-internals",
        launcher(ctx).absolutePath,
        "--parakeet-selftest",
    )
}
