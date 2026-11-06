package io.github.ccch1mneyyy.dsh_app.runtime

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * Parakeet host engine: Termux's node, bash and their libraries ship BYTE FOR BYTE
 * as `lib*_exec.so` / `lib*_tx.so` jniLibs (never patchelf'd: rewriting these
 * 16 KiB-aligned ELFs broke Bionic's linker). They still ask for their original
 * sonames (libz.so.1, libc++_shared.so, ...), so `filesDir/termux-lib/<soname>`
 * symlinks into nativeLibraryDir go first on LD_LIBRARY_PATH.
 */
object TermuxLibs {
    const val ASSET = "runtime/termux-manifest.json"

    fun dir(context: Context) = File(context.filesDir, "termux-lib")

    fun ensure(context: Context): File {
        val dir = dir(context).apply { mkdirs() }
        val nativeDir = File(context.applicationInfo.nativeLibraryDir)
        val text = runCatching { context.assets.open(ASSET).bufferedReader().use { it.readText() } }.getOrNull() ?: return dir
        val links = parseSonames(text).filterValues { File(nativeDir, it).isFile }
        dir.listFiles()?.forEach { if (it.name !in links) it.delete() }
        for ((soname, flat) in links) {
            val target = File(nativeDir, flat).absolutePath
            val link = File(dir, soname)
            val current = runCatching { android.system.Os.readlink(link.absolutePath) }.getOrNull()
            if (current == target) continue
            link.delete()
            runCatching { android.system.Os.symlink(target, link.absolutePath) }
        }
        return dir
    }

    /** soname -> flat jniLib name; plain file names only. */
    fun parseSonames(manifestJson: String): Map<String, String> {
        val obj = JSONObject(manifestJson).optJSONObject("sonames") ?: return emptyMap()
        val out = linkedMapOf<String, String>()
        for (k in obj.keys()) {
            val v = obj.getString(k)
            if ('/' in k || '/' in v || k.startsWith(".") || v.startsWith(".")) continue
            out[k] = v
        }
        return out
    }
}
