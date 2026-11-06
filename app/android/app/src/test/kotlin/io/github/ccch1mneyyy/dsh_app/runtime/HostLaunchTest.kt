package io.github.ccch1mneyyy.dsh_app.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** Parakeet host engine: the proot-shaped manifest argv becomes a direct Bionic-node launch. */
class HostLaunchTest {
    private fun fixture(): Triple<File, File, File> {
        val base = Files.createTempDirectory("hostlaunch").toFile()
        val rootfs = File(base, "runtime/rootfs")
        File(rootfs, "opt/dsh-go/direct").mkdirs()
        File(rootfs, HostLaunch.PRELOAD).writeText("// preload")
        File(rootfs, "opt/dsh/node_modules/@deepseek-ai/dsh/lib").mkdirs()
        File(rootfs, "opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js").writeText("")
        val native = File(base, "lib/arm64").apply { mkdirs() }
        File(native, HostLaunch.NODE_LIB).apply { writeText("elf"); setExecutable(true) }
        File(native, HostLaunch.BASH_LIB).apply { writeText("elf"); setExecutable(true) }
        val links = File(base, "files/termux-lib").apply { mkdirs() }
        return Triple(rootfs, native, links)
    }

    private val manifestArgv = listOf(
        "{NATIVE_LIB_DIR}/libnode_exec.so",
        "-b", "/system", "-b", "/data", "-b", "/sdcard", "-b", "/storage", "-b", "/proc",
        "-b", "/storage/emulated/0:/sdcard",
        "/usr/bin/env", "-i", "HOME=/root", "TMPDIR=/tmp", "DSH_HOME=/root/.dsh",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/bin:/bin", "DEEPSEEK_API_KEY=sk-test",
        "/bin/sh", "-c",
        "echo \$\$ > /tmp/dsh-web.pid; exec /usr/local/bin/dsh web --patch /etc/dsh-app/dsh-web.patch.yml --host 127.0.0.1 --port 3080 --no-open",
    )

    @Test fun launchesBionicNodeDirectly() {
        val (rootfs, native, links) = fixture()
        assertNull(HostLaunch.unavailable(rootfs, native))
        val plan = HostLaunch.prepare(rootfs, native, links, manifestArgv, mapOf("PROOT_TMP_DIR" to "/x", "ANDROID_ROOT" to "/system"),
            hostShell = "/bin/sh", extraNodeFlags = listOf("--max-old-space-size=1024"))
        val root = rootfs.canonicalPath
        assertEquals(File(native, HostLaunch.NODE_LIB).path, plan.argv[0])
        assertTrue(plan.argv.contains("--expose-internals"))
        assertTrue(plan.argv.contains("--max-old-space-size=1024"))
        assertTrue(plan.argv.contains("--import=$root/${HostLaunch.PRELOAD}"))
        assertTrue(plan.argv.contains("$root/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"))
        val web = plan.argv.subList(plan.argv.indexOf("web"), plan.argv.size)
        assertEquals(listOf("web", "--patch", "$root/etc/dsh-app/dsh-web.patch.yml", "--host", "127.0.0.1", "--port", "3080", "--no-open"), web)
        assertFalse("no proot anywhere", plan.argv.any { it.contains("proot") })
        val env = plan.environment
        assertEquals("$root/root", env["HOME"])
        assertEquals("$root/root/.dsh", env["DSH_HOME"])
        assertEquals("$root/tmp", env["TMPDIR"])
        assertEquals("sk-test", env["DEEPSEEK_API_KEY"])
        assertEquals("${links.path}:${native.path}", env["LD_LIBRARY_PATH"])
        assertTrue(env["PATH"]!!.startsWith("$root/opt/dsh-app/direct/bin:"))
        assertTrue(env["PATH"]!!.endsWith("/system/bin:/system/xbin"))
        assertEquals("1", env["DSH_TELEMETRY_DISABLED"])
        assertFalse(env.keys.any { it.startsWith("PROOT_") })
        assertEquals(File(rootfs.canonicalFile, "root"), plan.cwd)
    }

    @Test fun writesHostConfigAndWrappers() {
        val (rootfs, native, links) = fixture()
        HostLaunch.prepare(rootfs, native, links, manifestArgv, emptyMap(), hostShell = "/bin/sh")
        val owned = File(rootfs, "opt/dsh-app/direct")
        val config = File(owned, "config.json").readText()
        assertTrue(config.contains("\"engine\":\"host\""))
        assertTrue(config.contains("\"guest\":\"/sdcard\""))
        assertTrue("phone storage bind wins for /sdcard", config.contains("{\"host\":\"/storage/emulated/0\",\"guest\":\"/sdcard\"}"))
        assertTrue(config.contains("{\"host\":\"/system\",\"guest\":\"/system\"}"))
        for (name in listOf("guest", "bash", "sh", "node", "pnpm", "pnpx")) {
            val f = File(owned, "bin/$name")
            assertTrue("$name wrapper", f.isFile && f.canExecute())
        }
        assertTrue(File(owned, "bin/bash").readText().contains(File(native, HostLaunch.BASH_LIB).path))
        assertTrue(File(owned, "bin/node").readText().contains("--expose-internals"))
    }

    private val pem = "-----BEGIN CERTIFICATE-----\nMIIBfakeAAA=\n-----END CERTIFICATE-----"

    @Test fun neverPointsAtTheTermuxPrefix() {
        val (rootfs, native, links) = fixture()
        val ca = Files.createTempDirectory("cacerts").toFile()
        // Android's cacerts files: one PEM block followed by a text dump.
        File(ca, "b0000000.0").writeText("$pem\nCertificate:\n    Data: ...\n")
        File(ca, "a0000000.0").writeText(pem.replace("AAA", "BBB") + "\nCertificate: ...\n")
        val plan = HostLaunch.prepare(rootfs, native, links, manifestArgv,
            mapOf("SSL_CERT_DIR" to "/data/data/com.termux/files/usr/etc/tls/certs", "OPENSSL_CONF" to "/data/data/com.termux/files/usr/etc/tls/openssl.cnf"),
            hostShell = "/bin/sh", caSources = listOf(File(ca, "missing"), ca))
        val env = plan.environment
        val owned = File(rootfs.canonicalFile, "opt/dsh-app/direct")
        assertEquals(File(owned, "tls/openssl.cnf").path, env["OPENSSL_CONF"])
        assertEquals(File(owned, "tls/cert.pem").path, env["SSL_CERT_FILE"])
        assertEquals(File(owned, "tls/certs").path, env["SSL_CERT_DIR"])
        assertEquals(File(owned, "ossl-modules").path, env["OPENSSL_MODULES"])
        assertEquals(File(owned, "engines-3").path, env["OPENSSL_ENGINES"])
        for (k in listOf("OPENSSL_CONF", "CTLOG_FILE", "INPUTRC")) assertTrue("$k exists", File(env[k]!!).isFile)
        assertTrue(File(env["SSL_CERT_DIR"]!!).isDirectory)
        assertFalse(env.values.any { it.contains("com.termux") })
        assertTrue(File(owned, "tls/openssl.cnf").readText().contains("nodejs_conf = openssl_init"))
        // file-name order, text dumps dropped
        assertEquals(pem.replace("AAA", "BBB") + "\n" + pem + "\n", File(owned, "tls/cert.pem").readText())
        assertFalse(plan.argv.contains("--use-bundled-ca"))
        // wrappers default every override for children launched with a cleared environment
        for (name in listOf("node", "bash", "sh")) {
            val text = File(owned, "bin/$name").readText()
            for (k in listOf("HOME", "TMPDIR", "LD_LIBRARY_PATH", "OPENSSL_CONF", "OPENSSL_MODULES", "SSL_CERT_FILE", "SSL_CERT_DIR")) {
                assertTrue("$name defaults $k", text.contains("if [ -z \"\${$k:-}\" ]; then export $k="))
            }
            assertFalse(text.contains("com.termux"))
        }
        assertTrue(File(owned, "bin/bash").readText().contains("--noprofile --rcfile"))
        assertTrue(File(owned, "bin/sh").readText().contains("--posix --noprofile"))
    }

    @Test fun withoutASystemStoreNodeUsesItsBundledRoots() {
        val (rootfs, native, links) = fixture()
        val empty = Files.createTempDirectory("nocerts").toFile()
        val plan = HostLaunch.prepare(rootfs, native, links, manifestArgv, emptyMap(), hostShell = "/bin/sh", caSources = listOf(empty))
        assertTrue(plan.argv.contains("--use-bundled-ca"))
        assertNull(plan.environment["SSL_CERT_FILE"])
        assertTrue(File(rootfs, "opt/dsh-app/direct/bin/node").readText().contains("--use-bundled-ca"))
    }

    @Test fun reportsMissingNode() {
        val (rootfs, native, _) = fixture()
        File(native, HostLaunch.NODE_LIB).delete()
        assertEquals("nodeMissing", HostLaunch.unavailable(rootfs, native))
        assertTrue(HostLaunch.isHost("host"))
        assertFalse(HostLaunch.isHost("proot"))
    }
}
