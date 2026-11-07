package io.github.ccch1mneyyy.dsh_app.phone

import io.github.ccch1mneyyy.dsh_app.runtime.GuestPaths
import io.github.ccch1mneyyy.dsh_app.runtime.SessionSearchGuest
import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v0.2.3: under the Parakeet host engine (Android's own `/`) the phone MCP row and the search
 * index must name host paths; v0.2.2 handed the relay `/var/lib/dsh-app/phone/bridge.json`
 * (ENOENT on Android) and the `phone` server stayed disconnected.
 */
class PhoneGuestPathsTest {
    private fun tempRoot(): File = Files.createTempDirectory("pk-rootfs").toFile()

    @Test fun guestEnginesKeepGuestSpellings() {
        val yaml = PhoneGuest.PATCH_YAML
        assertTrue(yaml.contains("          - /opt/dsh-app/phone/relay.cjs\n"))
        assertTrue(yaml.contains("          - /var/lib/dsh-app/phone/bridge.json\n"))
        assertTrue(yaml.contains("serverName: phone"))
    }

    @Test fun hostEngineWritesHostPathsIntoThePatch() {
        val root = tempRoot()
        try {
            PhoneGuest.writeFiles(root, host = true)
            val patch = File(root, "opt/dsh-app/phone/phone.patch.yml").readText()
            val base = root.canonicalPath
            assertTrue(patch, patch.contains("          - $base/opt/dsh-app/phone/relay.cjs\n"))
            assertTrue(patch, patch.contains("          - $base/var/lib/dsh-app/phone/bridge.json\n"))
            assertFalse(patch, patch.contains("          - /var/"))
            assertTrue(File(root, "opt/dsh-app/phone/relay.cjs").isFile)
            // Guest mode on the same tree goes back to guest spellings.
            PhoneGuest.writeFiles(root, host = false)
            assertEquals(PhoneGuest.PATCH_YAML, File(root, "opt/dsh-app/phone/phone.patch.yml").readText())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun pathsThatNeedQuotingAreQuoted() {
        assertEquals("/a/b-c_d.e", GuestPaths.yamlQuote("/a/b-c_d.e"))
        assertEquals("'/a b/it''s: x'", GuestPaths.yamlQuote("/a b/it's: x"))
        assertEquals("/r/var/x", GuestPaths.childPath(File("/r"), "/var/x", host = true))
        assertEquals("/var/x", GuestPaths.childPath(File("/r"), "/var/x", host = false))
    }

    @Test fun relayStatusIsReadAndClearedPerLaunch() {
        val root = tempRoot()
        try {
            assertNull(PhoneGuest.relayStatus(root))
            val f = File(root, PhoneGuest.RELAY_STATUS.removePrefix("/"))
            f.parentFile.mkdirs()
            f.writeText("""{"v":1,"ok":false,"error":"config /var/lib/dsh-app/phone/bridge.json: ENOENT","config":"/var/lib/dsh-app/phone/bridge.json"}""")
            val s = PhoneGuest.relayStatus(root)!!
            assertFalse(s.ok)
            assertEquals("config /var/lib/dsh-app/phone/bridge.json: ENOENT", s.error)
            PhoneGuest.writeFiles(root, host = true)
            assertNull("a new launch forgets the last relay's report", PhoneGuest.relayStatus(root))
        } finally {
            root.deleteRecursively()
        }
    }

    @Test fun relayFallsBackToItsOwnTree() {
        // The relay itself retries <its rootfs> + the guest path (no '$' in the script: raw string).
        assertTrue(PhoneGuest.RELAY_JS.contains("candidates.push(ROOT + ASKED)"))
        assertTrue(PhoneGuest.RELAY_JS.contains("relay-status.json"))
        assertFalse(PhoneGuest.RELAY_JS.contains("$"))
    }

    @Test fun searchIndexIsAHostPathUnderTheHostEngine() {
        assertTrue(SessionSearchGuest.PATCH_YAML.contains("    path: /root/.dsh/session-search.sqlite\n"))
        val root = tempRoot()
        try {
            assertTrue(SessionSearchGuest.writeFiles(root, host = true))
            val text = SessionSearchGuest.file(root).readText()
            assertTrue(text, text.contains("    path: ${root.canonicalPath}/root/.dsh/session-search.sqlite\n"))
        } finally {
            root.deleteRecursively()
        }
    }
}
