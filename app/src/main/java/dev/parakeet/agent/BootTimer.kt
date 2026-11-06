package dev.parakeet.agent

import java.io.File

/**
 * Startup phase timings (wall-clock ms) for one runtime boot.
 *
 * Each [mark] records how long the phase that just ended took and the time
 * since boot start. The summary goes to logcat (tag `parakeet`, line prefix
 * `parakeet-timing:` so CI can grep it), to the Logs screen, and to
 * `filesDir/boot-timings.txt` (last [KEEP] boots) so slow starts on a real
 * phone can be read back after the fact.
 *
 * Pure JVM apart from the file write, so it is unit-tested directly.
 */
class BootTimer(private val clock: () -> Long = { System.nanoTime() / 1_000_000 }) {
    private val start = clock()
    private var last = start
    private val phases = mutableListOf<Pair<String, Long>>()

    /** End the current phase under [name]; returns its duration in ms. */
    @Synchronized
    fun mark(name: String): Long {
        val now = clock()
        val d = now - last
        last = now
        phases += name to d
        return d
    }

    @Synchronized
    fun totalMs(): Long = last - start

    @Synchronized
    fun phases(): List<Pair<String, Long>> = phases.toList()

    /** `extract=0 links=3 config=41 spawn->ready=5210 total=5254` */
    @Synchronized
    fun summary(): String = (phases.map { "${it.first}=${it.second}" } + "total=${totalMs()}").joinToString(" ")

    companion object {
        const val KEEP = 10
        const val PREFIX = "parakeet-timing:"

        /** Append [line] to [file], keeping only the newest [KEEP] lines. */
        fun persist(file: File, line: String) {
            val old = if (file.isFile) file.readLines().filter { it.isNotBlank() } else emptyList()
            file.writeText((old + line).takeLast(KEEP).joinToString("\n", postfix = "\n"))
        }
    }
}
