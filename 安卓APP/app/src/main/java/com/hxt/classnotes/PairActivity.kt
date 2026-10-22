package com.hxt.classnotes

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import org.json.JSONObject

/**
 * 连接电脑 & AI 设置（v2.0 开源版入口，装好后只需来一次）：
 * ① 同 WiFi 一键自动找电脑（UDP 广播，无需输入任何东西）；
 * ② 不在同一网络时手动输入电脑上显示的地址；
 * ③ AI 笔记开关：不填 key = 免费转写稿模式（开箱即用）；
 *    填一个免费的 API Key（如智谱 glm-4-flash，注册就送、调用免费）= AI 整理模式。
 */
class PairActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var container: LinearLayout
    private var statusLine: android.widget.TextView? = null
    private var aiLine: android.widget.TextView? = null
    private var keyInput: EditText? = null
    private var appliedTheme = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        appliedTheme = UiTheme.stamp(this)
        setTheme(if (UiTheme.dark) android.R.style.Theme_Material_NoActionBar
        else android.R.style.Theme_Material_Light_NoActionBar)
        UiTheme.applyWindow(this)
        container = LinearLayout(this)
        container.orientation = LinearLayout.VERTICAL
        setContentView(Ui.scroll(this, container))
        render()
        refreshAiStatus()
    }

    override fun onResume() {
        super.onResume()
        val s = UiTheme.stamp(this)
        if (s != appliedTheme) {
            appliedTheme = s
            recreate()
        }
    }

    private fun render() {
        container.removeAllViews()

        val head = Ui.card(this)
        head.addView(Ui.text(this, "🔗 连接电脑 & AI 设置", 20, Ui.PRIMARY, true))
        head.addView(Ui.text(this,
            if (Api.paired()) "已连接你的电脑（点「自动找电脑」可重连/换电脑）"
            else "第一次使用：让电脑跑起来「课堂笔记·电脑端」，手机连同一个 WiFi，点下面的按钮就行。",
            13, Ui.TEXT_SUB))
        container.addView(head)

        // ---- 自动发现 ----
        val card1 = Ui.card(this)
        card1.addView(Ui.text(this, "① 自动找电脑（推荐，同一个 WiFi）", 15, Ui.TEXT, true))
        card1.addView(Ui.text(this, "不用输任何东西，最多几秒钟。找不到时再用下面的手动方式。", 12, Ui.TEXT_SUB))
        val b1 = Ui.button(this, "🔍 自动找我的电脑")
        b1.setOnClickListener { doDiscover(b1) }
        card1.addView(b1)
        statusLine = Ui.text(this, "", 13, Ui.TEXT_SUB)
        statusLine?.setPadding(0, Ui.dp(6), 0, 0)
        card1.addView(statusLine)
        container.addView(card1)

        // ---- 手动 ----
        val card2 = Ui.card(this)
        card2.addView(Ui.text(this, "② 手动输入电脑地址（不在同一 WiFi / 自动找不到时）", 15, Ui.TEXT, true))
        card2.addView(Ui.text(this, "电脑端屏幕上会显示一行地址（http://…:8776），抄到这里。", 12, Ui.TEXT_SUB))
        val input = EditText(this)
        input.hint = "http://192.168.x.x:8776"
        input.textSize = 14f
        card2.addView(input)
        val b2 = Ui.button(this, "连接", false)
        b2.setOnClickListener {
            val s = input.text.toString().trim()
            if (s.isEmpty()) { Ui.toast(this, "先填电脑地址"); return@setOnClickListener }
            doManual(b2, s)
        }
        card2.addView(b2)
        container.addView(card2)

        // ---- AI 设置 ----
        val card3 = Ui.card(this)
        card3.addView(Ui.text(this, "③ AI 笔记（可选）", 15, Ui.TEXT, true))
        aiLine = Ui.text(this, "正在问电脑当前模式…", 12, Ui.TEXT_SUB)
        card3.addView(aiLine)
        keyInput = EditText(this)
        keyInput?.hint = "粘贴 API Key（留空点保存=关掉AI）"
        keyInput?.textSize = 14f
        card3.addView(keyInput)
        val b3 = Ui.button(this, "保存 AI 设置", false)
        b3.setOnClickListener { doSaveKey(b3) }
        card3.addView(b3)
        card3.addView(Ui.text(this,
            "不填也能用：笔记会是「转写稿模式」（课堂原话+照片，免费无账号）。\n" +
            "想要 AI 整理（要点提炼、大白话讲解、例题、自动抽作业）：注册智谱开放平台（bigmodel.cn）领一个免费的 API Key 粘贴到这里即可，glm-4-flash 模型免费，不会扣费。",
            12, Ui.TEXT_SUB))
        container.addView(card3)
    }

    private fun doDiscover(btn: Button) {
        btn.isEnabled = false
        statusLine?.text = "正在这个 WiFi 里找电脑…（约 3 秒）"
        Thread {
            val found = try { Api.discoverLocal() } catch (_: Exception) { null }
            handler.post {
                if (isFinishing || isDestroyed) return@post
                btn.isEnabled = true
                if (found == null) {
                    statusLine?.text = "❌ 没找到。看看：电脑端跑起来了吗？手机和电脑是同一个 WiFi 吗？都不行就用下面的手动方式。"
                    return@post
                }
                statusLine?.text = "找到电脑：${found.optString("name")}（${found.optString("server")}），正在连接…"
                Thread {
                    val ok = try { Api.connect(found) } catch (_: Exception) { false }
                    handler.post {
                        if (isFinishing || isDestroyed) return@post
                        if (ok) {
                            statusLine?.text = "✅ 已连上 ${found.optString("name")}！以后不用再配，回主页就能用了。"
                            Ui.toast(this, "连接成功")
                            refreshAiStatus()
                        } else {
                            statusLine?.text = "⚠️ 找到了但没连通（${found.optString("server")}），检查电脑端防火墙是否放行 8776 端口，或试手动方式。"
                        }
                    }
                }.start()
            }
        }.start()
    }

    private fun doManual(btn: Button, server: String) {
        btn.isEnabled = false
        statusLine?.text = "正在连接 $server …"
        Thread {
            val info = try { Api.pairManual(server) } catch (_: Exception) { null }
            val ok = info != null && try { Api.connect(info) } catch (_: Exception) { false }
            handler.post {
                if (isFinishing || isDestroyed) return@post
                btn.isEnabled = true
                if (ok) {
                    statusLine?.text = "✅ 已连上 ${info!!.optString("name")}！以后不用再配。"
                    Ui.toast(this, "连接成功")
                    refreshAiStatus()
                } else {
                    statusLine?.text = "❌ 连不上。常见原因：地址抄错了；电脑端没开「局域网直连」（config 里 listen 要是 0.0.0.0）；防火墙拦了。"
                }
            }
        }.start()
    }

    private fun refreshAiStatus() {
        Thread {
            val st = try { Api.aiStatus() } catch (_: Exception) { null }
            handler.post {
                if (isFinishing || isDestroyed) return@post
                aiLine?.text = when {
                    st == null -> "（现在连不上电脑，AI 状态待会儿再看；不影响保存——连上后自动生效）"
                    st.optString("engine") == "glm" -> "✅ 当前模式：AI 整理（${st.optString("model")}）"
                    st.optString("engine") == "zcode" -> "✅ 当前模式：私有 AI 引擎（zcode）"
                    else -> "当前模式：免费转写稿（无 AI）——开箱即用，想升级在上面填免费 Key"
                }
            }
        }.start()
    }

    private fun doSaveKey(btn: Button) {
        val key = (keyInput?.text?.toString() ?: "").trim()
        btn.isEnabled = false
        Thread {
            val r = try { Api.setApiKey(key) } catch (_: Exception) { null }
            handler.post {
                if (isFinishing || isDestroyed) return@post
                btn.isEnabled = true
                when {
                    r == null -> Ui.toast(this, "暂时连不上电脑，设置没保存——连上后再来点一次")
                    r.optBoolean("ok") && key.isNotEmpty() -> Ui.toast(this, "✅ AI 已开启！以后的笔记自动用 AI 整理")
                    r.optBoolean("ok") -> Ui.toast(this, "已关掉 AI，回到免费转写稿模式")
                    else -> Ui.toast(this, "保存失败：${r.optString("error").take(60)}")
                }
                keyInput?.setText("")
                refreshAiStatus()
            }
        }.start()
    }
}
