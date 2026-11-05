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
        const val BROADCAST_STATE = "dev.parakeet.agent.STATE"

        /** The URL (with the DSH browser token) once the server has printed it. */
        val url = AtomicReference<String?>(null)
        val lastError = AtomicReference<String?>(null)
        val running = AtomicReference(false)

        fun start(ctx: Context) {
            val i = Intent(ctx, DshService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context) = ctx.startService(Intent(ctx, DshService::class.java).setAction(ACTION_STOP))

        /** Pick a free loopback port by binding and releasing one. */
        fun freePort(): Int = ServerSocket(0).use { it.localPort }

        /** The `dsh web` banner carries the URL with its one-time browser token. */
        private val URL_RE = Regex("https?://127\\.0\\.0\\.1:\\d+/\\S*")

        fun extractUrl(line: String): String? = URL_RE.find(line)?.value
    }

    private var process: Process? = null
    private var logWriter: java.io.Writer? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            shutdown()
            stopSelf()
            return START_NOT_STICKY
        }
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(1, notification("Starting agent runtime…"), android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(1, notification("Starting agent runtime…"))
        }
        if (process?.isAlive != true) Thread { boot() }.start()
        return START_STICKY
    }

    private fun boot() {
        running.set(true)
        lastError.set(null)
        url.set(null)
        try {
            if (!Runtime.nodePresent(this)) {
                fail("No Node runtime for this device's ABI (${Build.SUPPORTED_ABIS.joinToString()}). This build ships arm64-v8a.")
                return
            }
            Runtime.ensureRuntime(this)
            Runtime.ensureShims(this)
            Runtime.ensureLibLinks(this)
            val store = SecretStore(this)
            val cfg = store.load()
            Runtime.writeConfig(this, cfg)

            val env = Runtime.env(this, store.apiKey())
            // Fail fast, with a readable reason, if node cannot even start.
            val self = Su.runProcess(Runtime.selfTestArgv(this), 60_000, env)
            Log.i(Runtime.TAG, "parakeet selftest: ${self.stdout.trim()} ${self.stderr.trim()}".trim())
            if (self.exitCode != 0) {
                fail("Node self-test failed (exit ${self.exitCode}): ${self.stderr.ifBlank { self.stdout }.take(500)}")
                return
            }
            val port = freePort()
            val pb = ProcessBuilder(Runtime.webArgv(this, port))
                .directory(Runtime.workspaceDir(this))
                .redirectErrorStream(true)
            pb.environment().clear()
            pb.environment().putAll(env)
            Log.i(Runtime.TAG, "starting DSH on 127.0.0.1:$port")
            val p = pb.start()
            process = p
            val log = File(Runtime.logFile(this).path)
            logWriter = log.bufferedWriter()
            p.inputStream.bufferedReader().forEachLine { line ->
                logWriter?.apply { write(line); write("\n"); flush() }
                Log.i(Runtime.TAG, line)
                if (url.get() == null) {
                    extractUrl(line)?.let {
                        url.set(it)
                        notify("Agent running on $it")
                        sendBroadcast(Intent(BROADCAST_STATE).setPackage(packageName))
                    }
                }
            }
            val code = p.waitFor()
            if (url.get() == null) fail("Runtime exited with code $code before serving. See the log screen.")
            else Log.i(Runtime.TAG, "DSH exited with $code")
        } catch (e: Exception) {
            fail(e.message ?: e.toString())
        } finally {
            running.set(false)
            logWriter?.runCatching { close() }
            sendBroadcast(Intent(BROADCAST_STATE).setPackage(packageName))
        }
    }

    private fun fail(message: String) {
        Log.e(Runtime.TAG, message)
        lastError.set(message)
        notify("Runtime failed: $message")
    }

    private fun shutdown() {
        process?.destroy()
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
