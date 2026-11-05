package dev.parakeet.agent

import org.json.JSONObject

/**
 * The app's provider and safety settings, and their two on-disk projections:
 *  - `parakeet-config.json` (read by the DSH launcher, turned into a
 *    `--patch` overlay) — never contains the API key;
 *  - `parakeet-settings.json` (re-read by the root_shell plugin on every
 *    call) — the confirmation toggle.
 * The API key itself lives in EncryptedSharedPreferences (see [SecretStore])
 * and reaches DSH only as the PARAKEET_API_KEY environment variable.
 */
data class AgentConfig(
    val providerKind: ProviderKind = ProviderKind.NONE,
    val baseUrl: String = "",
    val model: String = "",
    val displayName: String = "",
    /** Wire protocol override; blank = derive from [providerKind]. */
    val api: String = "",
    val contextWindow: Int? = null,
    val rootToolEnabled: Boolean = true,
    /** "Require confirmation before root commands" — default ON. */
    val requireRootConfirm: Boolean = true,
) {
    enum class ProviderKind(val wire: String, val label: String) {
        NONE("none", "None (configure in DSH web UI)"),
        OPENAI_COMPATIBLE("openai-compatible", "OpenAI-compatible (any vendor)"),
        ANTHROPIC("anthropic", "Anthropic Messages API"),
        DEEPSEEK("deepseek", "DeepSeek (native DSH adapter)");

        companion object {
            fun fromWire(s: String?): ProviderKind = entries.firstOrNull { it.wire == s } ?: NONE
        }
    }

    /** Validation errors to show in the settings screen; empty when valid. */
    fun validate(): List<String> {
        val errors = mutableListOf<String>()
        when (providerKind) {
            ProviderKind.OPENAI_COMPATIBLE, ProviderKind.ANTHROPIC -> {
                if (!isHttpUrl(baseUrl)) errors += "Base URL must start with https:// (or http:// for a LAN/loopback server)"
                if (model.isBlank()) errors += "Model name is required"
            }
            ProviderKind.DEEPSEEK, ProviderKind.NONE -> Unit
        }
        if (api.isNotBlank() && api !in KNOWN_APIS) errors += "Unknown API protocol '$api'"
        return errors
    }

    /** The launcher-facing JSON (no secrets). */
    fun toLauncherJson(workspaceRoot: String): JSONObject {
        val provider = JSONObject().put("kind", providerKind.wire)
        if (baseUrl.isNotBlank()) provider.put("baseUrl", baseUrl.trim())
        if (model.isNotBlank()) provider.put("model", model.trim())
        if (displayName.isNotBlank()) provider.put("displayName", displayName.trim())
        if (api.isNotBlank()) provider.put("api", api.trim())
        contextWindow?.let { provider.put("contextWindow", it) }
        return JSONObject()
            .put("provider", provider)
            .put("rootTool", rootToolEnabled)
            .put("workspaceRoot", workspaceRoot)
    }

    /** The plugin-facing JSON. */
    fun toPluginSettingsJson(): JSONObject = JSONObject().put("requireRootConfirm", requireRootConfirm)

    companion object {
        val KNOWN_APIS = setOf("openai-completions", "openai-responses", "anthropic-messages")

        fun isHttpUrl(s: String): Boolean {
            val t = s.trim()
            return (t.startsWith("https://") || t.startsWith("http://")) && t.length > "https://".length
        }
    }
}
