package dev.parakeet.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class PerfTest {
    @Test
    fun bootTimerRecordsPhases() {
        var now = 1000L
        val t = BootTimer { now }
        now += 5; assertEquals(5, t.mark("extract-skip"))
        now += 40; assertEquals(40, t.mark("config"))
        now += 3000; t.mark("spawn->ready")
        assertEquals(3045, t.totalMs())
        assertEquals("extract-skip=5 config=40 spawn->ready=3000 total=3045", t.summary())
    }

    @Test
    fun timingsFileKeepsNewest() {
        val f = File.createTempFile("timings", ".txt")
        f.delete()
        for (i in 1..15) BootTimer.persist(f, "boot $i")
        val lines = f.readLines().filter { it.isNotBlank() }
        assertEquals(BootTimer.KEEP, lines.size)
        assertEquals("boot 15", lines.last())
        assertEquals("boot 6", lines.first())
        f.delete()
    }

    @Test
    fun heapLimitScalesWithRamAndIsClamped() {
        val gb = 1024L * 1024 * 1024
        assertEquals(768, Runtime.heapLimitMb(2 * gb))
        assertEquals(1536, Runtime.heapLimitMb(6 * gb))
        assertEquals(2048, Runtime.heapLimitMb(16 * gb))
        assertEquals(1024, Runtime.heapLimitMb(0))
    }

    @Test
    fun nicePrefixOnlyWhenNiceExists() {
        assertEquals(listOf("/system/bin/nice", "-n", Runtime.NICE.toString()), Runtime.nicePrefix { it == "/system/bin/nice" })
        assertEquals(emptyList<String>(), Runtime.nicePrefix { false })
    }

    @Test
    fun bundleStampChangesOnReinstall() {
        assertNotEquals(Runtime.bundleStamp("0.1.1", 2, 100), Runtime.bundleStamp("0.1.1", 2, 200))
        assertEquals(Runtime.bundleStamp("0.1.1", 2, 100), Runtime.bundleStamp("0.1.1", 2, 100))
    }

    @Test
    fun logTailIsBounded() {
        val f = File.createTempFile("dsh", ".log")
        f.writeText((1..50_000).joinToString("\n") { "line $it" })
        val tail = LogActivity.tail(f, maxBytes = 4096, maxLines = 100)
        val lines = tail.split('\n')
        assertTrue(lines.size <= 100)
        assertEquals("line 50000", lines.last())
        assertTrue(lines.first().startsWith("line "))
        f.delete()
        assertEquals("(no log yet)", LogActivity.tail(f))
    }

    @Test
    fun onlyNotableServerLinesAfterReady() {
        assertTrue(DshService.notable("dsh: warning: 7 entries did not activate"))
        assertTrue(DshService.notable("Error: ECONNREFUSED"))
        assertFalse(DshService.notable("GET /api/session 200 3ms"))
    }

    @Test
    fun cssOverrideKillsBackdropBlur() {
        assertTrue(Perf.CSS.contains("backdrop-filter:none!important"))
        assertTrue(Perf.CSS_INJECT_JS.contains("parakeet-perf-css"))
    }
}
