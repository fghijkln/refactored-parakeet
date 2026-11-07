package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File

/**
 * Paths the app writes into engine config (overlays, MCP server rows) that the engine or its
 * children open. Under PRoot and dsh-Go's direct engine the rootfs is `/` (or bound at the same
 * path), so guest spellings work. The Parakeet host engine ([HostLaunch]) runs on Android's own
 * `/`, where `/var`, `/opt`, `/root` and `/tmp` do not exist: it gets host spellings
 * (`<rootfs>/var/...`). v0.2.2: the phone MCP relay was handed `/var/lib/dsh-app/phone/bridge.json`
 * and failed with ENOENT. runtime/direct/host-args.mjs maps child argv/env as a second layer.
 */
object GuestPaths {
    /** What to write for [guestPath]: the host path under the host engine, else the guest path. */
    fun childPath(rootfs: File, guestPath: String, host: Boolean): String =
        if (host) File(rootfs.canonicalFile, guestPath.removePrefix("/")).path else guestPath

    /** A plain YAML scalar when safe, else single-quoted ('' escapes). */
    fun yamlQuote(v: String): String =
        if (Regex("[A-Za-z0-9_./-]+").matches(v)) v else "'" + v.replace("'", "''") + "'"
}
