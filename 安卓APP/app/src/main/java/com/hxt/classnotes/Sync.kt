package com.hxt.classnotes

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * 上传前台服务（v2.9，2026-10-24 用户要求：切后台、锁屏都不能停）。
 *
 * 之前上传跑在普通线程里：APP 一退到后台/一锁屏，Android 12+ 的「缓存进程冻结」
 * 会把进程整个按暂停，分块传到一半就没下文（用户实测：换到别的页面就失效）。
 * 升级成前台服务后进程不再被冻结，再配一把 PARTIAL_WAKE_LOCK，息屏也能继续传。
 *
 * 只做「保活 + 显示进度」，不搬上传逻辑：真正干活的线程仍在 Api/TestReupload，
 * 这样 UI 里的进度、续传、MD5 校验全部照旧，改动面最小。
 */
class Sync : Service() {

    companion object {
        private const val CH = "sync"
        private const val NID = 2
        @Volatile private var title = "正在上传课堂笔记"
        @Volatile private var body = "可以切后台或锁屏，传完自动收尾"
        private var inst: Sync? = null

        /** 有上传开始：把进程提升成前台服务（重复调用无副作用） */
        fun ensure(ctx: Context) {
            try {
                val i = Intent(ctx, Sync::class.java)
                if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
            } catch (_: Exception) { }
        }

        /** 上传全部结束：撤掉通知 */
        fun stop(ctx: Context) {
            try { ctx.stopService(Intent(ctx, Sync::class.java)) } catch (_: Exception) { }
        }

        /** 进度文字（在主线程外调用也安全：只改字段 + notify） */
        fun progress(t: String, b: String) {
            title = t
            body = b
            try { inst?.refresh() } catch (_: Exception) { }
        }

        fun isRunning(): Boolean = inst != null
    }

    private var wake: PowerManager.WakeLock? = null
    private var nm: NotificationManager? = null
    private var foreground = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        inst = this
        nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            nm?.createNotificationChannel(
                NotificationChannel(CH, "上传课堂笔记", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "把课堂录音传回电脑时显示进度"
                    setShowBadge(false)
                }
            )
        }
        try {
            wake = (getSystemService(Context.POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "classnotes:sync")
                .apply { setReferenceCounted(false); acquire(2L * 60 * 60 * 1000) }
        } catch (_: Exception) { }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startFg()
        return START_NOT_STICKY
    }

    private fun startFg() {
        if (foreground) { refresh(); return }
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NID, build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(NID, build())
            }
            foreground = true
        } catch (_: Exception) { }
    }

    /** 供 companion.progress 调用：通知栏实时显示传到哪一节 */
    private fun refresh() {
        if (!foreground) return
        try { nm?.notify(NID, build()) } catch (_: Exception) { }
    }

    private fun build(): Notification {
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, CH)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setContentIntent(pi)
            .build()
    }

    override fun onDestroy() {
        inst = null
        foreground = false
        try { wake?.release() } catch (_: Exception) { }
        wake = null
        try { stopForeground(true) } catch (_: Exception) { }
        super.onDestroy()
    }
}
