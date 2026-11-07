package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.io.IOException

/**
 * Message search for the local engine. DSH ships `session-query-sqlite`, but its default config
 * is `openAt: never`: `session/search` answers "session search is disabled", and the drawer's
 * search can only match titles (the official Web client behaves the same). This overlay opens the
 * index on the first search instead, so nothing changes at startup.
 *
 * Verified on 0.2.1-rc.2 (x86_64, Node 24): content search works. The index splits words on
 * punctuation, so English words and identifiers are found, while a Chinese word inside an
 * unpunctuated run is not. The first search reads every log once to build the index.
 *
 * Written at every engine start like phone control's overlay (no rootfs rebuild); passed with
 * --patch on normal launches only, never in safe mode, and only when the file is in place.
 */
object SessionSearchGuest {
    const val PATCH = "/opt/dsh-app/search.patch.yml"

    private const val WEB_PATCH_ARG = "--patch /etc/dsh-app/dsh-web.patch.yml"
    private const val DSH_WEB = "/usr/local/bin/dsh web"

    const val INDEX = "/root/.dsh/session-search.sqlite"

    /**
     * [index]: the guest spelling for the PRoot/direct engines; the Parakeet host engine opens the
     * index in-process on Android's own `/`, where `/root` does not exist, so it gets the host path.
     */
    // l10n:keep guest config comment
    fun patchYaml(index: String = INDEX): String = """# dsh-app: message search (搜索对话). The DSH App rewrites this file at every engine start and
# passes it with --patch on normal launches (never in safe mode). Edits do not survive.
- id: session-query-sqlite
  config:
    path: ${GuestPaths.yamlQuote(index)}
    openAt: first-search
"""

    val PATCH_YAML: String get() = patchYaml()

    /** The launch shell command with the overlay right after the app's own one; null when [arg] is not the `dsh web` launch. */
    fun launchArg(arg: String): String? {
        val web = arg.indexOf("$DSH_WEB ")
        if (web < 0 || arg.indexOf("$DSH_WEB ", web + 1) >= 0 || arg.contains("--profile")) return null
        val patch = arg.indexOf(WEB_PATCH_ARG, web)
        val at = if (patch >= 0 && arg.indexOf(WEB_PATCH_ARG, patch + 1) < 0) patch + WEB_PATCH_ARG.length else web + DSH_WEB.length
        return arg.substring(0, at) + " --patch $PATCH" + arg.substring(at)
    }

    fun file(rootfs: File) = File(rootfs, PATCH.removePrefix("/"))

    /** Writes the overlay; false (and no file) when it could not be written, so the launch leaves it out. */
    fun writeFiles(rootfs: File, host: Boolean = false): Boolean {
        val target = file(rootfs)
        val yaml = patchYaml(GuestPaths.childPath(rootfs, INDEX, host))
        return try {
            val dir = target.parentFile ?: throw IOException("no parent for ${target.path}")
            if (!dir.isDirectory && !dir.mkdirs()) throw IOException("could not create ${dir.path}")
            if (!target.exists() || target.readText() != yaml) {
                val tmp = File(dir, ".${target.name}.dsh-app-${System.nanoTime()}.tmp")
                try {
                    tmp.writeText(yaml)
                    tmp.setReadable(true, false)
                    if (!tmp.renameTo(target)) throw IOException("could not replace ${target.path}")
                } finally {
                    if (tmp.exists()) tmp.delete()
                }
            }
            true
        } catch (_: Exception) {
            target.delete()
            false
        }
    }
}
