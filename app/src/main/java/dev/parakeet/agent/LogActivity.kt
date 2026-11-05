package dev.parakeet.agent

import android.app.Activity
import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView

/** The tail of the DSH process log, for when the runtime refuses to start. */
class LogActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val log = Runtime.logFile(this)
        val text = buildString {
            append("node: ").append(Runtime.nodeBinary(this@LogActivity).path)
            append(" (present=").append(Runtime.nodePresent(this@LogActivity)).append(")\n")
            append("abis: ").append(android.os.Build.SUPPORTED_ABIS.joinToString()).append('\n')
            append("runtime: ").append(Runtime.runtimeDir(this@LogActivity).path).append('\n')
            DshService.lastError.get()?.let { append("last error: ").append(it).append('\n') }
            append("\n----- dsh.log (tail) -----\n")
            if (log.isFile) {
                val lines = log.readLines()
                append(lines.takeLast(400).joinToString("\n"))
            } else {
                append("(no log yet)")
            }
        }
        setContentView(ScrollView(this).apply {
            addView(TextView(this@LogActivity).apply {
                setTextIsSelectable(true)
                textSize = 11f
                typeface = android.graphics.Typeface.MONOSPACE
                setPadding(16, 16, 16, 16)
                this.text = text
            })
        })
    }
}
