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
     * Unzip `assets/dsh-bundle.zip` into `filesDir/dsh` once per app version.
     * Returns true when extraction ran (first launch or upgrade).
     */
    fun ensureRuntime(ctx: Context, force: Boolean = false): Boolean {
        val dir = runtimeDir(ctx)
        val stamp = File(dir, STAMP)
        val want = "${BuildConfig.VERSION_NAME}:${BuildConfig.VERSION_CODE}"
        if (!force && stamp.isFile && stamp.readText() == want) return false
        Log.i(TAG, "extracting DSH runtime -> $dir")
        dir.deleteRecursively()
        dir.mkdirs()
        ctx.assets.open(BUNDLE_ASSET).use { raw ->
            ZipInputStream(raw.buffered()).use { zip ->
                while (true) {
                    val entry = zip.nextEntry ?: break
                    val target = File(dir, entry.name).canonicalFile
                    // Zip-slip guard: an entry must stay under dir.
                    if (!target.path.startsWith(dir.canonicalPath + File.separator)) {
                        throw SecurityException("bundle entry escapes runtime dir: ${entry.name}")
                    }
                    if (entry.isDirectory) {
                        target.mkdirs()
                    } else {
                        target.parentFile?.mkdirs()
                        FileOutputStream(target).use { out -> zip.copyTo(out, 64 * 1024) }
                    }
                    zip.closeEntry()
                }
            }
        }
        stamp.writeText(want)
        return true
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
            link.delete()
            try {
                android.system.Os.symlink(File(nativeDir, lib).absolutePath, link.absolutePath)
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

    /** Build the argv that boots the DSH web server on loopback. */
    fun webArgv(ctx: Context, port: Int): List<String> = listOf(
        nodeBinary(ctx).absolutePath,
        "--expose-internals",
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
