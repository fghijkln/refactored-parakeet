package dev.parakeet.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import java.io.File
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicReference

/**
 * Hosts the Node/DSH process for as long as the user wants the agent running.
 *
 * A foreground service is what keeps the process alive once the UI goes to
 * the background; without it Android freezes or kills the child within a
 * minute or two, and an agent that dies mid-task is worse than no agent.
 */
class DshService : Service() {

    companion object {
        const val CHANNEL = "parakeet-runtime"
        const val ACTION_STOP = "dev.parakeet.agent.STOP"
        const val ACTION_RESTART = "dev.parakeet.agent.RESTART"
        const val BROADCAST_STATE = "dev.parakeet.agent.STATE"

        /** The URL (with the DSH browser token) once the server has printed it. */
        val url = AtomicReference<String?>(null)
        val lastError = AtomicReference<String?>(null)
        val running = AtomicReference(false)
        /** Human-readable boot phase for the status strip ("Extracting runtime 42%"). */
        val phase = AtomicReference<String?>(null)
        /** Phase timings of the latest boot (see [BootTimer]). */
        val lastTimings = AtomicReference<String?>(null)

        fun start(ctx: Context) {
            val i = Intent(ctx, DshService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context) = ctx.startService(Intent(ctx, DshService::class.java).setAction(ACTION_STOP))

        /** Stop the running server (if any) and boot a fresh one, e.g. after settings change. */
        fun restart(ctx: Context) {
            val i = Intent(ctx, DshService::class.java).setAction(ACTION_RESTART)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
        }

        /** Server lines worth keeping in logcat once the server is up (release builds). */
        private val NOTABLE = Regex("(?i)error|warn|fail|exception|denied|did not activate")
        fun notable(line: String) = NOTABLE.containsMatchIn(line)

        /** dsh.log is truncated (and restarted) past this size during one long run. */
        const val LOG_CAP_BYTES = 4L * 1024 * 1024

        /** Pick a free loopback port by binding and releasing one. */
        fun freePort(): Int = ServerSocket(0).use { it.localPort }

        /** The `dsh web` banner carries the URL with its one-time browser token. */
        private val URL_RE = Regex("https?://127\\.0\\.0\\.1:\\d+/\\S*")

        fun extractUrl(line: String): String? = URL_RE.find(line)?.value
    }

    @Volatile private var process: Process? = null
    @Volatile private var bootThread: Thread? = null
    @Volatile private var stopping = false
    private var logWriter: java.io.Writer? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // Never wait for node on the main thread.
            Thread({ shutdown(wait = true) }, "parakeet-stop").start()
            stopSelf()
            return START_NOT_STICKY
        }
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(1, notification("Starting agent runtime…"), android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(1, notification("Starting agent runtime…"))
        }
        if (intent?.action == ACTION_RESTART) {
            Thread({
                shutdown(wait = true)
                bootThread?.join(5000)
                startBoot()
            }, "parakeet-restart").start()
        } else {
            startBoot()
        }
        return START_STICKY
    }

    /**
     * One server per service: an activity recreate, a second start() from the
     * UI or a sticky restart never spawns a second node while the first is
     * booting or serving.
     */
    @Synchronized
    private fun startBoot() {
        if (process?.isAlive == true || bootThread?.isAlive == true) return
        stopping = false
        bootThread = Thread({ boot() }, "parakeet-boot").also { it.start() }
    }

    private fun boot() {
        running.set(true)
        lastError.set(null)
        url.set(null)
        val t = BootTimer()
        fun setPhase(text: String) {
            phase.set(text)
            sendBroadcast(Intent(BROADCAST_STATE).setPackage(packageName))
        }
        try {
            if (!Runtime.nodePresent(this)) {
                fail("No Node runtime for this device's ABI (${Build.SUPPORTED_ABIS.joinToString()}). This build ships arm64-v8a.")
                return
            }
            setPhase("Checking runtime…")
            var lastPct = -1
            val extracted = Runtime.ensureRuntime(this) { pct ->
                // A broadcast per 5% is plenty for a progress line.
                if (pct / 5 != lastPct / 5) { lastPct = pct; setPhase("First launch: extracting agent runtime $pct%") }
            }
            t.mark(if (extracted) "extract" else "extract-skip")
            Runtime.ensureShims(this)
            Runtime.ensureLibLinks(this)
            t.mark("links")
            val store = SecretStore(this)
            val cfg = store.load()
            Runtime.writeConfig(this, cfg)
            val apiKey = store.apiKey()
            t.mark("config")

            val env = Runtime.env(this, apiKey)
            // A fresh tree gets one readable health check before the server
            // (a broken install then fails with node's own words). On ordinary
            // launches the tree is the one that already served, and an extra
            // node start would only delay the UI.
            if (extracted) {
                setPhase("Checking Node runtime…")
                val self = Su.runProcess(Runtime.selfTestArgv(this), 60_000, env)
                Log.i(Runtime.TAG, "parakeet selftest: ${self.stdout.trim()} ${self.stderr.trim()}".trim())
                if (self.exitCode != 0) {
                    fail("Node self-test failed (exit ${self.exitCode}): ${self.stderr.ifBlank { self.stdout }.take(500)}")
                    return
                }
                t.mark("selftest")
            }
            setPhase("Starting agent runtime…")
            val port = freePort()
            val argv = Runtime.webArgv(this, port)
            val pb = ProcessBuilder(argv)
                .directory(Runtime.workspaceDir(this))
                .redirectErrorStream(true)
            pb.environment().clear()
            pb.environment().putAll(env)
            Log.i(Runtime.TAG, "starting DSH on 127.0.0.1:$port: ${argv.joinToString(" ")}")
            val p = pb.start()
            process = p
            t.mark("spawn")
            val log = Runtime.logFile(this)
            var logBytes = 0L
            logWriter = log.bufferedWriter()
            val reader = p.inputStream.bufferedReader()
            while (true) {
                val line = reader.readLine() ?: break
                logWriter?.apply {
                    write(line); write("\n")
                    logBytes += line.length + 1
                    if (logBytes > LOG_CAP_BYTES) {
                        close(); logBytes = 0
                        logWriter = log.bufferedWriter().apply { write("[parakeet] log truncated at ${LOG_CAP_BYTES / 1024 / 1024} MB\n") }
                    }
                    // Batch: flush only once the pipe is drained, not per line,
                    // so a chatty server never waits on our disk writes (node
                    // writes to a pipe synchronously).
                    if (!reader.ready()) logWriter?.flush()
                }
                val ready = url.get() != null
                // Before the server is up every line goes to logcat (CI and
                // bug reports read it). Afterwards a release build keeps only
                // notable lines; dsh.log has the rest.
                if (!ready || BuildConfig.DEBUG || notable(line)) Log.i(Runtime.TAG, line)
                if (!ready) {
                    extractUrl(line)?.let {
                        t.mark("spawn->ready")
                        val summary = t.summary()
                        lastTimings.set(summary)
                        Log.i(Runtime.TAG, "${BootTimer.PREFIX} $summary")
                        runCatching { BootTimer.persist(Runtime.timingsFile(this), "${java.util.Date()} v${BuildConfig.VERSION_NAME} $summary") }
                        phase.set(null)
                        url.set(it)
                        notify("Agent running on $it")
                        sendBroadcast(Intent(BROADCAST_STATE).setPackage(packageName))
                    }
                }
            }
            logWriter?.flush()
            val code = p.waitFor()
            if (stopping) Log.i(Runtime.TAG, "DSH stopped (exit $code)")
            else if (url.get() == null) fail("Runtime exited with code $code before serving. See the log screen.")
            else Log.i(Runtime.TAG, "DSH exited with $code")
        } catch (e: Exception) {
            if (!stopping) fail(e.message ?: e.toString())
        } finally {
            running.set(false)
            phase.set(null)
            logWriter?.runCatching { close() }
            sendBroadcast(Intent(BROADCAST_STATE).setPackage(packageName))
        }
    }

    private fun fail(message: String) {
        Log.e(Runtime.TAG, message)
        lastError.set(message)
        notify("Runtime failed: $message")
    }

    /** @param wait block (off the main thread only) until the old node is gone, so a restart never races it. */
    private fun shutdown(wait: Boolean = false) {
        stopping = true
        process?.let { p ->
            p.destroy()
            if (wait && !runCatching { p.waitFor(2, java.util.concurrent.TimeUnit.SECONDS) }.getOrDefault(false)) p.destroyForcibly()
        }
        process = null
        url.set(null)
        running.set(false)
    }

    override fun onDestroy() {
        shutdown()
        super.onDestroy()
    }

    private fun channel(): NotificationManager {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "Agent runtime", NotificationManager.IMPORTANCE_LOW),
            )
        }
        return nm
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, DshService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        channel()
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
        return b.setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .build()
    }

    private fun notify(text: String) = channel().notify(1, notification(text))
}
