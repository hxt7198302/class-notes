package com.hxt.classnotes

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * 录音看门狗（v1.4）。上课录音被系统杀后台（荣耀/华为等 OEM 激进省电）时进程直接没了，
 * 自己的代码一行都跑不了——唯一能在「死后」跑的是系统代持的闹钟。
 * 机制：Rec 服务活着时每 30 秒写一次心跳（meta.recHB）；本收音机每 2 分钟被闹钟叫醒：
 *   - 库里没有「录音中」的会话 → 收班，不再排下一班；
 *   - 心跳 5 分钟内 → 服务健在，继续排下一班；
 *   - 心跳过期 → 录音已经悄悄死了，发高优先级通知「录音中断了，点这里继续」。
 * Android 12+ 拿不到精确闹钟权限就降级 setAndAllowWhileIdle（Doze 里最勤 9 分钟一响，也够用）。
 */
class Watch : BroadcastReceiver() {
    companion object {
        fun schedule(ctx: Context, delayMs: Long) {
            val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val pi = PendingIntent.getBroadcast(
                ctx, 11, Intent(ctx, Watch::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val at = System.currentTimeMillis() + delayMs
            val exact = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()
            if (exact) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
            else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        }
    }

    override fun onReceive(ctx: Context, intent: Intent) {
        try {
            Db.init(ctx)
            var hasRec = false
            val sess = Db.sessions(30)
            for (i in 0 until sess.length()) {
                if (sess.getJSONObject(i).optString("state") == "recording") { hasRec = true; break }
            }
            if (!hasRec) return   // 没有在录的会话，看门狗收班
            val hb = Db.meta("recHB").toLongOrNull() ?: 0L
            if (System.currentTimeMillis() - hb > 5 * 60_000L) {
                val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                if (Build.VERSION.SDK_INT >= 26) {
                    nm.createNotificationChannel(NotificationChannel("watchdog", "录音异常提醒", NotificationManager.IMPORTANCE_HIGH))
                }
                val pi = PendingIntent.getActivity(
                    ctx, 0, Intent(ctx, MainActivity::class.java),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                val n: Notification = Notification.Builder(ctx, "watchdog")
                    .setSmallIcon(android.R.drawable.ic_dialog_alert)
                    .setContentTitle("录音中断了！")
                    .setContentText("录音被系统停掉了，点这里回去继续录（已录的部分都保存着，同一天的会归成一篇笔记）")
                    .setAutoCancel(true)
                    .setContentIntent(pi)
                    .build()
                nm.notify(3, n)
            }
            schedule(ctx, 2 * 60_000L)
        } catch (_: Exception) { }
    }
}
