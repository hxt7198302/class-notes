package com.hxt.classnotes

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * v2.1 笔记页：搜索 + 课程筛选 + 「笔记 / 课堂记录」分段 + 富卡片列表。
 *
 * 设计稿：设计稿/v2.1-质感方向/笔记页面设计稿.png 第 1/2 屏。
 * - 笔记卡：课程色点 + 标题 + 两行摘要 + 时长/板书数 + 封面缩略图，按日期分组；
 * - 课堂记录：按「课程 + 日期」分组，整组上传 / 长按作废，和 v2.0 逻辑一致；
 * - 摘要和封面直接从已下载的 note.html 里提取，老笔记不用重新生成。
 */
class NotesView(private val act: Activity) : LinearLayout(act) {

    var onRequestSync: (() -> Unit)? = null

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var countText: TextView
    private lateinit var search: EditText
    private lateinit var segNotes: TextView
    private lateinit var segSessions: TextView
    private lateinit var chipRow: LinearLayout
    private lateinit var listBox: LinearLayout

    private var segment = 0          // 0=笔记 1=课堂记录
    private var courseFilter = ""
    private var query = ""
    private var pendingRefresh: Runnable? = null

    private data class NoteMeta(
        val summary: String, val cover: File?, val photos: Int, val stamp: Long,
        val error: String = "", val points: Int = 0, val doubts: Int = 0, val quotes: Int = 0
    )
    private data class NoteRow(
        val sid: String, val course: String, val title: String, val state: String,
        val day: String, val time: String, val durMs: Long, val summary: String,
        val aiSummary: String, val points: Int, val doubts: Int, val quotes: Int,
        val cover: File?, val photos: Int, val error: String
    )
    private data class SessionGroup(
        val course: String, val dayIso: String, val items: List<JSONObject>,
        val startedAt: Long, val totalMs: Long, val nReady: Int, val recording: Boolean, val uploading: Boolean
    )

    private val metaCache = ConcurrentHashMap<String, NoteMeta>()
    private val metaLoading = ConcurrentHashMap.newKeySet<String>()
    private val thumbCache = android.util.LruCache<String, Bitmap>(8 * 1024 * 1024)
    private val dayFmt = SimpleDateFormat("yyyyMMdd", Locale.CHINA)
    private val isoFmt = SimpleDateFormat("yyyy-MM-dd", Locale.CHINA)
    private val labelFmt = SimpleDateFormat("M月d日", Locale.CHINA)
    private val weekFmt = SimpleDateFormat("M月d日 EEEE", Locale.CHINA)
    private val hmFmt = SimpleDateFormat("HH:mm", Locale.CHINA)

    init {
        orientation = VERTICAL
        setPadding(Ui.dp(12), Ui.dp(4), Ui.dp(12), 0)
        buildStatic()
        refresh()
    }

    // ---------- 固定头部：标题 / 搜索 / 分段 / 课程筛选 ----------
    private fun buildStatic() {
        val head = LinearLayout(act)
        head.orientation = HORIZONTAL
        head.gravity = Gravity.CENTER_VERTICAL
        head.setPadding(Ui.dp(4), Ui.dp(6), Ui.dp(4), Ui.dp(2))
        head.addView(Ui.text(act, "📒 笔记", 22, Ui.PRIMARY, true))
        countText = Ui.text(act, "", 12, Ui.TEXT_SUB)
        val countLp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        countLp.leftMargin = Ui.dp(8)
        head.addView(countText, countLp)
        val sync = Ui.text(act, "⟳ 同步", 13, Ui.PRIMARY, true)
        sync.setPadding(Ui.dp(8), Ui.dp(6), Ui.dp(8), Ui.dp(6))
        sync.setOnClickListener { onRequestSync?.invoke() }
        head.addView(sync)
        // v2.3：一键体检并补传旧版上传写坏的录音（自动修复之外的兜底入口）
        val fix = Ui.text(act, "🛠 修复坏课", 13, Ui.PRIMARY, true)
        fix.isSingleLine = true
        fix.setPadding(Ui.dp(4), Ui.dp(6), Ui.dp(2), Ui.dp(6))
        fix.setOnClickListener { Repair.manual(act) { onRequestSync?.invoke() } }
        head.addView(fix)
        addView(head)

        // 搜索
        val searchBox = LinearLayout(act)
        searchBox.orientation = HORIZONTAL
        searchBox.gravity = Gravity.CENTER_VERTICAL
        searchBox.background = Glass.cardBg(Glass.THIN, 16)
        searchBox.setPadding(Ui.dp(12), 0, Ui.dp(12), 0)
        val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(42))
        lp.topMargin = Ui.dp(4)
        addView(searchBox, lp)
        searchBox.addView(Ui.text(act, "🔍", 14, Ui.TEXT_SUB).apply { setPadding(0, 0, Ui.dp(6), 0) })
        search = EditText(act)
        search.hint = "搜索课程 / 标题 / 内容"
        search.textSize = Ui.sp(14)
        search.setTextColor(Ui.TEXT)
        search.setHintTextColor(Ui.TEXT_SUB)
        search.background = null
        search.gravity = Gravity.CENTER_VERTICAL
        search.isSingleLine = true
        search.setPadding(0, 0, 0, 0)
        searchBox.addView(search, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                query = s?.toString() ?: ""
                pendingRefresh?.let { handler.removeCallbacks(it) }
                val r = Runnable { refreshList() }
                pendingRefresh = r
                handler.postDelayed(r, 120)
            }
        })

        // 分段：笔记 / 课堂记录
        val segBox = LinearLayout(act)
        segBox.orientation = HORIZONTAL
        segBox.background = Glass.cardBg(Glass.THIN, 15)
        segBox.setPadding(Ui.dp(3), Ui.dp(3), Ui.dp(3), Ui.dp(3))
        val segLp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        segLp.topMargin = Ui.dp(10)
        addView(segBox, segLp)
        segNotes = segText("笔记")
        segSessions = segText("课堂记录")
        segNotes.setOnClickListener { setSegment(0) }
        segSessions.setOnClickListener { setSegment(1) }
        segBox.addView(segNotes, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        segBox.addView(segSessions, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

        val hs = HorizontalScrollView(act)
        hs.isHorizontalScrollBarEnabled = false
        hs.clipToPadding = false
        chipRow = LinearLayout(act)
        chipRow.orientation = HORIZONTAL
        chipRow.setPadding(0, Ui.dp(8), 0, Ui.dp(2))
        hs.addView(chipRow)
        addView(hs, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        val scroll = ScrollView(act)
        scroll.isFillViewport = true
        scroll.clipToPadding = false
        listBox = LinearLayout(act)
        listBox.orientation = VERTICAL
        listBox.setPadding(0, Ui.dp(2), 0, Ui.dp(28))
        scroll.addView(listBox)
        addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        applySegment()
    }

    private fun segText(label: String): TextView {
        val t = TextView(act)
        t.text = label
        t.gravity = Gravity.CENTER
        t.textSize = Ui.sp(14)
        t.setPadding(0, Ui.dp(8), 0, Ui.dp(8))
        t.setTextColor(Ui.TEXT_SUB)
        Ui.pressable(t, 0.97f)
        return t
    }

    private fun setSegment(i: Int) {
        if (segment == i) return
        segment = i
        applySegment()
        refreshList()
    }

    private fun applySegment() {
        for (i in 0..1) {
            val on = i == segment
            val t = if (i == 0) segNotes else segSessions
            t.background = if (on) Glass.cardBg(Glass.THICK, 13) else null
            t.setTextColor(if (on) Ui.PRIMARY else Ui.TEXT_SUB)
            t.setTypeface(null, if (on) Typeface.BOLD else Typeface.NORMAL)
        }
    }

    // ---------- 公开刷新 ----------
    fun refresh() {
        refreshChips()
        refreshList()
        preloadMetaAsync()
    }

    /**
     * 摘要/封面/缩略图在后台读：首屏先用缓存出卡片，读完再补一遍。
     * 主线程不读 note.html、不解大图，保证切换标签和滚动不卡。
     */
    private fun preloadMetaAsync() {
        val notes = Db.noteCacheList()
        val pending = ArrayList<String>()
        for (i in 0 until notes.length()) {
            val sid = notes.getJSONObject(i).optString("sid")
            if (sid.isEmpty()) continue
            val html = File(File(File(act.filesDir, "notes"), sid), "note.html")
            if (!html.exists()) continue
            val old = metaCache[sid]
            if (old != null && old.stamp == html.lastModified()) continue
            if (metaLoading.add(sid)) pending.add(sid)
        }
        if (pending.isEmpty()) return
        Thread {
            for (sid in pending) {
                try { computeMeta(sid) } catch (_: Exception) { } finally { metaLoading.remove(sid) }
            }
            handler.post {
                if (!act.isFinishing && !act.isDestroyed) refreshList()
            }
        }.start()
    }

    private fun refreshChips() {
        val courses = LinkedHashSet<String>()
        Db.courses().forEach { courses.add(it) }
        val notes = Db.noteCacheList()
        for (i in 0 until notes.length()) {
            val c = notes.getJSONObject(i).optString("course")
            if (c.isNotEmpty()) courses.add(c)
        }
        val sess = Db.sessions(200)
        for (i in 0 until sess.length()) {
            val s = sess.getJSONObject(i)
            if (s.optString("state") == "cancelled") continue
            val c = s.optString("course")
            if (c.isNotEmpty()) courses.add(c)
        }
        if (courseFilter.isNotEmpty() && !courses.contains(courseFilter)) courseFilter = ""

        chipRow.removeAllViews()
        chipRow.addView(filterChip("全部", courseFilter.isEmpty()) {
            courseFilter = ""
            refreshChips(); refreshList()
        })
        for (c in courses) {
            chipRow.addView(filterChip(c, courseFilter == c) {
                courseFilter = c
                refreshChips(); refreshList()
            })
        }
    }

    private fun filterChip(label: String, on: Boolean, onClick: () -> Unit): TextView {
        val t = Ui.chip(act, label)
        if (on) {
            t.background = Glass.primaryBg(999)
            t.setTextColor(Ui.ON_PRIMARY)
            t.setTypeface(null, Typeface.BOLD)
        } else {
            t.setTextColor(Ui.TEXT)
        }
        t.setOnClickListener { onClick() }
        return t
    }

    private fun refreshList() {
        listBox.removeAllViews()
        val q = query.trim().lowercase(Locale.getDefault())
        if (segment == 0) renderNotes(q) else renderSessions(q)
    }

    // ---------- 笔记列表 ----------
    private fun renderNotes(q: String) {
        val notes = Db.noteCacheList()
        val durations = sessionDurations()
        val rows = ArrayList<NoteRow>()
        for (i in 0 until notes.length()) {
            val n = notes.getJSONObject(i)
            val course = n.optString("course")
            if (courseFilter.isNotEmpty() && course != courseFilter) continue
            val sid = n.optString("sid")
            val title = n.optString("title").ifEmpty { course.ifEmpty { "课堂笔记" } }
            val meta = metaOf(sid)
            val aiSummary = n.optString("summary")
            val haystack = "$course $title ${meta.summary} $aiSummary"
            if (q.isNotEmpty() && !haystack.lowercase(Locale.getDefault()).contains(q)) continue
            val day = dayOf(sid)
            val dur = durations[course + "|" + day] ?: 0L
            rows.add(
                NoteRow(
                    sid, course, title, n.optString("state"), day, noteTime(sid),
                    dur, meta.summary, aiSummary, meta.points, meta.doubts, meta.quotes,
                    meta.cover, meta.photos,
                    if (n.optString("state") == "error") (Db.noteCache(sid)?.optString("error") ?: "") else ""
                )
            )
        }
        rows.sortByDescending { it.sid }
        countText.text = when {
            q.isNotEmpty() -> "找到 ${rows.size} 篇"
            else -> "共 ${rows.size} 篇"
        }

        if (rows.isEmpty()) {
            listBox.addView(emptyState(
                if (q.isNotEmpty()) "没有匹配的笔记" else "还没有笔记",
                if (q.isNotEmpty()) "换个关键词试试，或点「全部」清除课程筛选。"
                else "上完课、素材传到电脑后，笔记会自动出现在这里。"
            ))
            return
        }

        var lastDay = ""
        for (r in rows) {
            if (r.day != lastDay) {
                lastDay = r.day
                listBox.addView(dayHeader(r.day, rows.count { it.day == r.day }))
            }
            listBox.addView(noteCard(r))
        }
    }

    private fun noteCard(r: NoteRow): View {
        val card = LinearLayout(act)
        card.orientation = VERTICAL
        card.background = Glass.cardBg(Glass.REGULAR, 20)
        card.elevation = Ui.dp(3).toFloat()
        card.setPadding(Ui.dp(14), Ui.dp(13), Ui.dp(14), Ui.dp(13))
        val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        lp.bottomMargin = Ui.dp(10)
        card.layoutParams = lp
        Ui.pressable(card, 0.985f)

        val row = LinearLayout(act)
        row.orientation = HORIZONTAL
        val col = LinearLayout(act)
        col.orientation = VERTICAL

        val top = LinearLayout(act)
        top.orientation = HORIZONTAL
        top.gravity = Gravity.CENTER_VERTICAL
        val dot = View(act)
        dot.background = Ui.roundBg(Ui.courseColor(r.course.ifEmpty { r.title }), 999)
        top.addView(dot, LinearLayout.LayoutParams(Ui.dp(8), Ui.dp(8)))
        val course = Ui.text(act, r.course.ifEmpty { "课堂笔记" }, 12, Ui.courseColor(r.course.ifEmpty { r.title }), true)
        course.setPadding(Ui.dp(6), 0, 0, 0)
        top.addView(course)
        if (r.state != "done") {
            val (badge, color) = stateBadge(r.state)
            val b = Ui.badge(act, badge, color)
            b.textSize = Ui.sp(10)
            b.setPadding(Ui.dp(7), Ui.dp(2), Ui.dp(7), Ui.dp(2))
            val blp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            blp.leftMargin = Ui.dp(8)
            top.addView(b, blp)
        }
        col.addView(top)

        val title = Ui.text(act, r.title, 16, Ui.TEXT, true)
        title.maxLines = 2
        title.ellipsize = android.text.TextUtils.TruncateAt.END
        title.setLineSpacing(0f, 1.12f)
        title.setPadding(0, Ui.dp(5), 0, 0)
        col.addView(title)

        val summaryText = when {
            r.state == "error" -> "⚠️ 这次整理出错了" + (if (r.error.isNotEmpty()) "：${r.error}" else "")
            r.state != "done" -> "电脑正在整理这篇笔记，通常课后 15–40 分钟出稿。"
            r.aiSummary.isNotEmpty() -> r.aiSummary      // v2.4：AI 生成的真总结
            r.summary.isNotEmpty() -> r.summary          // 旧笔记回退：正文前 150 字
            else -> "点开看全文"
        }
        val summary = Ui.text(act, summaryText, 13, if (r.state == "error") Ui.RED else Ui.TEXT_SUB)
        summary.maxLines = if (r.state == "done" && r.aiSummary.isNotEmpty()) 3 else 2
        summary.ellipsize = android.text.TextUtils.TruncateAt.END
        summary.setLineSpacing(Ui.dp(2).toFloat(), 1f)
        summary.setPadding(0, Ui.dp(5), 0, 0)
        col.addView(summary)

        // v2.4：结构标签（只数明确打了标签的条目，数字不虚报）
        if (r.state == "done") {
            val tags = ArrayList<Pair<String, Int>>()
            if (r.points > 0) tags.add("考点 ${r.points}" to Ui.PRIMARY)
            if (r.doubts > 0) tags.add("存疑 ${r.doubts}" to Ui.RED)
            if (r.quotes > 0) tags.add("原话 ${r.quotes}" to Ui.TEXT_SUB)
            if (tags.isNotEmpty()) {
                val tagRow = LinearLayout(act)
                tagRow.orientation = HORIZONTAL
                tagRow.setPadding(0, Ui.dp(7), 0, 0)
                for ((label, color) in tags) {
                    val chip = Ui.text(act, label, 10, color, true)
                    chip.setPadding(Ui.dp(6), Ui.dp(2), Ui.dp(6), Ui.dp(3))
                    chip.background = Glass.cardBg(Glass.THIN, 999)
                    val lp = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                    lp.rightMargin = Ui.dp(6)
                    tagRow.addView(chip, lp)
                }
                col.addView(tagRow)
            }
        }

        val foot = LinearLayout(act)
        foot.orientation = HORIZONTAL
        foot.gravity = Gravity.CENTER_VERTICAL
        foot.setPadding(0, Ui.dp(9), 0, 0)
        val bits = ArrayList<String>()
        if (r.time.isNotEmpty()) bits.add(r.time)
        if (r.durMs > 0) bits.add("${r.durMs / 60000} 分钟")
        if (r.photos > 0) bits.add("${r.photos} 张板书")
        val footText = Ui.text(act, bits.joinToString(" · "), 11, Ui.TEXT_SUB)
        foot.addView(footText, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        foot.addView(Ui.text(act, "›", 18, Ui.PRIMARY, true))
        col.addView(foot)

        row.addView(col, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(thumb(r), LinearLayout.LayoutParams(Ui.dp(74), Ui.dp(74)).also {
            it.leftMargin = Ui.dp(12)
            it.gravity = Gravity.TOP
        })
        card.addView(row)

        card.setOnClickListener {
            act.startActivity(Intent(act, NoteActivity::class.java).putExtra("sid", r.sid))
        }
        return card
    }

    private fun thumb(r: NoteRow): View {
        val size = Ui.dp(74)
        val cover = r.cover
        if (cover != null) {
            val iv = ImageView(act)
            iv.scaleType = ImageView.ScaleType.CENTER_CROP
            iv.background = Glass.cardBg(Glass.THIN, 14)
            iv.clipToOutline = true
            val key = cover.absolutePath
            val bmp = thumbCache.get(key) ?: decodeThumb(cover, size)?.also { thumbCache.put(key, it) }
            if (bmp != null) iv.setImageBitmap(bmp)
            return iv
        }
        val letter = (r.course.ifEmpty { r.title }).take(1)
        val t = TextView(act)
        t.text = letter
        t.textSize = Ui.sp(24)
        t.setTypeface(null, Typeface.BOLD)
        t.gravity = Gravity.CENTER
        val c = Ui.courseColor(r.course.ifEmpty { r.title })
        t.setTextColor(c)
        t.background = GradientDrawable().apply {
            cornerRadius = Ui.dp(14).toFloat()
            setColor(Color.argb(30, Color.red(c), Color.green(c), Color.blue(c)))
            setStroke(Ui.dp(1), Color.argb(70, Color.red(c), Color.green(c), Color.blue(c)))
        }
        return t
    }

    // ---------- 课堂记录 ----------
    private fun renderSessions(q: String) {
        val sess = Db.sessions(300)
        val groups = LinkedHashMap<String, MutableList<JSONObject>>()
        for (i in 0 until sess.length()) {
            val s = sess.getJSONObject(i)
            if (s.optString("state") == "cancelled") continue
            if (courseFilter.isNotEmpty() && s.optString("course") != courseFilter) continue
            val key = s.optString("course") + "|" + isoFmt.format(Date(s.getLong("startedAt")))
            groups.getOrPut(key) { ArrayList() }.add(s)
        }
        val list = ArrayList<SessionGroup>()
        for ((_, items) in groups) {
            if (items.isEmpty()) continue
            val course = items[0].optString("course")
            val dayIso = isoFmt.format(Date(items[0].getLong("startedAt")))
            val label = "$course $dayIso ${items.size} 段"
            if (q.isNotEmpty() && !label.lowercase(Locale.getDefault()).contains(q)) continue
            list.add(
                SessionGroup(
                    course, dayIso, items,
                    items.maxOf { it.optLong("startedAt") },
                    items.sumOf { it.optLong("durMs") },
                    items.count { it.optString("state") == "ready" },
                    items.any { it.optString("state") == "recording" },
                    items.any { it.optString("state") == "uploading" }
                )
            )
        }
        list.sortByDescending { it.startedAt }
        countText.text = "共 ${list.size} 组"

        if (list.isEmpty()) {
            listBox.addView(emptyState(
                if (q.isNotEmpty()) "没有匹配的课堂记录" else "还没有课堂记录",
                "上完课点「下课」，这节素材就会出现在这里；连上家里 WiFi 会自动传电脑。"
            ))
            return
        }

        var lastDay = ""
        for (g in list) {
            if (g.dayIso != lastDay) {
                lastDay = g.dayIso
                listBox.addView(dayHeaderIso(g.dayIso, list.count { it.dayIso == g.dayIso }))
            }
            listBox.addView(sessionCard(g))
        }
    }

    private fun sessionCard(g: SessionGroup): View {
        val (badge, color) = when {
            g.nReady > 0 -> "⬆ ${g.nReady} 段待上传" to Ui.ORANGE
            g.recording -> "🔴 录音中" to Ui.RED
            g.uploading -> "⬆ 上传中…" to Ui.ORANGE
            else -> "已传电脑" to Ui.PRIMARY
        }
        val card = LinearLayout(act)
        card.orientation = VERTICAL
        card.background = Glass.cardBg(Glass.REGULAR, 20)
        card.elevation = Ui.dp(3).toFloat()
        card.setPadding(Ui.dp(14), Ui.dp(13), Ui.dp(14), Ui.dp(13))
        val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        lp.bottomMargin = Ui.dp(10)
        card.layoutParams = lp
        Ui.pressable(card, 0.985f)

        val top = LinearLayout(act)
        top.orientation = HORIZONTAL
        top.gravity = Gravity.CENTER_VERTICAL
        val dot = View(act)
        dot.background = Ui.roundBg(Ui.courseColor(g.course), 999)
        top.addView(dot, LinearLayout.LayoutParams(Ui.dp(8), Ui.dp(8)))
        val course = Ui.text(act, g.course.ifEmpty { "课堂记录" }, 15, Ui.TEXT, true)
        course.setPadding(Ui.dp(6), 0, 0, 0)
        top.addView(course, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        top.addView(Ui.text(act, hmFmt.format(Date(g.startedAt)) + " 开录", 11, Ui.TEXT_SUB))
        card.addView(top)

        val sub = Ui.text(
            act,
            "${g.items.size} 段录音 · 共 ${Ui.dur(g.totalMs)} · $badge",
            12, color
        )
        sub.setPadding(0, Ui.dp(5), 0, 0)
        card.addView(sub)

        val hint = Ui.text(
            act,
            if (g.nReady > 0) "点这里整组上传（长按可作废/重传）"
            else if (g.recording) "还在录，下课后再传"
            else "电脑会按天归成一篇笔记，点这里看笔记（长按可重传素材）",
            11, Ui.TEXT_SUB
        )
        hint.setPadding(0, Ui.dp(6), 0, 0)
        card.addView(hint)

        card.setOnClickListener { onGroupTap(g) }
        card.setOnLongClickListener { onGroupLongPress(g); true }
        return card
    }

    private fun onGroupTap(g: SessionGroup) {
        val ready = g.items.filter { it.optString("state") == "ready" }
        if (ready.isNotEmpty()) {
            Ui.toast(act, "开始上传这组的 ${ready.size} 段…")
            for (s in ready) Db.setSessionState(s.optString("sid"), "uploading")
            refreshList()
            Thread {
                var ok = 0
                var fail = 0
                for (s in ready) {
                    val sid = s.optString("sid")
                    val err = Api.uploadSession(sid)
                    if (err == null) ok++ else { fail++; Db.setSessionState(sid, "ready") }
                }
                handler.post {
                    Ui.toast(act, if (fail == 0) "传完了 $ok 段，电脑开始归成一篇笔记" else "传了 $ok 段，$fail 段没传上（稍后自动重试）")
                    onRequestSync?.invoke()
                    refresh()
                }
            }.start()
            return
        }
        openNoteForDay(g.course, g.dayIso)
    }

    private fun openNoteForDay(course: String, dayIso: String) {
        val ymd = dayIso.replace("-", "")
        val notes = Db.noteCacheList()
        for (i in 0 until notes.length()) {
            val n = notes.getJSONObject(i)
            if (n.optString("course") == course && n.optString("sid").startsWith("c$ymd")) {
                act.startActivity(Intent(act, NoteActivity::class.java).putExtra("sid", n.optString("sid")))
                return
            }
        }
        Ui.toast(act, "这天的笔记还没同步到手机（回家里 WiFi 打开 APP 会自动下）")
    }

    /** 长按一组：作废还没上传的段 / 重新上传已传的素材（修复电脑上的坏文件，v2.2） */
    private fun onGroupLongPress(g: SessionGroup) {
        val ready = g.items.filter { it.optString("state") == "ready" }
        val uploaded = g.items.filter { it.optString("state") == "uploaded" }
        if (ready.isEmpty() && uploaded.isEmpty()) {
            Ui.toast(act, "这组没有可操作的录音（录音中的等下课）")
            return
        }
        val actions = ArrayList<Pair<String, () -> Unit>>()
        if (uploaded.isNotEmpty()) actions.add("重新上传素材（修复电脑上的坏文件）" to { reuploadGroup(g, uploaded) })
        if (ready.isNotEmpty()) actions.add("作废还没上传的录音" to { cancelReady(g, ready) })
        if (actions.size == 1) { actions[0].second(); return }
        AlertDialog.Builder(act)
            .setTitle("《${g.course}》${g.dayIso}")
            .setItems(actions.map { it.first }.toTypedArray()) { _, which -> actions[which].second() }
            .setNegativeButton("取消", null)
            .show()
    }

    /** 重传修复：电脑先把旧文件挪进 files_备份（不删），手机从 0 重传这一组所有已传会话，
     *  全部传完再让电脑统一重新整理一次，避免锚点先跑一遍、成员并入后又补跑一遍白烧 AI。 */
    private fun reuploadGroup(g: SessionGroup, items: List<JSONObject>) {
        AlertDialog.Builder(act)
            .setTitle("重新上传《${g.course}》${g.dayIso} 的素材？")
            .setMessage("电脑上这天的录音会先备份到 files_备份 文件夹（不删除），然后用手机里的原始录音从头重传，传完自动重新生成笔记。手机里的录音不会动。")
            .setPositiveButton("开始重传") { _, _ ->
                Ui.toast(act, "开始重传，别关 APP…")
                Thread {
                    var anchor = ""
                    var fail = ""
                    for (s in items) {
                        val sid = s.optString("sid")
                        val (ok, msg) = Api.prepareReupload(sid)
                        if (!ok) { fail = msg; break }
                        if (msg.isNotEmpty()) anchor = msg
                        Db.setSessionState(sid, "uploading")
                        val err = Api.uploadSession(sid)
                        if (err != null) { fail = err; break }
                    }
                    val finished = fail.isEmpty() && anchor.isNotEmpty() && Api.finishReupload(anchor)
                    handler.post {
                        Ui.toast(
                            act,
                            when {
                                fail.isNotEmpty() -> "重传中断：$fail（可再长按重来一次）"
                                !finished -> "素材传完了，但没能通知电脑重跑（连上后点「同步」再试）"
                                else -> "重传完成，电脑开始重新整理这节课"
                            }
                        )
                        refresh()
                        if (fail.isEmpty()) onRequestSync?.invoke()
                    }
                }.start()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    /** 作废还没上传的录音（原长按逻辑） */
    private fun cancelReady(g: SessionGroup, ready: List<JSONObject>) {
        val labels = ready.map {
            "${hmFmt.format(Date(it.getLong("startedAt")))} 开录 · 录了 ${Ui.dur(it.optLong("durMs"))}"
        }.toTypedArray()
        val checked = BooleanArray(ready.size)
        AlertDialog.Builder(act)
            .setTitle("作废《${g.course}》没上传的录音？")
            .setMultiChoiceItems(labels, checked) { _, which, on -> checked[which] = on }
            .setPositiveButton("作废选中") { _, _ ->
                var n = 0
                for (i in ready.indices) if (checked[i]) {
                    Db.setSessionState(ready[i].optString("sid"), "cancelled"); n++
                }
                Ui.toast(act, if (n > 0) "已作废 $n 段：不上传、不出笔记（录音文件还留在手机里）" else "没勾任何一段")
                refresh()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // ---------- 小部件 ----------
    private fun dayHeader(day: String, n: Int): View {
        val label = if (day.length == 8) friendlyDay(day) else "较早"
        val t = Ui.text(act, "$label · $n 篇", 12, Ui.TEXT_SUB, true)
        t.setPadding(Ui.dp(4), Ui.dp(14), 0, Ui.dp(7))
        return t
    }

    private fun dayHeaderIso(iso: String, n: Int): View {
        val day = iso.replace("-", "")
        val t = Ui.text(act, "${if (day.length == 8) friendlyDay(day) else "较早"} · $n 组", 12, Ui.TEXT_SUB, true)
        t.setPadding(Ui.dp(4), Ui.dp(14), 0, Ui.dp(7))
        return t
    }

    private fun friendlyDay(day: String): String {
        val d = try { dayFmt.parse(day) } catch (_: Exception) { null } ?: return day
        val cal = Calendar.getInstance()
        val today = dayFmt.format(cal.time)
        cal.add(Calendar.DAY_OF_YEAR, -1)
        val yesterday = dayFmt.format(cal.time)
        return when (day) {
            today -> "今天 · " + labelFmt.format(d)
            yesterday -> "昨天 · " + labelFmt.format(d)
            else -> weekFmt.format(d)
        }
    }

    private fun emptyState(title: String, hint: String): View {
        val box = LinearLayout(act)
        box.orientation = VERTICAL
        box.gravity = Gravity.CENTER
        box.setPadding(Ui.dp(20), Ui.dp(46), Ui.dp(20), Ui.dp(20))
        box.addView(Ui.text(act, "🗒", 34, Ui.TEXT_SUB).apply { gravity = Gravity.CENTER })
        val t = Ui.text(act, title, 15, Ui.TEXT, true)
        t.gravity = Gravity.CENTER
        t.setPadding(0, Ui.dp(10), 0, 0)
        box.addView(t)
        val h = Ui.text(act, hint, 12, Ui.TEXT_SUB)
        h.gravity = Gravity.CENTER
        h.setPadding(Ui.dp(16), Ui.dp(5), Ui.dp(16), 0)
        box.addView(h)
        return box
    }

    private fun stateBadge(state: String): Pair<String, Int> = when (state) {
        "done" -> "✅ 已整理" to Ui.GREEN
        "transcribing" -> "⏳ 转写中" to Ui.ORANGE
        "analyzing" -> "🧠 整理中" to Ui.ORANGE
        "queued" -> "⏳ 排队中" to Ui.ORANGE
        "uploading" -> "⬆️ 接收中" to Ui.ORANGE
        "error" -> "⚠️ 出错了" to Ui.RED
        else -> "· $state" to Ui.TEXT_SUB
    }

    // ---------- 读取 note.html 提取摘要 / 封面（只在后台线程调用） ----------
    private fun metaOf(sid: String): NoteMeta = metaCache[sid] ?: NoteMeta("", null, 0, 0)

    private fun computeMeta(sid: String) {
        if (sid.isEmpty()) return
        val dir = File(File(act.filesDir, "notes"), sid)
        val html = File(dir, "note.html")
        if (!html.exists()) return
        val stamp = html.lastModified()
        val old = metaCache[sid]
        if (old != null && old.stamp == stamp) return
        var summary = ""
        var cover: File? = null
        var photos = 0
        var points = 0
        var doubts = 0
        var quotes = 0
        try {
            val text = html.readText()
            val imgs = Regex("""<img[^>]*src\s*=\s*["']([^"']+)["']""", RegexOption.IGNORE_CASE)
                .findAll(text).map { it.groupValues[1] }.toList()
            photos = imgs.size
            cover = imgs.firstOrNull()?.let { src ->
                if (src.startsWith("http") || src.startsWith("data:")) null
                else File(dir, src).takeIf { it.exists() }
            }
            val body = text.replace(Regex("(?is)<(script|style)[^>]*>.*?</\\1>"), " ")
            val afterTitle = body.indexOf("</h1>").let { if (it >= 0) body.substring(it + 5) else body }
            // 旧笔记没有 AI 总结：优先取第一条「考点/结论」条目，其次第一条列表/正文，
            // 跳过开头「全课 X 分钟 · 照片 N 张」和「⚠ 如实说明」这类元信息，避免卡片摘要全是套话。
            val lis = Regex("(?is)<li\\b[^>]*>(.*?)</li>").findAll(afterTitle)
                .map { it.groupValues[1] }.toList()
            val pointLi = Regex("(?i)<strong[^>]*>\\s*(考点|知识点|结论|重点|要点|易错)\\s*</strong>")
            val picked = lis.firstOrNull { pointLi.containsMatchIn(it) }
                ?: lis.firstOrNull()
                ?: Regex("(?is)<p\\b[^>]*>(.*?)</p>").find(afterTitle)?.groupValues?.get(1)
            summary = (picked ?: afterTitle)
                .replace(Regex("(?is)<[^>]+>"), " ")
                .replace("&nbsp;", " ").replace("&amp;", "&")
                .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"")
                .replace(Regex("^(考点|知识点|结论|重点|要点|易错)\\s*[：:]?\\s*"), "")
                .replace(Regex("\\s+"), " ")
                .trim()
                .take(150)
            // 只数「明确带标签」的条目，数字能对得上正文，不靠关键词猜
            points = Regex(
                "(?i)<strong[^>]*>\\s*(考点|知识点|结论|重点|要点|易错)\\s*</strong>"
            ).findAll(text).count()
            doubts = Regex(
                "(?i)<strong[^>]*>\\s*(存疑|待核|不确定)\\s*</strong>"
            ).findAll(text).count()
            quotes = (Regex("(?i)<blockquote\\b").findAll(text).count() - 1).coerceAtLeast(0)
        } catch (_: Exception) { }
        metaCache[sid] = NoteMeta(summary, cover, photos, stamp, "", points, doubts, quotes)
        if (cover != null) {
            val key = cover.absolutePath
            if (thumbCache.get(key) == null) {
                decodeThumb(cover, Ui.dp(74))?.let { thumbCache.put(key, it) }
            }
        }
    }

    private fun decodeThumb(f: File, targetPx: Int): Bitmap? = try {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(f.absolutePath, bounds)
        var sample = 1
        while (bounds.outWidth / sample > targetPx * 2 || bounds.outHeight / sample > targetPx * 2) sample *= 2
        BitmapFactory.decodeFile(f.absolutePath, BitmapFactory.Options().apply { inSampleSize = sample })
    } catch (_: Exception) { null }

    // ---------- sid / 时长 ----------
    private fun dayOf(sid: String): String {
        val m = Regex("^c(\\d{8})").find(sid) ?: return ""
        return m.groupValues[1]
    }

    private fun noteTime(sid: String): String {
        val m = Regex("^c\\d{8}-(\\d{2})(\\d{2})").find(sid) ?: return ""
        return m.groupValues[1] + ":" + m.groupValues[2]
    }

    /** 每门课每天录了多久：聚合 sessions，给笔记卡显示时长 */
    private fun sessionDurations(): HashMap<String, Long> {
        val map = HashMap<String, Long>()
        val sess = Db.sessions(500)
        for (i in 0 until sess.length()) {
            val s = sess.getJSONObject(i)
            if (s.optString("state") == "cancelled") continue
            val day = dayFmt.format(Date(s.getLong("startedAt")))
            val key = s.optString("course") + "|" + day
            map[key] = (map[key] ?: 0L) + s.optLong("durMs")
        }
        return map
    }
}
