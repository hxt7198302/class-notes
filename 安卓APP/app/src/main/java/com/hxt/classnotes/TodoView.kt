package com.hxt.classnotes

import android.app.Activity
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * v2.0「待办」标签页：作业汇总（短期/长期/通知与活动）+ 待办倒计时 + 课程文件夹。
 * 逻辑从 CourseActivity 顶层原样搬来（缓存秒开、联网增量刷新、勾选即消、过期折叠、撤销），
 * 只是外壳从独立页面变成底栏的一页；课程文件夹点进去仍走 CourseActivity 看总纲/笔记。
 */
class TodoView(private val act: Activity) : LinearLayout(act) {
    private val handler = Handler(Looper.getMainLooper())
    private var agg: JSONObject? = null
    private var droot: JSONObject? = null
    private var fromCacheOnly = false
    private var showOverdue = false
    private var showOverdueTodo = false
    private var lastLoadAt = 0L

    /** 待办角标数量回调（只算未过期、未勾掉的 deadlines 条目） */
    var onCount: ((Int) -> Unit)? = null

    init {
        orientation = VERTICAL
        setPadding(Ui.dp(12), Ui.dp(4), Ui.dp(12), Ui.dp(24))
        loadCached()
    }

    private fun cacheFile(name: String) = File(act.filesDir, name)

    private fun loadCached() {
        agg = try { JSONObject(cacheFile("courses-cache.json").readText()) } catch (_: Exception) { null }
        droot = try {
            val t = cacheFile("deadlines-cache.json").readText()
            try { JSONObject(t) } catch (_: Exception) { JSONObject().put("items", JSONArray(t)) }
        } catch (_: Exception) { null }
        fromCacheOnly = agg != null || droot != null
        render()
    }

    /** 联网刷新（15 秒内重复调用直接跳过，避免切页/回前台连打） */
    fun load(force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && now - lastLoadAt < 15_000) return
        lastLoadAt = now
        Thread {
            val a = try { Api.courseAgg() } catch (_: Exception) { null }
            if (a != null) try { cacheFile("courses-cache.json").writeText(a.toString()) } catch (_: Exception) { }
            handler.post {
                if (act.isFinishing || act.isDestroyed) return@post
                if (a != null) { agg = a; fromCacheOnly = false; render() }
            }
        }.start()
        Thread {
            val d = try { Api.deadlines() } catch (_: Exception) { null }
            if (d != null) try { cacheFile("deadlines-cache.json").writeText(d.toString()) } catch (_: Exception) { }
            handler.post {
                if (act.isFinishing || act.isDestroyed) return@post
                if (d != null) { droot = d; render() }
            }
        }.start()
    }

    private fun render() {
        removeAllViews()

        // 页头
        val head = Ui.card(act)
        head.addView(Ui.text(act, "⏰ 待办", 20, Ui.PRIMARY, true))
        head.addView(Ui.text(act, "作业、截止日期、课程都在这里；点 ☐ 勾掉，勾一下就消失", 12, Ui.TEXT_SUB))
        addView(head)

        // v2.11 学习通入口：底栏「待办」页顶部（CourseActivity 顶层也留了一份，两条路都能进）
        addView(chaoxingCard())

        val list = agg?.optJSONArray("list")
        if (list == null) {
            addView(Ui.text(act, "待办和总纲要连上家里电脑才能看（素材和笔记不会丢）。连上 WiFi 打开 APP 会自动重试。",
                13, Ui.ORANGE).apply { setPadding(Ui.dp(8), Ui.dp(12), Ui.dp(8), 0) })
        } else {
            if (fromCacheOnly) {
                addView(Ui.text(act, "暂时连不上电脑，下面是上次同步的内容（连上后自动更新）。",
                    12, Ui.TEXT_SUB).apply { setPadding(Ui.dp(8), Ui.dp(8), Ui.dp(8), 0) })
            }
            addView(homeworkCard(list))
        }

        addView(deadlineCard())

        // 课程文件夹
        val card = Ui.card(act)
        card.addView(Ui.text(act, "🗂 课程文件夹", 15, Ui.TEXT, true))
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
        if (n == 0) {
            val seen = LinkedHashSet<String>()
            val cached = Db.noteCacheList()
            for (i in 0 until cached.length()) seen.add(cached.getJSONObject(i).optString("course"))
            for (c in seen) if (c.isNotEmpty() && !c.contains("自测")) card.addView(courseRow(c, "本地缓存"))
            if (seen.isEmpty()) card.addView(Ui.text(act, "还没有课程。上完第一节课就会出现在这里。", 13, Ui.TEXT_SUB))
        }
        addView(card)

        onCount?.invoke(pendingCount())
    }

    private fun pendingCount(): Int {
        val dr = droot ?: return 0
        val local = Api.localDone(act)
        val arr = dr.optJSONArray("items") ?: return 0
        var n = 0
        for (i in 0 until arr.length()) {
            val t = arr.getJSONObject(i)
            val rec = local.optJSONObject(t.optString("id"))
            if (rec == null || !rec.optBoolean("done")) n++
        }
        return n
    }

    /** v2.11 学习通入口卡：有本地缓存就显示上次的计数（不发网络请求，秒开） */
    private fun chaoxingCard(): View {
        val card = Ui.card(act)
        val row = LinearLayout(act)
        row.orientation = LinearLayout.HORIZONTAL
        val col = LinearLayout(act)
        col.orientation = LinearLayout.VERTICAL
        col.addView(Ui.text(act, "📖 学习通", 15, Ui.TEXT, true))
        var sub = "扫码登录后看作业 / 通知 / 考试 / 章节进度"
        try {
            val f = File(act.filesDir, "chaoxing-cache.json")
            if (f.exists() && f.length() > 0) {
                val s = JSONObject(f.readText(Charsets.UTF_8))
                    .optJSONObject("data")?.optJSONObject("summary")
                if (s != null) {
                    sub = "未交 ${s.optInt("pending")} · 待互评 ${s.optInt("peer")} · 未读通知 ${s.optInt("unread")}"
                }
            }
        } catch (_: Exception) { }
        col.addView(Ui.text(act, sub, 12, Ui.TEXT_SUB))
        row.addView(col, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(Ui.text(act, "›", 22, Ui.PRIMARY))
        card.addView(row)
        card.setOnClickListener { act.startActivity(Intent(act, ChaoxingActivity::class.java)) }
        return card
    }

    private fun courseRow(course: String, sub: String): View {
        val row = Ui.card(act)
        row.setPadding(Ui.dp(12), Ui.dp(10), Ui.dp(12), Ui.dp(10))
        row.addView(Ui.text(act, "📁 $course", 15, Ui.TEXT, true))
        row.addView(Ui.text(act, sub, 12, Ui.TEXT_SUB))
        row.setOnClickListener {
            act.startActivity(Intent(act, CourseActivity::class.java).putExtra("course", course))
        }
        val lp = row.layoutParams as LinearLayout.LayoutParams
        lp.topMargin = Ui.dp(6)
        return row
    }

    // ---------- 待办倒计时 ----------
    private fun deadlineCard(): View {
        val dcard = Ui.card(act)
        dcard.addView(Ui.text(act, "⏰ 待办（点 ☐ 完成，勾一下就消失）", 15, Ui.TEXT, true))
        val dr = droot
        if (dr == null) {
            dcard.addView(Ui.text(act, "连上家里电脑后和作业一起加载。", 12, Ui.TEXT_SUB))
            return dcard
        }
        val local = Api.localDone(act)
        val items = ArrayList<JSONObject>()
        val arr = dr.optJSONArray("items") ?: JSONArray()
        for (i in 0 until arr.length()) {
            val t = arr.getJSONObject(i)
            val rec = local.optJSONObject(t.optString("id"))
            if (rec != null && rec.optBoolean("done")) continue
            items.add(t)
        }
        if (items.isEmpty()) {
            dcard.addView(Ui.text(act, "暂无待办，很清净。", 12, Ui.TEXT_SUB))
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
        // 已过期：默认收起（防 AI 抽错日期静默吞正事）
        val ovArr = dr.optJSONArray("overdue") ?: JSONArray()
        val ovs = ArrayList<JSONObject>()
        for (i in 0 until ovArr.length()) {
            val t = ovArr.getJSONObject(i)
            val rec = local.optJSONObject("dl:" + t.optString("id"))
            if (rec != null && rec.optBoolean("done")) continue
            ovs.add(t)
        }
        if (ovs.isNotEmpty()) {
            val head = Ui.text(act, if (showOverdue) "▾ 已过期 ${ovs.size} 条（点收起）"
            else "▸ 已过期 ${ovs.size} 条（已自动取消，点开可看/可勾掉）", 12, Ui.RED)
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
            if (rec != null && !rec.optBoolean("done")) continue
            val u = Ui.text(act, "↩️ 刚勾掉：${t.optString("title")}（点撤销）", 11, Ui.TEXT_SUB)
            u.setPadding(0, Ui.dp(4), 0, 0)
            u.setOnClickListener { checkTodo(fullId, t.optString("title"), done = false) }
            dcard.addView(u)
        }
        return dcard
    }

    // ---------- 作业汇总 ----------
    private fun homeworkCard(list: JSONArray): View {
        val card = Ui.card(act)
        card.addView(Ui.text(act, "📝 作业汇总（各科，点 ☐ 完成）", 15, Ui.TEXT, true))
        val local = Api.localDone(act)
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
            card.addView(Ui.text(act, "$name（${items.size}）", 13, color, true).apply {
                setPadding(0, Ui.dp(8), 0, Ui.dp(2))
            })
            if (items.isEmpty()) {
                card.addView(Ui.text(act, "  暂无", 12, Ui.TEXT_SUB))
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
            val head = Ui.text(act, if (showOverdueTodo) "▾ 已过期 ${ovs.size} 条（点收起）"
            else "▸ 已过期 ${ovs.size} 条（已自动取消，点开可看/可勾掉）", 12, Ui.RED)
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

    private fun todoRow(id: String, title: String, sub: String, overdue: Boolean): View {
        val row = LinearLayout(act)
        row.orientation = LinearLayout.HORIZONTAL
        row.setPadding(Ui.dp(2), Ui.dp(3), Ui.dp(2), Ui.dp(3))
        val box = Ui.text(act, "☐", 20, if (overdue) Ui.RED else Ui.PRIMARY, true)
        box.setPadding(Ui.dp(6), 0, Ui.dp(10), 0)
        box.setOnClickListener { checkTodo(id, title, done = true) }
        row.addView(box)
        val col = LinearLayout(act)
        col.orientation = LinearLayout.VERTICAL
        col.addView(Ui.text(act, title, 13, if (overdue) Ui.RED else Ui.TEXT))
        if (sub.isNotEmpty()) col.addView(Ui.text(act, sub, 11, Ui.TEXT_SUB))
        row.addView(col, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        return row
    }

    /** 勾掉/撤销：先本地生效，后台推服务端；连不上记账，下次同步补推 */
    private fun checkTodo(id: String, title: String, done: Boolean) {
        Api.setLocalDone(act, id, done, title)
        render()
        Thread {
            val ok = Api.deadlineDone(id, done, title)
            if (ok) Api.clearLocalDone(act, id)
            handler.post {
                if (act.isFinishing || act.isDestroyed) return@post
                if (!ok) Ui.toast(act, if (done) "已记在手机，连上电脑后自动同步" else "撤销已记在手机，连上电脑后自动同步")
                if (!done) load(force = true)
            }
        }.start()
    }
}
