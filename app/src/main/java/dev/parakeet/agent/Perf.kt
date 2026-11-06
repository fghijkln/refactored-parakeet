package dev.parakeet.agent

import android.os.StrictMode

/** Debug-time jank guards and the WebView rendering overrides. */
object Perf {

    /**
     * Debug builds only: log (never crash) any disk or network access on the
     * main thread and leaked closeables, so a regression that blocks the UI
     * thread shows up in logcat as `StrictMode policy violation`.
     */
    fun strictMode() {
        StrictMode.setThreadPolicy(
            StrictMode.ThreadPolicy.Builder().detectDiskReads().detectDiskWrites().detectNetwork()
                .penaltyLog().build(),
        )
        StrictMode.setVmPolicy(
            StrictMode.VmPolicy.Builder().detectLeakedClosableObjects().penaltyLog().build(),
        )
    }

    /**
     * The DSH web UI is designed for desktop browsers: menus and popovers use
     * `backdrop-filter: blur(40px) saturate(150%)` over 64–70%-opaque fills,
     * modal masks and the dock scrim blur everything behind them. On a phone
     * GPU a large backdrop blur is re-rendered every frame anything under it
     * moves (scrolling a list behind an open menu, streaming text under a
     * mask), which is a classic WebView scroll-jank source. Replace the blur
     * with the same colours made opaque, so menus stay legible.
     *
     * Light/dark fills are DSH's own `--dsw-menu-surface-fill` values
     * (#fcfdfeb3 / #303136a3) without their alpha.
     */
    const val CSS = "*,*::before,*::after{-webkit-backdrop-filter:none!important;backdrop-filter:none!important}" +
        ":root,body,body *{--dsw-menu-backdrop-filter:none!important;--dsw-mask-blur:none!important;--dsw-menu-surface-fill:#fcfdfe!important}" +
        "body[data-ds-dark-theme],body[data-ds-dark-theme] *{--dsw-menu-surface-fill:#303136!important}"

    /** Adds [CSS] once per document, as early as the document allows. */
    val CSS_INJECT_JS = """
        (function(){
          if (document.getElementById('parakeet-perf-css')) return;
          var s = document.createElement('style');
          s.id = 'parakeet-perf-css';
          s.textContent = ${org.json.JSONObject.quote(CSS)};
          (document.head || document.documentElement).appendChild(s);
        })();
    """.trimIndent()
}
