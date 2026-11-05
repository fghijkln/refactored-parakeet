package dev.parakeet.agent

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Settings persistence. Non-secret settings go to plain SharedPreferences;
 * the API key goes to EncryptedSharedPreferences (AES-256, key in Android
 * Keystore). Nothing is hardcoded and nothing leaves the device except the key
 * sent to the provider the user configured.
 */
class SecretStore(context: Context) {
    private val app = context.applicationContext
    private val plain: SharedPreferences = app.getSharedPreferences("parakeet", Context.MODE_PRIVATE)
    private val secret: SharedPreferences by lazy {
        val key = MasterKey.Builder(app).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            app,
            "parakeet_secrets",
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    fun load(): AgentConfig = AgentConfig(
        providerKind = AgentConfig.ProviderKind.fromWire(plain.getString("provider_kind", null)),
        baseUrl = plain.getString("base_url", "") ?: "",
        model = plain.getString("model", "") ?: "",
        displayName = plain.getString("display_name", "") ?: "",
        api = plain.getString("api", "") ?: "",
        contextWindow = plain.getInt("context_window", 0).takeIf { it > 0 },
        rootToolEnabled = plain.getBoolean("root_tool", true),
        requireRootConfirm = plain.getBoolean("require_root_confirm", true),
    )

    fun save(c: AgentConfig) {
        plain.edit()
            .putString("provider_kind", c.providerKind.wire)
            .putString("base_url", c.baseUrl)
            .putString("model", c.model)
            .putString("display_name", c.displayName)
            .putString("api", c.api)
            .putInt("context_window", c.contextWindow ?: 0)
            .putBoolean("root_tool", c.rootToolEnabled)
            .putBoolean("require_root_confirm", c.requireRootConfirm)
            .apply()
    }

    fun apiKey(): String? = runCatching { secret.getString("api_key", null) }.getOrNull()?.takeIf { it.isNotBlank() }

    fun setApiKey(value: String?) {
        if (value.isNullOrBlank()) secret.edit().remove("api_key").apply()
        else secret.edit().putString("api_key", value.trim()).apply()
    }
}
