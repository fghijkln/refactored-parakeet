package io.github.ccch1mneyyy.dsh_app.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class RootAccessTest {
    @Test
    fun storeAndReadTheGrant() {
        val rootfs = Files.createTempDirectory("rootfs").toFile()
        try {
            assertFalse("no settings file: off", RootAccess.enabled(rootfs))
            RootAccess.store(rootfs, true)
            val file = File(rootfs, "root/.dsh/parakeet-settings.json")
            assertTrue(file.isFile)
            assertTrue(RootAccess.enabled(rootfs))
            // The engine side (runtime/direct/root-exec.mjs) reads this with JSON.parse.
            assertEquals("{\n \"rootExec\": true\n}\n", file.readText())
            RootAccess.store(rootfs, false)
            assertFalse(RootAccess.enabled(rootfs))
            assertEquals(0, rootfs.resolve("root/.dsh").listFiles()!!.count { it.name.startsWith(".parakeet-") })
        } finally {
            rootfs.deleteRecursively()
        }
    }

    @Test
    fun parsesTheGrantText() {
        assertTrue(RootAccess.parseEnabled("{\"rootExec\":true}"))
        assertTrue(RootAccess.parseEnabled("{ \"other\": 1, \"rootExec\" : true }"))
        assertFalse(RootAccess.parseEnabled("{\"rootExec\": false}"))
        assertFalse(RootAccess.parseEnabled("{\"rootExecX\": true}"))
        assertFalse(RootAccess.parseEnabled(""))
    }

    @Test
    fun parsesIdAndFindsSu() {
        assertEquals(0, RootAccess.parseUid("uid=0(root) gid=0(root) context=u:r:su:s0"))
        assertEquals(10234, RootAccess.parseUid("uid=10234(u0_a234)"))
        assertNull(RootAccess.parseUid("Permission denied"))
        assertEquals("/system/xbin/su", RootAccess.findSu { it == "/system/xbin/su" || it == "/sbin/su" })
        assertNull(RootAccess.findSu { false })
    }

    @Test
    fun probeWithoutSuIsUnavailable() {
        val p = RootAccess.probe(su = null)
        assertFalse(p.available)
        assertEquals("no su binary on this device", p.detail)
    }

    @Test
    fun probeThroughAFakeSu() {
        val dir = Files.createTempDirectory("su").toFile()
        try {
            val root = File(dir, "su-root").apply { writeText("#!/bin/sh\necho 'uid=0(root) gid=0(root)'\n"); setExecutable(true) }
            assertTrue(RootAccess.probe(su = root.path).available)
            val denied = File(dir, "su-denied").apply { writeText("#!/bin/sh\necho 'Permission denied' >&2; exit 1\n"); setExecutable(true) }
            val d = RootAccess.probe(su = denied.path)
            assertFalse(d.available)
            assertEquals("Permission denied", d.detail)
        } finally {
            dir.deleteRecursively()
        }
    }
}
