package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.concurrent.TimeUnit

/**
 * Parakeet: the Root item of 设置 › 系统权限.
 *
 * Granting it makes the AI agent equivalent to the device's root user: every shell
 * command the agent runs executes as uid 0 through `su` (KernelSU; Magisk and other
 * su managers work the same way). Ordinary root commands are no longer confirmed one
 * by one; brick-risk commands (partition writes, system partitions mounted rw or
 * written, /data or /metadata wiped or formatted, flashing) are always confirmed once.
 *
 * The grant is a real `su -c id` that must answer uid 0 — that call is also what
 * makes the KernelSU / Magisk manager ask the user. The result lands in the engine's
 * settings file, `<rootfs>/root/.dsh/parakeet-settings.json` (DSH_HOME), as
 * `rootExec`; the host runtime (runtime/direct/root-exec.mjs) and the root-shell
 * plugin re-read it on every command, so turning Root on or off needs no restart.
 * The engine process itself keeps the app's uid.
 */
object RootAccess {
    const val SETTINGS_FILE = "parakeet-settings.json"
    const val KEY = "rootExec"

    /** su binaries, most standard first (SU_CANDIDATES in runtime/direct/root-exec.mjs). */
    val SU_CANDIDATES = listOf(
        "/system/bin/su",
        "/system/xbin/su",
        "/debug_ramdisk/su",
        "/sbin/su",
        "/data/adb/ksu/bin/su",
    )

    /** KernelSU installed (markers), independent of whether this app was granted root. */
    val KSU_MARKERS = listOf("/data/adb/ksu", "/data/adb/ksud", "/system/bin/ksud")

    fun settingsFile(rootfs: File): File = File(rootfs, "root/.dsh/$SETTINGS_FILE")

    fun findSu(exists: (String) -> Boolean = { File(it).exists() }): String? = SU_CANDIDATES.firstOrNull(exists)

    private val ENABLED = Regex("\"$KEY\"\\s*:\\s*true\\b")

    /** Whether the stored settings text has Root on. */
    fun parseEnabled(text: String): Boolean = ENABLED.containsMatchIn(text)

    /** The settings file's text for [on]; the file holds this one key. */
    fun settingsText(on: Boolean): String = "{\n \"$KEY\": $on\n}\n"

    /** Whether the user turned Root on in the app (the stored grant). */
    fun enabled(rootfs: File): Boolean = runCatching { parseEnabled(settingsFile(rootfs).readText()) }.getOrDefault(false)

    /** Store [on] in the settings file. Atomic (temp + rename), so the engine never reads half a file. */
    fun store(rootfs: File, on: Boolean) {
        val file = settingsFile(rootfs)
        val dir = file.parentFile ?: return
        if (!dir.isDirectory) dir.mkdirs()
        val temp = File.createTempFile(".parakeet-", ".tmp", dir)
        try {
            temp.writeText(settingsText(on))
            Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        } finally {
            temp.delete()
        }
    }

    /** Parse `id` output into its uid. */
    fun parseUid(text: String): Int? = Regex("uid=(\\d+)").find(text)?.groupValues?.get(1)?.toIntOrNull()

    data class Probe(val available: Boolean, val suPath: String?, val uid: Int?, val kernelSu: Boolean, val detail: String?) {
        fun toMap(): Map<String, Any?> = mapOf(
            "available" to available, "suPath" to suPath, "uid" to uid, "kernelSu" to kernelSu, "detail" to detail,
        )
    }

    /**
     * `su -c id`, bounded by [timeoutSec] (a grant dialog the user ignores must not hang
     * the caller). Runs on a worker thread: on KernelSU this is where the manager asks.
     */
    fun probe(timeoutSec: Long = 30, su: String? = findSu()): Probe {
        val kernelSu = KSU_MARKERS.any { File(it).exists() }
        if (su == null) return Probe(false, null, null, kernelSu, "no su binary on this device")
        return try {
            val p = ProcessBuilder(su, "-c", "id").redirectErrorStream(true).start()
            p.outputStream.close()
            if (!p.waitFor(timeoutSec, TimeUnit.SECONDS)) {
                p.destroyForcibly()
                return Probe(false, su, null, kernelSu, "su did not answer within ${timeoutSec}s")
            }
            val out = p.inputStream.bufferedReader().readText()
            val uid = parseUid(out)
            if (uid == 0) Probe(true, su, 0, kernelSu, null)
            else Probe(false, su, uid, kernelSu, out.trim().ifEmpty { "su exited with ${p.exitValue()}" })
        } catch (e: Exception) {
            Probe(false, su, null, kernelSu, e.message ?: e.toString())
        }
    }

    /** What the system-permissions page shows: the stored grant plus su's presence (no prompt). */
    fun status(rootfs: File): Map<String, Any?> = mapOf(
        "enabled" to enabled(rootfs),
        "suPath" to findSu(),
        "kernelSu" to KSU_MARKERS.any { File(it).exists() },
    )

    /**
     * Grant: probe for uid 0 (the manager's prompt) and store the result. Turning it off
     * needs no probe. Returns the probe with `enabled` added.
     */
    fun request(rootfs: File, on: Boolean): Map<String, Any?> {
        if (!on) {
            store(rootfs, false)
            return mapOf("enabled" to false, "available" to false)
        }
        val probe = probe()
        store(rootfs, probe.available)
        return probe.toMap() + ("enabled" to probe.available)
    }
}
