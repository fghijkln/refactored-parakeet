package dev.parakeet.agent

import android.app.Activity
import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView
import java.io.File
import java.io.RandomAccessFile

/**
 * Diagnostics: boot phase timings and the tail of the DSH process log.
 *
 * The log can be megabytes after a long session, so only its last
 * [TAIL_BYTES] are read, on a background thread, and shown once (a single
 * bounded TextView; nothing streams into it).
 */
class LogActivity : Activity() {
    companion object {
        const val TAIL_BYTES = 96 * 1024
        const val TAIL_LINES = 400

        /** Last [maxLines] lines within the last [maxBytes] of [file]. */
        fun tail(file: File, maxBytes: Int = TAIL_BYTES, maxLines: Int = TAIL_LINES): String {
            if (!file.isFile) return "(no log yet)"
            RandomAccessFile(file, "r").use { raf ->
                val len = raf.length()
                val from = (len - maxBytes).coerceAtLeast(0)
                val buf = ByteArray((len - from).toInt())
                raf.seek(from)
                raf.readFully(buf)
                var lines = String(buf, Charsets.UTF_8).split('\n')
                if (from > 0 && lines.size > 1) lines = lines.drop(1) // partial first line
                return lines.takeLast(maxLines).joinToString("\n")
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val view = TextView(this).apply {
            setTextIsSelectable(true)
            textSize = 11f
            typeface = android.graphics.Typeface.MONOSPACE
            setPadding(16, 16, 16, 16)
            text = "Loading…"
        }
        setContentView(ScrollView(this).apply { addView(view) })
        Thread({
            val ctx = this@LogActivity
            val text = buildString {
                append("app: ").append(BuildConfig.VERSION_NAME).append(if (BuildConfig.DEBUG) " (debug)" else "").append('\n')
                append("node: ").append(Runtime.nodeBinary(ctx).path)
                append(" (present=").append(Runtime.nodePresent(ctx)).append(")\n")
                append("abis: ").append(android.os.Build.SUPPORTED_ABIS.joinToString()).append('\n')
                append("runtime: ").append(Runtime.runtimeDir(ctx).path).append('\n')
                append("node heap cap: ").append(Runtime.deviceHeapLimitMb(ctx)).append(" MB\n")
                DshService.lastError.get()?.let { append("last error: ").append(it).append('\n') }
                append("\n----- startup timings (ms) -----\n")
                DshService.lastTimings.get()?.let { append("this run: ").append(it).append('\n') }
                val tf = Runtime.timingsFile(ctx)
                append(if (tf.isFile) tf.readText() else "(none yet)\n")
                append("\n----- dsh.log (tail) -----\n")
                append(runCatching { tail(Runtime.logFile(ctx)) }.getOrElse { "(cannot read log: $it)" })
            }
            runOnUiThread { if (!isDestroyed) view.text = text }
        }, "parakeet-log").start()
    }
}
