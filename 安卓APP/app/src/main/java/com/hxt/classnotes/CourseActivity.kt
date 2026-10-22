package com.hxt.classnotes

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/**
 * 课程页（v1.2 起，v1.3 加总纲本地缓存与小助手倒计时，v1.4 改缓存先上屏，v1.7 待办勾一下就消）：
 * 顶层 = 作业汇总（短期/长期/通知与活动）+ 待办倒计时（可勾选完成即消失、过期默认收起）+ 课程文件夹；
 * 课程 = 课程总纲（存手机，秒开，后台核对更新）+ 待办（可勾选）+ 该课全部笔记（本地缓存）。
 * v1.4：进页面先拿上次的缓存立刻渲染（不再白等网络），网络回来再刷新；
 * 总纲核对改增量（带 have=修改时间，没变只回几十字节）。
 * v1.7：待办每条带 ☐，点一下本地立即消失并回传电脑（断网先记手机、连上自动补推）；
 * 已过期的默认收进折叠行（不再红字挂着），点开可看可勾掉；最近勾掉的可以点撤销。
 */
class CourseActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var container: LinearLayout
    private var currentCourse = ""      // "" = 顶层
    private var agg: JSONObject? = null // /api/courses 的返回缓存
    private var droot: JSONObject? = null // /api/deadlines 完整结构（items/overdue/recentDone）
    private var fromCacheOnly = false   // 本次渲染来自本地缓存（网络还没回来）
    private var showOverdue = false     // 已过期折叠段的展开状态（倒计时卡）
    private var showOverdueTodo = false // 已过期折叠段的展开状态（待办/作业汇总）
    private var appliedTheme = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        appliedTheme = UiTheme.stamp(this)
        setTheme(if (UiTheme.dark) android.R.style.Theme_Material_NoActionBar
        else android.R.style.Theme_Material_Light_NoActionBar)
        UiTheme.applyWindow(this)
        currentCourse = intent.getStringExtra("course") ?: ""
        container = LinearLayout(this)
        container.orientation = LinearLayout.VERTICAL
        setContentView(Ui.scroll(this, container))
        // 先用上次的缓存秒开（没有缓存才显示加载中）；旧版缓存是纯数组，包一层兼容
        agg = try { JSONObject(cacheFile("courses-cache.json").readText()) } catch (_: Exception) { null }
        droot = try {
            val t = cacheFile("deadlines-cache.json").readText()
            try { JSONObject(t) } catch (_: Exception) { JSONObject().put("items", org.json.JSONArray(t)) }
        } catch (_: Exception) { null }
        fromCacheOnly = agg != null || droot != null
        if (fromCacheOnly) render() else renderLoading()
        load()
    }

    override fun onResume() {
        super.onResume()
        // 设置页换过主题/明暗/字号：回到本页时重建，避免半新半旧
        val s = UiTheme.stamp(this)
        if (s != appliedTheme) {
            appliedTheme = s
            recreate()
        }
    }

    private fun cacheFile(name: String) = java.io.File(filesDir, name)

    private fun load() {
        // v1.5：两个请求并行（原来串行，隧道慢时打开要等双倍发现时间）
        Thread {
            val a = try { Api.courseAgg() } catch (_: Exception) { null }
            try { if (a != null) cacheFile("courses-cache.json").writeText(a.toString()) } catch (_: Exception) { }
            handler.post {
                if (isFinishing || isDestroyed) return@post
                if (a != null) { agg = a; fromCacheOnly = false; render() }
            }
        }.start()
        Thread {
            val d = try { Api.deadlines() } catch (_: Exception) { null }
            try { if (d != null) cacheFile("deadlines-cache.json").writeText(d.toString()) } catch (_: Exception) { }
            handler.post {
                if (isFinishing || isDestroyed) return@post
                if (d != null) { droot = d; render() }
            }
        }.start()
    }

    private fun renderLoading() {
        container.removeAllViews()
        container.addView(header())
        container.addView(Ui.text(this, "加载中…", 14, Ui.TEXT_SUB).apply { setPadding(Ui.dp(20), Ui.dp(12), Ui.dp(20), 0) })
    }

    private fun header(): View {
        val head = Ui.card(this)
        val title = if (currentCourse.isEmpty()) "📚 课程与作业" else "📚 $currentCourse"
        head.addView(Ui.text(this, title, 20, Ui.PRIMARY, true))
        head.addView(Ui.text(this, (if (currentCourse.isEmpty()) "点课程看总纲、待办和这门课的全部笔记" else "总纲 · 待办 · 笔记") + " · v" + Upd.VERSION_NAME, 12, Ui.TEXT_SUB))
        return head
    }

    private fun render() {
        container.removeAllViews()
        container.addView(header())

        if (currentCourse.isEmpty()) {
            renderRoot()
        } else {
            renderCourse()
        }
    }

    // ---------- 顶层：作业汇总 + 小助手倒计时 + 课程文件夹 ----------
    private fun renderRoot() {
        val list = agg?.optJSONArray("list")
        if (list == null) {
            container.addView(Ui.text(this, "待办和总纲要连上家里电脑才能看（素材和笔记不会丢）。连上 WiFi 打开 APP 会自动重试。", 13, Ui.ORANGE).apply { setPadding(Ui.dp(20), Ui.dp(12), Ui.dp(20), 0) })
        } else if (fromCacheOnly) {
            container.addView(Ui.text(this, "暂时连不上电脑，下面是上次同步的内容（连上后自动更新）。", 12, Ui.TEXT_SUB).apply { setPadding(Ui.dp(20), Ui.dp(8), Ui.dp(20), 0) })
            container.addView(homeworkCard(list))
        } else {
            container.addView(homeworkCard(list))
        }

        // 待办倒计时（v1.7：像小助手一样勾一下就消；过期的默认收起；最近勾掉的可撤销）
        val dcard = Ui.card(this)
        dcard.addView(Ui.text(this, "⏰ 待办（点 ☐ 完成，勾一下就消失）", 15, Ui.TEXT, true))
        val dr = droot
        if (dr == null) {
            dcard.addView(Ui.text(this, "连上家里电脑后和待办一起加载。", 12, Ui.TEXT_SUB))
        } else {
            val local = Api.localDone(this)
            val items = ArrayList<JSONObject>()
            val arr = dr.optJSONArray("items") ?: JSONArray()
            for (i in 0 until arr.length()) {
                val t = arr.getJSONObject(i)
                val rec = local.optJSONObject(t.optString("id"))
                if (rec != null && rec.optBoolean("done")) continue
                items.add(t)
            }
            if (items.isEmpty()) {
                dcard.addView(Ui.text(this, "暂无待办，很清净。", 12, Ui.TEXT_SUB))
            } else {
                for (t in items) {
                    val due = t.optString("due")
                    val sub = buildString {
                        if (t.optBoolean("urgent")) append("⚠ ")
                        if (due.isNotEmpty()) append("截止 $due")
                    }
                    dcard.addView(todoRow("dl:" + t.optString("id"), t.optString("title"), sub, false))
                }
            }
            // 已过期：默认收起（用户令：超截止日期的自动取消不再显示），留一行小入口兜底防日期抽错漏正事
            val ovArr = dr.optJSONArray("overdue") ?: JSONArray()
            val ovs = ArrayList<JSONObject>()
            for (i in 0 until ovArr.length()) {
                val t = ovArr.getJSONObject(i)
                val rec = local.optJSONObject("dl:" + t.optString("id"))
                if (rec != null && rec.optBoolean("done")) continue
                ovs.add(t)
            }
            if (ovs.isNotEmpty()) {
                val head = Ui.text(this, if (showOverdue) "▾ 已过期 ${ovs.size} 条（点收起）" else "▸ 已过期 ${ovs.size} 条（已自动取消，点开可看/可勾掉）", 12, Ui.RED)
                head.setPadding(0, Ui.dp(6), 0, 0)
                head.setOnClickListener { showOverdue = !showOverdue; render() }
                dcard.addView(head)
                if (showOverdue) {
                    for (t in ovs) {
                        dcard.addView(todoRow("dl:" + t.optString("id"), t.optString("title"),
                            "已过期 ${t.optString("due")}", true))
                    }
                }
            }
            // 最近勾掉的：点一下撤销（误勾保险）
            val rd = dr.optJSONArray("recentDone") ?: JSONArray()
            for (i in 0 until minOf(rd.length(), 3)) {
                val t = rd.getJSONObject(i)
                val fullId = "dl:" + t.optString("id")
                val rec = local.optJSONObject(fullId)
                if (rec != null && !rec.optBoolean("done")) continue   // 刚撤销的等下次刷新回来
                val u = Ui.text(this, "↩️ 刚勾掉：${t.optString("title")}（点撤销）", 11, Ui.TEXT_SUB)
                u.setPadding(0, Ui.dp(4), 0, 0)
                u.setOnClickListener { checkTodo(fullId, t.optString("title"), done = false) }
                dcard.addView(u)
            }
        }
        container.addView(dcard)

        // 课程文件夹
        val card = Ui.card(this)
        card.addView(Ui.text(this, "🗂 课程文件夹", 15, Ui.TEXT, true))
        var n = 0
        if (list != null) {
            for (i in 0 until list.length()) {
                val c = list.getJSONObject(i)
                val course = c.optString("course")
                val noteCnt = c.optJSONArray("notes")?.length() ?: 0
                val todoCnt = (c.optJSONArray("todos")?.length() ?: 0) + (c.optJSONArray("todosOverdue")?.length() ?: 0)
                card.addView(courseRow(course, "$noteCnt 篇笔记 · $todoCnt 条待办"))
                n++
            }
        }
        // 本地兜底：连不上电脑时也把手机里已缓存的课列出来
        if (n == 0) {
            val seen = LinkedHashSet<String>()
            val cached = Db.noteCacheList()
            for (i in 0 until cached.length()) seen.add(cached.getJSONObject(i).optString("course"))
            for (c in seen) if (c.isNotEmpty() && !c.contains("自测")) card.addView(courseRow(c, "本地缓存"))
            if (seen.isEmpty()) card.addView(Ui.text(this, "还没有课程。上完第一节课就会出现在这里。", 13, Ui.TEXT_SUB))
        }
        container.addView(card)
    }

    private fun courseRow(course: String, sub: String): View {
        val row = Ui.card(this)
        row.setPadding(Ui.dp(12), Ui.dp(10), Ui.dp(12), Ui.dp(10))
        row.addView(Ui.text(this, "📁 $course", 15, Ui.TEXT, true))
        row.addView(Ui.text(this, sub, 12, Ui.TEXT_SUB))
        row.setOnClickListener {
            startActivity(Intent(this, CourseActivity::class.java).putExtra("course", course))
        }
        val lp = row.layoutParams as LinearLayout.LayoutParams
        lp.topMargin = Ui.dp(6)
        return row
    }

    // ---------- 待办勾选（v1.7：勾一下就消） ----------

    /** 一条可勾选的待办行：☐ + 标题 + 小字说明；点 ☐ 本地立即消失，后台回传电脑 */
    private fun todoRow(id: String, title: String, sub: String, overdue: Boolean): View {
        val row = LinearLayout(this)
        row.orientation = LinearLayout.HORIZONTAL
        row.setPadding(Ui.dp(2), Ui.dp(3), Ui.dp(2), Ui.dp(3))
        val box = Ui.text(this, "☐", 20, if (overdue) Ui.RED else Ui.PRIMARY, true)
        box.setPadding(Ui.dp(6), Ui.dp(0), Ui.dp(10), Ui.dp(0))
        box.setOnClickListener { checkTodo(id, title, done = true) }
        row.addView(box)
        val col = LinearLayout(this)
        col.orientation = LinearLayout.VERTICAL
        col.addView(Ui.text(this, title, 13, if (overdue) Ui.RED else Ui.TEXT))
        if (sub.isNotEmpty()) col.addView(Ui.text(this, sub, 11, Ui.TEXT_SUB))
        row.addView(col, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        return row
    }

    /** 勾掉/撤销一条：先本地生效（列表立即少一条/回来），后台推服务端；连不上不丢（记账，同步时补推） */
    private fun checkTodo(id: String, title: String, done: Boolean) {
        Api.setLocalDone(this, id, done, title)
        render()
        Thread {
            val ok = Api.deadlineDone(id, done, title)
            if (ok) Api.clearLocalDone(this, id)
            handler.post {
                if (isFinishing || isDestroyed) return@post
                if (!ok) Ui.toast(this, if (done) "已记在手机，连上电脑后自动同步" else "撤销已记在手机，连上电脑后自动同步")
                if (!done) load()   // 撤销后拉一次最新列表让它尽快回到列表里
            }
        }.start()
    }

    /** 作业汇总：各科待办按 短期作业 / 长期作业 / 通知与活动 三类聚合（v1.7 每条可勾掉） */
    private fun homeworkCard(list: JSONArray): View {
        val card = Ui.card(this)
        card.addView(Ui.text(this, "📝 作业汇总（各科，点 ☐ 完成）", 15, Ui.TEXT, true))
        val local = Api.localDone(this)
        val shortTerm = ArrayList<JSONObject>()
        val longTerm = ArrayList<JSONObject>()
        val acts = ArrayList<JSONObject>()
        val ovs = ArrayList<JSONObject>()
        for (i in 0 until list.length()) {
            val c = list.getJSONObject(i)
            val course = c.optString("course")
            for (arrName in listOf("todos", "todosOverdue")) {
                val todos = c.optJSONArray(arrName) ?: continue
                for (j in 0 until todos.length()) {
                    val t = todos.getJSONObject(j)
                    val rec = local.optJSONObject(t.optString("id"))
                    if (rec != null && rec.optBoolean("done")) continue
                    t.put("_course", course)
                    if (arrName == "todosOverdue") { ovs.add(t); continue }
                    when (t.optString("category")) {
                        "作业", "考试" -> if (t.optString("due").isNotEmpty()) shortTerm.add(t) else longTerm.add(t)
                        "比赛", "社团" -> acts.add(t)
                        else -> longTerm.add(t)
                    }
                }
            }
        }
        fun section(name: String, items: List<JSONObject>, color: Int) {
            card.addView(Ui.text(this, "$name（${items.size}）", 13, color, true).apply { setPadding(0, Ui.dp(8), 0, Ui.dp(2)) })
            if (items.isEmpty()) {
                card.addView(Ui.text(this, "  暂无", 12, Ui.TEXT_SUB))
                return
            }
            for (t in items.sortedBy { it.optString("due") }) {
                val due = t.optString("due")
                card.addView(todoRow(t.optString("id"), t.optString("title"),
                    t.optString("_course") + if (due.isNotEmpty()) " · 截止 $due" else "", overdue = false))
            }
        }
        section("⏰ 短期作业", shortTerm, Ui.RED)
        section("📅 长期作业", longTerm, Ui.ORANGE)
        section("🎯 通知与活动", acts, Ui.GREEN)
        if (ovs.isNotEmpty()) {
            val head = Ui.text(this, if (showOverdueTodo) "▾ 已过期 ${ovs.size} 条（点收起）" else "▸ 已过期 ${ovs.size} 条（已自动取消，点开可看/可勾掉）", 12, Ui.RED)
            head.setPadding(0, Ui.dp(8), 0, 0)
            head.setOnClickListener { showOverdueTodo = !showOverdueTodo; render() }
            card.addView(head)
            if (showOverdueTodo) {
                for (t in ovs.sortedBy { it.optString("due") }) {
                    card.addView(todoRow(t.optString("id"), t.optString("title"),
                        t.optString("_course") + " · 已过期 " + t.optString("due"), overdue = true))
                }
            }
        }
        return card
    }

    // ---------- 课程内：总纲 + 待办 + 笔记 ----------
    private fun renderCourse() {
        val list = agg?.optJSONArray("list")
        var mine: JSONObject? = null
        if (list != null) {
            for (i in 0 until list.length()) {
                if (list.getJSONObject(i).optString("course") == currentCourse) { mine = list.getJSONObject(i); break }
            }
        }

        // 总纲
        val gzCard = Ui.card(this)
        gzCard.addView(Ui.text(this, "📌 课程总纲", 15, Ui.TEXT, true))
        gzCard.addView(Ui.text(this, "存在手机里，点开秒开；联网时自动核对更新", 12, Ui.TEXT_SUB))
        val gzBtn = Ui.button(this, "打开总纲", false)
        gzBtn.layoutParams = (LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)).also { it.topMargin = Ui.dp(6) }
        gzBtn.setOnClickListener { openOverview() }
        gzCard.addView(gzBtn)
        container.addView(gzCard)

        // 例题汇总开关（v1.6）：这门课以后的每篇笔记末尾自动多一节「🧮 例题汇总」
        val exCard = Ui.card(this)
        exCard.addView(Ui.text(this, "🧮 例题汇总", 15, Ui.TEXT, true))
        val exOn = examplesOn(currentCourse)
        exCard.addView(Ui.text(this,
            if (exOn) "已开启：这门课以后的每篇笔记末尾，AI 会把这节课讲的例题整理成一节（题目 · 思路 · 答案 · 时间点），课下复习直接看它。"
            else "没开。开启后，这门课以后的每篇笔记末尾会多一节「例题汇总」，把课上讲的例题列出来方便复习；只影响以后的笔记，已出的不变。",
            12, Ui.TEXT_SUB))
        val exBtn = Ui.button(this, if (exOn) "✅ 已开启（点我关掉）" else "开启例题汇总", !exOn)
        exBtn.layoutParams = (LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)).also { it.topMargin = Ui.dp(6) }
        exBtn.setOnClickListener { toggleExamples(exOn) }
        exCard.addView(exBtn)
        container.addView(exCard)

        // 待办（v1.7：点 ☐ 完成，勾一下就消失；过期默认收起）
        val todoCard = Ui.card(this)
        todoCard.addView(Ui.text(this, "📋 待办（点 ☐ 完成）", 15, Ui.TEXT, true))
        val todos = mine?.optJSONArray("todos")
        if (todos == null && mine == null) {
            todoCard.addView(Ui.text(this, "要连上家里电脑才能看待办。", 13, Ui.ORANGE))
        } else {
            val local = Api.localDone(this)
            fun visible(t: JSONObject): Boolean {
                val rec = local.optJSONObject(t.optString("id"))
                return !(rec != null && rec.optBoolean("done"))
            }
            val shortTerm = ArrayList<JSONObject>(); val longTerm = ArrayList<JSONObject>(); val acts = ArrayList<JSONObject>()
            val ovs = ArrayList<JSONObject>()
            for (j in 0 until (todos?.length() ?: 0)) {
                val t = todos!!.getJSONObject(j)
                if (!visible(t)) continue
                when (t.optString("category")) {
                    "作业", "考试" -> if (t.optString("due").isNotEmpty()) shortTerm.add(t) else longTerm.add(t)
                    "比赛", "社团" -> acts.add(t)
                    else -> longTerm.add(t)
                }
            }
            val ovArr = mine?.optJSONArray("todosOverdue")
            for (j in 0 until (ovArr?.length() ?: 0)) {
                val t = ovArr!!.getJSONObject(j)
                if (visible(t)) ovs.add(t)
            }
            if (shortTerm.isEmpty() && longTerm.isEmpty() && acts.isEmpty() && ovs.isEmpty()) {
                todoCard.addView(Ui.text(this, "这门课暂无待办。", 13, Ui.TEXT_SUB))
            } else {
                fun sec(name: String, items: List<JSONObject>, color: Int) {
                    if (items.isEmpty()) return
                    todoCard.addView(Ui.text(this, name, 13, color, true).apply { setPadding(0, Ui.dp(6), 0, Ui.dp(2)) })
                    for (t in items.sortedBy { it.optString("due") }) {
                        val due = t.optString("due")
                        todoCard.addView(todoRow(t.optString("id"), t.optString("title"),
                            if (due.isNotEmpty()) "截止 $due" else "", overdue = false))
                    }
                }
                sec("⏰ 短期作业", shortTerm, Ui.RED)
                sec("📅 长期作业", longTerm, Ui.ORANGE)
                sec("🎯 通知与活动", acts, Ui.GREEN)
                if (ovs.isNotEmpty()) {
                    val head = Ui.text(this, if (showOverdueTodo) "▾ 已过期 ${ovs.size} 条（点收起）" else "▸ 已过期 ${ovs.size} 条（已自动取消，点开可看/可勾掉）", 12, Ui.RED)
                    head.setPadding(0, Ui.dp(6), 0, 0)
                    head.setOnClickListener { showOverdueTodo = !showOverdueTodo; render() }
                    todoCard.addView(head)
                    if (showOverdueTodo) {
                        for (t in ovs.sortedBy { it.optString("due") }) {
                            todoCard.addView(todoRow(t.optString("id"), t.optString("title"),
                                "已过期 " + t.optString("due"), overdue = true))
                        }
                    }
                }
            }
        }
        container.addView(todoCard)

        // 笔记（本地缓存，离线可用）
        val noteCard = Ui.card(this)
        noteCard.addView(Ui.text(this, "📒 这门课的笔记", 15, Ui.TEXT, true))
        val cached = Db.noteCacheList()
        var cnt = 0
        for (i in 0 until cached.length()) {
            val n = cached.getJSONObject(i)
            if (n.optString("course") != currentCourse) continue
            cnt++
            val state = n.optString("state")
            val (badge, color) = when (state) {
                "done" -> "✅" to Ui.GREEN
                "error" -> "⚠️" to Ui.RED
                else -> "⏳" to Ui.ORANGE
            }
            val row = Ui.card(this)
            row.setPadding(Ui.dp(12), Ui.dp(8), Ui.dp(12), Ui.dp(8))
            row.addView(Ui.text(this, n.optString("title").ifEmpty { currentCourse }, 14, Ui.TEXT, true))
            row.addView(Ui.text(this, badge, 12, color))
            row.setOnClickListener { startActivity(Intent(this, NoteActivity::class.java).putExtra("sid", n.optString("sid"))) }
            val lp = row.layoutParams as LinearLayout.LayoutParams
            lp.topMargin = Ui.dp(6)
            noteCard.addView(row)
        }
        if (cnt == 0) noteCard.addView(Ui.text(this, "这门课的笔记还没同步到手机，回家里 WiFi 打开 APP 会自动下。", 13, Ui.TEXT_SUB))
        container.addView(noteCard)
    }

    // ---------- 总纲（存手机秒开，后台核对更新） ----------
    private fun overviewFile(course: String): File = File(File(filesDir, "overviews"), course + ".html")

    // ---------- 例题汇总开关（v1.6） ----------
    /** 开关状态：手机本地（meta ex_<课程>）是真相源；本地没设过的课，用服务端下发的值补上（换机/重装不丢设置） */
    private fun examplesOn(course: String): Boolean {
        val local = Db.meta("ex_$course")
        if (local == "1" || local == "0") return local == "1"
        val srv = agg?.optJSONObject("examples")?.optBoolean(course)
        if (srv != null) Db.setMeta("ex_$course", if (srv) "1" else "0")
        return srv == true
    }

    /** 切换开关：先落本地（立刻生效于显示），后台推给电脑；连不上电脑也不丢——下次同步会自动补推 */
    private fun toggleExamples(nowOn: Boolean) {
        Db.setMeta("ex_$currentCourse", if (nowOn) "0" else "1")
        render()
        Thread {
            val prefs = Api.examplePrefs()
            val ok = Api.pushCourseConfig(prefs)
            handler.post {
                if (isFinishing || isDestroyed) return@post
                Ui.toast(this, when {
                    ok && !nowOn -> "已开启！这门课以后的笔记都会带「例题汇总」"
                    ok -> "已关闭。以后的笔记不再带「例题汇总」"
                    else -> "设置已存手机，暂时连不上电脑（连上后自动同步）"
                })
            }
        }.start()
    }

    private fun openOverview() {
        val back = Ui.button(this, "← 返回 $currentCourse", false)
        back.setOnClickListener { setContentView(Ui.scroll(this, container)); render() }
        val status = Ui.text(this, "总纲打开中…", 13, Ui.TEXT_SUB).apply { setPadding(Ui.dp(20), Ui.dp(12), Ui.dp(20), 0) }
        val box = LinearLayout(this)
        box.orientation = LinearLayout.VERTICAL
        box.background = Ui.glowBg()
        box.addView(back)
        box.addView(status)
        setContentView(box)

        val cached = overviewFile(currentCourse)
        var wv: WebView? = null
        fun show(html: String) {
            if (wv == null) {
                val w = WebView(this)
                w.settings.javaScriptEnabled = false
                w.settings.allowFileAccess = true
                w.settings.builtInZoomControls = true
                w.settings.displayZoomControls = false
                w.setBackgroundColor(Color.WHITE)
                w.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
                        if (url.startsWith("http")) {
                            try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: Exception) { }
                            return true
                        }
                        return false
                    }
                }
                box.addView(w, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
                wv = w
            }
            wv!!.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
        }

        if (cached.exists()) {
            show(cached.readText(Charsets.UTF_8))
            status.text = "已用手机缓存秒开，正在核对有没有更新…"
        }

        Thread {
            val have = Db.meta("ovMd_$currentCourse").toLongOrNull() ?: 0L
            val r = Api.overview(currentCourse, have)
            handler.post {
                if (isFinishing || isDestroyed) return@post
                if (r == null) {
                    status.text = if (cached.exists()) "手机里这份就是最新拿到的（现在连不上电脑，没法核对更新）。"
                                  else "总纲第一次要先连上家里电脑生成（每节课整理笔记时自动写），连上后重进本页再试。"
                    return@post
                }
                if (r.optBoolean("unchanged")) {
                    status.text = "总纲已是最新 ✓"
                    handler.postDelayed({ box.removeView(status) }, 1200)
                    return@post
                }
                val html = r.optString("html")
                if (html.isEmpty()) {
                    status.text = if (cached.exists()) "电脑返回了空总纲，继续用手机里这份。"
                                  else "电脑上还没有这门课的总纲（每节课整理笔记时自动写）。"
                    return@post
                }
                cached.parentFile?.mkdirs()
                cached.writeText(html, Charsets.UTF_8)
                if (r.optLong("mdTime") > 0) Db.setMeta("ovMd_$currentCourse", r.optLong("mdTime").toString())
                show(html)
                box.removeView(status)
            }
        }.start()
    }

    override fun onBackPressed() {
        if (currentCourse.isNotEmpty()) {
            currentCourse = ""
            setContentView(Ui.scroll(this, container))
            render()
        } else {
            super.onBackPressed()
        }
    }
}
