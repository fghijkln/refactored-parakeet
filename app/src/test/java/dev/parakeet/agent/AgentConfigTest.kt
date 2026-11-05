package dev.parakeet.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentConfigTest {

    @Test
    fun defaultsAreSafe() {
        val c = AgentConfig()
        assertTrue("root confirmation must default ON", c.requireRootConfirm)
        assertTrue(c.rootToolEnabled)
        assertEquals(AgentConfig.ProviderKind.NONE, c.providerKind)
        assertTrue(c.validate().isEmpty())
    }

    @Test
    fun openAiCompatibleNeedsUrlAndModel() {
        val bad = AgentConfig(providerKind = AgentConfig.ProviderKind.OPENAI_COMPATIBLE)
        assertEquals(2, bad.validate().size)
        val ok = bad.copy(baseUrl = "https://api.deepseek.com/v1", model = "deepseek-chat")
        assertTrue(ok.validate().isEmpty())
        assertFalse(ok.copy(api = "smoke-signals").validate().isEmpty())
    }

    @Test
    fun launcherJsonNeverCarriesTheKey() {
        val c = AgentConfig(
            providerKind = AgentConfig.ProviderKind.ANTHROPIC,
            baseUrl = " https://api.anthropic.com ",
            model = "claude-sonnet-4-5",
        )
        val json = c.toLauncherJson("/data/user/0/dev.parakeet.agent/files/workspace")
        val p = json.getJSONObject("provider")
        assertEquals("anthropic", p.getString("kind"))
        assertEquals("https://api.anthropic.com", p.getString("baseUrl"))
        assertEquals("claude-sonnet-4-5", p.getString("model"))
        assertTrue(json.getBoolean("rootTool"))
        assertFalse(json.toString().contains("sk-"))
        assertFalse(json.toString().lowercase().contains("apikey"))
    }

    @Test
    fun pluginSettingsCarryTheToggle() {
        assertTrue(AgentConfig().toPluginSettingsJson().getBoolean("requireRootConfirm"))
        assertFalse(AgentConfig(requireRootConfirm = false).toPluginSettingsJson().getBoolean("requireRootConfirm"))
    }

    @Test
    fun providerKindRoundTrips() {
        AgentConfig.ProviderKind.entries.forEach {
            assertEquals(it, AgentConfig.ProviderKind.fromWire(it.wire))
        }
        assertEquals(AgentConfig.ProviderKind.NONE, AgentConfig.ProviderKind.fromWire("bogus"))
    }

    @Test
    fun extractsDshBannerUrl() {
        assertEquals(
            "http://127.0.0.1:41234/?token=abc-DEF_1",
            DshService.extractUrl("dsh web: http://127.0.0.1:41234/?token=abc-DEF_1"),
        )
        assertEquals(null, DshService.extractUrl("dsh: warning: 7 entries did not activate"))
    }
}
