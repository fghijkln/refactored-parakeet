package dev.parakeet.agent

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.text.InputType
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast

/**
 * Provider configuration and the root-safety toggle.
 *
 * Any vendor works as long as it speaks one of the protocols DSH's pi-ai
 * adapter knows: OpenAI-compatible chat completions (OpenAI, DeepSeek,
 * Qwen, Moonshot, SiliconFlow, OpenRouter, vLLM, Ollama, …), OpenAI
 * Responses, or the Anthropic Messages API. The key is written to
 * EncryptedSharedPreferences and never into any config file.
 */
class SettingsActivity : Activity() {

    private lateinit var store: SecretStore
    private lateinit var kind: Spinner
    private lateinit var baseUrl: EditText
    private lateinit var model: EditText
    private lateinit var displayName: EditText
    private lateinit var api: EditText
    private lateinit var apiKey: EditText
    private lateinit var rootTool: CheckBox
    private lateinit var requireConfirm: CheckBox

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = SecretStore(this)
        val cfg = store.load()

        val form = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
        }
        fun label(text: String) = form.addView(TextView(this).apply {
            this.text = text
            setPadding(0, 24, 0, 4)
        })

        label("Provider type / 模型供应商类型")
        kind = Spinner(this).apply {
            adapter = ArrayAdapter(
                this@SettingsActivity,
                android.R.layout.simple_spinner_dropdown_item,
                AgentConfig.ProviderKind.entries.map { it.label },
            )
            setSelection(AgentConfig.ProviderKind.entries.indexOf(cfg.providerKind))
        }
        form.addView(kind)

        label("Base URL (e.g. https://api.deepseek.com/v1)")
        baseUrl = EditText(this).apply {
            setText(cfg.baseUrl)
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            hint = "https://api.openai.com/v1"
        }
        form.addView(baseUrl)

        label("Model name / 模型名称")
        model = EditText(this).apply {
            setText(cfg.model)
            hint = "deepseek-chat"
        }
        form.addView(model)

        label("API key (stored encrypted on this device)")
        apiKey = EditText(this).apply {
            setText(store.apiKey() ?: "")
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            hint = "sk-…"
        }
        form.addView(apiKey)

        label("Display name (optional)")
        displayName = EditText(this).apply { setText(cfg.displayName) }
        form.addView(displayName)

        label("Protocol override (optional): openai-completions | openai-responses | anthropic-messages")
        api = EditText(this).apply { setText(cfg.api) }
        form.addView(api)

        rootTool = CheckBox(this).apply {
            text = "Give the agent a root shell tool (KernelSU) / 启用 root 工具"
            isChecked = cfg.rootToolEnabled
        }
        form.addView(rootTool)

        requireConfirm = CheckBox(this).apply {
            text = "Require confirmation before root commands / 执行 root 命令前需确认"
            isChecked = cfg.requireRootConfirm
        }
        form.addView(requireConfirm)

        form.addView(TextView(this).apply {
            text = "⚠ A root agent can brick this device or wipe your data. Keep confirmation on unless you " +
                "are watching every command. Commands that write to /dev/block, flash partitions or wipe data " +
                "always ask, whatever this setting says.\n\n" +
                "⚠ root 代理可能变砖或清空数据。除非你全程盯着,否则请保持确认开启;写入 /dev/block、刷分区、清数据的命令始终会询问。"
            setPadding(0, 24, 0, 16)
        })

        form.addView(Button(this).apply {
            text = "Save and restart runtime / 保存并重启"
            setOnClickListener { save() }
        })

        setContentView(ScrollView(this).apply {
            addView(form, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        })
    }

    private fun save() {
        val cfg = AgentConfig(
            providerKind = AgentConfig.ProviderKind.entries[kind.selectedItemPosition],
            baseUrl = baseUrl.text.toString().trim(),
            model = model.text.toString().trim(),
            displayName = displayName.text.toString().trim(),
            api = api.text.toString().trim(),
            rootToolEnabled = rootTool.isChecked,
            requireRootConfirm = requireConfirm.isChecked,
        )
        val errors = cfg.validate()
        if (errors.isNotEmpty()) {
            Toast.makeText(this, errors.joinToString("\n"), Toast.LENGTH_LONG).show()
            return
        }
        store.save(cfg)
        store.setApiKey(apiKey.text.toString())
        Runtime.writeConfig(this, cfg)
        DshService.stop(this)
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
        Toast.makeText(this, "Saved. Restarting runtime…", Toast.LENGTH_SHORT).show()
        finish()
    }
}
