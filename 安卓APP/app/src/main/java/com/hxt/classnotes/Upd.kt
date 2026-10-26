package com.hxt.classnotes

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.widget.LinearLayout
import android.widget.TextView
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * 应用内更新（v1.1 起）：APK 与版本清单都托管在家里电脑的 API 上
 * （GET /api/version 清单 + GET /api/apk 安装包），走 APP 已自动跟随的隧道，
 * 不依赖任何外部托管。启动时静默检查（几秒超时、失败不打扰）。
 * v1.3：录音中也会检查，但不弹窗——只在主页挂「可更新」横幅（存本地，下次打开还在），
 * 下课点横幅再走 下载带进度 → sha256 校验 → 唤起系统安装 的流程。
 */
object Upd {
    // v2.0 前端改版：与 build.gradle 的 versionCode/versionName 必须同步（v1.9 曾漏更，导致头部显示 1.8 且误报更新）
    const val VERSION_CODE = 26
    const val VERSION_NAME = "2.13"

    private val handler = Handler(Looper.getMainLooper())
    private var checked = false   // 每次开 APP 只静默查一次
    @Volatile private var manual = false   // 设置页手动点「检查更新」：无论结果都给反馈

    /** 设置页手动检查：绕过节流，连不上/已最新也明确告诉用户 */
    fun checkNow(activity: Activity) {
        checked = false
        manual = true
        checkAsync(activity)
    }

    fun checkAsync(activity: Activity) {
        if (checked) return
        checked = true
        val byUser = manual
        manual = false
        Thread {
            try {
                val url = Api.workingUrl()
                if (url == null) {
                    if (byUser) handler.post { android.widget.Toast.makeText(activity, "检查失败：连不上家里电脑（素材和笔记不受影响）", android.widget.Toast.LENGTH_LONG).show() }
                    return@Thread
                }
                val c = URL("$url/api/version").openConnection() as HttpURLConnection
                c.connectTimeout = 8000; c.readTimeout = 8000
                c.setRequestProperty("x-app-token", Api.TOKEN)
                val code = c.responseCode
                val text = (if (code in 200..299) c.inputStream else c.errorStream)?.readBytes()?.toString(Charsets.UTF_8) ?: ""
                c.disconnect()
                if (code != 200) {
                    if (byUser) handler.post { android.widget.Toast.makeText(activity, "检查失败：电脑端返回 HTTP $code", android.widget.Toast.LENGTH_LONG).show() }
                    return@Thread
                }
                val v = org.json.JSONObject(text)
                val newCode = v.optInt("versionCode", 0)
                if (newCode <= VERSION_CODE) {
                    Db.setMeta("updateAvailable", "")
                    if (byUser) handler.post { android.widget.Toast.makeText(activity, "已是最新版本 v$VERSION_NAME", android.widget.Toast.LENGTH_SHORT).show() }
                    return@Thread
                }
                val name = v.optString("versionName", newCode.toString())
                handler.post {
                    // 版本信息存本地：录音中不弹窗（不打扰上课），主页横幅会挂出来
                    Db.setMeta("updateAvailable", v.toString())
                    if (RecState.recording) {
                        android.widget.Toast.makeText(activity, "有新版本 v$name，下课后打开 APP 按横幅更新", android.widget.Toast.LENGTH_LONG).show()
                    } else {
                        ask(activity, v)
                    }
                }
            } catch (_: Exception) {
                if (byUser) handler.post { android.widget.Toast.makeText(activity, "检查失败：连不上家里电脑（素材和笔记不受影响）", android.widget.Toast.LENGTH_LONG).show() }
            }
        }.start()
    }

    /** 本地挂起的可更新信息（主页横幅用）；没有返回 null */
    fun pendingUpdate(): org.json.JSONObject? {
        val s = Db.meta("updateAvailable", "")
        if (s.isEmpty()) return null
        return try { org.json.JSONObject(s) } catch (_: Exception) { null }
    }

    fun ask(activity: Activity, v: org.json.JSONObject) {
        if (activity.isFinishing || activity.isDestroyed) return
        val newCode = v.optInt("versionCode", 0)
        val name = v.optString("versionName", newCode.toString())
        val notes = v.optString("notes", "")
        val box = LinearLayout(activity)
        box.orientation = LinearLayout.VERTICAL
        box.setPadding(Ui.dp(20), Ui.dp(8), Ui.dp(20), 0)
        box.addView(Ui.text(activity, "新版本 v$name（构建 #$newCode）", 15, Ui.TEXT, true))
        if (notes.isNotEmpty()) box.addView(Ui.text(activity, notes, 13, Ui.TEXT_SUB))
        box.addView(Ui.text(activity, "更新包由家里电脑提供，下载完会请你点一下安装。录课时先别更新。", 12, Ui.TEXT_SUB))
        AlertDialog.Builder(activity)
            .setTitle("发现新版本")
            .setView(box)
            .setPositiveButton("立即更新") { _, _ -> download(activity, name, v) }
            .setNegativeButton("以后再说", null)
            .show()
    }

    private fun download(activity: Activity, name: String, v: org.json.JSONObject) {
        if (activity.isFinishing || activity.isDestroyed) return
        val sha = v.optString("sha256", "")
        val status = TextView(activity)
        status.textSize = 14f
        status.setPadding(Ui.dp(20), Ui.dp(8), Ui.dp(20), 0)
        val box = LinearLayout(activity)
        box.orientation = LinearLayout.VERTICAL
        box.addView(status)
        val dlg = AlertDialog.Builder(activity)
            .setTitle("下载更新 v$name")
            .setView(box)
            .setCancelable(false)
            .create()
        dlg.show()
        Thread {
            var fail = ""
            try {
                val url = Api.workingUrl() ?: throw Exception("连不上电脑")
                val tmp = File(File(activity.filesDir, "update"), "update.apk.tmp")
                tmp.parentFile?.mkdirs()
                val c = URL("$url/api/apk").openConnection() as HttpURLConnection
                c.connectTimeout = 15000; c.readTimeout = 60000
                c.setRequestProperty("x-app-token", Api.TOKEN)
                if (c.responseCode !in 200..299) throw Exception("下载失败（HTTP ${c.responseCode}）")
                val total = c.contentLengthLong
                val digest = MessageDigest.getInstance("SHA-256")
                var done = 0L
                c.inputStream.use { ins ->
                    tmp.outputStream().use { out ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = ins.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            digest.update(buf, 0, n)
                            done += n
                            if (total > 0) handler.post { status.text = "下载中 ${done * 100 / total}%（${done / 1024 / 1024}MB / ${total / 1024 / 1024}MB）" }
                        }
                    }
                }
                c.disconnect()
                val got = digest.digest().joinToString("") { "%02x".format(it) }
                if (sha.isNotEmpty() && !got.equals(sha, ignoreCase = true)) throw Exception("安装包校验不对，已放弃安装")
                val out = File(tmp.parentFile, "update.apk")
                if (out.exists()) out.delete()
                if (!tmp.renameTo(out)) throw Exception("落盘失败")
                Db.setMeta("updateAvailable", "")
                handler.post {
                    status.text = "下载完成，校验通过 ✓"
                    dlg.dismiss()
                    askInstall(activity)
                }
            } catch (e: Exception) {
                fail = e.message ?: "下载出错"
                handler.post {
                    status.text = "没下成：$fail"
                    android.widget.Toast.makeText(activity, "更新没下成：$fail（稍后再试）", android.widget.Toast.LENGTH_LONG).show()
                }
            }
            if (fail.isNotEmpty()) dlg.setCancelable(true)
        }.start()
    }

    private fun askInstall(activity: Activity) {
        if (activity.isFinishing || activity.isDestroyed) return
        AlertDialog.Builder(activity)
            .setTitle("可以安装了")
            .setMessage("接下来会弹出系统安装界面，点「安装」即可完成更新（数据都在，不会丢）。")
            .setPositiveButton("去安装") { _, _ -> install(activity) }
            .setNegativeButton("稍后", null)
            .show()
    }

    fun install(activity: Activity) {
        val uri = Uri.parse("content://com.hxt.classnotes.photos/update/update.apk")
        val i = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            activity.startActivity(i)
        } catch (_: Exception) {
            Ui.toast(activity, "打不开安装界面，请到「交付」文件夹手动装新 APK")
        }
    }
}
