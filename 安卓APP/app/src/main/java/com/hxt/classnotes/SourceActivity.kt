package com.hxt.classnotes

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.PlaybackParams
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Calendar
import java.util.Locale
import java.util.concurrent.Executors

/**
 * 原始素材页（v2.6）：一节课的录音原文 / 照片 / 录音三合一。
 *
 * 数据策略：
 *  - 照片和录音**本地优先**（filesDir/sessions），笔记还在转写/整理时也能看能听；
 *  - 原文来自电脑 /api/source，转写中每 5 秒拉一次增量（已完成段 + 半成品段）；
 *  - 同日同课被服务端合并的会话，本地按同样规则（同课程 + 同一天）聚合，偏移 = 会话起点差 + 段内偏移；
 *  - 原文落本地缓存，断网时显示上次拉到的内容，并明确提示。
 *
 * 播放：只用一个 MediaPlayer，分段队列连播；全局进度按「第几段 + 段内偏移」换算。
 * 不做后台/锁屏播放——离开页面即暂停（要后台需前台服务，另开需求）。
 */
class SourceActivity : Activity() {

    companion object {
        private const val EXTRA_SID = "sid"
        private const val EXTRA_COURSE = "course"
        private const val EXTRA_STARTED = "startedAt"
        private const val EXTRA_TAB = "tab"
        private const val REQ_PHOTO = 77

        fun open(ctx: Context, sid: String, course: String, startedAt: Long, tab: Int) {
            val i = Intent(ctx, SourceActivity::class.java)
            i.putExtra(EXTRA_SID, sid)
            i.putExtra(EXTRA_COURSE, course)
            i.putExtra(EXTRA_STARTED, startedAt)
            i.putExtra(EXTRA_TAB, tab)
            ctx.startActivity(i)
        }

        /**
         * 本地聚合计数：本会话 + 同课程同一天的其他会话（与服务端合并规则一致）。
         * 返回 [录音段数, 照片张数]，供笔记状态页显示，不联网。
         */
        fun localCounts(sid: String, course: String, startedAt: Long): IntArray {
            val anchorStart = if (startedAt > 0) startedAt else (Db.session(sid)?.optLong("startedAt") ?: 0L)
            var segs = 0
            var photos = 0
            val all = Db.sessions(400)
            for (i in 0 until all.length()) {
                val s = all.getJSONObject(i)
                val id = s.optString("sid")
                if (!belongsTo(id, s.optString("course"), s.optLong("startedAt"), sid, course, anchorStart)) continue
                segs += Db.segments(id).length()
                photos += Db.photos(id).length()
            }
            return intArrayOf(segs, photos)
        }

        private fun belongsTo(id: String, c: String, at: Long, sid: String, course: String, anchorStart: Long): Boolean {
            if (id == sid) return true
            if (course.isEmpty() || c != course || anchorStart <= 0) return false
            return dayKey(at) == dayKey(anchorStart)
        }

        private fun dayKey(ms: Long): Int {
            if (ms <= 0) return -1
            val c = Calendar.getInstance()
            c.timeInMillis = ms
            return c.get(Calendar.YEAR) * 1000 + c.get(Calendar.DAY_OF_YEAR)
        }
    }

    private data class Seg(
        val name: String,
        val startMs: Long,
        val endMs: Long,
        val srcId: String,
        val local: File?,
        val done: Boolean,
        val partial: Boolean
    )

    private data class Cue(val s: Double, val e: Double, val t: String)

    private data class Photo(val name: String, val offsetMs: Long, var local: File?, val srcId: String = "")

    private data class Model(
        val segs: List<Seg>,
        val photos: List<Photo>,
        val cues: List<Cue>,
        val totalMs: Long,
        val transcriptTotal: Int,
        val transcriptDone: Int,
        val transcriptProgress: Int,
        val transcriptComplete: Boolean,
        val fromServer: Boolean
    )

    private var sid = ""
    private var course = ""
    private var startedAt = 0L
    private var tab = 1

    private lateinit var contentHost: FrameLayout
    private lateinit var tabAudio: TextView
    private lateinit var tabText: TextView
    private lateinit var tabPhoto: TextView
    private lateinit var audioPage: ScrollView
    private lateinit var textPage: LinearLayout
    private lateinit var photoPage: ScrollView
    private lateinit var segBox: LinearLayout
    private lateinit var photoGrid: LinearLayout
    private lateinit var photoHint: TextView
    private lateinit var banner: TextView
    private lateinit var seek: SeekBar
    private lateinit var totalLabel: TextView
    private lateinit var curLabel: TextView
    private lateinit var playBig: TextView
    private lateinit var speedBig: TextView
    private lateinit var miniTime: TextView
    private lateinit var miniPlay: TextView
    private lateinit var miniSpeed: TextView
    private lateinit var segSource: TextView
    private lateinit var wv: WebView

    private var segs: List<Seg> = emptyList()
    private var photos: List<Photo> = emptyList()
    private var cues: List<Cue> = emptyList()
    private var totalMs = 0L
    private var fromServer = false
    private var transcriptTotal = 0
    private var transcriptDone = 0
    private var transcriptProgress = 0
    private var transcriptComplete = false

    private var player: MediaPlayer? = null
    private var curSeg = -1
    private var playing = false
    private var speed = 1.0f
    private val speeds = floatArrayOf(0.75f, 1.0f, 1.25f, 1.5f)
    private var dragging = false
    private var lastGlobal = 0L
    private var baseUrl: String? = null

    private var segSignature = ""
    private var photoSignature = ""
    private var cueRendered = 0
    private var webReady = false
    private var loading = false
    private var gen = 0
    private var visible = false
    private var pageBuilt = false

    private val main = Handler(Looper.getMainLooper())
    private val pool = Executors.newFixedThreadPool(2)
    private val thumbs = HashMap<String, Bitmap>()

    private val ticker = object : Runnable {
        override fun run() {
            updatePositionUi()
            if (playing) main.postDelayed(this, 400)
        }
    }

    private val poller = object : Runnable {
        override fun run() {
            if (visible) refresh(false)
        }
    }

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
            pause()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        UiTheme.stamp(this)
        setTheme(if (UiTheme.dark) android.R.style.Theme_Material_NoActionBar
        else android.R.style.Theme_Material_Light_NoActionBar)
        UiTheme.applyWindow(this)

        sid = intent.getStringExtra(EXTRA_SID) ?: ""
        course = intent.getStringExtra(EXTRA_COURSE) ?: ""
        startedAt = intent.getLongExtra(EXTRA_STARTED, 0L)
        tab = intent.getIntExtra(EXTRA_TAB, 1).coerceIn(0, 2)
        if (sid.isEmpty()) { finish(); return }

        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.background = Ui.glowBg()
        root.addView(buildTopBar(), LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).also { it.setMargins(Ui.dp(10), Ui.dp(6), Ui.dp(10), Ui.dp(2)) })

        root.addView(buildTabs(), LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).also { it.setMargins(Ui.dp(14), Ui.dp(6), Ui.dp(14), Ui.dp(2)) })

        contentHost = FrameLayout(this)
        root.addView(contentHost, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f
        ))
        buildPages()
        setContentView(root)

        val cached = try { Api.cachedSource(this, sid) } catch (_: Exception) { null }
        applyModel(buildModel(cached), announce = false)
        selectTab(tab)
        refresh(true)
    }

    override fun onStart() {
        super.onStart()
        visible = true
        main.post(poller)
        main.postDelayed(ticker, 400)
    }

    override fun onStop() {
        visible = false
        main.removeCallbacks(poller)
        main.removeCallbacks(ticker)
        pause()
        super.onStop()
    }

    override fun onDestroy() {
        releasePlayer()
        pool.shutdownNow()
        super.onDestroy()
    }

    // ---------- 顶栏 / 页签 ----------

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
        back.setOnClickListener { finish() }
        Ui.pressable(back, 0.9f)
        bar.addView(back, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Ui.dp(36)))

        val name = if (course.isNotEmpty()) "原始素材 · $course" else "原始素材"
        val title = Ui.text(this, name, 15, Ui.TEXT, true)
        title.maxLines = 1
        title.ellipsize = TextUtils.TruncateAt.END
        title.setPadding(Ui.dp(2), 0, Ui.dp(6), 0)
        bar.addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

        val again = Ui.text(this, "⟳", 15, Ui.PRIMARY, true)
        again.setPadding(Ui.dp(10), Ui.dp(6), Ui.dp(10), Ui.dp(6))
        again.background = Glass.secondaryBg(12)
        Ui.pressable(again, 0.94f)
        again.setOnClickListener {
            Ui.toast(this, "正在刷新…")
            refresh(true)
        }
        bar.addView(again)
        return bar
    }

    private fun buildTabs(): LinearLayout {
        val box = LinearLayout(this)
        box.orientation = LinearLayout.HORIZONTAL
        box.setPadding(Ui.dp(3), Ui.dp(3), Ui.dp(3), Ui.dp(3))
        box.background = Glass.cardBg(Glass.THIN, 14)
        tabAudio = tabItem("🎧 录音")
        tabText = tabItem("📄 原文")
        tabPhoto = tabItem("📷 照片")
        box.addView(tabAudio, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        box.addView(tabText, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        box.addView(tabPhoto, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        tabAudio.setOnClickListener { selectTab(0) }
        tabText.setOnClickListener { selectTab(1) }
        tabPhoto.setOnClickListener { selectTab(2) }
        return box
    }

    private fun tabItem(label: String): TextView {
        val t = Ui.text(this, label, 13, Ui.TEXT_SUB, true)
        t.gravity = Gravity.CENTER
        t.setPadding(0, Ui.dp(9), 0, Ui.dp(9))
        Ui.pressable(t, 0.96f)
        return t
    }

    private fun selectTab(i: Int) {
        tab = i.coerceIn(0, 2)
        audioPage.visibility = if (tab == 0) View.VISIBLE else View.GONE
        textPage.visibility = if (tab == 1) View.VISIBLE else View.GONE
        photoPage.visibility = if (tab == 2) View.VISIBLE else View.GONE
        for ((t, idx) in listOf(tabAudio to 0, tabText to 1, tabPhoto to 2)) {
            if (idx == tab) {
                t.setTextColor(Color.WHITE)
                t.background = roundBg(Ui.PRIMARY, 11)
            } else {
                t.setTextColor(Ui.TEXT_SUB)
                t.background = roundBg(Color.TRANSPARENT, 11)
            }
        }
        if (tab == 1) updateHighlight()
    }

    // ---------- 三页 ----------

    private fun buildPages() {
        audioPage = ScrollView(this)
        val audioBox = LinearLayout(this)
        audioBox.orientation = LinearLayout.VERTICAL
        audioBox.setPadding(Ui.dp(12), Ui.dp(8), Ui.dp(12), Ui.dp(30))
        audioPage.addView(audioBox)

        val card = Ui.card(this)
        card.addView(Ui.text(this, "整堂课", 13, Ui.TEXT_SUB, true))
        totalLabel = Ui.text(this, "—", 26, Ui.TEXT, true)
        totalLabel.setPadding(0, Ui.dp(2), 0, Ui.dp(6))
        card.addView(totalLabel)

        seek = SeekBar(this)
        seek.progressTintList = ColorStateList.valueOf(Ui.PRIMARY)
        seek.thumbTintList = ColorStateList.valueOf(Ui.PRIMARY)
        seek.max = 1000
        seek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar?, progress: Int, fromUser: Boolean) {
                if (fromUser && !dragging) return
                if (fromUser) {
                    lastGlobal = seekToGlobal(progress.toLong())
                    curLabel.text = hms(lastGlobal)
                }
            }
            override fun onStartTrackingTouch(sb: SeekBar?) { dragging = true }
            override fun onStopTrackingTouch(sb: SeekBar?) {
                dragging = false
                val target = seekToGlobal((sb?.progress ?: 0).toLong())
                playAt(target, playing)
            }
        })
        card.addView(seek, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        val times = LinearLayout(this)
        times.orientation = LinearLayout.HORIZONTAL
        curLabel = Ui.text(this, "0:00", 12, Ui.TEXT_SUB)
        val right = Ui.text(this, "0:00", 12, Ui.TEXT_SUB)
        right.gravity = Gravity.END
        times.addView(curLabel, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        times.addView(right, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        card.addView(times)
        // 总时长标签就是右侧那个，后面刷新时复用
        totalTimeView = right

        val controls = LinearLayout(this)
        controls.orientation = LinearLayout.HORIZONTAL
        controls.gravity = Gravity.CENTER_VERTICAL
        controls.setPadding(0, Ui.dp(10), 0, 0)
        val rew = pillControl("⏪ 15s")
        rew.setOnClickListener { playAt(currentGlobalMs() - 15000, playing) }
        val fwd = pillControl("15s ⏩")
        fwd.setOnClickListener { playAt(currentGlobalMs() + 15000, playing) }
        playBig = TextView(this)
        playBig.text = "▶"
        playBig.textSize = 24f
        playBig.setTextColor(Color.WHITE)
        playBig.gravity = Gravity.CENTER
        playBig.background = roundBg(Ui.PRIMARY, 28)
        playBig.setOnClickListener { togglePlay() }
        Ui.pressable(playBig, 0.94f)
        speedBig = pillControl("1.0×")
        speedBig.setOnClickListener { cycleSpeed() }
        val lpBig = LinearLayout.LayoutParams(Ui.dp(56), Ui.dp(56)).also { it.leftMargin = Ui.dp(10); it.rightMargin = Ui.dp(10) }
        controls.addView(rew, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        controls.addView(fwd, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        controls.addView(playBig, lpBig)
        controls.addView(speedBig, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        card.addView(controls)

        segSource = Ui.text(this, "来源：本机录音", 11, Ui.TEXT_SUB)
        segSource.setPadding(0, Ui.dp(8), 0, 0)
        card.addView(segSource)
        audioBox.addView(card)

        audioBox.addView(Ui.text(this, "分段（点一段从段首播）", 12, Ui.TEXT_SUB, true).also {
            it.setPadding(Ui.dp(4), Ui.dp(14), 0, Ui.dp(4))
        })
        segBox = LinearLayout(this)
        segBox.orientation = LinearLayout.VERTICAL
        audioBox.addView(segBox)
        contentHost.addView(audioPage, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        // ---- 原文页 ----
        textPage = LinearLayout(this)
        textPage.orientation = LinearLayout.VERTICAL
        banner = Ui.text(this, "", 12, Ui.ORANGE, true)
        banner.setPadding(Ui.dp(14), Ui.dp(8), Ui.dp(14), Ui.dp(8))
        banner.background = roundBg(withAlpha(Ui.ORANGE, 22), 12)
        textPage.addView(banner, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).also { it.setMargins(Ui.dp(12), Ui.dp(8), Ui.dp(12), 0) })
        val tip = Ui.text(this, "点任意一句，录音跳到那一刻继续播", 11, Ui.TEXT_SUB)
        tip.setPadding(Ui.dp(16), Ui.dp(6), Ui.dp(16), Ui.dp(2))
        textPage.addView(tip)

        val webBox = FrameLayout(this)
        webBox.background = Glass.cardBg(Glass.THIN, 16)
        webBox.clipToOutline = true
        textPage.addView(webBox, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f
        ).also { it.setMargins(Ui.dp(12), Ui.dp(4), Ui.dp(12), Ui.dp(6)) })
        wv = WebView(this)
        wv.settings.javaScriptEnabled = true
        wv.settings.allowFileAccess = false
        wv.settings.allowContentAccess = false
        wv.settings.domStorageEnabled = false
        wv.settings.builtInZoomControls = false
        wv.settings.loadWithOverviewMode = false
        wv.settings.useWideViewPort = true
        wv.overScrollMode = View.OVER_SCROLL_NEVER
        wv.setBackgroundColor(Color.TRANSPARENT)
        wv.addJavascriptInterface(object {
            @JavascriptInterface
            fun seek(sec: Double) {
                runOnUiThread { playAt((sec * 1000).toLong(), true) }
            }
        }, "Android")
        webBox.addView(wv, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        val mini = LinearLayout(this)
        mini.orientation = LinearLayout.HORIZONTAL
        mini.gravity = Gravity.CENTER_VERTICAL
        mini.setPadding(Ui.dp(14), Ui.dp(6), Ui.dp(14), Ui.dp(8))
        mini.background = Glass.cardBg(Glass.THIN, 14)
        miniTime = Ui.text(this, "0:00", 12, Ui.TEXT_SUB)
        miniPlay = pillControl("▶")
        miniPlay.setOnClickListener { togglePlay() }
        miniSpeed = pillControl("1.0×")
        miniSpeed.setOnClickListener { cycleSpeed() }
        mini.addView(miniTime, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        mini.addView(miniPlay)
        mini.addView(miniSpeed, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        textPage.addView(mini, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).also { it.setMargins(Ui.dp(12), 0, Ui.dp(12), Ui.dp(8)) })
        contentHost.addView(textPage, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        // ---- 照片页 ----
        photoPage = ScrollView(this)
        val pbox = LinearLayout(this)
        pbox.orientation = LinearLayout.VERTICAL
        pbox.setPadding(Ui.dp(12), Ui.dp(8), Ui.dp(12), Ui.dp(30))
        photoHint = Ui.text(this, "共 0 张", 12, Ui.TEXT_SUB, true)
        photoHint.setPadding(Ui.dp(4), 0, 0, Ui.dp(6))
        pbox.addView(photoHint)
        photoGrid = LinearLayout(this)
        photoGrid.orientation = LinearLayout.VERTICAL
        pbox.addView(photoGrid)
        photoPage.addView(pbox)
        contentHost.addView(photoPage, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    private var totalTimeView: TextView? = null

    private fun pillControl(label: String): TextView {
        val t = Ui.text(this, label, 13, Ui.PRIMARY, true)
        t.gravity = Gravity.CENTER
        t.setPadding(Ui.dp(12), Ui.dp(8), Ui.dp(12), Ui.dp(8))
        t.background = Glass.secondaryBg(12)
        Ui.pressable(t, 0.95f)
        return t
    }

    // ---------- 数据加载 ----------

    private fun refresh(announce: Boolean) {
        if (loading) return
        loading = true
        val my = ++gen
        if (announce) banner.text = "正在从电脑取原文…"
        pool.execute {
            val base = try { Api.workingUrl() } catch (_: Exception) { null }
            val remote = if (base != null) try { Api.source(base, sid) } catch (_: Exception) { null } else null
            if (remote != null) {
                baseUrl = base
                try { Api.saveSourceCache(this, sid, remote) } catch (_: Exception) { }
            }
            val j = remote ?: try { Api.cachedSource(this, sid) } catch (_: Exception) { null }
            val m = buildModel(j)
            runOnUiThread {
                loading = false
                if (my != gen || isFinishing || isDestroyed) return@runOnUiThread
                applyModel(m, announce)
            }
        }
    }

    /** 有服务端 JSON 就按它建（原文最全）；没有就用本地会话聚合（照片/录音仍可用） */
    private fun buildModel(j: JSONObject?): Model {
        return if (j != null) buildFromServer(j) else buildLocal()
    }

    private fun buildFromServer(j: JSONObject): Model {
        val total = maxOf(j.optLong("durationMs"), 0L)
        val arr = j.optJSONArray("segments") ?: JSONArray()
        val out = ArrayList<Seg>()
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            val start = maxOf(o.optLong("startOffsetMs"), 0L)
            val end = if (i + 1 < arr.length()) maxOf(arr.getJSONObject(i + 1).optLong("startOffsetMs"), start)
            else maxOf(total, start)
            val src = o.optString("srcId")
            val name = o.optString("name")
            out.add(Seg(name, start, end, src, findLocal(src, name), o.optBoolean("done"), o.optBoolean("partial")))
        }
        if (out.isEmpty() && j.optInt("transcriptTotal") == 0) {
            // 旧会话没有 segments 字段时给个可播的分段
            val n = findAnyRecording()
            if (n != null) out.add(Seg(n.name, 0L, maxOf(total, 600000L), "", n, true, false))
        }
        val ph = ArrayList<Photo>()
        val pa = j.optJSONArray("photos") ?: JSONArray()
        for (i in 0 until pa.length()) {
            val o = pa.getJSONObject(i)
            val name = o.optString("name")
            if (name.isEmpty()) continue
            val psrc = o.optString("srcId")
            ph.add(Photo(name, o.optLong("offsetMs"), findLocalPhoto(psrc, name), psrc))
        }
        val cs = ArrayList<Cue>()
        val ca = j.optJSONArray("transcript") ?: JSONArray()
        for (i in 0 until ca.length()) {
            val o = ca.getJSONObject(i)
            cs.add(Cue(o.optDouble("s"), o.optDouble("e"), o.optString("t")))
        }
        val realTotal = maxOf(total, out.maxOfOrNull { it.startMs + 600000L } ?: 0L, ph.maxOfOrNull { it.offsetMs } ?: 0L)
        return Model(
            out.sortedBy { it.startMs }, ph.sortedBy { it.offsetMs }, cs, realTotal,
            j.optInt("transcriptTotal", out.size), j.optInt("transcriptDone"), j.optInt("transcriptProgress"),
            j.optBoolean("transcriptComplete"), true
        )
    }

    /** 断网/电脑没上线：只聚合本机会话，原文用空列表（由缓存另行覆盖） */
    private fun buildLocal(): Model {
        val anchor = if (startedAt > 0) startedAt else (Db.session(sid)?.optLong("startedAt") ?: 0L)
        val sessions = ArrayList<Pair<String, Long>>()
        val all = Db.sessions(400)
        for (i in 0 until all.length()) {
            val s = all.getJSONObject(i)
            val id = s.optString("sid")
            if (!belongsTo(id, s.optString("course"), s.optLong("startedAt"), sid, course, anchor)) continue
            val off = if (id == sid || anchor <= 0) 0L else s.optLong("startedAt") - anchor
            sessions.add(id to off)
        }
        if (sessions.none { it.first == sid }) sessions.add(sid to 0L)

        val segList = ArrayList<Seg>()
        val photoList = ArrayList<Photo>()
        var maxEnd = 0L
        for ((id, off) in sessions) {
            val dur = Db.session(id)?.optLong("durMs") ?: 0L
            maxEnd = maxOf(maxEnd, off + dur)
            val sa = Db.segments(id)
            for (i in 0 until sa.length()) {
                val o = sa.getJSONObject(i)
                val name = o.optString("name")
                segList.add(Seg(name, off + o.optLong("startOffsetMs"), 0L, if (id == sid) "" else id,
                    findLocal(if (id == sid) "" else id, name), true, false))
            }
            val pa = Db.photos(id)
            for (i in 0 until pa.length()) {
                val o = pa.getJSONObject(i)
                val f = File(o.optString("path"))
                photoList.add(Photo(o.optString("name"), off + o.optLong("offsetMs"), if (f.exists()) f else null, id))
            }
        }
        segList.sortBy { it.startMs }
        val fixed = ArrayList<Seg>()
        for (i in segList.indices) {
            val s = segList[i]
            val e = if (i + 1 < segList.size) segList[i + 1].startMs else maxOf(maxEnd, s.startMs + 600000L)
            fixed.add(s.copy(endMs = e))
        }
        val total = maxOf(maxEnd, fixed.lastOrNull()?.endMs ?: 0L)
        return Model(fixed, photoList.sortedBy { it.offsetMs }, emptyList(), total, fixed.size, 0, 0, false, false)
    }

    private fun findLocal(srcId: String, name: String): File? {
        if (name.isEmpty()) return null
        val dirs = ArrayList<File>()
        // 成员会话优先：同名 recording_00.m4a 在锚点目录里也有，先查锚点会拿错文件
        if (srcId.isNotEmpty()) dirs.add(File(File(filesDir, "sessions"), srcId))
        dirs.add(File(File(filesDir, "sessions"), sid))
        for (d in dirs) {
            val f = File(d, name)
            if (f.exists() && f.length() > 0) return f
        }
        return null
    }

    private fun findLocalPhoto(srcId: String, name: String): File? = findLocal(srcId, name)

    private fun findAnyRecording(): File? {
        val dir = File(File(filesDir, "sessions"), sid)
        return dir.listFiles { f -> f.isFile && (f.name.endsWith(".m4a") || f.name.endsWith(".aac") || f.name.endsWith(".wav")) }
            ?.sortedBy { it.name }?.firstOrNull()
    }

    // ---------- 应用模型到界面 ----------

    private fun applyModel(m: Model, announce: Boolean) {
        val oldTotal = totalMs
        segs = m.segs
        photos = m.photos
        cues = m.cues
        totalMs = m.totalMs
        fromServer = m.fromServer
        transcriptTotal = m.transcriptTotal
        transcriptDone = m.transcriptDone
        transcriptProgress = m.transcriptProgress
        transcriptComplete = m.transcriptComplete

        totalLabel.text = "整堂课 ${hms(totalMs)} · 共 ${segs.size} 段"
        totalTimeView?.text = hms(totalMs)
        seek.max = 1000
        val localCnt = segs.count { it.local != null }
        segSource.text = when {
            segs.isEmpty() -> "没有找到录音分段"
            localCnt == segs.size -> "来源：本机录音（断网也能听）"
            localCnt == 0 -> "来源：电脑流式播放（手机里没有这段）"
            else -> "来源：本机 $localCnt 段 + 电脑 ${segs.size - localCnt} 段"
        }
        if (pageBuilt && oldTotal != totalMs) lastGlobal = lastGlobal.coerceIn(0, maxOf(totalMs, 0))

        val sig = segs.joinToString("|") { "${it.name}:${it.startMs}:${it.local?.absolutePath ?: ""}" }
        if (sig != segSignature) {
            segSignature = sig
            rebuildSegmentList()
        }
        val psig = photos.joinToString("|") { "${it.name}:${it.offsetMs}:${it.local?.absolutePath ?: ""}" }
        if (psig != photoSignature) {
            photoSignature = psig
            rebuildPhotos()
        }
        updateTranscript(rebuild = false)
        updateBanner()
        pageBuilt = true
        updatePositionUi()
        updatePlayButtons()

        // 边转边看：没转完就隔几秒拉一次。在线 5 秒；离线也慢速重试，断网恢复后能自己接上
        if (visible && !transcriptComplete) {
            main.removeCallbacks(poller)
            main.postDelayed(poller, if (fromServer) 5000 else 15000)
        }
        if (announce && !fromServer) {
            Ui.toast(this, "连不上电脑，先显示手机里的录音和照片")
        }
    }

    private fun updateBanner() {
        banner.visibility = View.VISIBLE
        when {
            transcriptComplete && cues.isNotEmpty() -> banner.visibility = View.GONE
            !fromServer && cues.isEmpty() -> banner.text = "原文在电脑上：连上电脑后自动出现（录音和照片不受影响）"
            !fromServer && cues.isNotEmpty() -> banner.text = "离线：显示上次同步的原文（共 ${cues.size} 句）"
            transcriptTotal > 0 -> banner.text = "⏳ 电脑正在转写：已转 $transcriptDone/$transcriptTotal 段（$transcriptProgress%）"
            else -> banner.text = "⏳ 电脑还没开始转写（音频传完才开始）"
        }
    }

    private fun rebuildSegmentList() {
        segBox.removeAllViews()
        if (segs.isEmpty()) {
            segBox.addView(emptyCard("这节课没有找到录音分段"))
            return
        }
        for ((i, s) in segs.withIndex()) {
            val row = LinearLayout(this)
            row.orientation = LinearLayout.HORIZONTAL
            row.gravity = Gravity.CENTER_VERTICAL
            row.setPadding(Ui.dp(12), Ui.dp(11), Ui.dp(12), Ui.dp(11))
            row.background = roundBg(Color.TRANSPARENT, 12)
            val left = Ui.text(this, "第 ${i + 1} 段　${hms(s.startMs)}–${hms(maxOf(s.startMs, s.endMs))}", 13, Ui.TEXT, true)
            val right = Ui.text(this, if (s.local != null) "本机" else "电脑", 11, Ui.TEXT_SUB)
            right.gravity = Gravity.END
            row.addView(left, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            row.addView(right)
            row.setOnClickListener { playAt(s.startMs, true) }
            Ui.pressable(row, 0.97f)
            segBox.addView(row, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).also { it.topMargin = Ui.dp(3) })
        }
    }

    private fun rebuildPhotos() {
        photoGrid.removeAllViews()
        photoHint.text = if (photos.isEmpty()) "这节课还没有照片" else "共 ${photos.size} 张 · 点开可放大，可跳到录音"
        if (photos.isEmpty()) {
            photoGrid.addView(emptyCard("这节课还没有拍照片"))
            return
        }
        var i = 0
        while (i < photos.size) {
            val row = LinearLayout(this)
            row.orientation = LinearLayout.HORIZONTAL
            row.gravity = Gravity.TOP
            for (c in 0 until 2) {
                if (i + c < photos.size) {
                    row.addView(photoCell(i + c, photos[i + c]), LinearLayout.LayoutParams(0, Ui.dp(150), 1f).also {
                        it.setMargins(Ui.dp(4), Ui.dp(4), Ui.dp(4), Ui.dp(4))
                    })
                } else {
                    row.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
                }
            }
            photoGrid.addView(row)
            i += 2
        }
    }

    private fun photoCell(index: Int, p: Photo): FrameLayout {
        val cell = FrameLayout(this)
        cell.background = roundBg(withAlpha(Ui.TEXT_SUB, 18), 12)
        cell.clipToOutline = true
        val iv = ImageView(this)
        iv.scaleType = ImageView.ScaleType.CENTER_CROP
        cell.addView(iv, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        val badge = Ui.text(this, "第 ${hms(p.offsetMs)} 拍", 10, Color.WHITE, true)
        badge.setPadding(Ui.dp(7), Ui.dp(3), Ui.dp(7), Ui.dp(3))
        badge.background = roundBg(0x8C000000.toInt(), 8)
        cell.addView(badge, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).also { it.gravity = Gravity.BOTTOM or Gravity.START; it.setMargins(Ui.dp(6), 0, 0, Ui.dp(6)) })
        cell.setOnClickListener { openPhoto(index) }
        loadThumb(iv, index, p)
        return cell
    }

    private fun loadThumb(iv: ImageView, index: Int, p: Photo) {
        val key = p.local?.absolutePath ?: "remote:$sid:${p.name}"
        thumbs[key]?.let { b ->
            iv.setImageBitmap(b)
            return
        }
        iv.setImageBitmap(null)
        iv.tag = key
        pool.execute {
            var f = p.local
            if (f == null) {
                val b = baseUrl
                if (b != null) f = try { Api.cachePhoto(this, b, sid, p.name, p.srcId) } catch (_: Exception) { null }
            }
            val bmp = if (f != null) decodeSampled(f, 480) else null
            runOnUiThread {
                if (isFinishing || isDestroyed || iv.tag != key || bmp == null) return@runOnUiThread
                if (thumbs.size > 80) { thumbs.clear() }
                thumbs[key] = bmp
                if (index < photos.size) {
                    if (photos[index].local == null && f != null) photos[index].local = f
                    iv.setImageBitmap(bmp)
                }
            }
        }
    }

    private fun decodeSampled(f: File, maxSide: Int): Bitmap? {
        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(f.absolutePath, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / sample > maxSide * 2) sample *= 2
            val opt = BitmapFactory.Options().apply {
                inSampleSize = sample
                inPreferredConfig = Bitmap.Config.RGB_565
            }
            BitmapFactory.decodeFile(f.absolutePath, opt)
        } catch (_: Throwable) { null }
    }

    private fun openPhoto(index: Int) {
        val p = photos[index]
        if (p.local == null) {
            Ui.toast(this, "这张还在电脑上，正在取…")
            val b = baseUrl
            if (b == null) { Ui.toast(this, "连不上电脑，这张还没下到手机"); return }
            pool.execute {
                val f = try { Api.cachePhoto(this, b, sid, p.name, p.srcId) } catch (_: Exception) { null }
                runOnUiThread {
                    if (f != null) { p.local = f; openPhoto(index) }
                    else Ui.toast(this, "连不上电脑，这张还没下到手机")
                }
            }
            return
        }
        val arr = JSONArray()
        val idxs = ArrayList<Int>()
        for ((i, q) in photos.withIndex()) {
            val f = q.local ?: continue
            arr.put(JSONObject().put("name", q.name).put("path", f.absolutePath).put("offsetMs", q.offsetMs))
            idxs.add(i)
        }
        val at = idxs.indexOf(index).let { if (it < 0) 0 else it }
        val i = Intent(this, PhotoActivity::class.java)
        i.putExtra("sid", sid)
        i.putExtra("index", at)
        i.putExtra("photosJson", arr.toString())
        i.putExtra("seekEnabled", true)
        @Suppress("DEPRECATION")
        startActivityForResult(i, REQ_PHOTO)
    }

    @Deprecated("PhotoActivity 返回「跳到录音这里」用结果回传")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_PHOTO && resultCode == RESULT_OK) {
            val ms = data?.getLongExtra("seekMs", -1L) ?: -1L
            if (ms >= 0) {
                selectTab(0)
                playAt(ms, true)
            }
        }
    }

    private fun emptyCard(msg: String): TextView {
        val t = Ui.text(this, msg, 13, Ui.TEXT_SUB)
        t.gravity = Gravity.CENTER
        t.setPadding(0, Ui.dp(30), 0, Ui.dp(30))
        return t
    }

    // ---------- 原文 ----------

    private fun updateTranscript(rebuild: Boolean) {
        if (!::wv.isInitialized) return
        val html = if (!webReady || rebuild || cueRendered > cues.size) {
            buildTranscriptHtml()
        } else {
            null
        }
        if (html != null) {
            wv.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
            webReady = true
            cueRendered = cues.size
            wv.postDelayed({ updateHighlight() }, 350)
        } else if (cueRendered < cues.size) {
            val arr = JSONArray()
            for (i in cueRendered until cues.size) {
                arr.put(JSONObject().put("s", cues[i].s).put("t", cues[i].t))
            }
            wv.evaluateJavascript("addRows($arr)", null)
            cueRendered = cues.size
        }
    }

    private fun buildTranscriptHtml(): String {
        val ink = hex(Ui.TEXT)
        val sub = hex(Ui.TEXT_SUB)
        val pri = hex(Ui.PRIMARY)
        val hlBg = "rgba(${Color.red(Ui.PRIMARY)},${Color.green(Ui.PRIMARY)},${Color.blue(Ui.PRIMARY)},${if (UiTheme.dark) "0.18" else "0.10"})"
        val sb = StringBuilder(64 * 1024)
        sb.append("<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,maximum-scale=1\">")
        sb.append("<style>")
        sb.append("html,body{margin:0;padding:8px 10px 26px;background:transparent;color:$ink;")
        sb.append("font:15px/1.62 -apple-system,'MiSans','HarmonyOS Sans',sans-serif;word-break:break-word;}")
        sb.append(".ln{display:flex;gap:10px;padding:6px 8px;border-left:3px solid transparent;border-radius:8px;}")
        sb.append(".ts{color:$sub;font-size:12px;min-width:52px;padding-top:2px;font-variant-numeric:tabular-nums;flex:none;}")
        sb.append(".tx{flex:1;}")
        sb.append(".ln.hl{background:$hlBg;border-left-color:$pri;}")
        sb.append(".ln.hl .tx{color:$pri;}")
        sb.append(".empty{color:$sub;text-align:center;padding:40px 16px;font-size:13px;}")
        sb.append("</style></head><body><div id=\"box\">")
        if (cues.isEmpty()) {
            sb.append("<div class=\"empty\" id=\"empty\">").append(if (fromServer) "电脑还没开始转写，稍等一会儿自动出现" else "原文在电脑上，连上后自动出现").append("</div>")
        } else {
            for ((i, c) in cues.withIndex()) {
                sb.append("<div class=\"ln\" id=\"l").append(i).append("\" data-s=\"").append(c.s).append("\">")
                sb.append("<span class=\"ts\">").append(hms((c.s * 1000).toLong())).append("</span>")
                sb.append("<span class=\"tx\">").append(TextUtils.htmlEncode(c.t)).append("</span></div>")
            }
        }
        sb.append("</div><script>")
        sb.append("window.__n=").append(cues.size).append(";window.__cur=-1;window.__follow=true;")
        sb.append("function fmt(s){s=Math.floor(s);var h=Math.floor(s/3600),m=Math.floor(s%3600/60),ss=s%60;")
        sb.append("var mm=(m<10?'0':'')+m;return (h?h+':'+mm:mm)+':'+((ss<10?'0':'')+ss);}")
        sb.append("function esc(t){return String(t).replace(/[&<>\"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c];});}")
        sb.append("window.addEventListener('scroll',function(){window.__follow=(window.scrollY+window.innerHeight>=document.body.scrollHeight-120);},{passive:true});")
        sb.append("document.addEventListener('click',function(e){var n=e.target.closest('.ln');if(n){window.__follow=true;Android.seek(parseFloat(n.dataset.s));}});")
        sb.append("function hl(i){if(i===window.__cur)return;var p=document.getElementById('l'+window.__cur);if(p)p.classList.remove('hl');")
        sb.append("window.__cur=i;if(i>=0){var n=document.getElementById('l'+i);if(n){n.classList.add('hl');")
        sb.append("if(window.__follow)n.scrollIntoView({block:'center'});}}}")
        sb.append("function addRows(a){var box=document.getElementById('box');var e=document.getElementById('empty');if(e&&e.parentNode)e.parentNode.removeChild(e);var f=document.createDocumentFragment();")
        sb.append("for(var k=0;k<a.length;k++){var r=a[k],d=document.createElement('div');d.className='ln';")
        sb.append("d.id='l'+(window.__n++);d.dataset.s=r.s;d.innerHTML='<span class=\"ts\">'+fmt(r.s)+'</span><span class=\"tx\">'+esc(r.t)+'</span>';f.appendChild(d);}")
        sb.append("box.appendChild(f);}")
        sb.append("</script></body></html>")
        return sb.toString()
    }

    private fun updateHighlight() {
        if (!::wv.isInitialized || !webReady || cues.isEmpty()) return
        val t = currentGlobalMs() / 1000.0
        var idx = -1
        for (i in cues.indices) {
            if (cues[i].s <= t + 0.05) idx = i else break
        }
        // 段落之间可能短暂落在空档，保留上一句
        if (idx < 0 && cues.isNotEmpty()) idx = 0
        wv.evaluateJavascript("hl($idx)", null)
    }

    // ---------- 播放 ----------

    private fun currentGlobalMs(): Long {
        val p = player ?: return lastGlobal
        val within = try { p.currentPosition.toLong() } catch (_: Exception) { 0L }
        val base = segs.getOrNull(curSeg)?.startMs ?: 0L
        return (base + within).coerceIn(0, maxOf(totalMs, 0L))
    }

    private fun seekToGlobal(progress: Long): Long {
        if (totalMs <= 0) return 0
        return (totalMs * progress / 1000.0).toLong().coerceIn(0, totalMs)
    }

    private fun playAt(ms: Long, autoplay: Boolean) {
        if (segs.isEmpty()) { Ui.toast(this, "这节课还没有录音"); return }
        val target = ms.coerceIn(0, maxOf(totalMs, segs.last().startMs))
        var idx = 0
        for (i in segs.indices) if (segs[i].startMs <= target) idx = i else break
        val within = target - segs[idx].startMs
        lastGlobal = target
        if (idx == curSeg && player != null) {
            try { player?.seekTo(within.toInt().coerceAtLeast(0)) } catch (_: Exception) { }
            if (autoplay) startPlay() else pause()
            updatePositionUi()
            return
        }
        openSegment(idx, within, autoplay)
    }

    private fun openSegment(idx: Int, withinMs: Long, autoplay: Boolean) {
        if (idx !in segs.indices) return
        releasePlayer()
        curSeg = idx
        val seg = segs[idx]
        val url = seg.local?.absolutePath ?: run {
            val b = baseUrl
            if (b == null) { Ui.toast(this, "这一段在电脑上，现在连不上电脑"); return }
            Api.fileUrl(b, sid, seg.name, seg.srcId)
        }
        val mp = MediaPlayer()
        player = mp
        try {
            mp.setAudioAttributes(AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build())
            mp.setDataSource(url)
            mp.setOnPreparedListener { p ->
                if (player !== p) return@setOnPreparedListener
                try { p.start() } catch (_: Exception) { }
                applySpeed(p)
                try { p.seekTo(withinMs.toInt().coerceAtLeast(0)) } catch (_: Exception) { }
                playing = autoplay
                if (!autoplay) try { p.pause() } catch (_: Exception) { }
                if (autoplay) requestFocus()
                updatePlayButtons()
                updatePositionUi()
                main.removeCallbacks(ticker)
                main.post(ticker)
            }
            mp.setOnCompletionListener {
                if (player !== it) return@setOnCompletionListener
                if (curSeg + 1 < segs.size) {
                    openSegment(curSeg + 1, 0L, true)
                } else {
                    playing = false
                    lastGlobal = totalMs
                    updatePlayButtons()
                    updatePositionUi()
                    Ui.toast(this, "本课录音播完了")
                }
            }
            mp.setOnErrorListener { p, _, _ ->
                if (player === p) {
                    playing = false
                    updatePlayButtons()
                    Ui.toast(this, "这一段读取失败（文件损坏或连不上电脑）")
                }
                true
            }
            mp.prepareAsync()
        } catch (e: Exception) {
            Ui.toast(this, "这段录音打不开：${e.message ?: "未知原因"}")
            releasePlayer()
        }
    }

    private fun startPlay() {
        if (segs.isEmpty()) { Ui.toast(this, "这节课还没有录音"); return }
        val p = player
        if (p == null) { playAt(lastGlobal, true); return }
        try {
            requestFocus()
            p.start()
            playing = true
            applySpeed(p)
            updatePlayButtons()
            main.removeCallbacks(ticker)
            main.post(ticker)
        } catch (_: Exception) {
            playAt(lastGlobal, true)
        }
    }

    private fun pause() {
        try { player?.pause() } catch (_: Exception) { }
        playing = false
        if (::playBig.isInitialized) updatePlayButtons()
        abandonFocus()
        updatePositionUi()
    }

    private fun togglePlay() {
        if (playing) pause() else startPlay()
    }

    private fun cycleSpeed() {
        val i = speeds.indexOfFirst { it == speed }.let { if (it < 0) 1 else it }
        speed = speeds[(i + 1) % speeds.size]
        player?.let { applySpeed(it) }
        updatePlayButtons()
    }

    private fun applySpeed(p: MediaPlayer) {
        try { p.playbackParams = PlaybackParams().setSpeed(speed) } catch (_: Exception) { }
    }

    private fun releasePlayer() {
        try { player?.stop() } catch (_: Exception) { }
        try { player?.release() } catch (_: Exception) { }
        player = null
        playing = false
        curSeg = -1
    }

    private fun requestFocus() {
        try {
            @Suppress("DEPRECATION")
            val am = getSystemService(AUDIO_SERVICE) as AudioManager
            @Suppress("DEPRECATION")
            am.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
        } catch (_: Exception) { }
    }

    private fun abandonFocus() {
        try {
            @Suppress("DEPRECATION")
            val am = getSystemService(AUDIO_SERVICE) as AudioManager
            @Suppress("DEPRECATION")
            am.abandonAudioFocus(focusListener)
        } catch (_: Exception) { }
    }

    private fun updatePlayButtons() {
        val glyph = if (playing) "⏸" else "▶"
        if (::playBig.isInitialized) playBig.text = glyph
        if (::miniPlay.isInitialized) miniPlay.text = glyph
        val spText = when (speed) { 0.75f -> "0.75×"; 1.0f -> "1.0×"; 1.25f -> "1.25×"; else -> "1.5×" }
        if (::speedBig.isInitialized) speedBig.text = spText
        if (::miniSpeed.isInitialized) miniSpeed.text = spText
    }

    private fun updatePositionUi() {
        if (!::seek.isInitialized) return
        val g = currentGlobalMs()
        lastGlobal = g
        if (!dragging) {
            seek.progress = if (totalMs > 0) (g * 1000 / totalMs).toInt().coerceIn(0, 1000) else 0
        }
        curLabel.text = hms(g)
        miniTime.text = hms(g)
        if (curSeg in segs.indices) {
            val row = segBox.getChildAt(curSeg)
            if (row != null) {
                for (i in 0 until segBox.childCount) {
                    val v = segBox.getChildAt(i)
                    val sel = i == curSeg
                    v.background = roundBg(if (sel) withAlpha(Ui.PRIMARY, if (UiTheme.dark) 30 else 18) else Color.TRANSPARENT, 12)
                }
            }
        }
        updateHighlight()
    }

    // ---------- 小工具 ----------

    private fun roundBg(color: Int, radiusDp: Int): GradientDrawable {
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = Ui.dp(radiusDp).toFloat()
            setColor(color)
        }
    }

    private fun withAlpha(color: Int, alpha: Int): Int {
        val a = (alpha * 255 / 100).coerceIn(0, 255)
        return Color.argb(a, Color.red(color), Color.green(color), Color.blue(color))
    }

    private fun hex(color: Int): String = String.format("#%06X", 0xFFFFFF and color)

    private fun hms(ms: Long): String {
        val total = (ms / 1000).coerceAtLeast(0)
        val h = total / 3600
        val m = total % 3600 / 60
        val s = total % 60
        return if (h > 0) String.format(Locale.CHINA, "%d:%02d:%02d", h, m, s)
        else String.format(Locale.CHINA, "%d:%02d", m, s)
    }
}
