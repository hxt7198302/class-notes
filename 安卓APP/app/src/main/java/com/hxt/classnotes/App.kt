package com.hxt.classnotes

import android.app.Application
import android.os.Process
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 崩溃黑匣子（v1.8）。Application 在**每个进程**（主进程 + :rec 录音进程）都会装载一次：
 * 任何线程冒出未捕获异常，先把堆栈原样写进 filesDir/crash-<时间>-<进程名>.txt（本地优先，没网也不丢），
 * 再交回系统默认处理（该崩还崩）。日志由 Api.syncAll 顺手 POST /api/diag 存到电脑素材库 _diag\。
 * 起因：2026-10-08 大模型课 13:30 节录 7分22秒进程死亡，电脑侧无任何痕迹，死因查无实据——
 * 下次再出这种事，crash 文件 + rec-log.txt（录音服务面包屑）两相对照就是铁证。
 */
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Db.init(this)
        Api.initCtx(this)   // v2.9：上传保活服务需要 Context
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            try {
                val name = "crash-" + SimpleDateFormat("yyyyMMdd-HHmmss", Locale.CHINA).format(Date()) +
                        "-p${Process.myPid()}-t${t.id}.txt"
                File(filesDir, name).writeText(
                    "time=${SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.CHINA).format(Date())}\n" +
                            "pid=${Process.myPid()} thread=${t.name}\n" +
                            "version=${Upd.VERSION_NAME}(${Upd.VERSION_CODE})\n" +
                            android.util.Log.getStackTraceString(e) + "\n"
                )
            } catch (_: Exception) { }
            prev?.uncaughtException(t, e)
        }
    }
}
