package com.hxt.classnotes

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 「重传并验证」面板（2026-10-24 由测试版并入生产）。
 *
 * 选择层：按会话勾选（默认全选），只列 ready/uploaded，录音中的会话不给选。
 * 进度层：不可取消，实时显示 节/文件/块、实发/续传、速度、分块 MD5 通过数。
 * 结果层：整文件 MD5+字节逐项列出，失败可原地重试（续传），报告可复制。
 */
object TestReuploadUi {
    private val main = Handler(Looper.getMainLooper())
    private val hm = SimpleDateFormat("HH:mm", Locale.CHINA)

    fun open(act: Activity, course: String, dayIso: String, items: List<JSONObject>, onFinished: () -> Unit) {
        if (TestReupload.isRunning()) {
            Ui.toast(act, "已有重传任务在跑，等它结束")
            return
        }
        val usable = items.filter {
            val st = it.optString("state")
            st != "recording" && st != "cancelled"
        }
        if (usable.isEmpty()) {
            Ui.toast(act, "这组没有可传的录音（录音中的等下课）")
            return
        }
        val planAll = TestReupload.buildPlan(course, dayIso, usable)
        val checked = BooleanArray(usable.size) { true }

        val box = LinearLayout(act)
        box.orientation = LinearLayout.VERTICAL
        box.setPadding(Ui.dp(18), Ui.dp(6), Ui.dp(18), 0)

        val target = Api.savedUrl()
        val tvTarget = Ui.text(act,
            "目标电脑：" + if (target.isEmpty()) "未配对（先回主页进「连接电脑」配对）" else target,
            12, if (target.isEmpty()) Ui.RED else Ui.TEXT_SUB, true)
        tvTarget.setOnClickListener { act.startActivity(Intent(act, PairActivity::class.java)) }
        box.addView(tvTarget)
        box.addView(Ui.text(act,
            "已传过的会话会先把电脑上的旧素材备份到 files_备份（不删），再从手机重传；手机里的录音不动。",
            11, Ui.TEXT_SUB))

        val scroll = ScrollView(act)
        val rows = LinearLayout(act)
        rows.orientation = LinearLayout.VERTICAL
        scroll.addView(rows)
        val sum = Ui.text(act, "", 12, Ui.PRIMARY, true)
        sum.setPadding(0, Ui.dp(6), 0, Ui.dp(2))

        fun label(i: Int): String {
            val it = planAll.items[i]
            val st = when (it.state) {
                "uploaded" -> "已传"
                "uploading" -> "上传中"
                else -> "待上传"
            }
            return "${hm.format(Date(it.startedAt))} 开录 · ${Ui.dur(it.durMs)} · ${fmtBytes(it.bytes)} · $st"
        }

        fun updateSummary() {
            var n = 0
            var b = 0L
            for (i in checked.indices) if (checked[i]) { n++; b += planAll.items[i].bytes }
            sum.text = "已选 $n/${usable.size} 节 · 共 ${fmtBytes(b)}"
        }

        val boxes = ArrayList<CheckBox>()
        for (i in usable.indices) {
            val cb = CheckBox(act)
            cb.text = label(i)
            cb.textSize = Ui.sp(13)
            cb.isChecked = true
            cb.setPadding(0, Ui.dp(3), 0, Ui.dp(3))
            cb.setOnCheckedChangeListener { _, on -> checked[i] = on; updateSummary() }
            boxes.add(cb)
            rows.addView(cb)
        }
        scroll.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(238))
        box.addView(scroll)

        val tools = LinearLayout(act)
        tools.orientation = LinearLayout.HORIZONTAL
        tools.gravity = Gravity.CENTER_VERTICAL
        val allBtn = Ui.button(act, "全选", false)
        allBtn.textSize = Ui.sp(12)
        allBtn.setOnClickListener {
            for (i in checked.indices) { checked[i] = true; boxes[i].isChecked = true }
            updateSummary()
        }
        val noneBtn = Ui.button(act, "全不选", false)
        noneBtn.textSize = Ui.sp(12)
        noneBtn.setOnClickListener {
            for (i in checked.indices) { checked[i] = false; boxes[i].isChecked = false }
            updateSummary()
        }
        tools.addView(allBtn)
        val gap = LinearLayout.LayoutParams(Ui.dp(8), 1)
        tools.addView(android.view.View(act), gap)
        tools.addView(noneBtn)
        box.addView(tools)
        box.addView(sum)
        updateSummary()

        val wrap = ScrollView(act)
        wrap.addView(box)
        val dlg = AlertDialog.Builder(act)
            .setTitle("重传并验证《${course}》${dayIso}")
            .setView(wrap)
            .setPositiveButton("开始", null)
            .setNegativeButton("取消", null)
            .create()
        dlg.setOnShowListener {
            dlg.window?.setLayout(dialogWidth(act), ViewGroup.LayoutParams.WRAP_CONTENT)
            dlg.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val sel = ArrayList<JSONObject>()
                for (i in checked.indices) if (checked[i]) sel.add(usable[i])
                if (sel.isEmpty()) { Ui.toast(act, "至少选一节"); return@setOnClickListener }
                if (target.isEmpty()) {
                    Ui.toast(act, "还没配对电脑，先去配对")
                    act.startActivity(Intent(act, PairActivity::class.java))
                    return@setOnClickListener
                }
                dlg.dismiss()
                showProgress(act, TestReupload.buildPlan(course, dayIso, sel), false, onFinished)
            }
        }
        dlg.show()
        dlg.window?.setLayout(dialogWidth(act), ViewGroup.LayoutParams.WRAP_CONTENT)
    }

    private fun dialogWidth(act: Activity): Int {
        val screen = act.resources.displayMetrics.widthPixels
        return minOf(Ui.dp(390), screen - Ui.dp(24))
    }

    private fun showProgress(act: Activity, plan: TestReupload.Plan?, retry: Boolean, onFinished: () -> Unit) {
        val box = LinearLayout(act)
        box.orientation = LinearLayout.VERTICAL
        box.setPadding(Ui.dp(20), Ui.dp(8), Ui.dp(20), 0)

        val phase = Ui.text(act, "准备", 14, Ui.PRIMARY, true)
        // v2.9：上传改成前台服务，退后台/锁屏不会再断
        val hint = Ui.text(act, "可以退到后台或锁屏，都会继续传；进度也在通知栏里。", 11, Ui.TEXT_SUB)
        hint.setPadding(0, Ui.dp(2), 0, Ui.dp(4))
        val msg = Ui.text(act, "", 12, Ui.TEXT_SUB)
        val bar = ProgressBar(act, null, android.R.attr.progressBarStyleHorizontal)
        bar.max = 1000
        val bytes = Ui.text(act, "", 13, Ui.TEXT, true)
        val chunk = Ui.text(act, "", 12, Ui.TEXT_SUB)
        val speed = Ui.text(act, "", 12, Ui.TEXT_SUB)
        val extra = Ui.text(act, "", 12, Ui.TEXT_SUB)
        box.addView(phase)
        box.addView(hint)
        box.addView(msg)
        val barLp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(10))
        barLp.topMargin = Ui.dp(8)
        box.addView(bar, barLp)
        for (v in listOf(bytes, chunk, speed, extra)) {
            v.setPadding(0, Ui.dp(6), 0, 0)
            box.addView(v)
        }

        val dlg = AlertDialog.Builder(act)
            .setTitle("重传并验证中（可切后台）")
            .setView(box)
            .setCancelable(false)
            .create()
        dlg.setCanceledOnTouchOutside(false)
        dlg.show()
        dlg.window?.setLayout(dialogWidth(act), ViewGroup.LayoutParams.WRAP_CONTENT)

        fun render(s: TestReupload.State) {
            phase.text = s.phase + if (s.message.isNotEmpty()) " · ${s.message}" else ""
            val sec = if (s.sessionCount > 0) "第 ${s.sessionNo}/${s.sessionCount} 节" else ""
            val fil = if (s.fileCount > 0) "文件 ${s.fileNo}/${s.fileCount}" else ""
            val ck = if (s.chunkTotal > 0) "分块 ${s.chunkNo}/${s.chunkTotal}" else ""
            msg.text = listOf(sec, fil, ck).filter { it.isNotEmpty() }.joinToString(" · ")
            val processed = (s.sentBytes + s.resumedBytes).coerceAtMost(s.totalBytes)
            bar.progress = if (s.totalBytes > 0) ((processed * 1000) / s.totalBytes).toInt() else 0
            val pct = if (s.totalBytes > 0) processed * 100 / s.totalBytes else 0
            bytes.text = "已处理 $pct% · 本次实发 ${fmtBytes(s.sentBytes)} / ${fmtBytes(s.totalBytes)}"
            chunk.text = "分块 MD5 通过 ${s.md5ChunkPass}/${s.md5ChunkTotal} · 重试 ${s.retries} 次"
            speed.text = String.format(Locale.CHINA, "平均 %.2f MB/s · 已用 %ds（上传 %ds）",
                s.speedBps / 1048576.0, s.elapsedMs / 1000, s.uploadElapsedMs / 1000)
            extra.text = "续传跳过 ${fmtBytes(s.resumedBytes)}" +
                (if (s.currentFile.isNotEmpty()) "\n当前文件：${s.currentFile}" else "")
        }
        render(TestReupload.snapshot())

        val tick = object : Runnable {
            override fun run() {
                if (dlg.isShowing) {
                    render(TestReupload.snapshot())
                    main.postDelayed(this, 500)
                }
            }
        }
        dlg.setOnDismissListener { main.removeCallbacks(tick) }
        main.post(tick)

        val onUpdate: (TestReupload.State) -> Unit = { s ->
            main.post { if (dlg.isShowing) render(s) }
        }
        val onDone: (TestReupload.State) -> Unit = { s ->
            main.post {
                if (dlg.isShowing) dlg.dismiss()
                if (!act.isFinishing && !act.isDestroyed) showResult(act, s, onFinished)
            }
        }
        if (retry) TestReupload.retry(onUpdate, onDone)
        else if (plan != null) TestReupload.start(act, plan, onUpdate, onDone)
    }

    private fun showResult(act: Activity, s: TestReupload.State, onFinished: () -> Unit) {
        val title = when {
            s.failed -> "重传中断"
            !s.allMatch -> "传完了，但有文件不一致"
            !s.notifyOk -> "传完且核对一致，但没通知到电脑"
            else -> "重传并验证完成"
        }
        val body = TextView(act)
        body.text = TestReupload.reportText(s)
        body.textSize = Ui.sp(11)
        body.setTextColor(Ui.TEXT)
        body.setTypeface(Typeface.MONOSPACE)
        body.setPadding(Ui.dp(18), Ui.dp(6), Ui.dp(18), 0)
        val scroll = ScrollView(act)
        scroll.addView(body)
        scroll.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(330))

        val canRetry = s.failed || !s.allMatch
        val b = AlertDialog.Builder(act)
            .setTitle(title)
            .setView(scroll)
            .setNeutralButton("复制报告", null)
            .setNegativeButton("关闭", null)
        if (canRetry) b.setPositiveButton("重试", null) else b.setPositiveButton("关闭", null)
        val dlg = b.create()
        dlg.setOnShowListener {
            dlg.window?.setLayout(dialogWidth(act), ViewGroup.LayoutParams.WRAP_CONTENT)
            dlg.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener { copy(act, TestReupload.reportText(s)) }
            if (canRetry) {
                dlg.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                    dlg.dismiss()
                    showProgress(act, null, true, onFinished)
                }
                dlg.getButton(AlertDialog.BUTTON_NEGATIVE).setOnClickListener { dlg.dismiss(); onFinished() }
            } else {
                dlg.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener { dlg.dismiss(); onFinished() }
                dlg.getButton(AlertDialog.BUTTON_NEGATIVE).setOnClickListener { dlg.dismiss(); onFinished() }
            }
        }
        dlg.setCancelable(false)
        dlg.show()
        dlg.window?.setLayout(dialogWidth(act), ViewGroup.LayoutParams.WRAP_CONTENT)
    }

    private fun copy(act: Activity, text: String) {
        try {
            val cm = act.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("课堂笔记重传报告", text))
            Ui.toast(act, "报告已复制")
        } catch (_: Exception) {
            Ui.toast(act, "复制失败")
        }
    }

    private fun fmtBytes(n: Long): String = when {
        n >= 1024L * 1024 * 1024 -> String.format(Locale.CHINA, "%.2f GB", n / 1073741824.0)
        n >= 1024L * 1024 -> String.format(Locale.CHINA, "%.1f MB", n / 1048576.0)
        n >= 1024 -> String.format(Locale.CHINA, "%.1f KB", n / 1024.0)
        else -> "$n B"
    }
}
