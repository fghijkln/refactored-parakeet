package dev.parakeet.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class SuTest {

    @Test
    fun parsesUidFromIdOutput() {
        assertEquals(0, Su.parseUid("uid=0(root) gid=0(root) groups=0(root) context=u:r:su:s0"))
        assertEquals(10234, Su.parseUid("uid=10234(u0_a234) gid=10234(u0_a234)"))
        assertNull(Su.parseUid("Permission denied"))
        assertNull(Su.parseUid(null))
    }

    @Test
    fun argvKeepsCommandAsOneElement() {
        val cmd = "ls -l /data/adb && echo 'a b'; id"
        assertEquals(listOf("/system/bin/su", "-c", cmd), Su.argv("/system/bin/su", cmd))
    }

    @Test(expected = IllegalArgumentException::class)
    fun argvRejectsBlank() {
        Su.argv("/system/bin/su", "   ")
    }

    @Test
    fun findsFirstExistingSuInPreferenceOrder() {
        val present = setOf("/data/adb/ksu/bin/su", "/system/xbin/su")
        assertEquals("/system/xbin/su", Su.findSu { it in present })
        assertNull(Su.findSu { false })
        assertTrue(Su.kernelSuPresent { it == "/data/adb/ksud" })
        assertFalse(Su.kernelSuPresent { false })
    }

    @Test
    fun probeReportsRootWhenSuReturnsUidZero() {
        val s = Su.probe("/system/bin/su", runner = { argv ->
            assertEquals(listOf("/system/bin/su", "-c", "id"), argv)
            Su.ProcResult(0, "uid=0(root) gid=0(root)\n", "")
        })
        assertTrue(s.available)
        assertEquals(0, s.uid)
    }

    @Test
    fun probeReportsDenial() {
        val s = Su.probe("/system/bin/su", runner = { Su.ProcResult(1, "", "Permission denied\n") })
        assertFalse(s.available)
        assertEquals("Permission denied", s.detail)
    }

    @Test
    fun probeReportsMissingBinaryAndTimeouts() {
        assertFalse(Su.probe(null).available)
        val t = Su.probe("/system/bin/su", runner = { Su.ProcResult(-1, "", "", timedOut = true) })
        assertFalse(t.available)
        assertTrue(t.detail!!.contains("timed out"))
        val e = Su.probe("/system/bin/su", runner = { throw java.io.IOException("Cannot run program") })
        assertFalse(e.available)
    }

    /** End-to-end through a real process: a fake `su` script that honours `-c`. */
    @Test
    fun probeWithFakeSuScript() {
        val dir = createTempDir()
        try {
            val fake = File(dir, "su")
            fake.writeText("#!/bin/sh\n[ \"$1\" = \"-c\" ] || exit 2\nshift\necho 'uid=0(root) gid=0(root)'\n")
            fake.setExecutable(true)
            val s = Su.probe(fake.absolutePath)
            assertTrue(s.detail ?: "", s.available)
            val denied = File(dir, "su-denied")
            denied.writeText("#!/bin/sh\necho 'Permission denied' >&2\nexit 1\n")
            denied.setExecutable(true)
            assertFalse(Su.probe(denied.absolutePath).available)
        } finally {
            dir.deleteRecursively()
        }
    }
}
