package dev.parakeet.agent

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.Menu
import android.view.MenuItem
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * The app shell: a WebView on the DSH web UI running at 127.0.0.1, plus a
 * status strip showing root availability and a button to ask KernelSU for it.
 *
 * The DSH web UI is a full agent surface (sessions, model picker, plugin
 * manager, terminal), so hosting it beats re-implementing a chat screen, and
 * every DSH plugin's UI contribution works unchanged.
 */
class MainActivity : android.app.Activity() {

    private lateinit var web: WebView
    private lateinit var status: TextView
    private lateinit var rootStatus: TextView
    private var loaded = false

    private val stateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) = refresh()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

        status = TextView(this).apply {
            setPadding(24, 24, 24, 8)
            text = "Starting…"
        }
        rootStatus = TextView(this).apply {
            setPadding(24, 0, 24, 8)
            setTextColor(Color.DKGRAY)
        }
        val rootButton = Button(this).apply {
            text = "Check / request root (KernelSU)"
            setOnClickListener { probeRoot(interactive = true) }
        }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(rootButton)
        }
        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            webViewClient = WebViewClient()
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                    android.util.Log.d(Runtime.TAG, "web: ${m.message()}")
                    return true
                }
            }
        }
        root.addView(status)
        root.addView(rootStatus)
        root.addView(bar)
        root.addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)

        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7)
        }

        DshService.start(this)
        probeRoot(interactive = false)
    }

    override fun onResume() {
        super.onResume()
        val filter = IntentFilter(DshService.BROADCAST_STATE)
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(stateReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        else @Suppress("UnspecifiedRegisterReceiverFlag") registerReceiver(stateReceiver, filter)
        refresh()
        // The server can come up a moment after a broadcast is missed.
        web.postDelayed(::refresh, 1500)
        web.postDelayed(::refresh, 5000)
    }

    override fun onPause() {
        super.onPause()
        runCatching { unregisterReceiver(stateReceiver) }
    }

    private fun refresh() {
        val url = DshService.url.get()
        val err = DshService.lastError.get()
        when {
            url != null -> {
                status.text = "Agent runtime ready"
                if (!loaded) {
                    loaded = true
                    web.loadUrl(url)
                }
            }
            err != null -> status.text = "Runtime error: $err"
            else -> status.text = "Starting agent runtime… (first launch extracts ~200 MB, give it a minute)"
        }
    }

    private fun probeRoot(interactive: Boolean) {
        rootStatus.text = "Checking root…"
        Thread {
            val s = Su.probe()
            // /data/adb is unreadable for an app uid, so the file markers only
            // show up after root is granted; the manager package is visible
            // before that (declared in <queries>).
            val manager = installedManager()
            val ksu = s.kernelSu || manager != null
            runOnUiThread {
                rootStatus.text = when {
                    s.available -> "Root: granted (uid ${s.uid}) via ${s.suPath}"
                    ksu -> "Root: ${manager ?: "KernelSU"} manager present, root not granted — open the KernelSU manager and allow ${packageName}"
                    else -> "Root: unavailable (${s.detail ?: "no su"}) — the agent still works with a normal shell"
                }
                rootStatus.setTextColor(if (s.available) Color.rgb(0x1a, 0x7f, 0x37) else Color.DKGRAY)
                if (interactive && !s.available && manager != null) {
                    Toast.makeText(this, "Grant root to Parakeet in the manager (Superuser tab), then press again", Toast.LENGTH_LONG).show()
                    packageManager.getLaunchIntentForPackage(manager)?.let { startActivity(it) }
                }
            }
        }.start()
    }

    private fun installedManager(): String? = Su.MANAGER_PACKAGES.firstOrNull { pkg ->
        runCatching { packageManager.getPackageInfo(pkg, 0) }.isSuccess
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menu.add(0, 1, 0, R.string.settings)
        menu.add(0, 2, 1, R.string.logs)
        menu.add(0, 3, 2, "Restart runtime")
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            1 -> startActivity(Intent(this, SettingsActivity::class.java))
            2 -> startActivity(Intent(this, LogActivity::class.java))
            3 -> {
                loaded = false
                DshService.stop(this)
                web.postDelayed({ DshService.start(this) }, 800)
            }
        }
        return true
    }

    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }
}
