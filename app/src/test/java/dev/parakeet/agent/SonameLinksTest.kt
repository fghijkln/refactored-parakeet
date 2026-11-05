package dev.parakeet.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class SonameLinksTest {
    @Test
    fun parsesManifestSonames() {
        val m = """{"executables":{"node":"libnode_exec.so"},"sonames":{"libz.so.1":"libz_tx.so","libc++_shared.so":"libcxx_shared_tx.so","../evil":"libz_tx.so","libx.so":"../../bin/sh"}}"""
        val links = Runtime.parseSonames(m)
        assertEquals("libz_tx.so", links["libz.so.1"])
        assertEquals("libcxx_shared_tx.so", links["libc++_shared.so"])
        assertFalse(links.containsKey("../evil"))
        assertFalse(links.containsKey("libx.so"))
        assertEquals(2, links.size)
    }

    @Test
    fun missingSonamesIsEmpty() {
        assertEquals(emptyMap<String, String>(), Runtime.parseSonames("""{"libs":[]}"""))
    }

    @Test
    fun abiFromNativeLibraryDirName() {
        assertEquals(listOf("arm64-v8a"), Runtime.abiCandidates("arm64"))
        assertEquals(listOf("x86_64"), Runtime.abiCandidates("x86_64"))
    }
}
