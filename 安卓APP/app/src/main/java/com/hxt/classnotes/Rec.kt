package com.hxt.classnotes

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** 录音会话的活状态（**仅 :rec 进程内部可见**；主进程一律走 RecInfo/Db，别碰这里） */
object RecState {
    @Volatile var recording = false
    @Volatile var sid = ""
    @Volatile var course = ""
    @Volatile var startElapsed = 0L
    @Volatile var startWall = 0L
    @Volatile var segIdx = 0
    @Volatile var photoCount = 0
    @Volatile var markCount = 0

    /** 当前拍照/事件相对录音开始的毫秒偏移；没在录音返回 -1 */
    fun offsetMs(): Long = if (recording) SystemClock.elapsedRealtime() - startElapsed else -1L
    fun elapsedMs(): Long = if (recording) SystemClock.elapsedRealtime() - startElapsed else 0L
}

/**
 * 主进程读录音状态的窗口（v1.8：Rec 服务已搬进独立进程 :rec，静态 RecState 不再跨进程可见）。
 * 真相源 = Db：会话 state=recording 且 30 秒心跳（meta.recHB）新鲜 → 服务活着在录。
 * 拍照/标记的时间偏移用 meta.recStartElapsed（elapsedRealtime 是内核单调钟，跨进程读完全一致）。
 */
object RecInfo {
    private const val HB_STALE_MS = 2 * 60_000L

    fun heartbeatFresh(): Boolean {
        val hb = Db.meta("recHB").toLongOrNull() ?: 0L
        return System.currentTimeMillis() - hb < HB_STALE_MS
    }

    /** 当前在录的会话行（sid/course/startedAt…）；服务不在录返回 null */
    fun current(): org.json.JSONObject? {
        if (!heartbeatFresh()) return null
        val sess = Db.sessions(10)
        for (i in 0 until sess.length()) {
            val s = sess.getJSONObject(i)
            if (s.optString("state") == "recording") return s
        }
        return null
    }

    fun currentSid(): String? = current()?.optString("sid")?.ifEmpty { null }

    fun recording(): Boolean = current() != null

    /** 拍照/标记相对开录的毫秒偏移（单调钟，跨进程一致）；没在录返回 -1 */
    fun offsetMs(): Long {
        val st = Db.meta("recStartElapsed").toLongOrNull() ?: -1L
        if (st <= 0) return -1L
        val off = SystemClock.elapsedRealtime() - st
        return if (current() != null) off else -1L
    }

    fun elapsedMs(): Long = offsetMs().coerceAtLeast(0L)
}

/**
 * 录音前台服务（**v1.8 起跑在独立进程 :rec**）：息屏可长录（WakeLock + foregroundServiceType=microphone）。
 * 进程隔离的意义：页面进程（看笔记/课程页/相机返回）无论崩溃还是被系统杀，录音进程都不受牵连——
 * 2026-10-08 大模型课 13:30 节录 7分22秒死亡即页面进程带崩同进程录音，此架构根治。
 * 每 10 分钟轮转一个 recording_XX.m4a——崩溃/被杀最多丢当前一段，转写和上传粒度也小。
 * 接缝处可能丢零点几秒，属已知取舍。
 */
class Rec : Service() {
    companion object {
        const val SEGMENT_MS = 10L * 60 * 1000
        const val ACTION_START = "start"
        const val ACTION_STOP = "stop"
        const val ACTION_MARK = "mark"
        const val ACTION_DISCARD = "discard"
    }

    private var rec: MediaRecorder? = null
    private var wake: PowerManager.WakeLock? = null
    private val handler = Handler(Looper.getMainLooper())
    private var segStartElapsed = 0L
    private var segFile = ""
    private lateinit var sessionDir: File

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Db.init(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                // 服务活着走正常收尾；进程刚被拉起而库里还有 recording 残留（上次死了没落账）→ 先对账收尸
                if (RecState.recording) stopRecording() else reconcileStale("stop兜底")
            }
            ACTION_MARK -> quickMark()
            ACTION_DISCARD -> if (RecState.recording) discardRecording() else reconcileStale("discard兜底")
            else -> {
                reconcileStale("开录前对账")
                if (!RecState.recording) startRecording(intent?.getStringExtra("course") ?: "未命名课程")
            }
        }
        return START_NOT_STICKY
    }

    /** 库里 state=recording 但本进程没有活会话的残留（上次进程死亡没来得及收尾）：按实际录音时长如实落账 */
    private fun reconcileStale(why: String) {
        try {
            var reaped = false
            val sess = Db.sessions(30)
            for (i in 0 until sess.length()) {
                val s = sess.getJSONObject(i)
                if (s.optString("state") != "recording") continue
                val sid = s.optString("sid")
                val dir = File(File(filesDir, "sessions"), sid)
                val real = Db.realRecordedMs(dir)
                val startedAt = s.optLong("startedAt")
                val dur = real ?: (System.currentTimeMillis() - startedAt).coerceAtLeast(0L)
                val ended = if (real != null) startedAt + dur else System.currentTimeMillis()
                Db.finishSession(sid, ended, dur)
                reaped = true
                recLog("reconcile", "$why：孤儿会话 $sid 落账 dur=${dur}ms（real=${real != null}）")
            }
            // v1.9：收尸终结了残留录音=这节录音早死了，通知监督员解除上课模式（幂等）
            if (reaped) GuardLink.classMode(this, false, "")
        } catch (e: Exception) {
            recLog("reconcile-fail", "${e.message}")
        }
    }

    /** 通知栏快捷标记：来不及选类型时一键落一个「🔖重点」，事后 AI 照样重点提取 */
    private fun quickMark() {
        if (!RecState.recording) return
        val off = RecState.offsetMs()
        if (off < 0) return
        Db.addMark(RecState.sid, off, "🔖重点", "")
        RecState.markCount++
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(1, notif("正在录课：${RecState.course}"))
    }

    private fun newRecorder(path: String): MediaRecorder {
        val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(this) else @Suppress("DEPRECATION") MediaRecorder()
        r.setAudioSource(MediaRecorder.AudioSource.MIC)
        r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        // v2.0：音质偏好从设置页读；分段轮转时逐段生效，改设置不打断当前录音
        val hq = Db.meta("recQuality", "std") == "hq"
        if (hq) {
            r.setAudioSamplingRate(44100)      // 高保真：文件约 2.7 倍，转写效果不受影响
            r.setAudioEncodingBitRate(128000)
        } else {
            r.setAudioSamplingRate(16000)      // 标准 16kHz 单声道：转写最优，体积最小
            r.setAudioEncodingBitRate(48000)
        }
        r.setAudioChannels(1)
        r.setOutputFile(path)
        r.prepare()
        return r
    }

    private fun startRecording(course: String) {
        val st = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.CHINA).format(Date())
        val sid = "c$st-${Integer.toHexString((SystemClock.elapsedRealtime() and 0xFFFF).toInt())}"
        sessionDir = File(File(filesDir, "sessions"), sid).apply { mkdirs() }
        RecState.sid = sid
        RecState.course = course
        RecState.startElapsed = SystemClock.elapsedRealtime()
        RecState.startWall = System.currentTimeMillis()
        RecState.segIdx = 0
        RecState.photoCount = 0
        RecState.markCount = 0
        RecState.recording = true
        Db.createSession(sid, course, RecState.startWall, sessionDir.absolutePath)
        // 主进程拍照/标记靠这两个 meta 算偏移（单调钟跨进程一致）；心跳 30 秒一发是「服务活着」的凭证
        Db.setMeta("recStartElapsed", RecState.startElapsed.toString())
        Db.setMeta("recHB", System.currentTimeMillis().toString())
        startFG(notif("正在录课：$course"))
        wake = (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "classnotes:rec").apply { acquire(6L * 60 * 60 * 1000) }
        handler.post(heartbeat)
        Watch.schedule(this, 2 * 60_000L)   // 给看门狗排班：进程被杀后由闹钟收尸报警
        startSegment()
        scheduleRotate()
        recLog("start", "sid=$sid course=$course")
    }

    /** 看门狗心跳：活着就每 30 秒报一次到；进程死了心跳自然过期，闹钟那边负责喊人 */
    private val heartbeat = object : Runnable {
        override fun run() {
            if (!RecState.recording) return
            Db.setMeta("recHB", System.currentTimeMillis().toString())
            handler.postDelayed(this, 30_000L)
        }
    }

    private fun startSegment() {
        segFile = String.format(Locale.CHINA, "recording_%02d.m4a", RecState.segIdx)
        segStartElapsed = SystemClock.elapsedRealtime()
        Db.addSegment(RecState.sid, segFile, segStartElapsed - RecState.startElapsed)
        try {
            rec = newRecorder(File(sessionDir, segFile).absolutePath)
            rec?.start()
            recLog("seg", "第 ${RecState.segIdx + 1} 段开录 $segFile")
            // v1.9：录音真实开起来了才通知监督员「上课」（每段 10 分钟续期一次安全阀；对方不在=静默跳过）
            GuardLink.classMode(this, true, RecState.course)
        } catch (e: Exception) {
            // 麦克风被别的应用抢走等临时状况：800ms 后重试一次；再失败高优告警，绝不再无声死亡
            try { rec?.release() } catch (_: Exception) { }
            rec = null
            recLog("seg-retry", "第 ${RecState.segIdx + 1} 段首开失败：${e.message}")
            handler.postDelayed({
                if (!RecState.recording) return@postDelayed
                try {
                    rec = newRecorder(File(sessionDir, segFile).absolutePath)
                    rec?.start()
                    recLog("seg-ok", "第 ${RecState.segIdx + 1} 段重试成功")
                    GuardLink.classMode(this, true, RecState.course)   // v1.9：重试成功同样算开录成功
                } catch (e2: Exception) {
                    rec = null
                    failLoudly("第 ${RecState.segIdx + 1} 段录音开不起来（${e2.message ?: "麦克风被占用"}）")
                }
            }, 800)
        }
    }

    /** 录音失败收场：如实落账 + 高优通知喊人（v1.3 及以前是悄无声息地停，上课的人完全不知道） */
    private fun failLoudly(msg: String) {
        recLog("fail", msg)
        val dur = SystemClock.elapsedRealtime() - RecState.startElapsed
        try { Db.finishSession(RecState.sid, System.currentTimeMillis(), dur) } catch (_: Exception) { }
        RecState.recording = false
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel("watchdog", "录音异常提醒", NotificationManager.IMPORTANCE_HIGH))
        }
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val n = Notification.Builder(this, "watchdog")
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle("录音出错了，已停止")
            .setContentText(msg + "。点这里重新开录（已录的都保存着，同一天同一门课会归成一篇笔记）")
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        nm.notify(3, n)
        GuardLink.classMode(this, false, "")   // v1.9：录音失败收场=下课，通知监督员解除上课模式
        stopFG()
        stopSelf()
    }

    private fun scheduleRotate() {
        handler.postDelayed({
            if (RecState.recording) {
                closeSegment()
                RecState.segIdx++
                startSegment()
                scheduleRotate()
            }
        }, SEGMENT_MS)
    }

    private fun closeSegment() {
        try { rec?.stop() } catch (_: Exception) { }
        try { rec?.release() } catch (_: Exception) { }
        rec = null
    }

    private fun stopRecording() {
        if (!RecState.recording) return
        handler.removeCallbacksAndMessages(null)
        closeSegment()
        val dur = SystemClock.elapsedRealtime() - RecState.startElapsed
        Db.finishSession(RecState.sid, System.currentTimeMillis(), dur)
        wake?.release(); wake = null
        RecState.recording = false
        recLog("stop", "sid=${RecState.sid} dur=${dur}ms")
        GuardLink.classMode(this, false, "")   // v1.9：下课=通知监督员解除上课模式
        stopFG()
        stopSelf()
    }

    /** 用户取消本节（误触等，v1.6）：照常收尾录音，但会话标 cancelled——永不上传、不出笔记；
     *  录音文件保留在手机存储不删（与「不删」原则一致，也防手滑反悔） */
    private fun discardRecording() {
        if (!RecState.recording) return
        handler.removeCallbacksAndMessages(null)
        closeSegment()
        val dur = SystemClock.elapsedRealtime() - RecState.startElapsed
        Db.finishSession(RecState.sid, System.currentTimeMillis(), dur)
        Db.setSessionState(RecState.sid, "cancelled")
        wake?.release(); wake = null
        RecState.recording = false
        recLog("discard", "sid=${RecState.sid} dur=${dur}ms")
        GuardLink.classMode(this, false, "")   // v1.9：取消本节=下课，同样解除上课模式
        stopFG()
        stopSelf()
    }

    private fun startFG(n: Notification) {
        if (Build.VERSION.SDK_INT >= 30) {
            startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(1, n)
        }
    }

    private fun stopFG() = stopForeground(true)

    private fun notif(text: String): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel("record", "录课中", NotificationManager.IMPORTANCE_LOW))
        }
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, "record")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("课堂笔记·录课中")
            .setContentText(text)
            .setWhen(RecState.startWall)
            .setUsesChronometer(true)
            .setOngoing(true)
            .setContentIntent(pi)
            .build()
    }

    override fun onDestroy() {
        // 系统强杀服务时尽量保住已录内容：把会话落成 ready
        if (RecState.recording) {
            handler.removeCallbacksAndMessages(null)
            closeSegment()
            val dur = SystemClock.elapsedRealtime() - RecState.startElapsed
            try { Db.finishSession(RecState.sid, System.currentTimeMillis(), dur) } catch (_: Exception) { }
            RecState.recording = false
            recLog("destroy", "sid=${RecState.sid} dur=${dur}ms（onDestroy 收尾）")
            try { GuardLink.classMode(this, false, "") } catch (_: Exception) { }   // v1.9：尽力发下课（onDestroy 不保证跑，跑不了靠对方 15 分钟安全阀）
        } else {
            recLog("destroy", "无活会话")
        }
        try { wake?.release() } catch (_: Exception) { }
        super.onDestroy()
    }

    // ---------- 黑匣子面包屑（v1.8）：录音服务的生死大事都记一笔，崩溃时与 crash-*.txt 互相印证死因 ----------
    private fun recLog(event: String, detail: String) {
        try {
            val f = File(filesDir, "rec-log.txt")
            if (f.length() > 400 * 1024) {
                // 日志轮转：保两代（rec-log.old.txt 是上一代），再满一轮覆盖最旧——运行时环形日志，不涉交付物
                val old = File(filesDir, "rec-log.old.txt")
                if (old.exists()) old.delete()
                f.renameTo(old)
            }
            val line = "${SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.CHINA).format(Date())} [$event] $detail\n"
            f.appendText(line)
        } catch (_: Exception) { }
    }
}
