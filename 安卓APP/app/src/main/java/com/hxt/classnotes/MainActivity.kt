package com.hxt.classnotes

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.MediaStore
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.io.File

/**
 * v2.0：单页滚到底 → 底部四标签（上课 / 笔记 / 待办 / 设置）。
 * - 上课：课程 chips + 大号开始/下课按钮 + 拍板书/标记 + 缩略图横条（首屏只干这一件事）
 * - 笔记：笔记列表 + 课堂记录（上传/作废）
 * - 待办：TodoView（作业汇总 + 倒计时 + 课程文件夹）
 * - 设置：配色风格、明暗、字体大小、录音音质、自动上传、连接电脑、检查更新
 * 底栏自绘（TabBar），主题色从 UiTheme 实时取；录音仍在 :rec 独立进程，切页/重建不影响录音。
 */
class MainActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())

    // 上课页
    private lateinit var statusLine: TextView
    private lateinit var recStatus: TextView
    private lateinit var recordBtn: Button
    private lateinit var photoBtn: Button
    private lateinit var markBtn: Button
    private lateinit var courseChips: LinearLayout
    private lateinit var verText: TextView
    private lateinit var updateBtn: Button
    private lateinit var photoScroll: HorizontalScrollView
    private lateinit var photoStrip: LinearLayout

    // 笔记页
    private var notesView: NotesView? = null

    // 底栏与页面
    private lateinit var content: FrameLayout
    private lateinit var tabBar: TabBar
    private val pages = arrayOfNulls<View>(4)
    private var currentTab = 0
    private var appliedTheme = ""
    private lateinit var settingsBox: LinearLayout
    private var todoView: TodoView? = null

    private var selectedCourse = ""

    private var pendingPhotoName = ""
    private var pendingPhotoSid = ""
    private var pendingPhotoAt = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // v2.5：相机在前台时主界面若被系统回收重建，待回收照片的会话/时间点不能丢
        // （丢了 onActivityResult 会直接返回，照片静默消失）
        pendingPhotoName = savedInstanceState?.getString("pendingPhotoName") ?: ""
        pendingPhotoSid = savedInstanceState?.getString("pendingPhotoSid") ?: ""
        pendingPhotoAt = savedInstanceState?.getLong("pendingPhotoAt", 0L) ?: 0L
        Db.init(this)
        Api.initCredentials()
        appliedTheme = UiTheme.stamp(this)
        setTheme(if (UiTheme.dark) android.R.style.Theme_Material_NoActionBar
        else android.R.style.Theme_Material_Light_NoActionBar)
        UiTheme.applyWindow(this)
        requestPerms()
        buildUi()
    }

    override fun onResume() {
        super.onResume()
        // 系统深色模式在后台切换过 / 设置页改过主题：重建一次让所有页面用新色板
        val s = UiTheme.stamp(this)
        if (s != appliedTheme) {
            appliedTheme = s
            recreate()
            return
        }
        cleanupOrphans()
        if (!RecInfo.recording()) selectedCourse = Db.meta("lastCourse", "")
        refresh()
        refreshPhotos()
        asyncSync()
        // v2.3：更新后自动体检电脑上的损坏录音并补传（每个版本只自动跑一次，失败下次启动再试）
        Repair.autoCheck(this) { asyncSync(); refresh() }
        Upd.checkAsync(this)
        handler.postDelayed({ refreshUpdateBanner() }, 8000)
        if (currentTab == 2) todoView?.load(force = true)
    }

    private fun refreshUpdateBanner() {
        if (!::updateBtn.isInitialized) return
        val p = Upd.pendingUpdate()
        if (p != null) {
            updateBtn.visibility = View.VISIBLE
            updateBtn.text = "🆕 有新版 v${p.optString("versionName")}，点这里更新"
            verText.text = "v" + Upd.VERSION_NAME + "（可更新）"
        } else {
            updateBtn.visibility = View.GONE
            verText.text = "v" + Upd.VERSION_NAME
        }
    }

    // ---------- 权限 ----------
    private fun requestPerms() {
        val need = ArrayList<String>()
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.RECORD_AUDIO)
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (need.isNotEmpty()) requestPermissions(need.toTypedArray(), 7)
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(code, perms, results)
        if (code == 7 && results.isNotEmpty() && results[0] != PackageManager.PERMISSION_GRANTED) {
            Ui.toast(this, "不给麦克风权限就没法录课哦")
        }
    }

    // ---------- 界面骨架 ----------
    private fun buildUi() {
        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.background = Ui.glowBg()

        content = FrameLayout(this)
        root.addView(content, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        tabBar = TabBar(this)
        tabBar.onSelect = { selectTab(it) }
        root.addView(tabBar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        pages[0] = buildStudyPage()
        val nv = NotesView(this)
        nv.onRequestSync = { asyncSync(); refresh() }
        notesView = nv
        pages[1] = nv
        val tv = TodoView(this)
        tv.onCount = { n -> runOnUiThread { tabBar.setBadge(2, n) } }
        todoView = tv
        pages[2] = pageScrollWrap(tv)
        pages[3] = buildSettingsPage()

        for (p in pages) {
            content.addView(p, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        selectTab(0, refreshData = false)
        setContentView(root)
    }

    private fun pageScrollWrap(child: View): ScrollView {
        child.layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        return Ui.scroll(this, child)
    }

    private fun selectTab(i: Int, refreshData: Boolean = true) {
        if (i !in pages.indices) return
        val old = currentTab
        currentTab = i
        for (idx in pages.indices) {
            val p = pages[idx] ?: continue
            if (idx == i) {
                p.visibility = View.VISIBLE
                if (old != i) {
                    // 切页：淡入 + 轻微上浮，页面之间不再“啪”一下切换
                    p.animate().cancel()
                    p.alpha = 0f
                    p.translationY = Ui.dp(10).toFloat()
                    p.animate().alpha(1f).translationY(0f).setDuration(200).start()
                }
            } else {
                p.visibility = View.GONE
                p.animate().cancel()
                p.alpha = 1f
                p.translationY = 0f
            }
        }
        if (::tabBar.isInitialized) tabBar.select(i, notify = false)
        when (i) {
            1 -> if (refreshData) notesView?.refresh()
            2 -> todoView?.load()
            3 -> rebuildSettings()
        }
    }

    // ---------- 上课页 ----------
    private fun buildStudyPage(): View {
        val box = LinearLayout(this)
        box.orientation = LinearLayout.VERTICAL

        val head = Ui.card(this)
        head.addView(Ui.text(this, "📚 课堂笔记", 22, Ui.PRIMARY, true))
        statusLine = Ui.text(this, "…", 13, Ui.TEXT_SUB)
        head.addView(statusLine)
        val verRow = LinearLayout(this)
        verRow.orientation = LinearLayout.HORIZONTAL
        verRow.setPadding(0, Ui.dp(2), 0, 0)
        verText = Ui.text(this, "v" + Upd.VERSION_NAME, 11, Ui.TEXT_SUB)
        verRow.addView(verText)
        updateBtn = Ui.button(this, "🆕 有新版本，点这里更新", false)
        updateBtn.visibility = View.GONE
        updateBtn.setPadding(Ui.dp(10), Ui.dp(2), Ui.dp(10), Ui.dp(2))
        updateBtn.textSize = Ui.sp(12)
        val ulp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        ulp.leftMargin = Ui.dp(8)
        updateBtn.layoutParams = ulp
        updateBtn.setOnClickListener { Upd.pendingUpdate()?.let { p -> Upd.ask(this, p) } }
        verRow.addView(updateBtn)
        head.addView(verRow)
        box.addView(head)

        // 课程选择
        val courseCard = Ui.card(this)
        courseCard.addView(Ui.text(this, "上哪门课？", 15, Ui.TEXT, true))
        val hs = HorizontalScrollView(this)
        courseChips = LinearLayout(this)
        courseChips.orientation = LinearLayout.HORIZONTAL
        hs.addView(courseChips)
        courseCard.addView(hs)
        box.addView(courseCard)

        // 录课主卡
        val recCard = Ui.card(this)
        recCard.addView(Ui.text(this, "上课", 15, Ui.TEXT, true))
        recordBtn = Ui.bigButton(this, "▶ 开始上课")
        recordBtn.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(66)).also { it.topMargin = Ui.dp(6) }
        recordBtn.setOnClickListener { onRecordTap() }
        recCard.addView(recordBtn)

        val tools = LinearLayout(this)
        tools.orientation = LinearLayout.HORIZONTAL
        photoBtn = Ui.button(this, "📷 拍板书", false)
        markBtn = Ui.button(this, "🔖 标记一下", false)
        // v2.5 修复：v2.0 四标签改版漏接点击监听，两个按钮点了没反应（拍照/标记从 10-17 起全线失效）
        photoBtn.setOnClickListener { onPhotoTap() }
        markBtn.setOnClickListener { onMarkTap() }
        tools.addView(photoBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).also { it.rightMargin = Ui.dp(8) })
        tools.addView(markBtn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        tools.setPadding(0, Ui.dp(8), 0, 0)
        recCard.addView(tools)

        photoScroll = HorizontalScrollView(this)
        photoScroll.isHorizontalScrollBarEnabled = false
        photoStrip = LinearLayout(this)
        photoStrip.orientation = LinearLayout.HORIZONTAL
        photoStrip.setPadding(0, Ui.dp(8), 0, 0)
        photoScroll.addView(photoStrip)
        photoScroll.visibility = View.GONE
        recCard.addView(photoScroll)

        recStatus = Ui.text(this, "选好课程就能开录。录音中每 10 分钟自动存一段，上课放心息屏。", 13, Ui.TEXT_SUB)
        recStatus.setPadding(0, Ui.dp(8), 0, 0)
        recCard.addView(recStatus)
        box.addView(recCard)

        box.addView(Ui.text(this, "小提示：录音中拍板书会自动记下「第几分几秒」，下课后电脑把照片插进笔记对应位置。",
            11, Ui.TEXT_SUB).apply { setPadding(Ui.dp(8), Ui.dp(10), Ui.dp(8), Ui.dp(4)) })

        return pageScrollWrap(box)
    }

    // ---------- 设置页 ----------
    private fun buildSettingsPage(): View {
        val box = LinearLayout(this)
        box.orientation = LinearLayout.VERTICAL
        settingsBox = box
        fillSettings(box)
        return pageScrollWrap(box)
    }

    private fun rebuildSettings() {
        if (!::settingsBox.isInitialized) return
        settingsBox.removeAllViews()
        fillSettings(settingsBox)
    }

    private fun fillSettings(box: LinearLayout) {
        val head = Ui.card(this)
        head.addView(Ui.text(this, "⚙ 设置", 20, Ui.PRIMARY, true))
        head.addView(Ui.text(this, "v" + Upd.VERSION_NAME + " · 改完立即生效", 12, Ui.TEXT_SUB))
        box.addView(head)

        // 配色风格
        val themeCard = Ui.card(this)
        themeCard.addView(Ui.text(this, "🎨 配色风格", 15, Ui.TEXT, true))
        themeCard.addView(Ui.text(this, "四套都能选，点一下立即换；深色模式下会用对应深色版", 11, Ui.TEXT_SUB))
        for (id in listOf(UiTheme.ACADEMIC, UiTheme.PAPER, UiTheme.NIGHT, UiTheme.MORANDI)) {
            themeCard.addView(themeRow(id))
        }
        box.addView(themeCard)

        // 明暗 + 字体
        val lookCard = Ui.card(this)
        lookCard.addView(Ui.text(this, "🌓 显示", 15, Ui.TEXT, true))
        choiceRow(lookCard, "深色模式", listOf(
            "follow" to "跟随系统", "light" to "浅色", "dark" to "深色"
        ), Db.meta(UiTheme.KEY_DARK, "follow")) { v ->
            Db.setMeta(UiTheme.KEY_DARK, v)
            UiTheme.load(this)
            recreate()
        }
        choiceRow(lookCard, "字体大小", listOf(
            "90" to "小", "100" to "标准", "115" to "大"
        ), Db.meta(UiTheme.KEY_FONT, "100")) { v ->
            Db.setMeta(UiTheme.KEY_FONT, v)
            UiTheme.load(this)
            recreate()
        }
        choiceRow(lookCard, "笔记正文", listOf(
            "paper" to "精排纸面", "glass" to "玻璃卡片"
        ), Db.meta(UiTheme.KEY_NOTE_BODY, "paper")) { v ->
            Db.setMeta(UiTheme.KEY_NOTE_BODY, v)
            rebuildSettings()
            Ui.toast(this, if (v == "glass") "笔记正文已切成玻璃卡片（下次打开笔记生效）" else "笔记正文已切回精排纸面（下次打开笔记生效）")
        }
        lookCard.addView(Ui.text(this, "纸面更适合长时间阅读；玻璃卡片和 APP 其他页面更统一。深色模式自动适配。", 11, Ui.TEXT_SUB))
        box.addView(lookCard)

        // 录音偏好
        val recCard = Ui.card(this)
        recCard.addView(Ui.text(this, "🎙 录音", 15, Ui.TEXT, true))
        choiceRow(recCard, "音质（下一段录音生效）", listOf(
            "std" to "标准 16kHz", "hq" to "高保真 44.1kHz"
        ), Db.meta("recQuality", "std")) { v ->
            Db.setMeta("recQuality", v)
            rebuildSettings()
            Ui.toast(this, if (v == "hq") "已切到高保真：文件约 2.7 倍，转写效果不变" else "已切回标准音质：体积最小、转写最优")
        }
        recCard.addView(Ui.text(this, "标准音质是语音转写的最优档；高保真只在对录音本身有要求时用。", 11, Ui.TEXT_SUB))
        choiceRow(recCard, "自动上传", listOf(
            "auto" to "开", "wifi" to "仅 WiFi", "manual" to "关（手动）"
        ), Db.meta("autoUpload", "auto")) { v ->
            Db.setMeta("autoUpload", v)
            rebuildSettings()
            Ui.toast(this, when (v) {
                "wifi" -> "以后只在 WiFi 下自动传；移动网络下会留在手机里"
                "manual" -> "已关闭自动上传：去「笔记」页点课堂记录手动传"
                else -> "已恢复自动上传"
            })
        }
        recCard.addView(Ui.text(this, "关掉自动上传后，素材仍在手机里；到「笔记」页点那一组就能手动传。", 11, Ui.TEXT_SUB))
        box.addView(recCard)

        // 连接
        val connCard = Ui.card(this)
        connCard.addView(Ui.text(this, "🔗 连接", 15, Ui.TEXT, true))
        val pairBtn = Ui.button(this, "连接电脑 & AI 设置", false)
        pairBtn.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).also { it.topMargin = Ui.dp(6) }
        pairBtn.setOnClickListener { startActivity(Intent(this, PairActivity::class.java)) }
        connCard.addView(pairBtn)
        connCard.addView(Ui.text(this, if (Api.paired()) "当前：已连接你的电脑" else "当前：还没配对（同一 WiFi 下可一键自动找电脑）", 11, Ui.TEXT_SUB))
        box.addView(connCard)

        // 更新与关于
        val upCard = Ui.card(this)
        upCard.addView(Ui.text(this, "🔄 更新与关于", 15, Ui.TEXT, true))
        upCard.addView(Ui.text(this, "出品方：阿泰与朝瑞（ACC 2026 黑客松参赛作品）", 11, Ui.TEXT_SUB))
        val checkBtn = Ui.button(this, "检查更新（当前 v" + Upd.VERSION_NAME + "）", false)
        checkBtn.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).also { it.topMargin = Ui.dp(6) }
        checkBtn.setOnClickListener { Upd.checkNow(this) }
        upCard.addView(checkBtn)
        upCard.addView(Ui.text(this, "课堂笔记 v" + Upd.VERSION_NAME + "（versionCode " + Upd.VERSION_CODE + "）\n" +
                "录音与笔记都在你手机和家里电脑之间直传；电脑整理需要本地电脑端在运行。", 11, Ui.TEXT_SUB)
            .apply { setPadding(0, Ui.dp(8), 0, 0) })
        box.addView(upCard)
    }

    private fun themeRow(id: String): View {
        val row = LinearLayout(this)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = android.view.Gravity.CENTER_VERTICAL
        row.setPadding(0, Ui.dp(9), 0, Ui.dp(9))

        val sw = View(this)
        sw.background = Glass.swatch(id)
        row.addView(sw, LinearLayout.LayoutParams(Ui.dp(28), Ui.dp(28)))

        val col = LinearLayout(this)
        col.orientation = LinearLayout.VERTICAL
        col.addView(Ui.text(this, UiTheme.label(id), 14, Ui.TEXT, true))
        col.addView(Ui.text(this, UiTheme.desc(id), 11, Ui.TEXT_SUB))
        row.addView(col, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).also { it.leftMargin = Ui.dp(10) })

        if (UiTheme.id == id) row.addView(Ui.text(this, "✓", 18, Ui.PRIMARY, true))
        row.setOnClickListener {
            if (UiTheme.id != id) {
                Db.setMeta(UiTheme.KEY_THEME, id)
                UiTheme.load(this)
                recreate()
            }
        }
        return row
    }

    private fun choiceRow(box: LinearLayout, label: String, options: List<Pair<String, String>>, current: String, onPick: (String) -> Unit) {
        box.addView(Ui.text(this, label, 13, Ui.TEXT, true).apply { setPadding(0, Ui.dp(10), 0, Ui.dp(2)) })
        val row = LinearLayout(this)
        row.orientation = LinearLayout.HORIZONTAL
        for ((value, name) in options) {
            val chip = Ui.chip(this, name)
            if (value == current) {
                chip.background = Ui.roundBg(Ui.PRIMARY, 16)
                chip.setTextColor(Ui.ON_PRIMARY)
                chip.setTypeface(null, Typeface.BOLD)
            }
            chip.setOnClickListener { onPick(value) }
            row.addView(chip)
        }
        val hs = HorizontalScrollView(this)
        hs.addView(row)
        box.addView(hs)
    }

    // ---------- 数据刷新 ----------
    private fun refresh() {
        refreshCourses()
        if (currentTab == 1) notesView?.refresh()
        updateRecUi()
    }

    private fun refreshCourses() {
        courseChips.removeAllViews()
        val courses = Db.courses()
        if (selectedCourse.isNotEmpty() && !courses.contains(selectedCourse)) selectedCourse = ""
        for (c in courses) {
            val chip = Ui.chip(this, c)
            val selected = c == selectedCourse
            if (selected) {
                chip.setTextColor(Ui.ON_PRIMARY)
                chip.background = Ui.roundBg(Ui.PRIMARY, 16)
            }
            chip.setOnClickListener {
                selectedCourse = c
                Db.setMeta("lastCourse", c)
                refreshCourses()
            }
            courseChips.addView(chip)
        }
        val add = Ui.chip(this, "＋ 新建")
        add.setOnClickListener { addCourseDialog() }
        courseChips.addView(add)
    }

    private fun addCourseDialog() {
        val input = EditText(this)
        input.hint = "比如：高等数学"
        AlertDialog.Builder(this)
            .setTitle("新建课程")
            .setView(input)
            .setPositiveButton("建") { _, _ ->
                val name = input.text.toString().trim()
                if (name.isNotEmpty()) {
                    if (Db.addCourse(name)) {
                        selectedCourse = name
                        Db.setMeta("lastCourse", name)
                    } else Ui.toast(this, "这门课已经建过了")
                    refreshCourses()
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // ---------- 录课 ----------
    private fun onRecordTap() {
        if (RecInfo.recording()) {
            val ms = RecInfo.elapsedMs()
            val msg = if (ms < 2 * 60_000L)
                "这节才录了 ${Ui.dur(ms)}——像是误触碰开的？点「取消本节」就不上传电脑。"
            else
                "已录 ${Ui.dur(ms)}。结束录音后马上上传素材给电脑整理；录错了点「取消本节」。"
            AlertDialog.Builder(this)
                .setTitle("下课了？")
                .setMessage(msg)
                .setPositiveButton("下课") { _, _ ->
                    val i = Intent(this, Rec::class.java).setAction(Rec.ACTION_STOP)
                    startService(i)
                    handler.postDelayed({ refresh(); asyncSync() }, 800)
                }
                .setNeutralButton("取消本节") { _, _ -> confirmDiscard() }
                .setNegativeButton("继续录", null)
                .show()
        } else {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                requestPerms(); return
            }
            // 每次开录前必弹选课界面，避免录完才发现课程挂错
            coursePickDialog()
        }
    }

    private fun startWithCourse(course: String) {
        selectedCourse = course
        Db.setMeta("lastCourse", course)
        val i = Intent(this, Rec::class.java)
            .setAction(Rec.ACTION_START)
            .putExtra("course", course)
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i) else startService(i)
        Ui.toast(this, "《$course》开录了！认真听课，板书点拍照就行")
        handler.postDelayed({ refresh(); refreshPhotos() }, 500)
    }

    /** 取消本节录音的二次确认（防手滑）：作废后不上传、不出笔记；录音文件仍留在手机存储 */
    private fun confirmDiscard() {
        AlertDialog.Builder(this)
            .setTitle("取消这节课？")
            .setMessage("取消后这段录音不会上传电脑、也不会出笔记（录音文件仍留在手机存储，以防反悔）。确定是误触再取消。")
            .setPositiveButton("取消本节") { _, _ ->
                val i = Intent(this, Rec::class.java).setAction(Rec.ACTION_DISCARD)
                startService(i)
                Ui.toast(this, "已取消本节录音（不上传、不出笔记）")
                handler.postDelayed({ refresh() }, 800)
            }
            .setNegativeButton("手滑了，留着", null)
            .show()
    }

    /** 选课弹窗：单选历史课程（预选上次），可顺手新建；选完确认才开录 */
    private fun coursePickDialog() {
        val courses = Db.courses()
        if (courses.isEmpty()) {
            Ui.toast(this, "先建一门课程")
            addCourseThenPick()
            return
        }
        val names = courses.toTypedArray()
        var sel = names.indexOf(selectedCourse).let { if (it >= 0) it else 0 }
        AlertDialog.Builder(this)
            .setTitle("这节上什么课？")
            .setSingleChoiceItems(names, sel) { _, which -> sel = which }
            .setPositiveButton("开始上课") { _, _ -> maybeBatteryWhitelist(); startWithCourse(names[sel]) }
            .setNeutralButton("＋新建课程") { _, _ -> addCourseThenPick() }
            .setNegativeButton("先不上", null)
            .show()
    }

    /**
     * 开录前一次性引导电池优化白名单：荣耀/华为等省电策略会息屏后杀后台，
     * 这是「上课录着录着就停了」的头号原因。拿不豁免也照常录，只是被杀概率高。
     */
    private fun maybeBatteryWhitelist() {
        val pm = getSystemService(android.content.Context.POWER_SERVICE) as android.os.PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) return
        if (Db.meta("battAsked") == "1") return
        Db.setMeta("battAsked", "1")
        AlertDialog.Builder(this)
            .setTitle("上课录音防中断（一次性设置）")
            .setMessage("手机的省电策略可能会在息屏后停掉录音。点「去设置」，允许课堂笔记「忽略电池优化」，能大幅降低录音被系统掐断的概率。\n\n就算不设置也照样能录，被中断时 APP 会马上通知你。")
            .setPositiveButton("去设置") { _, _ ->
                try {
                    startActivity(Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
                } catch (_: Exception) {
                    try { startActivity(Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) } catch (_: Exception) { }
                }
            }
            .setNegativeButton("先不用", null)
            .show()
    }

    private fun addCourseThenPick() {
        val input = EditText(this)
        input.hint = "比如：高等数学"
        AlertDialog.Builder(this)
            .setTitle("新建课程")
            .setView(input)
            .setPositiveButton("建") { _, _ ->
                val name = input.text.toString().trim()
                if (name.isNotEmpty()) {
                    if (!Db.addCourse(name)) Ui.toast(this, "这门课已经建过了")
                    selectedCourse = name
                    Db.setMeta("lastCourse", name)
                    refreshCourses()
                }
                coursePickDialog()
            }
            .setNegativeButton("取消") { _, _ -> coursePickDialog() }
            .show()
    }

    // ---------- 课堂标记 ----------
    private fun onMarkTap() {
        val cur = RecInfo.current()
        if (cur == null) {
            Ui.toast(this, "开录之后才能做标记")
            return
        }
        val sid = cur.optString("sid")
        val types = arrayOf("❓ 这里没听懂", "⭐ 这里讲得好 / 喜欢这句", "🔖 普通重点")
        val marks = arrayOf("❓没听懂", "⭐讲得好", "🔖重点")
        val note = EditText(this)
        note.hint = "备注一句话（可选）：哪个点/哪句话"
        val rg = android.widget.RadioGroup(this)
        for (t in types) {
            val rb = android.widget.RadioButton(this)
            rb.text = t
            rb.textSize = Ui.sp(15)
            rg.addView(rb)
        }
        (rg.getChildAt(0) as android.widget.RadioButton).isChecked = true
        val box = LinearLayout(this)
        box.orientation = LinearLayout.VERTICAL
        box.setPadding(Ui.dp(20), Ui.dp(8), Ui.dp(20), 0)
        box.addView(Ui.text(this, "现在是第 ${Ui.dur(RecInfo.offsetMs())}，标记哪种？", 14, Ui.TEXT))
        box.addView(rg)
        box.addView(note)
        AlertDialog.Builder(this)
            .setTitle("🔖 做个标记")
            .setView(box)
            .setPositiveButton("标记") { _, _ ->
                val off = RecInfo.offsetMs()
                if (off < 0) { Ui.toast(this, "录音刚好结束了，这个标记没记上"); return@setPositiveButton }
                val type = marks[rg.indexOfChild(rg.findViewById(rg.checkedRadioButtonId)).coerceIn(0, marks.size - 1)]
                Db.addMark(sid, off, type, note.text.toString().trim().take(200))
                Ui.toast(this, "已标记（$type · 第 ${Ui.dur(off)} 处），整理笔记时会重点提取")
                refresh()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun onPhotoTap() {
        val cur = RecInfo.current()
        if (cur == null) {
            Ui.toast(this, "先开始上课，拍的照片才有时间定位")
            return
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPerms(); return
        }
        val sid = cur.optString("sid")
        val name = "${sid}_p${Db.photoFileCount(sid) + 1}.jpg"
        val uri = Uri.parse("content://com.hxt.classnotes.photos/$name")
        val i = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
            .putExtra(MediaStore.EXTRA_OUTPUT, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        pendingPhotoName = name
        pendingPhotoSid = sid
        pendingPhotoAt = RecInfo.offsetMs()
        try {
            startActivityForResult(i, 41)
        } catch (_: Exception) {
            Ui.toast(this, "手机上没有能用的相机")
            pendingPhotoName = ""
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString("pendingPhotoName", pendingPhotoName)
        outState.putString("pendingPhotoSid", pendingPhotoSid)
        outState.putLong("pendingPhotoAt", pendingPhotoAt)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != 41) return
        val name = pendingPhotoName
        val sid = pendingPhotoSid
        pendingPhotoName = ""
        pendingPhotoSid = ""
        if (name.isEmpty()) return
        val camFile = File(File(filesDir, "camera"), name)
        if (resultCode != RESULT_OK || !camFile.exists() || camFile.length() == 0L) {
            camFile.delete()   // 相机取消时的空壳文件，不算删素材
            return
        }
        val dir = File(File(filesDir, "sessions"), sid).apply { mkdirs() }
        val out = File(dir, name)
        val orig = File(dir, "orig_$name")
        camFile.renameTo(orig)
        Img.compress(orig, out)
        val offset = if (pendingPhotoAt >= 0) pendingPhotoAt else RecInfo.offsetMs()
        Db.addPhoto(sid, name, out.absolutePath, orig.absolutePath, offset)
        Ui.toast(this, "第 ${Db.photoFileCount(sid)} 张拍好了（第 ${Ui.dur(offset)} 处），下面缩略图点开可放大检查")
        refresh()
        refreshPhotos()
    }

    // ---------- 其他 ----------
    private fun cleanupOrphans() {
        // 上次录音被系统杀死没来得及收尾的会话：落成 ready；
        // v1.8：Rec 在独立进程——心跳（meta.recHB，30 秒一发）新鲜=服务还活着在录，绝不能当孤儿收尸
        if (RecInfo.heartbeatFresh()) return
        val sess = Db.sessions(100)
        for (i in 0 until sess.length()) {
            val s = sess.getJSONObject(i)
            val sid = s.getString("sid")
            when (s.optString("state")) {
                "recording" -> {
                    val startedAt = s.getLong("startedAt")
                    val dir = File(File(filesDir, "sessions"), sid)
                    Thread {
                        val real = Db.realRecordedMs(dir)
                        val dur = real ?: (System.currentTimeMillis() - startedAt).coerceAtLeast(0L)
                        val ended = if (real != null) startedAt + dur else System.currentTimeMillis()
                        Db.finishSession(sid, ended, dur)
                        handler.post { refresh() }
                    }.start()
                }
                "uploading" -> {
                    // 卡在上传中的（上传线程早死了，比如 APP 传一半被杀）：拨回 ready，让同步自动重传
                    if (sid !in Api.activeUploads) Db.setSessionState(sid, "ready")
                }
            }
        }
    }

    private fun asyncSync() {
        // 录音中不同步：别在上课时抢网络/电量传大文件，下课再传
        if (RecInfo.recording()) {
            statusLine.text = "录音中，联网同步先歇着（下课会自动传）"
            return
        }
        statusLine.text = "同步中…"
        Thread {
            val msg = try { Api.syncAll(this) } catch (e: Exception) { "同步出错：${e.message}" }
            handler.post {
                statusLine.text = msg
                refresh()
                if (currentTab == 2) todoView?.load(force = true)
            }
        }.start()
    }

    private fun updateRecUi() {
        if (RecInfo.recording()) {
            recordBtn.text = "■ 下课（结束录音）"
            recordBtn.background = Ui.roundBg(Ui.RED, 18)
            recordBtn.setTextColor(Ui.ON_PRIMARY)
            photoBtn.isEnabled = true
            photoBtn.alpha = 1f
            markBtn.isEnabled = true
            markBtn.alpha = 1f
        } else {
            recordBtn.text = "▶ 开始上课"
            recordBtn.background = Glass.primaryBg(18)
            recordBtn.setTextColor(Ui.ON_PRIMARY)
            photoBtn.isEnabled = false
            photoBtn.alpha = 0.5f
            markBtn.isEnabled = false
            markBtn.alpha = 0.5f
            photoScroll.visibility = View.GONE
        }
    }

    private val ticker = object : Runnable {
        override fun run() {
            val cur = RecInfo.current()
            if (cur != null) {
                val sid = cur.optString("sid")
                val elapsed = RecInfo.elapsedMs()
                val seg = elapsed / Rec.SEGMENT_MS + 1
                recStatus.text = "正在录《${cur.optString("course")}》  已录 ${Ui.dur(elapsed)} · 第 $seg 段 · 拍照 ${Db.photoFileCount(sid)} 张 · 标记 ${Db.markCount(sid)} 处"
                handler.postDelayed(this, 1000)
            }
        }
    }

    override fun onPause() {
        super.onPause()
        handler.removeCallbacks(ticker)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && RecInfo.recording()) handler.post(ticker)
    }

    // ---------- 拍照即时查看 ----------
    /** 录音中拍照键下方的缩略图横条：后台线程生成/取小图缓存，主线程只摆 ImageView；点开进大图查看 */
    private fun refreshPhotos() {
        val cur = RecInfo.current()
        if (cur == null) {
            photoStrip.removeAllViews()
            photoScroll.visibility = View.GONE
            return
        }
        val sid = cur.optString("sid")
        val list = Db.photos(sid)
        if (list.length() == 0) {
            photoStrip.removeAllViews()
            photoScroll.visibility = View.GONE
            return
        }
        Thread {
            // 小图缓存 filesDir/thumbs/<sid_pN>.jpg（144px 档），生成一次反复用；主线程绝不解码大图
            val thumbs = ArrayList<Pair<Int, File?>>()
            for (i in 0 until list.length()) {
                val p = list.getJSONObject(i)
                thumbs.add(Pair(i, ensureThumb(sid, p.optString("name"), p.optString("path"))))
            }
            handler.post {
                if (isFinishing || isDestroyed) return@post
                if (RecInfo.currentSid() != sid) return@post   // 会话已换/已停，别摆旧图
                photoStrip.removeAllViews()
                for ((i, tf) in thumbs) {
                    val iv = android.widget.ImageView(this)
                    val lp = LinearLayout.LayoutParams(Ui.dp(72), Ui.dp(72))
                    lp.rightMargin = Ui.dp(6)
                    iv.layoutParams = lp
                    iv.scaleType = android.widget.ImageView.ScaleType.CENTER_CROP
                    iv.background = Ui.roundBg(Ui.HILITE, 8)
                    iv.clipToOutline = true
                    if (tf != null && tf.exists()) {
                        try { iv.setImageBitmap(android.graphics.BitmapFactory.decodeFile(tf.absolutePath)) } catch (_: Exception) { }
                    }
                    iv.setOnClickListener { startActivity(Intent(this, PhotoActivity::class.java).putExtra("sid", sid).putExtra("index", i)) }
                    photoStrip.addView(iv)
                }
                photoScroll.visibility = View.VISIBLE
                photoStrip.post { photoScroll.fullScroll(View.FOCUS_RIGHT) }   // 最新一张露出来
            }
        }.start()
    }

    /** 生成 144px 档缩略图缓存文件；已有直接返回；解码失败返回 null（横条上留灰底占位） */
    private fun ensureThumb(sid: String, name: String, path: String): File? {
        return try {
            val f = File(File(filesDir, "thumbs"), name)
            if (f.exists() && f.length() > 0) return f
            val src = File(path)
            if (!src.exists()) return null
            val opt = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
            android.graphics.BitmapFactory.decodeFile(src.absolutePath, opt)
            if (opt.outWidth <= 0) return null
            var sample = 1
            while (maxOf(opt.outWidth, opt.outHeight) / (sample * 2) >= 288) sample *= 2
            val bmp = android.graphics.BitmapFactory.decodeFile(src.absolutePath, android.graphics.BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
            f.parentFile?.mkdirs()
            f.outputStream().use { bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 70, it) }
            bmp.recycle()
            f
        } catch (_: Exception) { null }
    }
}
