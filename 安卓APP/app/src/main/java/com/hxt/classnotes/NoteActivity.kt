package com.hxt.classnotes

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.io.File
import java.util.Locale

/**
 * v2.1 笔记阅读页：
 * - 顶部玻璃工具条：返回 / 标题 / 目录 / 重点；
 * - 正文精排：标题层级、时间胶囊、引用块、表格/公式样式、图片全宽；
 * - 目录：从 h2 抽取「时间 + 标题」，点哪节滚到哪节；
 * - 重点：聚合带 📌/❓/🔖/⭐ 的段落，页内高亮，点条目跳到对应小节；
 * - 图片：点一下全屏查看，双指缩放 / 双击放大 / 拖动；
 * - 正文样式：设置页可选「精排纸面」（默认）或「玻璃卡片」；深色模式两套都适配。
 *
 * 兼容性：CSS/JS 是显示时注入的，电脑端 md2html 不用改，旧笔记打开即自动升级。
 */
class NoteActivity : Activity() {
    private var sid = ""
    private lateinit var root: LinearLayout
    private lateinit var contentHost: LinearLayout
    private var barTitle: TextView? = null
    private var tocBtn: TextView? = null
    private var keysBtn: TextView? = null
    private var wv: WebView? = null
    private var appliedTheme = ""

    private var bodyMode = "paper"
    private var toc: List<TocEntry> = emptyList()
    private var keys: List<KeyEntry> = emptyList()

    private data class TocEntry(val id: String, val title: String, val time: String)
    private data class KeyEntry(val text: String, val anchor: String)

    private val timeTail = Regex("[（(]\\s*\\d{1,2}:\\d{2}\\s*[–—-]\\s*\\d{1,2}:\\d{2}\\s*[）)]\\s*\$")
    private val timeFind = Regex("[（(]\\s*(\\d{1,2}:\\d{2}\\s*[–—-]\\s*\\d{1,2}:\\d{2})\\s*[）)]")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        appliedTheme = UiTheme.stamp(this)
        setTheme(if (UiTheme.dark) android.R.style.Theme_Material_NoActionBar
        else android.R.style.Theme_Material_Light_NoActionBar)
        UiTheme.applyWindow(this)
        sid = intent.getStringExtra("sid") ?: ""
        bodyMode = Db.meta(UiTheme.KEY_NOTE_BODY, "paper")

        root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.background = Ui.glowBg()
        root.addView(buildTopBar(), LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).also { it.setMargins(Ui.dp(10), Ui.dp(6), Ui.dp(10), Ui.dp(2)) })

        contentHost = LinearLayout(this)
        contentHost.orientation = LinearLayout.VERTICAL
        root.addView(contentHost, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f
        ))
        setContentView(root)
        render()
    }

    override fun onResume() {
        super.onResume()
        val s = UiTheme.stamp(this)
        if (s != appliedTheme) {
            appliedTheme = s
            recreate()
        }
    }

    private fun buildTopBar(): LinearLayout {
        val bar = LinearLayout(this)
        bar.orientation = LinearLayout.HORIZONTAL
        bar.gravity = Gravity.CENTER_VERTICAL
        bar.background = Glass.cardBg(Glass.THIN, 16)
        bar.elevation = Ui.dp(3).toFloat()
        bar.setPadding(Ui.dp(4), Ui.dp(4), Ui.dp(6), Ui.dp(4))

        val back = Ui.text(this, "‹", 26, Ui.PRIMARY, true)
        back.gravity = Gravity.CENTER
        back.setPadding(Ui.dp(10), 0, Ui.dp(8), Ui.dp(2))
        back.setOnClickListener { goBack() }
        Ui.pressable(back, 0.9f)
        bar.addView(back, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Ui.dp(36)))

        barTitle = Ui.text(this, "笔记", 15, Ui.TEXT, true)
        barTitle?.maxLines = 1
        barTitle?.ellipsize = TextUtils.TruncateAt.END
        barTitle?.setPadding(Ui.dp(2), 0, Ui.dp(6), 0)
        bar.addView(barTitle, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

        tocBtn = pill("☰ 目录")
        tocBtn?.setOnClickListener { showToc() }
        tocBtn?.visibility = View.GONE
        bar.addView(tocBtn)

        keysBtn = pill("📌 重点")
        keysBtn?.setOnClickListener { showKeys() }
        keysBtn?.visibility = View.GONE
        bar.addView(keysBtn)
        return bar
    }

    private fun pill(label: String): TextView {
        val t = Ui.text(this, label, 12, Ui.PRIMARY, true)
        t.setPadding(Ui.dp(10), Ui.dp(6), Ui.dp(10), Ui.dp(6))
        t.background = Glass.secondaryBg(12)
        val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        lp.leftMargin = Ui.dp(6)
        t.layoutParams = lp
        Ui.pressable(t, 0.94f)
        return t
    }

    // ---------- 状态：正文 / 等待 ----------
    private fun render() {
        contentHost.removeAllViews()
        wv = null
        toc = emptyList()
        keys = emptyList()
        tocBtn?.visibility = View.GONE
        keysBtn?.visibility = View.GONE

        val cache = Db.noteCache(sid)
        val htmlFile = File(File(File(filesDir, "notes"), sid), "note.html")
        val state = cache?.optString("state") ?: ""
        val cachedTitle = cache?.optString("title") ?: ""
        val cachedCourse = cache?.optString("course") ?: ""
        barTitle?.text = (if (cachedTitle.isNotEmpty()) cachedTitle else cachedCourse).take(18).ifEmpty { "笔记" }

        if (state == "done" && htmlFile.exists()) showReader(htmlFile, cache)
        else showStatus(cache, state)
    }

    private fun showReader(htmlFile: File, cache: JSONObject?) {
        tocBtn?.visibility = View.VISIBLE
        keysBtn?.visibility = View.VISIBLE
        val t = cache?.optString("title") ?: ""
        if (t.isNotEmpty()) barTitle?.text = t.take(18)

        // 缺图自愈：以前下载断网会留下裂图，打开时后台补齐
        val expect = cache?.optInt("photoCount") ?: 0
        if (expect > 0 && Api.missingPhotos(this, sid, expect)) {
            val dir = htmlFile.parentFile
            val localCnt = dir?.listFiles { f -> f.name.endsWith(".jpg") }?.size ?: 0
            val tip = Ui.text(this, "⟳ 缺 ${expect - localCnt} 张图（以前下载时断了），正在自动补；现在连不上电脑的话，连上后打开这份笔记就会补。", 12, Ui.ORANGE)
            tip.setPadding(Ui.dp(14), Ui.dp(8), Ui.dp(14), Ui.dp(8))
            contentHost.addView(tip)
            Thread {
                val base = try { Api.workingUrl() } catch (_: Exception) { null } ?: return@Thread
                val ok = try { Api.refreshNote(this, base, sid) } catch (_: Exception) { false }
                if (ok && !Api.missingPhotos(this, sid, expect) && !isFinishing && !isDestroyed) {
                    runOnUiThread { if (!isFinishing && !isDestroyed) render() }
                }
            }.start()
        }

        val raw = try { htmlFile.readText(Charsets.UTF_8) } catch (_: Exception) { "" }
        if (raw.isEmpty()) {
            showStatus(cache, "done")
            return
        }

        val styled = injectSections(raw)
        val finalHtml = injectStylesAndScript(styled)

        val glass = bodyMode == "glass"
        val webBox = FrameLayout(this)
        if (!glass) {
            webBox.background = Glass.cardBg(Glass.THICK, 18)
            webBox.clipToOutline = true
            webBox.elevation = Ui.dp(3).toFloat()
        }
        val wlp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        wlp.setMargins(Ui.dp(if (glass) 0 else 10), Ui.dp(6), Ui.dp(if (glass) 0 else 10), Ui.dp(10))
        contentHost.addView(webBox, wlp)

        val w = WebView(this)
        w.settings.javaScriptEnabled = true
        w.settings.allowFileAccess = true
        w.settings.allowContentAccess = false
        w.settings.domStorageEnabled = false
        w.settings.builtInZoomControls = true
        w.settings.displayZoomControls = false
        w.settings.loadWithOverviewMode = false
        w.settings.useWideViewPort = true
        w.overScrollMode = View.OVER_SCROLL_NEVER
        w.setBackgroundColor(if (glass) Color.TRANSPARENT else UiTheme.p.bg)
        w.addJavascriptInterface(object {
            @JavascriptInterface
            fun openImage(src: String) {
                runOnUiThread {
                    val f = File(htmlFile.parentFile, src)
                    if (f.exists()) NoteImageViewer.show(this@NoteActivity, f)
                    else Ui.toast(this@NoteActivity, "这张图还没下载到手机，连上电脑后会自动补")
                }
            }
        }, "CNNative")
        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
                if (url.startsWith("http")) {
                    try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: Exception) { }
                    return true
                }
                return false
            }
        }
        w.loadDataWithBaseURL("file://" + htmlFile.parent + "/", finalHtml, "text/html", "utf-8", null)
        webBox.addView(w, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        wv = w
    }

    private fun showStatus(cache: JSONObject?, state: String) {
        val scroll = ScrollView(this)
        scroll.isFillViewport = true
        val box = LinearLayout(this)
        box.orientation = LinearLayout.VERTICAL
        box.setPadding(Ui.dp(14), Ui.dp(10), Ui.dp(14), Ui.dp(24))
        scroll.addView(box)
        contentHost.addView(scroll, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        val card = Ui.card(this)
        val (title, body) = when {
            cache == null -> "还没同步到手机" to "这份笔记还没下载。连上电脑/家里 WiFi 后点下面的「刷新」试试。"
            state == "error" -> "整理时出错了" to "电脑整理这份笔记时出了问题。下面是原始报错，方便直接发给 AI 修。"
            state == "transcribing" -> "正在转写录音" to "电脑在把录音转成文字（一节课要几分钟），先去忙别的，回头点「刷新」。"
            state == "analyzing" -> "正在整理笔记" to "电脑在读录音和照片写笔记，快好了，回头点「刷新」。"
            state == "done" -> "正文还没下载到手机" to "电脑说这篇已经整理好了，但全文还没下载完整。连上家里 WiFi 点「刷新」就会补下来。"
            else -> "排队等电脑处理" to "当前状态：${state.ifEmpty { "未知" }}。电脑端在跑的话，过一会儿点「刷新」。"
        }
        card.addView(Ui.text(this, title, 18, Ui.PRIMARY, true))
        val b = Ui.text(this, body, 14, Ui.TEXT)
        b.setLineSpacing(Ui.dp(3).toFloat(), 1f)
        b.setPadding(0, Ui.dp(6), 0, 0)
        card.addView(b)
        if (state == "error" && !cache?.optString("error").isNullOrEmpty()) {
            val err = Ui.text(this, cache?.optString("error") ?: "", 12, Ui.RED)
            err.setPadding(0, Ui.dp(8), 0, 0)
            card.addView(err)
        }
        val refresh = Ui.button(this, "⟳ 刷新")
        refresh.layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).also { it.topMargin = Ui.dp(12) }
        refresh.setOnClickListener {
            refresh.isEnabled = false
            refresh.text = "同步中…"
            Thread {
                try { Api.syncAll(this) } catch (_: Exception) { }
                runOnUiThread {
                    if (!isFinishing && !isDestroyed) render()
                }
            }.start()
        }
        card.addView(refresh)
        box.addView(card)

        val hint = Ui.text(this, "提示：正文样式在「设置 → 显示 → 笔记正文」里切换；图片点一下可全屏放大。", 11, Ui.TEXT_SUB)
        hint.setPadding(Ui.dp(6), Ui.dp(12), Ui.dp(6), 0)
        box.addView(hint)
    }

    // ---------- HTML 处理 ----------
    /** 给 h2 注入稳定 id，抽目录；顺带抽 📌/❓/🔖/⭐ 重点段落 */
    private fun injectSections(html: String): String {
        val h2 = Regex("(?is)<h2\\b([^>]*)>(.*?)</h2>").findAll(html).toList()
        val sb = StringBuilder(html.length + 64)
        var cursor = 0
        val tocList = ArrayList<TocEntry>()
        for ((i, m) in h2.withIndex()) {
            sb.append(html, cursor, m.range.first)
            val attrs = m.groupValues[1]
                .replace(Regex("(?i)\\s+id\\s*=\\s*\"[^\"]*\""), "")
                .replace(Regex("(?i)\\s+id\\s*=\\s*'[^']*'"), "")
            val inner = m.groupValues[2]
            val plain = stripHtml(inner)
            val time = timeFind.find(plain)?.groupValues?.get(1) ?: ""
            val id = "cn-sec-$i"
            sb.append("<h2").append(attrs).append(" id=\"").append(id).append("\">").append(inner).append("</h2>")
            tocList.add(TocEntry(id, cleanTitle(plain).ifEmpty { "第 ${i + 1} 节" }, time))
            cursor = m.range.last + 1
        }
        sb.append(html, cursor, html.length)
        var out = sb.toString()
        if (!Regex("(?is)<h1\\b[^>]*\\bid\\s*=").containsMatchIn(out)) {
            out = out.replaceFirst(Regex("(?i)<h1\\b"), "<h1 id=\"cn-top\"")
        }
        toc = tocList

        // 重点段落：按文档顺序扫。两种都算——
        // ① 自己带 📌/❓/🔖/⭐ 的段落；
        // ② 标题是「📌 要办的事 / ❓ 没看懂」这类小节的正文（否则只列出标题、看不到内容）
        val keyList = ArrayList<KeyEntry>()
        var section = -1
        var sectionIsKey = false
        val blocks = Regex("(?is)<(h2|h3|p|li|blockquote)\\b[^>]*>(.*?)</\\1>")
        for (m in blocks.findAll(out)) {
            val tag = m.groupValues[1].lowercase(Locale.US)
            val text = stripHtml(m.groupValues[2])
            val marked = text.contains("📌") || text.contains("❓") || text.contains("🔖") || text.contains("⭐")
            if (tag == "h2") {
                section++
                sectionIsKey = marked
                if (marked && text.length >= 2) keyList.add(KeyEntry(text, "cn-sec-$section"))
                continue
            }
            if (text.length < 3) continue
            if (marked || sectionIsKey) {
                keyList.add(KeyEntry(text, if (section >= 0) "cn-sec-$section" else "cn-top"))
            }
        }
        keys = keyList.distinctBy { it.text }
        return out
    }

    private fun stripHtml(s: String): String = s
        .replace(Regex("(?is)<[^>]+>"), " ")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace(Regex("\\s+"), " ")
        .trim()

    private fun cleanTitle(s: String): String = s.replace(timeTail, "").trim()

    private fun injectStylesAndScript(html: String): String {
        val p = UiTheme.p
        val dark = UiTheme.dark
        val text = hex(p.text)
        val sub = hex(p.textSub)
        val line = hex(p.line)
        val primary = hex(p.primary)
        val hilite = hex(p.hilite)
        val card = hex(p.card)
        val glassFill = rgba(p.card, if (dark) 0.58f else 0.64f)
        val glassStroke = if (dark) "rgba(255,255,255,0.10)" else "rgba(255,255,255,0.62)"
        val shadow = if (dark) "rgba(0,0,0,0.45)" else "rgba(0,0,0,0.13)"
        val bg = hex(p.bg)
        val red = hex(p.red)
        val pointTint = rgba(p.primary, if (dark) 0.18f else 0.09f)
        val quoteBar = rgba(p.textSub, if (dark) 0.55f else 0.45f)
        val doubtTint = rgba(p.red, if (dark) 0.16f else 0.07f)
        val doubtLine = rgba(p.red, if (dark) 0.55f else 0.42f)
        val markTint = rgba(p.primary, if (dark) 0.30f else 0.18f)
        val keyLine = rgba(p.primary, if (dark) 0.45f else 0.28f)
        val cardFill = if (bodyMode == "glass") rgba(p.card, if (dark) 0.10f else 0.55f) else card
        val cardStroke = if (bodyMode == "glass") glassStroke else line
        val base = 15.5f * UiTheme.fontScale

        val bodyStyle = if (bodyMode == "glass") {
            """
            background: $glassFill;
            margin: 10px;
            border-radius: 20px;
            border: 1px solid $glassStroke;
            box-shadow: 0 10px 34px $shadow;
            min-height: 70vh;
            """.trimIndent()
        } else {
            "background: $bg;"
        }

        val css = """
            :root { color-scheme: ${if (dark) "dark" else "light"}; }
            * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
            html { background: transparent; }
            body {
              margin: 0;
              padding: 12px 12px 42px;
              font-family: -apple-system, "Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
              font-size: ${base}px;
              line-height: 1.74;
              color: $text;
              $bodyStyle
              -webkit-text-size-adjust: 100%;
              word-wrap: break-word;
              overflow-wrap: break-word;
              line-break: strict;
            }
            h1 { font-size: 1.30em; line-height: 1.32; letter-spacing: -0.01em; font-weight: 700; margin: .1em 0 .3em; padding: 0 3px; }
            h3 { font-size: 1.02em; line-height: 1.5; margin: 1.1em 0 .4em; }
            h4 { font-size: .98em; line-height: 1.5; margin: 1em 0 .35em; color: $sub; }
            p { margin: .62em 0; }
            strong { font-weight: 700; color: $text; }
            a { color: $primary; text-decoration: none; }
            hr { border: 0; height: 1px; background: $line; margin: 1.4em 0; }
            .cn-sec > hr { display: none; }
            figure { margin: .8em 0; }
            figcaption { font-size: .8em; color: $sub; text-align: center; margin-top: .3em; }
            img {
              display: block; max-width: 100%; height: auto;
              margin: .85em auto; border-radius: 10px;
              box-shadow: 0 4px 18px $shadow;
              cursor: zoom-in;
            }
            /* 覆盖旧笔记自带样式：深色模式下别留浅色描边/浅色分隔线 */
            figure img { border: none; }
            hr.codecut { border: 0; height: 1px; background: $line; }
            table {
              display: block; width: 100%; overflow-x: auto;
              border-collapse: collapse; margin: .9em 0; font-size: .92em;
            }
            th, td { border: 1px solid $line; padding: 7px 9px; text-align: left; }
            th { background: $hilite; font-weight: 600; }
            code {
              font-family: ui-monospace, Menlo, Consolas, monospace;
              font-size: .9em; background: $hilite;
              padding: .12em .35em; border-radius: 6px;
            }
            pre { background: $hilite; padding: 11px 13px; border-radius: 10px; overflow-x: auto; }
            pre code { background: transparent; padding: 0; }

            /* ---- v2.4 紧凑大纲：每节一张卡 ---- */
            .cn-sec {
              background: $cardFill;
              border: 1px solid $cardStroke;
              border-radius: 14px;
              padding: 13px 13px 11px;
              margin: 0 0 12px;
              box-shadow: 0 1px 3px $shadow;
            }
            .cn-sec.cn-key-sec { border-color: $keyLine; }
            .cn-sec > h2 {
              display: block; position: relative;
              font-size: 1.08em; line-height: 1.42; font-weight: 700;
              margin: 0 0 .62em; padding: 0 0 .52em;
              border: 0; border-bottom: 1px solid $line; color: $text;
            }
            .cn-sec-hd {
              font-size: 1.08em; line-height: 1.42; font-weight: 700;
              margin: 0 0 .62em; padding: 0 0 .52em;
              border-bottom: 1px solid $line; color: $text;
            }
            .cn-no {
              display: inline-block; min-width: 1.75em; margin-right: .5em;
              padding: .08em .38em; font-size: .70em; line-height: 1.5;
              font-weight: 700; color: $primary; background: $pointTint;
              border-radius: 6px; text-align: center; vertical-align: .14em;
            }
            .cn-time {
              float: right; margin: .30em 0 0 .4em;
              font-size: .66em; font-weight: 500; color: $sub;
              background: transparent; border: 0; padding: 0;
              white-space: nowrap; font-variant-numeric: tabular-nums;
            }
            .cn-sec > p { margin: .5em 0; }
            .cn-sec > ul, .cn-sec > ol { margin: .35em 0 .15em; padding-left: 1.15em; }
            .cn-sec li { margin: .3em 0; line-height: 1.72; }
            .cn-sec img { margin: .75em auto; }
            blockquote {
              margin: .65em 0; padding: .5em .75em .55em .8em;
              border-left: 3px solid $quoteBar;
              background: $hilite;
              border-radius: 0 9px 9px 0;
              color: $text;
            }
            blockquote::before {
              content: attr(data-lab);
              display: block; font-size: .62em; line-height: 1.5;
              font-weight: 700; letter-spacing: .08em; color: $sub;
              margin-bottom: .2em;
            }
            blockquote[data-lab=""]::before { display: none; }
            blockquote p { margin: .15em 0; font-size: inherit; }
            blockquote.cn-meta {
              margin: .15em 0 .9em; padding: 0 3px;
              border: 0; background: transparent; border-radius: 0;
              font-size: .78em; line-height: 1.6; color: $sub;
            }

            /* 四类块：标签 + 形态 + 颜色一起用，不只靠颜色 */
            .cn-point, .cn-more, .cn-doubt { list-style: none; margin-left: -1.15em; }
            .cn-point > strong:first-child,
            .cn-more > strong:first-child,
            .cn-doubt > strong:first-child {
              display: inline-block; font-size: .72em; line-height: 1.55;
              font-weight: 700; padding: .02em .42em; margin-right: .42em;
              border-radius: 5px; vertical-align: .10em;
            }
            .cn-point > strong:first-child { color: $primary; background: $pointTint; }
            .cn-more > strong:first-child { color: $sub; background: $hilite; }
            .cn-doubt > strong:first-child { color: $red; background: $doubtTint; }
            .cn-more { color: $sub; }
            li.cn-doubt, p.cn-doubt {
              background: $doubtTint; border-left: 2px dashed $doubtLine;
              border-radius: 0 8px 8px 0; padding: .32em .55em .32em .6em;
            }
            p.cn-point {
              background: $pointTint; border-left: 3px solid $primary;
              border-radius: 0 8px 8px 0; padding: .34em .55em .34em .65em;
            }
            p.cn-more { border-left: 1px dashed $quoteBar; padding-left: .6em; }
            .cn-say strong, .cn-point strong:not(:first-child) {
              background: linear-gradient(transparent 62%, $markTint 62%);
            }
        """.trimIndent()

        val viewport = "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, maximum-scale=3.0\">"
        val styleBlock = viewport + "<style>" + css + "</style>"
        var out = html
        val headClose = out.indexOf("</head>", ignoreCase = true)
        if (headClose >= 0) {
            out = out.substring(0, headClose) + styleBlock + out.substring(headClose)
        } else {
            val headOpen = Regex("(?i)<head[^>]*>").find(out)
            out = if (headOpen != null) {
                val at = headOpen.range.last + 1
                out.substring(0, at) + styleBlock + out.substring(at)
            } else {
                styleBlock + out
            }
        }

        val js = """
            (function(){
              try {
                var de = document.documentElement;
                if (!de || de.getAttribute('data-cn') === '1') return;
                de.setAttribute('data-cn', '1');
                var body = document.body;
                if (!body) return;
                var SKIP = {SCRIPT:1, STYLE:1, LINK:1, META:1, NOSCRIPT:1};
                function txt(el){ return (el.textContent || '').replace(/\s+/g, ' ').trim(); }

                // 1) 按 h2 切节：每节包一张卡。只加外壳，不改原文顺序。
                var kids = Array.prototype.slice.call(body.children);
                var secs = [], h2s = [], cur = null;
                for (var i = 0; i < kids.length; i++) {
                  var el = kids[i];
                  if (SKIP[el.tagName]) continue;
                  if (el.tagName === 'H2') {
                    var sec = document.createElement('section');
                    sec.className = 'cn-sec';
                    body.insertBefore(sec, el);
                    sec.appendChild(el);
                    secs.push(sec); h2s.push(el); cur = sec;
                  } else if (cur) {
                    cur.appendChild(el);
                  }
                }
                // 没有 h2 的旧笔记：整篇包一张卡，不留裸文
                if (h2s.length === 0) {
                  var one = document.createElement('section');
                  one.className = 'cn-sec';
                  var hd = document.createElement('div');
                  hd.className = 'cn-sec-hd';
                  hd.textContent = '本课内容';
                  one.appendChild(hd);
                  var rest = Array.prototype.slice.call(body.children);
                  for (var r = 0; r < rest.length; r++) {
                    var e2 = rest[r];
                    if (SKIP[e2.tagName] || e2 === one || e2.tagName === 'H1') continue;
                    if (e2.className && String(e2.className).indexOf('cn-meta') >= 0) continue;
                    one.appendChild(e2);
                  }
                  body.appendChild(one);
                }

                // 2) 节头：编号 + 时间戳
                for (var s = 0; s < h2s.length; s++) {
                  var h = h2s[s];
                  var t = txt(h);
                  var m = t.match(/[（(]\s*\d{1,2}:\d{2}\s*[–—-]\s*\d{1,2}:\d{2}\s*[）)]\s*$/);
                  if (m) {
                    var time = document.createElement('span');
                    time.className = 'cn-time';
                    time.textContent = m[0];
                    // 只从最后一个文本节点里切掉时间，保住标题里的 <strong> 等内联标记
                    var ln = h.lastChild;
                    var cutOk = false;
                    if (ln && ln.nodeType === 3) {
                      var lv = ln.nodeValue.replace(/\s+$/, '');
                      if (lv.length >= m[0].length && lv.slice(-m[0].length) === m[0]) {
                        ln.nodeValue = lv.slice(0, lv.length - m[0].length);
                        cutOk = true;
                      }
                    }
                    if (cutOk) {
                      h.appendChild(time);
                    } else {
                      var cut = t.lastIndexOf(m[0]);
                      if (cut > 0) {
                        h.textContent = t.substring(0, cut);
                        h.appendChild(time);
                      }
                    }
                  }
                  var f = h.firstChild;
                  if (f && f.nodeType === 3) {
                    f.nodeValue = f.nodeValue.replace(/^\s*(?:\d{1,2}\s*[.、．)）]|[一二三四五六七八九十]{1,3}\s*[、.．])\s*/, '');
                  }
                  var no = document.createElement('span');
                  no.className = 'cn-no';
                  no.textContent = (s + 1 < 10 ? '0' : '') + (s + 1);
                  h.insertBefore(no, h.firstChild);
                  secs[s].setAttribute('data-idx', String(s + 1));
                  if (/📌|❓|🔖|⭐/.test(t)) secs[s].className += ' cn-key-sec';
                }

                // 3) 引用块：默认是老师原话；顶部课程信息行和用户标记单独处理
                var quotes = body.querySelectorAll('blockquote');
                for (var q = 0; q < quotes.length; q++) {
                  var bq = quotes[q];
                  var bt = txt(bq);
                  if (bt.length < 60 && /(全课|本课).{0,20}(分钟|照片)/.test(bt)) {
                    bq.className += ' cn-meta';
                    bq.setAttribute('data-lab', '');
                  } else if (bt.indexOf('用户标记') === 0) {
                    bq.setAttribute('data-lab', '用户标记');
                  } else {
                    bq.setAttribute('data-lab', '原话');
                  }
                }

                // 4) 四类块：存疑 > 考点 > 补充；匹配不到就不标（宁缺毋滥）
                var POINT = ['考点','知识点','结论','重点','要点','易错','必考','核心'];
                var MORE  = ['背景','延伸','补充','拓展','例子','举例','科普'];
                var DOUBT = ['存疑','待核','疑为','不确定','无法辨认','没听清'];
                function hit(s, arr) {
                  for (var k = 0; k < arr.length; k++) { if (s.indexOf(arr[k]) >= 0) return true; }
                  return false;
                }
                var blocks = body.querySelectorAll('p, li');
                for (var b = 0; b < blocks.length; b++) {
                  var blk = blocks[b];
                  var pn = blk.parentNode;
                  if (pn && (pn.tagName === 'BLOCKQUOTE' || pn.tagName === 'PRE')) continue;
                  var tx = txt(blk);
                  if (tx.length < 2) continue;
                  var st = blk.firstElementChild;
                  var lead = (st && st.tagName === 'STRONG') ? txt(st).replace(/[：:]\s*$/, '') : '';
                  var head = tx.slice(0, 30);
                  var kind = '';
                  if (hit(lead, DOUBT) || hit(head, DOUBT)) kind = 'doubt';
                  else if (hit(lead, POINT) || hit(head, POINT)) kind = 'point';
                  else if (hit(lead, MORE) || hit(head, MORE)) kind = 'more';
                  if (!kind) continue;
                  blk.className += ' cn-' + kind;
                  var isLab = hit(lead, DOUBT) || hit(lead, POINT) || hit(lead, MORE);
                  if (isLab && st && st.tagName === 'STRONG') {
                    st.textContent = lead;
                    var nx = st.nextSibling;
                    if (nx && nx.nodeType === 3) nx.nodeValue = nx.nodeValue.replace(/^[\s：:]+/, '');
                  }
                }

                // 5) 图片点击：交给原生全屏查看器
                var imgs = body.querySelectorAll('img');
                for (var g = 0; g < imgs.length; g++) {
                  imgs[g].addEventListener('click', function(){
                    var src = this.getAttribute('src') || '';
                    if (src.indexOf('http') === 0 || src.indexOf('data:') === 0) return;
                    var d = src;
                    try { d = decodeURIComponent(src); } catch(e) {}
                    try { CNNative.openImage(d); } catch(e) {}
                  });
                }
              } catch(e) {}
            })();
        """.trimIndent()

        val bodyClose = out.indexOf("</body>", ignoreCase = true)
        return if (bodyClose >= 0) {
            out.substring(0, bodyClose) + "<script>" + js + "</script>" + out.substring(bodyClose)
        } else {
            out + "<script>" + js + "</script>"
        }
    }

    private fun hex(c: Int): String = String.format(Locale.US, "#%06X", 0xFFFFFF and c)

    private fun rgba(c: Int, a: Float): String = String.format(
        Locale.US, "rgba(%d,%d,%d,%.2f)", Color.red(c), Color.green(c), Color.blue(c), a
    )

    // ---------- 目录 / 重点 ----------
    private fun showToc() {
        if (toc.isEmpty()) {
            Ui.toast(this, "这篇笔记没有分节标题")
            return
        }
        val labels = toc.map { e ->
            if (e.time.isNotEmpty()) "${e.time}  ·  ${e.title}" else e.title
        }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("目录 · ${toc.size} 节")
            .setItems(labels) { _, which -> jump(toc[which].id) }
            .setNegativeButton("关闭", null)
            .show()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun jump(id: String) {
        wv?.evaluateJavascript(
            "(function(){var e=document.getElementById('$id');if(e){e.scrollIntoView({behavior:'smooth',block:'start'});}})();",
            null
        )
    }

    private fun showKeys() {
        if (keys.isEmpty()) {
            Ui.toast(this, "这篇笔记里没有 📌 / ❓ / 🔖 / ⭐ 标记的重点")
            return
        }
        val box = LinearLayout(this)
        box.orientation = LinearLayout.VERTICAL
        box.setPadding(Ui.dp(6), Ui.dp(4), Ui.dp(6), Ui.dp(4))
        val dialog = AlertDialog.Builder(this)
            .setTitle("重点 · ${keys.size} 条")
            .setView(box)
            .setNegativeButton("关闭", null)
            .create()
        for (k in keys) {
            val row = Ui.text(this, k.text, 14, Ui.TEXT)
            row.maxLines = 4
            row.ellipsize = TextUtils.TruncateAt.END
            row.setLineSpacing(Ui.dp(2).toFloat(), 1f)
            row.setPadding(Ui.dp(10), Ui.dp(10), Ui.dp(10), Ui.dp(10))
            row.background = Glass.cardBg(Glass.THIN, 12)
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.topMargin = Ui.dp(6)
            row.layoutParams = lp
            row.setOnClickListener {
                dialog.dismiss()
                jump(k.anchor)
            }
            box.addView(row)
        }
        dialog.setOnShowListener {
            val dm = resources.displayMetrics
            dialog.window?.setLayout((dm.widthPixels * 0.92f).toInt(), (dm.heightPixels * 0.62f).toInt())
        }
        dialog.show()
    }

    /** 顶栏「‹」和系统返回一致：先退网页历史，再退页面 */
    private fun goBack() {
        val w = wv
        if (w != null && w.canGoBack()) w.goBack() else finish()
    }

    override fun onBackPressed() {
        goBack()
    }
}
