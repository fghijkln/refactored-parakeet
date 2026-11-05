package dev.parakeet.agent

import java.io.File

/**
 * Root detection and `su` execution on the Android host, aimed at KernelSU.
 *
 * KernelSU patches the kernel so that `su` exists for apps the user granted
 * root to in the KernelSU manager; the first `su -c id` is what makes the
 * manager show its prompt. Magisk is not a target but works, since the only
 * contract used here is "an `su` that accepts `-c <command>`".
 *
 * Everything here takes its filesystem and process launcher as parameters so
 * it is unit-testable on a JVM (see SuTest).
 */
object Su {

    /** Candidate `su` paths, most standard first. */
    val SU_PATHS = listOf(
        "/system/bin/su",
        "/system/xbin/su",
        "/debug_ramdisk/su",
        "/sbin/su",
        "/data/adb/ksu/bin/su",
    )

    /** Paths that show KernelSU is installed (independent of a grant to this app). */
    val KSU_MARKERS = listOf(
        "/data/adb/ksu",
        "/data/adb/ksud",
        "/data/adb/ksu/bin/ksud",
        "/system/bin/ksud",
    )

    /** Managers whose presence means the device is probably rooted. */
    val MANAGER_PACKAGES = listOf(
        "me.weishu.kernelsu",
        "com.rifsxd.ksunext",
        "com.sukisu.ultra",
        "com.topjohnwu.magisk",
    )

    data class Status(
        val available: Boolean,
        val suPath: String? = null,
        val uid: Int? = null,
        val kernelSu: Boolean = false,
        val detail: String? = null,
    )

    fun findSu(exists: (String) -> Boolean = { File(it).exists() }): String? =
        SU_PATHS.firstOrNull(exists)

    fun kernelSuPresent(exists: (String) -> Boolean = { File(it).exists() }): Boolean =
        KSU_MARKERS.any(exists)

    /** Parse `uid=0(root) gid=0(root) ...` into 0. */
    fun parseUid(text: String?): Int? =
        text?.let { Regex("uid=(\\d+)").find(it)?.groupValues?.get(1)?.toIntOrNull() }

    /**
     * The argv that runs [command] as root. `su -c <command>` keeps the whole
     * command one argv element, so nothing word-splits it before the root
     * shell sees it.
     */
    fun argv(suPath: String, command: String): List<String> {
        require(command.isNotBlank()) { "root command must not be blank" }
        return listOf(suPath, "-c", command)
    }

    /**
     * Probe for usable root. Never throws: an absent binary, a denied grant
     * and a timed-out prompt all come back as [Status.available] == false.
     *
     * @param timeoutMs how long to wait; the KernelSU prompt is modal, so a
     *   user who ignores it must not hang the caller forever.
     */
    @JvmStatic
    @JvmOverloads
    fun probe(
        suPath: String? = findSu(),
        timeoutMs: Long = 15_000,
        runner: (List<String>) -> ProcResult = { runProcess(it, timeoutMs) },
    ): Status {
        val ksu = kernelSuPresent()
        if (suPath == null) return Status(false, kernelSu = ksu, detail = "no su binary found on this device")
        val r = try {
            runner(argv(suPath, "id"))
        } catch (e: Exception) {
            return Status(false, suPath, kernelSu = ksu, detail = e.message ?: e.toString())
        }
        if (r.timedOut) return Status(false, suPath, kernelSu = ksu, detail = "su timed out after ${timeoutMs}ms (grant prompt not answered?)")
        val uid = parseUid(r.stdout + r.stderr)
        return if (uid == 0) {
            Status(true, suPath, 0, ksu)
        } else {
            Status(false, suPath, uid, ksu, (r.stderr.ifBlank { r.stdout }).trim().ifBlank { "su exited with ${r.exitCode}" })
        }
    }

    data class ProcResult(val exitCode: Int, val stdout: String, val stderr: String, val timedOut: Boolean = false)

    /** Run one process and collect its output, with a timeout. */
    fun runProcess(argv: List<String>, timeoutMs: Long = 15_000, env: Map<String, String> = emptyMap()): ProcResult {
        val pb = ProcessBuilder(argv)
        pb.environment().putAll(env)
        val p = pb.start()
        p.outputStream.close()
        val out = StringBuilder()
        val err = StringBuilder()
        val tOut = Thread { p.inputStream.reader().forEachLine { out.appendLine(it) } }
        val tErr = Thread { p.errorStream.reader().forEachLine { err.appendLine(it) } }
        tOut.start(); tErr.start()
        val finished = p.waitFor(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
        if (!finished) {
            p.destroyForcibly()
            tOut.join(1000); tErr.join(1000)
            return ProcResult(-1, out.toString(), err.toString(), timedOut = true)
        }
        tOut.join(2000); tErr.join(2000)
        return ProcResult(p.exitValue(), out.toString(), err.toString())
    }
}
