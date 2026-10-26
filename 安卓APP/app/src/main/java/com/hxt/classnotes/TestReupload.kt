package com.hxt.classnotes

import android.content.Context
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 单节课/整组重传执行器（2026-10-24 由测试版并入生产）。
 *
 * 只做三件事：把现有会话级 prepare/upload 串起来、把每块实测数据收集成可显示的状态、
 * 传完后用 /api/session/verify 做整文件 MD5 + 字节核对。不改上传协议。
 *
 * 原上传接口在“已有线程在传”时返回 null（等同成功），重传面板改用 UploadOutcome 三态，
 * 避免面板把“忙”误报成完成。
 */
object TestReupload {
    // 必须与 Api.CHUNK 一致（v2.10 起都是 512 KiB），否则进度里的「第几块」会算错
    private const val CHUNK = 512L * 1024
    private const val PHASE_PREPARE = "准备"
    private const val PHASE_UPLOAD = "上传"
    private const val PHASE_VERIFY = "核对"
    private const val PHASE_NOTIFY = "通知"
    private const val PHASE_DONE = "完成"
    private const val PHASE_FAIL = "失败"

    data class Item(
        val sid: String, val course: String, val startedAt: Long, val durMs: Long,
        val state: String, val names: List<String>, val files: List<File>, val bytes: Long
    )

    data class Plan(val course: String, val dayIso: String, val items: List<Item>) {
        val totalBytes: Long get() = items.sumOf { it.bytes }
        val totalFiles: Int get() = items.sumOf { it.files.size }
    }

    data class CheckRow(
        val name: String, val clientSize: Long, val serverSize: Long, val sizeMatch: Boolean,
        val clientMd5: String, val serverMd5: String, val md5Match: Boolean, val error: String = ""
    )

    data class State(
        val running: Boolean = false,
        val done: Boolean = false,
        val failed: Boolean = false,
        val phase: String = "",
        val message: String = "",
        val sessionNo: Int = 0,
        val sessionCount: Int = 0,
        val fileNo: Int = 0,
        val fileCount: Int = 0,
        val chunkNo: Int = 0,
        val chunkTotal: Int = 0,
        val currentFile: String = "",
        val currentSid: String = "",
        val totalBytes: Long = 0,
        val sentBytes: Long = 0,
        val resumedBytes: Long = 0,
        val receivedBytes: Long = 0,
        val elapsedMs: Long = 0,
        val uploadElapsedMs: Long = 0,
        val speedBps: Double = 0.0,
        val md5ChunkPass: Int = 0,
        val md5ChunkTotal: Int = 0,
        val retries: Int = 0,
        val checks: List<CheckRow> = emptyList(),
        val allMatch: Boolean = false,
        val missing: List<String> = emptyList(),
        val extra: List<String> = emptyList(),
        val notifyOk: Boolean = true,
        val noteState: String = "",
        val failStage: String = "",
        val failDetail: String = "",
        val failOffset: Long = 0,
        val startedMono: Long = 0,
        val reportPath: String = ""
    )

    private val lock = Any()
    @Volatile private var st = State()
    private var plan: Plan? = null
    private var appCtx: Context? = null
    private var resumeIndex = 0
    private val prepared = HashSet<String>()
    private var anchor = ""
    private var uploadStartMono = 0L
    private var uploadElapsedMs = 0L
    private var uploadSent = 0L
    private var resumedBytes = 0L
    private var passedChunks = 0
    private var retries = 0
    private val seenFiles = HashSet<String>()

    fun snapshot(): State = st
    fun isRunning(): Boolean = st.running

    /** 从“课堂记录”组的会话 JSON 生成计划；摘要字节按本地实际文件算 */
    fun buildPlan(course: String, dayIso: String, items: List<JSONObject>): Plan {
        val out = ArrayList<Item>()
        for (s in items) {
            val sid = s.optString("sid")
            val dir = Db.session(sid)?.optString("dir") ?: ""
            val files = localFiles(sid, dir)
            out.add(Item(
                sid, s.optString("course", course), s.optLong("startedAt"),
                s.optLong("durMs"), s.optString("state"),
                files.map { it.name }, files, files.sumOf { it.length() }
            ))
        }
        return Plan(course, dayIso, out)
    }

    /** 会话的录音/照片文件：以 Db 登记为准，文件不存在也保留名字（失败态要能点名） */
    private fun localFiles(sid: String, dirPath: String): List<File> {
        val dir = if (dirPath.isNotEmpty()) File(dirPath) else File(File(appCtx?.filesDir ?: File("."), "sessions"), sid)
        val out = ArrayList<File>()
        val seen = HashSet<String>()
        val segs = Db.segments(sid)
        for (i in 0 until segs.length()) {
            val n = segs.getJSONObject(i).optString("name")
            if (n.isNotEmpty() && seen.add(n)) out.add(File(dir, n))
        }
        val photos = Db.photos(sid)
        for (i in 0 until photos.length()) {
            val o = photos.getJSONObject(i)
            val n = o.optString("name")
            if (n.isNotEmpty() && seen.add(n)) {
                val p = o.optString("path")
                out.add(if (p.isNotEmpty() && File(p).exists()) File(p) else File(dir, n))
            }
        }
        if (out.isEmpty()) {
            dir.listFiles { f -> f.name.startsWith("recording_") && f.name.endsWith(".m4a") }
                ?.sortedBy { it.name }?.forEach { out.add(it) }
        }
        return out
    }

    fun start(ctx: Context, p: Plan, onUpdate: (State) -> Unit, onDone: (State) -> Unit) {
        synchronized(lock) {
            if (st.running) return
            appCtx = ctx.applicationContext
            plan = p
            resumeIndex = 0
            prepared.clear()
            anchor = ""
            uploadStartMono = 0L
            uploadElapsedMs = 0L
            uploadSent = 0L
            resumedBytes = 0L
            passedChunks = 0
            retries = 0
            seenFiles.clear()
            val chunks = p.items.sumOf { it.files.sumOf { f -> ((f.length() + CHUNK - 1) / CHUNK).toInt() } }
            st = State(
                running = true, phase = PHASE_PREPARE, message = "正在检查连接…",
                sessionCount = p.items.size, fileCount = p.totalFiles,
                totalBytes = p.totalBytes, md5ChunkTotal = chunks,
                startedMono = SystemClock.elapsedRealtime()
            )
        }
        onUpdate(st)
        Thread { run(false, onUpdate, onDone) }.start()
    }

    /** 失败后原地重试：已 prepare 过的会话不再 prepare，已传字节按服务端 received 续传 */
    fun retry(onUpdate: (State) -> Unit, onDone: (State) -> Unit) {
        synchronized(lock) {
            if (st.running || !st.failed) return
            st = st.copy(running = true, failed = false, phase = PHASE_PREPARE, message = "继续上次进度…")
        }
        onUpdate(st)
        Thread { run(true, onUpdate, onDone) }.start()
    }

    private fun run(isRetry: Boolean, onUpdate: (State) -> Unit, onDone: (State) -> Unit) {
        val p = plan ?: return
        try {
            if (Api.workingUrl() == null) {
                fail(onUpdate, onDone, PHASE_PREPARE, "连不上电脑（电脑关机/隧道没通/手机不在同一网络）")
                return
            }
            if (!isRetry) { resumeIndex = 0; anchor = ""; prepared.clear() }

            var doneSessions = 0
            for (i in 0 until resumeIndex) doneSessions++

            for (i in resumeIndex until p.items.size) {
                val item = p.items[i]
                val no = i + 1
                // 已上传的会话要先把电脑旧文件挪备份；首次上传（ready）不需要 prepare
                if (item.state != "ready" && !prepared.contains(item.sid)) {
                    setState(onUpdate, st.copy(
                        phase = PHASE_PREPARE, sessionNo = no, currentSid = item.sid,
                        message = "正在让电脑备份第 $no/${p.items.size} 节的旧文件…"
                    ))
                    val (ok, msg) = Api.prepareReupload(item.sid)
                    if (!ok) {
                        // 干净测试实例里没有这一节的 meta：当成首次上传即可，不能因此卡死
                        if (msg.contains("没有这个会话")) {
                            prepared.add(item.sid)
                        } else {
                            fail(onUpdate, onDone, PHASE_PREPARE, "第 ${no} 节准备失败：$msg")
                            return
                        }
                    } else {
                        if (msg.isNotEmpty()) anchor = msg
                        prepared.add(item.sid)
                    }
                }

                if (uploadStartMono == 0L) uploadStartMono = SystemClock.elapsedRealtime()
                setState(onUpdate, st.copy(
                    phase = PHASE_UPLOAD, sessionNo = no, currentSid = item.sid,
                    message = "上传第 $no/${p.items.size} 节…"
                ))
                Db.setSessionState(item.sid, "uploading")
                var outcome = Api.uploadSessionTracked(item.sid, null) { ev ->
                    onTx(item, no, ev, onUpdate)
                }
                // v2.10：网络类失败不再「一断就完」——自动再试最多 3 轮（每轮歇 8 秒）。
                // 已传字节电脑上有记录，重试是续传，不会从头传。
                var round = 0
                while (!outcome.ok && !outcome.busy && round < 3 && st.running) {
                    round++
                    setState(onUpdate, st.copy(
                        phase = PHASE_UPLOAD, sessionNo = no, currentSid = item.sid,
                        message = "第 $no 节中断（${outcome.error ?: "网络中断"}），8 秒后自动重试第 $round 次…"
                    ))
                    Api.reportClientLog("auto-retry", "第 $no 节 ${outcome.error ?: ""} · 线路 ${Api.currentRoute()}")
                    try { Thread.sleep(8000) } catch (_: InterruptedException) { return }
                    outcome = Api.uploadSessionTracked(item.sid, null) { ev ->
                        onTx(item, no, ev, onUpdate)
                    }
                }
                if (outcome.busy) {
                    fail(onUpdate, onDone, PHASE_UPLOAD, "第 ${no} 节正在被另一个上传任务占用，请等它结束")
                    return
                }
                if (!outcome.ok) {
                    fail(onUpdate, onDone, PHASE_UPLOAD, "第 ${no} 节上传失败：${outcome.error ?: "未知原因"}")
                    return
                }
                resumeIndex = i + 1
                doneSessions = no
            }
            uploadElapsedMs = if (uploadStartMono > 0) SystemClock.elapsedRealtime() - uploadStartMono else 0L

            // ---- 核对：整文件 MD5 + 字节数 ----
            setState(onUpdate, st.copy(
                phase = PHASE_VERIFY, message = "正在核对电脑端文件…",
                uploadElapsedMs = uploadElapsedMs
            ))
            val checks = ArrayList<CheckRow>()
            var allMatch = true
            var missing = emptyList<String>()
            var extra = emptyList<String>()
            for (item in p.items) {
                val r = Api.verifySession(item.sid, item.files)
                if (!r.ok) {
                    fail(onUpdate, onDone, PHASE_VERIFY, "第 ${p.items.indexOf(item) + 1} 节核对失败：${r.error ?: "未知错误"}")
                    return
                }
                if (!r.allMatch) allMatch = false
                if (r.missing.isNotEmpty()) missing = missing + r.missing
                if (r.extra.isNotEmpty()) extra = extra + r.extra
                for (f in r.files) checks.add(CheckRow(
                    f.name, f.clientSize, f.serverSize, f.sizeMatch,
                    f.clientMd5, f.serverMd5, f.md5Match, f.error
                ))
            }

            // ---- 通知电脑统一重新整理 ----
            setState(onUpdate, st.copy(phase = PHASE_NOTIFY, message = "正在通知电脑重新整理…", checks = checks))
            var notifyOk = true
            if (anchor.isNotEmpty()) notifyOk = Api.finishReupload(anchor)

            val elapsed = SystemClock.elapsedRealtime() - st.startedMono
            val speed = if (uploadElapsedMs > 500) uploadSent * 1000.0 / uploadElapsedMs else 0.0
            val report = saveReport(p, checks, allMatch, missing, extra, notifyOk, elapsed, "")
            setState(onUpdate, st.copy(
                running = false, done = true, phase = PHASE_DONE,
                message = "重传并验证完成", checks = checks, allMatch = allMatch,
                missing = missing, extra = extra, notifyOk = notifyOk,
                elapsedMs = elapsed, uploadElapsedMs = uploadElapsedMs,
                speedBps = speed, sessionNo = p.items.size,
                reportPath = report, noteState = if (anchor.isNotEmpty()) "已通知电脑" else "首次上传，已自动触发"
            ))
            onDone(st)
            pollNoteState(anchor, onUpdate)
        } catch (e: Exception) {
            fail(onUpdate, onDone, st.phase, e.message ?: "上传中断")
        }
    }

    private fun onTx(item: Item, sessionNo: Int, ev: Api.TxEvent, onUpdate: (State) -> Unit) {
        val fileIdx = item.files.indexOfFirst { it.name == ev.name }.let { if (it < 0) 0 else it + 1 }
        val fileChunks = ((ev.fileSize + CHUNK - 1) / CHUNK).toInt()
        synchronized(lock) {
            if (ev.ok) {
                if (ev.chunkBytes > 0) {
                    uploadSent += ev.chunkBytes
                    passedChunks++
                    if (seenFiles.add(ev.name) && ev.chunkStart > 0) resumedBytes += ev.chunkStart
                } else {
                    // 服务端已有整文件：跳过，不重复计实发字节
                    if (seenFiles.add(ev.name) && ev.received > 0) {
                        resumedBytes += ev.received
                        passedChunks += ((ev.received + CHUNK - 1) / CHUNK).toInt()
                    }
                }
            } else if (!ev.offsetMismatch) {
                retries++
            }
            val elapsed = SystemClock.elapsedRealtime() - st.startedMono
            val upMs = if (uploadStartMono > 0) SystemClock.elapsedRealtime() - uploadStartMono else 0L
            val speed = if (upMs > 500) uploadSent * 1000.0 / upMs else 0.0
            st = st.copy(
                phase = PHASE_UPLOAD, sessionNo = sessionNo, sessionCount = plan?.items?.size ?: st.sessionCount,
                fileNo = fileIdx, fileCount = item.files.size, currentFile = ev.name,
                chunkNo = ((ev.chunkStart + ev.chunkBytes + CHUNK - 1) / CHUNK).toInt().coerceAtMost(fileChunks),
                chunkTotal = fileChunks, sentBytes = uploadSent, resumedBytes = resumedBytes,
                receivedBytes = ev.received, elapsedMs = elapsed, uploadElapsedMs = upMs,
                speedBps = speed, md5ChunkPass = passedChunks, retries = retries
            )
        }
        onUpdate(st)
        try {
            // v2.10：通知栏带上线路和实时速度——局域网还是隧道、快还是慢，一眼可见
            val sp = if (st.speedBps > 1024) String.format(Locale.CHINA, " · %.0f KB/s", st.speedBps / 1024.0) else ""
            Sync.progress(
                "正在上传课堂笔记 ${st.sessionNo}/${st.sessionCount} 节 · ${Api.currentRoute()}",
                "${ev.name} · 分块 ${st.chunkNo}/${st.chunkTotal} · 已发 ${String.format(Locale.CHINA, "%.1f", st.sentBytes / 1048576.0)} MB$sp"
            )
        } catch (_: Exception) { }
    }

    private fun pollNoteState(anchor: String, onUpdate: (State) -> Unit) {
        if (anchor.isEmpty()) return
        Thread {
            val deadline = System.currentTimeMillis() + 3 * 60 * 1000
            while (System.currentTimeMillis() < deadline) {
                val s = Api.noteState(anchor)
                if (!s.isNullOrEmpty()) {
                    st = st.copy(noteState = s)
                    onUpdate(st)
                    if (s == "done" || s == "error") return@Thread
                }
                try { Thread.sleep(5000) } catch (_: InterruptedException) { return@Thread }
            }
        }.start()
    }

    private fun fail(onUpdate: (State) -> Unit, onDone: (State) -> Unit, stage: String, detail: String) {
        // v2.10：失败原因送回电脑（日志里能看到，不用再靠猜手机屏幕上写了什么）
        Api.reportClientLog("reupload-fail", "$stage：$detail")
        // 上传失败的那一节别把本地状态永远卡在 uploading（否则卡片按钮一直灰着，用户没法再点重试）
        if (stage == PHASE_UPLOAD && st.currentSid.isNotEmpty()) {
            val cur = plan?.items?.firstOrNull { it.sid == st.currentSid }
            if (cur != null) Db.setSessionState(cur.sid, if (cur.state == "uploaded") "uploaded" else "ready")
        }
        val elapsed = if (st.startedMono > 0) SystemClock.elapsedRealtime() - st.startedMono else 0L
        val report = saveReport(plan, st.checks, false, st.missing, st.extra, false, elapsed, "$stage：$detail")
        synchronized(lock) {
            st = st.copy(
                running = false, failed = true, phase = PHASE_FAIL,
                failStage = stage, failDetail = detail, failOffset = st.receivedBytes,
                elapsedMs = elapsed, reportPath = report, message = detail
            )
        }
        onDone(st)
    }

    private fun setState(onUpdate: (State) -> Unit, s: State) {
        st = s
        onUpdate(s)
        // v2.9：通知栏跟着走，用户退到后台/锁屏也知道传到哪了
        try {
            val head = when (s.phase) {
                PHASE_DONE -> "课堂笔记上传完成"
                PHASE_FAIL -> "课堂笔记上传中断"
                PHASE_VERIFY -> "正在核对电脑端文件"
                else -> "正在上传课堂笔记 ${s.sessionNo}/${s.sessionCount} 节"
            }
            val sub = when (s.phase) {
                PHASE_DONE -> "全部核对一致，可以去电脑看笔记了"
                PHASE_FAIL -> "点开 APP 可原地重试（已传的字节会续上）"
                else -> s.message.ifEmpty { "可以切后台或锁屏，传完自动收尾" }
            }
            Sync.progress(head, sub)
        } catch (_: Exception) { }
    }

    /** 一次运行的 JSON 报告（落 filesDir/reupload-tests，不删旧报告） */
    private fun saveReport(
        p: Plan?, checks: List<CheckRow>, allMatch: Boolean, missing: List<String>,
        extra: List<String>, notifyOk: Boolean, elapsedMs: Long, failText: String
    ): String {
        val ctx = appCtx ?: return ""
        return try {
            val fmt = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.CHINA)
            val dir = File(ctx.filesDir, "reupload-tests").apply { mkdirs() }
            val f = File(dir, "reupload-${fmt.format(Date())}.json")
            val o = JSONObject()
                .put("testRunId", fmt.format(Date()))
                .put("finishedAt", SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.CHINA).format(Date()))
                .put("course", p?.course ?: "")
                .put("dayIso", p?.dayIso ?: "")
                .put("target", Api.savedUrl())
                .put("elapsedMs", elapsedMs)
                .put("totalBytes", p?.totalBytes ?: 0)
                .put("sentBytes", uploadSent)
                .put("resumedBytes", resumedBytes)
                .put("speedBps", if (uploadElapsedMs > 0) uploadSent * 1000.0 / uploadElapsedMs else 0.0)
                .put("chunks", JSONObject().put("total", st.md5ChunkTotal).put("md5Passed", passedChunks).put("retries", retries))
                .put("allMatch", allMatch)
                .put("notifyOk", notifyOk)
                .put("noteState", st.noteState)
                .put("fail", failText)
            val arr = JSONArray()
            for (c in checks) arr.put(JSONObject()
                .put("name", c.name).put("clientSize", c.clientSize).put("serverSize", c.serverSize)
                .put("sizeMatch", c.sizeMatch).put("clientMd5", c.clientMd5)
                .put("serverMd5", c.serverMd5).put("md5Match", c.md5Match))
            o.put("files", arr)
            o.put("missing", JSONArray(missing))
            o.put("extra", JSONArray(extra))
            f.writeText(o.toString(1), Charsets.UTF_8)
            f.absolutePath
        } catch (_: Exception) { "" }
    }

    /** 复制给用户的纯文本摘要 */
    fun reportText(s: State): String {
        val sb = StringBuilder()
        sb.append("课堂笔记 重传报告\n")
        sb.append("目标：").append(Api.savedUrl()).append('\n')
        sb.append("阶段：").append(s.phase).append('\n')
        sb.append("节：").append(s.sessionNo).append('/').append(s.sessionCount)
        sb.append("  文件：").append(s.fileNo).append('/').append(s.fileCount).append('\n')
        sb.append("总字节：").append(s.totalBytes).append("  本次实发：").append(s.sentBytes)
        sb.append("  续传跳过：").append(s.resumedBytes).append('\n')
        sb.append("耗时：").append(s.elapsedMs / 1000).append("s  上传耗时：").append(s.uploadElapsedMs / 1000)
        sb.append("s  平均速度：").append(String.format(Locale.CHINA, "%.2f", s.speedBps / 1048576.0)).append(" MB/s\n")
        sb.append("分块 MD5：").append(s.md5ChunkPass).append('/').append(s.md5ChunkTotal)
        sb.append("  重试：").append(s.retries).append(" 次\n")
        sb.append("整文件 MD5/字节：").append(if (s.allMatch) "全部一致" else "存在不一致").append('\n')
        for (c in s.checks) {
            sb.append("  ").append(c.name).append("  ").append(c.clientSize).append(" / ").append(c.serverSize)
            sb.append("  size=").append(c.sizeMatch).append("  md5=").append(c.md5Match).append('\n')
        }
        if (s.failDetail.isNotEmpty()) sb.append("失败：").append(s.failStage).append(" - ").append(s.failDetail).append('\n')
        if (s.reportPath.isNotEmpty()) sb.append("报告文件：").append(s.reportPath).append('\n')
        return sb.toString()
    }
}
