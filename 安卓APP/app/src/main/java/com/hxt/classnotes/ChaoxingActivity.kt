package com.hxt.classnotes

import android.app.Activity
import android.app.AlertDialog
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import org.json.JSONObject
import java.io.File
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

/**
 * 学习通页（v2.11，只读）。
 *
 * 边界（2026-10-24 用户确认）：
 *  · 看的是**登录者自己的**作业/互评、老师通知、考试、章节任务点；
 *  · 只读：不签到、不刷课、不答题、不提交，代码里没有任何写操作；
 *  · 登录态只存在用户自己的电脑（电脑端\data\chaoxing），不上传任何服务器；
 *  · 电脑路径：APP 让电脑生成二维码并在电脑浏览器显示，用户用手机学习通扫。
 *
 * 状态机：need_login →（点按钮）→ waiting → scanned → success → 拉汇总
 *         汇总本身是异步的：第一次返回 loading，本页每 2 秒轮询直到 ready。
 */
class ChaoxingActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var container: LinearLayout
    private var resp: JSONObject? = null       // 最近一次 /api/chaoxing/summary 返回
    private var apiError = ""                  // 连不上电脑 / 接口错误的人话说明
    private var loginState = ""                // waiting/scanned/success/expired/failed
    private var loginMsg = ""
    private var loginStarting = false
    private var summaryPolling = false
    private var loginPolling = false
    private var alive = true
    private val expanded = HashSet<String>()   // 四区里"展开全部"的区
    private val expandedNotices = HashSet<String>()
    private var appliedTheme = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        appliedTheme = UiTheme.stamp(this)
        setTheme(if (UiTheme.dark) android.R.style.Theme_Material_NoActionBar
        else android.R.style.Theme_Material_Light_NoActionBar)
        UiTheme.applyWindow(this)
        container = Ui.list(this)
        setContentView(Ui.scroll(this, container))
        resp = readCache()
        render()
        refreshAsync(false)
    }

    override fun onResume() {
        super.onResume()
        val s = UiTheme.stamp(this)
        if (s != appliedTheme) { appliedTheme = s; recreate() }
    }

    override fun onDestroy() {
        alive = false
        super.onDestroy()
    }

    // ---------- 缓存 ----------
    private fun cacheFile(): File = File(filesDir, "chaoxing-cache.json")

    private fun readCache(): JSONObject? = try {
        val f = cacheFile()
        if (!f.exists() || f.length() == 0L) null else JSONObject(f.readText(Charsets.UTF_8))
    } catch (_: Exception) { null }

    private fun saveCache(j: JSONObject) {
        try { cacheFile().writeText(j.toString(), Charsets.UTF_8) } catch (_: Exception) { }
    }

    // ---------- 数据 ----------
    private fun refreshAsync(force: Boolean) {
        Thread {
            val r = Api.cxSummary(force)
            handler.post {
                if (!alive) return@post
                if (r == null) {
                    apiError = "连不上电脑（电脑关机或隧道没通）。下面是上次同步的内容。"
                } else {
                    apiError = ""
                    resp = r
                    saveCache(r)
                    val st = r.optString("state")
                    if (st != "loading") loginState = ""
                }
                render()
                if (r?.optString("state") == "loading") pollSummary()
            }
        }.start()
    }

    /** 汇总在电脑端是后台构建的（21 门课约 30 秒，有反爬限速），这里轮询到出结果为止 */
    private fun pollSummary() {
        if (summaryPolling) return
        summaryPolling = true
        Thread {
            var lastState = ""
            val stopAt = System.currentTimeMillis() + 150_000
            while (alive && System.currentTimeMillis() < stopAt) {
                Thread.sleep(2000)
                val r = Api.cxSummary(false) ?: continue
                lastState = r.optString("state")
                handler.post {
                    if (!alive) return@post
                    resp = r
                    if (lastState != "loading") saveCache(r)
                    render()
                }
                if (lastState != "loading") break
            }
            summaryPolling = false
            if (alive && lastState == "loading") {
                handler.post {
                    apiError = "读取超时了。学习通可能很慢或要求验证，过一会儿点右上角刷新。"
                    render()
                }
            }
        }.start()
    }

    private fun startLogin() {
        loginStarting = true
        loginMsg = "正在让电脑生成二维码…"
        render()
        Thread {
            val r = Api.cxLoginStart()
            handler.post {
                if (!alive) return@post
                loginStarting = false
                if (r == null) {
                    loginMsg = "连不上电脑。扫码要在电脑上显示二维码，请确认电脑开着、APP 电脑端服务在运行。"
                    render()
                    return@post
                }
                if (!r.optBoolean("ok", true)) {
                    loginMsg = r.optString("error", "生成二维码失败，稍后再试")
                    render()
                    return@post
                }
                loginState = r.optString("state", "waiting")
                loginMsg = r.optString("message", "请用手机学习通扫码")
                render()
                pollLogin()
            }
        }.start()
    }

    private fun pollLogin() {
        if (loginPolling) return
        loginPolling = true
        Thread {
            val stopAt = System.currentTimeMillis() + 5 * 60_000
            while (alive && System.currentTimeMillis() < stopAt) {
                Thread.sleep(2000)
                val j = Api.cxLoginStatus() ?: continue
                val st = j.optString("state")
                val msg = j.optString("message")
                handler.post {
                    if (!alive) return@post
                    loginState = st
                    loginMsg = msg
                    render()
                }
                if (st == "success" || j.optBoolean("loggedIn", false)) {
                    handler.post { if (alive) refreshAsync(true) }
                    break
                }
                if (st == "expired" || st == "failed") break
            }
            loginPolling = false
        }.start()
    }

    private fun logout() {
        AlertDialog.Builder(this)
            .setTitle("退出学习通登录")
            .setMessage("退出后电脑上会先备份这份登录状态再清空。下次要用再扫一次码。")
            .setPositiveButton("退出") { _, _ ->
                Thread {
                    Api.cxLogout()
                    handler.post {
                        if (!alive) return@post
                        resp = null
                        apiError = ""
                        loginState = ""
                        loginMsg = ""
                        try { cacheFile().delete() } catch (_: Exception) { }
                        render()
                    }
                }.start()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun openVerify() {
        Thread {
            val r = Api.cxOpenVerify()
            handler.post {
                if (!alive) return@post
                if (r == null) Ui.toast(this, "连不上电脑，没法打开验证页")
                else Ui.toast(this, "已在电脑浏览器打开验证页，输入验证码后回来点刷新")
            }
        }.start()
    }

    // ---------- 渲染 ----------
    private fun render() {
        if (!alive) return
        container.removeAllViews()
        container.addView(header())
        val st = resp?.optString("state") ?: ""
        val data = resp?.optJSONObject("data")
        when {
            st == "need_login" -> {
                // 登录过期时旧数据也一起回来：登录卡在上、上次数据在下，不能把用户堵在「没入口」的状态
                loginCard(data != null)
                if (data != null) dataCard(data)
            }
            st == "loading" && data == null -> loadingCard()
            data == null -> {
                if (apiError.isNotEmpty()) offlineCard() else loadingCard()
            }
            else -> {
                if (st == "blocked") blockedCard()
                dataCard(data)
            }
        }
        if (apiError.isNotEmpty()) {
            container.addView(Ui.text(this, apiError, 12, Ui.ORANGE).apply {
                setPadding(Ui.dp(6), Ui.dp(10), Ui.dp(6), 0)
            })
        }
        footerCard()
    }

    private fun header(): View {
        val card = Ui.card(this)
        val row = LinearLayout(this)
        row.orientation = LinearLayout.HORIZONTAL
        val col = LinearLayout(this)
        col.orientation = LinearLayout.VERTICAL
        col.addView(Ui.text(this, "📖 学习通", 20, Ui.PRIMARY, true))
        col.addView(Ui.text(this, "只读查询 · v" + Upd.VERSION_NAME, 12, Ui.TEXT_SUB))
        row.addView(col, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val btn = Ui.text(this, "⟳ 刷新", 14, Ui.PRIMARY, true)
        btn.setPadding(Ui.dp(10), Ui.dp(8), Ui.dp(4), Ui.dp(8))
        btn.setOnClickListener {
            apiError = ""
            Ui.toast(this, "正在刷新…")
            refreshAsync(true)
        }
        row.addView(btn)
        card.addView(row)
        return card
    }

    private fun loadingCard() {
        val card = Ui.card(this)
        card.addView(Ui.text(this, "正在读取学习通…", 15, Ui.TEXT, true))
        val p = resp?.optJSONObject("progress")
        val done = p?.optInt("done") ?: 0
        val total = p?.optInt("total") ?: 0
        card.addView(Ui.text(this,
            if (total > 0) "第 $done / $total 步（电脑正在逐门课读，约半分钟）"
            else "电脑正在读取，第一次会慢一点（约半分钟）。",
            12, Ui.TEXT_SUB))
    }

    private fun offlineCard() {
        val card = Ui.card(this)
        card.addView(Ui.text(this, "现在连不上电脑", 15, Ui.ORANGE, true))
        card.addView(Ui.text(this,
            "学习通数据要经过你自己的电脑读取（登录态只存在那台电脑上）。电脑开机、APP 电脑端服务在运行，再点下面重试。",
            12, Ui.TEXT_SUB))
        val b = Ui.button(this, "重试", true)
        b.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT).also { it.topMargin = Ui.dp(10) }
        b.setOnClickListener { apiError = ""; render(); refreshAsync(true) }
        card.addView(b)
        container.addView(card)
    }

    private fun loginCard(expired: Boolean = false) {
        val card = Ui.card(this)
        card.addView(Ui.text(this, if (expired) "登录已过期，重新扫码" else "扫码登录你的学习通", 16,
            if (expired) Ui.ORANGE else Ui.TEXT, true))
        card.addView(Ui.text(this, "登录后能看到你自己的作业、通知、考试和章节进度。只看不改，不会签到、答题或提交。",
            12, Ui.TEXT_SUB))
        if (expired) card.addView(Ui.text(this, "下面是上次的数据，重新登录后点「⟳ 刷新」更新。", 12, Ui.TEXT_SUB))
        card.addView(Ui.text(this, "① 点下面的按钮\n② 电脑浏览器会自动弹出二维码\n③ 用手机上的「学习通」扫一扫，并在手机上确认",
            13, Ui.TEXT).apply { setPadding(0, Ui.dp(8), 0, 0) })
        val b = Ui.button(this, if (loginStarting) "正在生成二维码…" else "在电脑上显示二维码", true)
        b.isEnabled = !loginStarting
        b.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT).also { it.topMargin = Ui.dp(10) }
        b.setOnClickListener { startLogin() }
        card.addView(b)
        if (loginMsg.isNotEmpty()) {
            card.addView(Ui.text(this, loginMsg, 12,
                if (loginState == "success") Ui.GREEN else Ui.TEXT_SUB).apply { setPadding(0, Ui.dp(8), 0, 0) })
        }
        card.addView(Ui.text(this, "需要电脑现在开着（二维码显示在电脑屏幕上）。登录一次后长期有效，过期再扫。",
            11, Ui.TEXT_SUB).apply { setPadding(0, Ui.dp(8), 0, 0) })
        container.addView(card)
    }

    private fun blockedCard() {
        val card = Ui.card(this)
        card.addView(Ui.text(this, "⚠️ 学习通要求输入验证码", 15, Ui.RED, true))
        card.addView(Ui.text(this,
            "学习通检测到访问异常，需要你亲自在电脑上输入一次图片验证码。程序不会自动识别验证码。",
            12, Ui.TEXT_SUB))
        val b = Ui.button(this, "在电脑上打开验证页", true)
        b.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT).also { it.topMargin = Ui.dp(10) }
        b.setOnClickListener { openVerify() }
        card.addView(b)
        card.addView(Ui.text(this, "验证通过后回到这里点右上角「⟳ 刷新」。下面是上次拿到的数据。",
            11, Ui.TEXT_SUB).apply { setPadding(0, Ui.dp(6), 0, 0) })
        container.addView(card)
    }

    private fun dataCard(data: JSONObject) {
        val sum = data.optJSONObject("summary") ?: JSONObject()
        val prof = data.optJSONObject("profile") ?: JSONObject()
        val account = Ui.card(this)
        val name = prof.optString("name").ifEmpty { "已登录" }
        val school = prof.optString("school")
        val who = if (school.isEmpty() || school == "?") name else "$name · $school"
        if (resp?.optString("state") == "need_login") {
            account.addView(Ui.text(this, "🗂 上次的数据 · $who", 15, Ui.ORANGE, true))
        } else {
            account.addView(Ui.text(this, "✅ $who", 15, Ui.GREEN, true))
        }
        val at = fmtAt(resp?.optString("fetchedAt") ?: "")
        account.addView(Ui.text(this,
            "未交 ${sum.optInt("pending")} · 待互评 ${sum.optInt("peer")} · " +
                "未读通知 ${sum.optInt("unread")} · 考试 ${sum.optInt("exams")}" +
                if (at.isEmpty()) "" else " · 更新于 $at",
            12, Ui.TEXT_SUB))
        val warn = resp?.optString("warning") ?: ""
        if (warn.isNotEmpty()) account.addView(Ui.text(this, warn, 12, Ui.ORANGE))
        container.addView(account)

        // ① 作业与互评
        val hw = data.optJSONArray("homework")
        section("📝 作业与互评", "hw", hw?.length() ?: 0, Ui.RED) { card ->
            val arr = hw ?: return@section
            if (arr.length() == 0) { card.addView(Ui.text(this, "暂无未交作业 🎉", 13, Ui.GREEN)); return@section }
            for (i in 0 until minOf(arr.length(), shownCount("hw", arr.length()))) {
                val o = arr.getJSONObject(i)
                val row = LinearLayout(this)
                row.orientation = LinearLayout.VERTICAL
                row.setPadding(0, Ui.dp(7), 0, Ui.dp(7))
                val l1 = LinearLayout(this)
                l1.orientation = LinearLayout.HORIZONTAL
                l1.addView(Ui.text(this, o.optString("title"), 13, Ui.TEXT, true),
                    LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                val kind = o.optString("kind")
                val badge = Ui.badge(this, if (kind == "互评") "互评" else "作业",
                    if (kind == "互评") Ui.ORANGE else Ui.PRIMARY)
                l1.addView(badge)
                row.addView(l1)
                val dl = o.optString("deadline")
                val (cd, level) = countdown(dl)
                val sub = buildString {
                    append(o.optString("course"))
                    if (dl.isNotEmpty()) append(" · 截止 ").append(dl.substring(5))
                    if (cd.isNotEmpty()) append(" · ").append(cd)
                    else if (o.optString("status").isNotEmpty()) append(" · ").append(o.optString("status"))
                }
                row.addView(Ui.text(this, sub, 11,
                    when (level) { -1, 0 -> Ui.RED; 1 -> Ui.ORANGE; else -> Ui.TEXT_SUB }))
                card.addView(row)
            }
        }

        // ② 老师通知
        val nt = data.optJSONArray("notices")
        section("🔔 老师通知", "notice", nt?.length() ?: 0, Ui.PRIMARY) { card ->
            val arr = nt ?: return@section
            if (arr.length() == 0) { card.addView(Ui.text(this, "暂无通知", 13, Ui.TEXT_SUB)); return@section }
            for (i in 0 until minOf(arr.length(), shownCount("notice", arr.length()))) {
                val o = arr.getJSONObject(i)
                val key = o.optString("time") + "|" + o.optString("title")
                val row = LinearLayout(this)
                row.orientation = LinearLayout.VERTICAL
                row.setPadding(0, Ui.dp(7), 0, Ui.dp(7))
                val l1 = LinearLayout(this)
                l1.orientation = LinearLayout.HORIZONTAL
                if (o.optBoolean("unread")) l1.addView(Ui.text(this, "● ", 11, Ui.RED))
                l1.addView(Ui.text(this, o.optString("title"), 13, Ui.TEXT, true),
                    LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                row.addView(l1)
                val meta = listOf(o.optString("time"), o.optString("sender"))
                    .filter { it.isNotEmpty() }.joinToString(" · ")
                if (meta.isNotEmpty()) row.addView(Ui.text(this, meta, 11, Ui.TEXT_SUB))
                val body = o.optString("content")
                if (body.isNotEmpty()) {
                    val tv = Ui.text(this, body, 12, Ui.TEXT)
                    tv.visibility = if (key in expandedNotices) View.VISIBLE else View.GONE
                    tv.setPadding(0, Ui.dp(4), 0, 0)
                    row.addView(tv)
                    row.setOnClickListener {
                        if (key in expandedNotices) expandedNotices.remove(key) else expandedNotices.add(key)
                        render()
                    }
                }
                card.addView(row)
            }
        }

        // ③ 考试安排
        val ex = data.optJSONArray("exams")
        section("📅 考试安排", "exam", ex?.length() ?: 0, Ui.GREEN) { card ->
            val arr = ex ?: return@section
            if (arr.length() == 0) { card.addView(Ui.text(this, "暂无考试安排", 13, Ui.TEXT_SUB)); return@section }
            for (i in 0 until minOf(arr.length(), shownCount("exam", arr.length()))) {
                val o = arr.getJSONObject(i)
                val row = LinearLayout(this)
                row.orientation = LinearLayout.VERTICAL
                row.setPadding(0, Ui.dp(7), 0, Ui.dp(7))
                row.addView(Ui.text(this, o.optString("name"), 13, Ui.TEXT, true))
                val sub = listOf(o.optString("time"), o.optString("status"),
                    o.optString("duration").let { if (it.isEmpty()) "" else "时长 $it" })
                    .filter { it.isNotEmpty() }.joinToString(" · ")
                if (sub.isNotEmpty()) row.addView(Ui.text(this, sub, 11, Ui.TEXT_SUB))
                card.addView(row)
            }
        }

        // ④ 章节任务点
        val pg = data.optJSONArray("progress")
        section("📊 章节任务点", "prog", pg?.length() ?: 0, Ui.ORANGE) { card ->
            val arr = pg ?: return@section
            var shown = 0
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                val total = o.optInt("total")
                if (total <= 0) continue
                if (shown >= shownCount("prog", arr.length())) break
                shown++
                val line = LinearLayout(this)
                line.orientation = LinearLayout.HORIZONTAL
                line.setPadding(0, Ui.dp(6), 0, 0)
                line.addView(Ui.text(this, o.optString("course"), 13, Ui.TEXT),
                    LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                val pct = o.optInt("pct")
                line.addView(Ui.text(this, "$pct%  ${o.optInt("done")}/${total}", 12,
                    if (pct >= 100) Ui.GREEN else Ui.TEXT_SUB))
                card.addView(line)
                card.addView(bar(pct))
            }
            if (shown == 0) card.addView(Ui.text(this, "暂无任务点数据", 13, Ui.TEXT_SUB))
        }

        val errs = data.optJSONArray("errors")
        if (errs != null && errs.length() > 0) {
            val c = Ui.card(this)
            c.addView(Ui.text(this, "⚠️ 有 ${errs.length()} 项没取到", 13, Ui.ORANGE, true))
            for (i in 0 until minOf(errs.length(), 5)) {
                c.addView(Ui.text(this, "· " + errs.optString(i), 11, Ui.TEXT_SUB))
            }
            c.addView(Ui.text(this, "没取到不等于「已完成/没作业」，以学习通网页为准。", 11, Ui.TEXT_SUB))
            container.addView(c)
        }
    }

    /** 默认每个区先显示 2 条；点标题栏展开全部 */
    private fun shownCount(key: String, total: Int): Int =
        if (key in expanded) total else minOf(2, total)

    private fun section(title: String, key: String, count: Int, color: Int,
                        build: (LinearLayout) -> Unit) {
        val card = Ui.card(this)
        val head = LinearLayout(this)
        head.orientation = LinearLayout.HORIZONTAL
        head.addView(Ui.text(this, "$title（$count）", 15, color, true),
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val open = key in expanded
        head.addView(Ui.text(this, if (open) "▾ 收起" else if (count > 2) "▸ 全部" else "▸", 12, Ui.TEXT_SUB))
        if (count > 2) {
            head.setOnClickListener {
                if (open) expanded.remove(key) else expanded.add(key)
                render()
            }
        }
        card.addView(head)
        build(card)
        container.addView(card)
    }

    private fun bar(pct: Int): View {
        val wrap = LinearLayout(this)
        wrap.orientation = LinearLayout.HORIZONTAL
        wrap.background = Ui.roundBg(Ui.LINE, 5)
        wrap.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(8)).also {
            it.topMargin = Ui.dp(4)
        }
        val p = pct.coerceIn(0, 100)
        if (p > 0) {
            val fill = View(this)
            fill.background = Ui.roundBg(if (p >= 100) Ui.GREEN else Ui.PRIMARY, 5)
            wrap.addView(fill, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, p.toFloat()))
        }
        if (p < 100) wrap.addView(View(this), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, (100 - p).toFloat()))
        return wrap
    }

    private fun footerCard() {
        val card = Ui.card(this)
        card.addView(Ui.text(this, "只读说明", 13, Ui.TEXT, true))
        card.addView(Ui.text(this,
            "这里只查询作业与截止时间（含互评）、老师通知、考试安排、章节任务点。不会签到、不会刷课、不会自动答题或提交。",
            11, Ui.TEXT_SUB))
        val out = Ui.text(this, "退出学习通登录", 13, Ui.RED)
        out.setPadding(0, Ui.dp(10), 0, 0)
        out.setOnClickListener { logout() }
        card.addView(out)
        container.addView(card)
    }

    // ---------- 小工具 ----------
    private fun fmtAt(iso: String): String {
        if (iso.isEmpty()) return ""
        return try {
            OffsetDateTime.parse(iso).format(DateTimeFormatter.ofPattern("MM-dd HH:mm"))
        } catch (_: Exception) {
            iso.replace("T", " ").take(16)
        }
    }

    /** 截止倒计时：返回 (文案, 紧急级别)；级别 -1=过期 0=今天 1=3天内 2=正常 */
    private fun countdown(dl: String): Pair<String, Int> {
        if (dl.isEmpty()) return "" to 2
        return try {
            val t = LocalDateTime.parse(dl, DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm"))
            val mins = ChronoUnit.MINUTES.between(LocalDateTime.now(), t)
            when {
                mins < 0 -> "已过截止" to -1
                mins < 60 -> "剩 ${mins} 分钟" to 0
                mins < 24 * 60 -> "剩 ${mins / 60} 小时" to 0
                mins < 72 * 60 -> "剩 ${mins / (24 * 60)} 天" to 1
                else -> "剩 ${mins / (24 * 60)} 天" to 2
            }
        } catch (_: Exception) { "" to 2 }
    }
}
