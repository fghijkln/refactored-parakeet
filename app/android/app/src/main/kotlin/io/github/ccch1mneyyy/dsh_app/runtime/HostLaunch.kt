package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption

/**
 * Parakeet host engine (modified from dsh-Go's [DirectLaunch]): `dsh web` runs
 * directly on Android with Termux's Bionic Node from nativeLibraryDir. There is
 * no PRoot, no Ubuntu rootfs and no glibc loader. The runtime directory keeps
 * dsh-Go's guest layout (opt/dsh, root, tmp, etc); runtime/direct/host-preload.mjs
 * maps guest spellings into it, and the manifest's `-b` entries (/system, /data,
 * /sdcard, /storage, /proc, ...) are identities, so the agent works on the real device.
 *
 * Consumes the same composed proot-shaped argv as [DirectLaunch.prepare], so every
 * overlay (`--patch` rows for phone control, search, ...) composes unchanged.
 * Pure JVM: unit-tested on the host (HostLaunchTest).
 */
object HostLaunch {
    const val ENGINE = "host"
    const val PRELOAD = "opt/dsh-go/direct/host-preload.mjs"
    private const val OWNED = "opt/dsh-app/direct"
    const val NODE_LIB = "libnode_exec.so"
    const val BASH_LIB = "libbash_exec.so"

    fun isHost(engine: String?): Boolean = engine == ENGINE

    /** Missing pieces that make this APK unable to start the host engine, or null. */
    fun unavailable(rootfs: File, nativeLibDir: File): String? = when {
        !File(nativeLibDir, NODE_LIB).canExecute() -> "nodeMissing"
        !File(rootfs, PRELOAD).isFile -> "runtimeUpdateRequired"
        !File(rootfs, "opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js").isFile -> "runtimeIncomplete"
        else -> null
    }

    /**
     * @param nativeLibDir applicationInfo.nativeLibraryDir (Termux node, bash and libs).
     * @param libLinks filesDir/termux-lib: soname symlinks for the unmodified Termux ELFs.
     * @param hostShell /system/bin/sh on Android, /bin/sh in the host test harness.
     */
    fun prepare(
        rootfs: File,
        nativeLibDir: File,
        libLinks: File,
        argv: List<String>,
        hostEnv: Map<String, String>,
        hostShell: String = "/system/bin/sh",
        extraNodeFlags: List<String> = emptyList(),
        caSources: List<File> = SYSTEM_CA_DIRS,
    ): DirectLaunch.Plan {
        val root = rootfs.canonicalFile
        val rootPath = root.path
        val envAt = argv.indexOf("/usr/bin/env")
        require(envAt > 0 && argv.getOrNull(envAt + 1) == "-i") { "host engine: missing guest environment" }
        val guest = linkedMapOf<String, String>()
        var i = envAt + 2
        while (i < argv.size && argv[i].contains('=')) {
            val pair = argv[i++].split('=', limit = 2)
            require(Regex("[A-Za-z_][A-Za-z0-9_]*").matches(pair[0])) { "host engine: invalid environment name" }
            guest[pair[0]] = pair[1]
        }
        require(argv.drop(i).take(2) == listOf("/bin/sh", "-c") && argv.size == i + 3) { "host engine: unsupported guest command" }
        val web = DirectLaunch.webArguments(argv.last()).toMutableList()
        for (at in 1 until web.lastIndex) if (web[at] == "--patch") web[at + 1] = rootPath + web[at + 1]

        val node = File(nativeLibDir, NODE_LIB).path
        val bash = File(nativeLibDir, BASH_LIB).path
        val preload = File(root, PRELOAD).path
        val owned = File(root, OWNED)
        for (relative in listOf("opt", "opt/dsh-app", OWNED, "$OWNED/bin", "tmp", "root")) {
            val dir = File(root, relative)
            require(!Files.isSymbolicLink(dir.toPath())) { "host engine: generated directory is a symlink" }
            check(dir.isDirectory || dir.mkdirs()) { "host engine: cannot create $relative" }
        }
        val bin = File(owned, "bin").path
        val guestPath = guest["PATH"] ?: "/usr/local/bin:/usr/bin:/bin"
        val mounts = DirectLaunch.mounts(argv.take(envAt), rootPath)
        val q = DirectLaunch::quote

        // Termux's ELFs have /data/data/com.termux/files/usr/... compiled in (OPENSSLDIR, ENGINESDIR,
        // MODULESDIR, c-ares' resolv.conf/hosts, bash's profile/bashrc and tmp, readline's inputrc,
        // ncurses' terminfo, node's tmpdir and default shell). With Termux absent those are ENOENT,
        // with Termux installed they are EACCES, and OpenSSL treats an unreadable config as fatal.
        // Every one that has an override gets a path of ours (see [termuxOverrides]).
        val tls = termuxOverrides(owned, caSources)
        val nodeFlagList = listOf("--expose-internals") + (if (tls.caBundle == null) listOf("--use-bundled-ca") else emptyList()) + extraNodeFlags
        val nodeFlags = nodeFlagList.joinToString(" ") { q(it) }
        val linkPath = "${libLinks.path}:${nativeLibDir.path}"
        // Defaults for children started with a cleared or partial environment (env -i, execa
        // with extendEnv:false, ...): without them a child node/bash falls back to the Termux paths.
        val defaults = linkedMapOf(
            "HOME" to "$rootPath/root",
            "TMPDIR" to "$rootPath/tmp",
            "LD_LIBRARY_PATH" to linkPath,
        ).apply { putAll(tls.env) }
        val preamble = defaults.entries.joinToString("") { (k, v) -> "if [ -z \"\${$k:-}\" ]; then export $k=${q(v)}; fi\n" }

        // guest <executable> args: guest executables run natively. A guest spelling with no
        // file in the runtime tree (/usr/bin/git, /bin/ls) falls back to the command name on
        // PATH (this bin, then Android's /system/bin and the toybox tools).
        write(File(bin, "guest"), buildString {
            append("#!$hostShell\n")
            append("f=\"\$1\"; shift\n")
            append("if [ -f \"\$f\" ] && [ -x \"\$f\" ]; then exec \"\$f\" \"\$@\"; fi\n")
            append("case \"\$f\" in ${q("$rootPath/")}*) n=\"\${f##*/}\"; [ -n \"\$n\" ] && exec \"\$n\" \"\$@\";; esac\n")
            append("exec \"\$f\" \"\$@\"\n")
        }, executable = true)
        // bash: no system profile/bashrc (Termux's /etc/profile and bash.bashrc); a user ~/.bashrc
        // still applies to interactive shells.
        write(File(bin, "bash"), "#!$hostShell\n$preamble" +
            "exec ${q(bash)} --noprofile --rcfile \"\$HOME/.bashrc\" \"\$@\"\n", true)
        write(File(bin, "sh"), "#!$hostShell\n${preamble}exec ${q(bash)} --posix --noprofile \"\$@\"\n", true)
        val nodeScript = "#!$hostShell\nunset DSH_GO_DIRECT_MAIN\n" + preamble +
            "export DSH_GO_RUNTIME_ROOT=${q(rootPath)} DSH_GO_DIRECT_ROOTFS=${q(rootPath)}\n" +
            "exec ${q(node)} $nodeFlags ${q("--import=$preload")} \"\$@\"\n"
        write(File(bin, "node"), nodeScript, true)
        for (name in listOf("pnpm", "pnpx")) write(File(bin, name),
            "#!$hostShell\nexport pnpm_config_package_import_method=copy npm_config_package_import_method=copy\n" +
                "exec ${q("$bin/node")} ${q("$rootPath/usr/local/lib/node_modules/pnpm/bin/$name.mjs")} \"\$@\"\n", true)

        val rgArch = if (nativeLibDir.name.contains("x86")) "x64" else "arm64"
        val rg = File(root, "opt/dsh/node_modules/@vscode/ripgrep-linux-$rgArch/bin/rg")
        val values = linkedMapOf("engine" to ENGINE, "rootfs" to rootPath, "bin" to bin, "loader" to "",
            "libraryPath" to "", "node" to node, "hostShell" to hostShell)
        val config = "{\"schema\":2," + values.entries.joinToString(",") { json(it.key) + ":" + json(it.value) } +
            ",\"mounts\":[" + mounts.joinToString(",") { "{\"host\":" + json(it.host) + ",\"guest\":" + json(it.guest) + "}" } + "]" +
            (if (rg.isFile) ",\"ripgrep\":{\"path\":" + json(rg.path) + ",\"dynamic\":false}" else "") + "}\n"
        write(File(owned, "config.json"), config)

        val env = LinkedHashMap(hostEnv)
        env.keys.removeAll { it.startsWith("PROOT_") || it == "LD_PRELOAD" }
        env.putAll(guest)
        fun hostPath(path: String): String {
            if (!path.startsWith('/') || path == rootPath || path.startsWith("$rootPath/")) return path
            val mount = mounts.firstOrNull { path == it.guest || path.startsWith("${it.guest}/") }
            return if (mount == null) rootPath + path else mount.host + path.removePrefix(mount.guest)
        }
        for (key in listOf("HOME", "DSH_HOME", "DSH_AGENTS_HOME", "DSH_APP_ORIGINAL_HOME", "TMPDIR", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE")) {
            env[key]?.let { env[key] = hostPath(it) }
        }
        env["HOME"] = env["HOME"] ?: "$rootPath/root"
        env["DSH_HOME"] = env["DSH_HOME"] ?: "$rootPath/root/.dsh"
        env["TMPDIR"] = env["TMPDIR"] ?: "$rootPath/tmp"
        env["SHELL"] = "$bin/bash"
        env["PATH"] = listOf(bin, *guestPath.split(':').map(::hostPath).toTypedArray(), "/system/bin", "/system/xbin")
            .distinct().joinToString(":")
        env["LD_LIBRARY_PATH"] = linkPath
        env["TZDIR"] = "/system/usr/share/zoneinfo"
        // Ours always: the Android app environment never means Termux's OpenSSL tree.
        for ((k, v) in tls.env) {
            val keep = (k == "SSL_CERT_FILE" || k == "SSL_CERT_DIR") && env[k]?.let { File(it.split(':').first()).exists() } == true
            if (!keep) env[k] = v
        }
        env["DSH_GO_RUNTIME_ROOT"] = rootPath
        env["DSH_GO_DIRECT_ROOTFS"] = rootPath
        env["DSH_GO_DIRECT_MAIN"] = "1"
        env["DSH_TELEMETRY_DISABLED"] = "1"
        env["DO_NOT_TRACK"] = "1"
        val launch = listOf(node) + nodeFlagList +
            listOf("--import=$preload", "$rootPath/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js") + web
        return DirectLaunch.Plan(launch, env, File(root, "root"))
    }

    /** Android's CA stores, newest first (the Conscrypt APEX copy supersedes /system's on 14+). */
    val SYSTEM_CA_DIRS = listOf(File("/apex/com.android.conscrypt/cacerts"), File("/system/etc/security/cacerts"))

    /** The compiled-in Termux prefix; nothing we launch may depend on it. */
    const val TERMUX_PREFIX = "/data/data/com.termux/files/usr"

    class TermuxOverrides(val env: Map<String, String>, val caBundle: File?)

    /**
     * OpenSSL (libcrypto: OPENSSLDIR/openssl.cnf, cert.pem, certs/, ct_log_list.cnf, ENGINESDIR,
     * MODULESDIR) and readline (inputrc) paths of ours. Node is built with NODE_OPENSSL_CERT_STORE
     * (OpenSSL's store by default), so it trusts only what SSL_CERT_FILE/SSL_CERT_DIR give it.
     * Android's cacerts directories use OpenSSL 0.9.8 (subject_hash_old) file names, which
     * OpenSSL 3's hashed-directory lookup never finds, so their PEM blocks are joined into one
     * SSL_CERT_FILE. Without any system store, [caBundle] is null and node uses its bundled roots.
     */
    fun termuxOverrides(owned: File, caSources: List<File>): TermuxOverrides {
        val tls = File(owned, "tls")
        for (dir in listOf(tls, File(tls, "certs"), File(owned, "ossl-modules"), File(owned, "engines-3"))) {
            require(!Files.isSymbolicLink(dir.toPath())) { "host engine: generated directory is a symlink" }
            check(dir.isDirectory || dir.mkdirs()) { "host engine: cannot create ${dir.name}" }
        }
        val conf = File(tls, "openssl.cnf")
        write(conf, "# Parakeet: replaces Termux's $TERMUX_PREFIX/etc/tls/openssl.cnf\n" +
            "openssl_conf = openssl_init\nnodejs_conf = openssl_init\n[openssl_init]\n")
        val ctLog = File(tls, "ct_log_list.cnf").also { write(it, "") }
        val inputrc = File(owned, "inputrc").also { write(it, "") }
        val bundle = File(tls, "cert.pem")
        val pem = systemCaBundle(caSources)
        if (pem != null) write(bundle, pem) else bundle.delete()
        val env = linkedMapOf(
            "OPENSSL_CONF" to conf.path,
            "OPENSSL_MODULES" to File(owned, "ossl-modules").path,
            "OPENSSL_ENGINES" to File(owned, "engines-3").path,
            "CTLOG_FILE" to ctLog.path,
            "SSL_CERT_DIR" to File(tls, "certs").path,
            "INPUTRC" to inputrc.path,
        )
        if (pem != null) env["SSL_CERT_FILE"] = bundle.path
        return TermuxOverrides(env, if (pem != null) bundle else null)
    }

    private val PEM_CERT = Regex("-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\\s]+?-----END CERTIFICATE-----")

    /** PEM certificates of the first CA directory that has any, in file-name order; null if none. */
    fun systemCaBundle(sources: List<File>): String? {
        for (dir in sources) {
            val files = runCatching { dir.listFiles() }.getOrNull()?.filter { it.isFile }?.sortedBy { it.name } ?: continue
            val out = StringBuilder()
            for (f in files) {
                val text = runCatching { f.readText(Charsets.US_ASCII) }.getOrNull() ?: continue
                PEM_CERT.findAll(text).forEach { out.append(it.value).append('\n') }
            }
            if (out.isNotEmpty()) return out.toString()
        }
        return null
    }

    private fun write(file: File, text: String, executable: Boolean = false) {
        val bytes = text.toByteArray(Charsets.UTF_8)
        if (Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS) && file.readBytes().contentEquals(bytes)) {
            if (executable) check(file.setExecutable(true, true))
            return
        }
        val temp = File.createTempFile(".host-", ".tmp", file.parentFile)
        try {
            temp.writeBytes(bytes)
            if (executable) check(temp.setExecutable(true, true))
            Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        } finally { temp.delete() }
    }

    private fun json(value: String): String = buildString {
        append('"')
        for (c in value) when (c) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            in '\u0000'..'\u001f' -> append("\\u" + c.code.toString(16).padStart(4, '0'))
            else -> append(c)
        }
        append('"')
    }
}
