package com.hxt.classnotes

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * v2.3 一键修复损坏录音。
 *
 * 背景：v2.2 之前手机端两个上传线程会并发传同一文件，电脑把同一个 3MiB 块追加两次，
 * 录音变成「前半段重复」，转写整段跳过——好多课的笔记缺内容。
 *
 * 做法：更新后自动问电脑要损坏清单（/api/repair/scan，按 3MiB 块 md5 重复判定），
 * 只补传坏掉的那几个文件（手机里的原件一直都在），整组传完让电脑统一重新整理；
 * 不用用户一节课一节课长按。手残中断了也不怕：下次启动会重新体检、没修完的继续修。
 */
object Repair {
    private const val KEY = "autoRepairAt"
    private const val PENDING = "repairPending"   // 没修完的工单：APP 被杀/断网后下次启动续上

    @Volatile var running = false
        private set
    @Volatile private var checking = false
    private val checkGate = Any()

    private data class Item(val anchor: String, val sid: String, val files: List<String>, val label: String, val bytes: Long)

    /** 启动时自动体检：每个版本只自动成功跑一次；没修完（失败/断网）下次启动继续 */
    fun autoCheck(act: Activity, onDone: (() -> Unit)? = null) {
        if (running || checking) return
        if (Db.meta(KEY) == Upd.VERSION_CODE.toString()) return
        if (RecInfo.recording()) return   // 正在录课，别抢网也别打断
        synchronized(checkGate) { if (checking) return; checking = true }
        Thread {
            try {
                // 上次没修完（APP 被杀/断网）先把工单续上，别让半截文件留在电脑上；
                // 流量网络下仍走「先问一句」的分支，避免偷偷耗流量。
                var work = loadPending()
                val resuming = work.isNotEmpty()
                if (resuming) {
                    act.runOnUiThread { Ui.toast(act, "继续上次没修完的 ${work.size} 个文件…") }
                } else {
                    val scan = Api.repairScan() ?: return@Thread    // 连不上就下次再说
                    work = buildWork(scan)
                    if (work.isEmpty()) {
                        Db.setMeta(KEY, Upd.VERSION_CODE.toString())
                        return@Thread
                    }
                }
                val groups = work.map { it.anchor }.distinct().size
                var bytes = 0L
                for (w in work) bytes += w.bytes
                val mb = Math.max(1L, bytes / 1048576L)
                act.runOnUiThread {
                    if (onWifi(act)) {
                        Ui.toast(act, "检测到 $groups 节课的录音损坏（约 ${mb}MB），开始自动修复…")
                        start(act, work, onDone)
                    } else {
                        // 非 Wi-Fi：不要每次回前台都弹，6 小时内最多提醒一次
                        val now = System.currentTimeMillis()
                        val last = Db.meta("repairPromptAt").toLongOrNull() ?: 0L
                        if (!resuming && now - last < 6 * 3600_000L) return@runOnUiThread
                        Db.setMeta("repairPromptAt", now.toString())
                        AlertDialog.Builder(act)
                            .setTitle("发现 $groups 节课的录音损坏")
                            .setMessage("旧版上传的锅：电脑上的录音有重复块，笔记会缺内容。现在用手机里的原件补传（约 ${mb}MB）。建议连 Wi-Fi，传的时候别关 APP。")
                            .setPositiveButton("现在修复") { _, _ -> start(act, work, onDone) }
                            .setNegativeButton("稍后", null)
                            .show()
                    }
                }
            } finally {
                checking = false
            }
        }.start()
    }

    /** 手动入口（笔记页「🛠 修复坏课」）：不管版本标记，立刻体检 */
    fun manual(act: Activity, onDone: (() -> Unit)? = null) {
        if (running) { Ui.toast(act, "正在修复，稍等…"); return }
        if (RecInfo.recording()) { Ui.toast(act, "正在录课，录完再修"); return }
        Ui.toast(act, "正在检查电脑上的录音…")
        Thread {
            val scan = Api.repairScan()
            if (scan == null) {
                act.runOnUiThread { Ui.toast(act, "连不上电脑（隧道没通/电脑关机）") }
                return@Thread
            }
            val work = buildWork(scan)
            act.runOnUiThread {
                if (work.isEmpty()) {
                    Ui.toast(act, "没有发现损坏的录音，笔记都是好的")
                    Db.setMeta(KEY, Upd.VERSION_CODE.toString())
                } else {
                    start(act, work, onDone)
                }
            }
        }.start()
    }

    /** 只修手机里还有原件的文件；手机上没有的跳过（电脑端无法凭空还原） */
    private fun buildWork(scan: JSONObject): List<Item> {
        val out = ArrayList<Item>()
        val groups = scan.optJSONArray("groups") ?: return out
        val fmt = SimpleDateFormat("M月d日", Locale.CHINA)
        for (gi in 0 until groups.length()) {
            val g = groups.optJSONObject(gi) ?: continue
            val anchor = g.optString("anchor")
            val course = g.optString("course")
            val day = try { fmt.format(Date(g.optLong("startedAt"))) } catch (_: Exception) { "" }
            val sessions = g.optJSONArray("sessions") ?: continue
            for (si in 0 until sessions.length()) {
                val s = sessions.optJSONObject(si) ?: continue
                val sid = s.optString("id")
                val row = Db.session(sid) ?: continue
                val dir = File(row.optString("dir"))
                val files = ArrayList<String>()
                var bytes = 0L
                val arr = s.optJSONArray("files") ?: continue
                for (i in 0 until arr.length()) {
                    val n = arr.optString(i)
                    val f = File(dir, n)
                    if (f.exists() && f.length() > 0) { files.add(n); bytes += f.length() }
                }
                if (files.isEmpty()) continue
                out.add(Item(anchor, sid, files, "$course $day", bytes))
            }
        }
        return out
    }

    /** 顺序修：一次改一组（同一天同一门课），整组传完再让电脑统一重跑 */
    private fun start(act: Activity, work: List<Item>, onDone: (() -> Unit)?) {
        if (running) return
        running = true
        Thread {
            var okFiles = 0
            var okGroups = 0
            val fails = ArrayList<String>()
            val byAnchor = LinkedHashMap<String, MutableList<Item>>()
            for (w in work) byAnchor.getOrPut(w.anchor) { ArrayList() }.add(w)

            val pendingLeft = ArrayList(work)
            try {
                savePending(work)   // 先落工单：传到一半 APP 被杀，下次启动能续上
                for ((anchor, items) in byAnchor) {
                    var groupOk = true
                    for (it in items) {
                        val (prepOk, msg) = Api.prepareReupload(it.sid, it.files)
                        if (!prepOk) {
                            fails.add("${it.label}：$msg")
                            groupOk = false
                            break
                        }
                        Db.setSessionState(it.sid, "uploading")
                        val err = Api.uploadSessionFiles(it.sid, it.files)
                        if (err != null) {
                            fails.add("${it.label}：$err")
                            groupOk = false
                            break
                        }
                        okFiles += it.files.size
                    }
                    if (groupOk && Api.finishReupload(anchor)) {
                        okGroups++
                        // 修好的节从工单里划掉，下次续传只补没修完的，不重复上传
                        pendingLeft.removeAll(items)
                        savePending(pendingLeft)
                        act.runOnUiThread { Ui.toast(act, "已修复 ${okGroups} 节，电脑正在重新整理…") }
                    } else if (groupOk) {
                        fails.add("通知电脑重跑失败（稍后点同步再试）")
                    }
                }
            } catch (e: Exception) {
                fails.add(e.message ?: "修复异常")
            } finally {
                running = false
                if (fails.isEmpty()) Db.setMeta(PENDING, "")
                act.runOnUiThread {
                    if (fails.isEmpty()) {
                        Db.setMeta(KEY, Upd.VERSION_CODE.toString())
                        Ui.toast(act, "修复完成：补传 $okFiles 个文件、$okGroups 节课，电脑正在重新整理笔记")
                    } else {
                        Ui.toast(act, "修复了 $okGroups 节，还有 ${fails.size} 处没成功（下次打开会再试）：${fails.first()}")
                    }
                    onDone?.invoke()
                }
            }
        }.start()
    }

    /** 工单落手机：传到一半 APP 被杀/断网，下次启动按这份清单续传（电脑端半截文件会被从头重传） */
    private fun savePending(work: List<Item>) {
        try {
            val arr = org.json.JSONArray()
            for (w in work) {
                val fa = org.json.JSONArray()
                for (n in w.files) fa.put(n)
                arr.put(JSONObject().put("anchor", w.anchor).put("sid", w.sid).put("label", w.label).put("files", fa))
            }
            Db.setMeta(PENDING, arr.toString())
        } catch (_: Exception) { }
    }

    private fun loadPending(): List<Item> {
        val out = ArrayList<Item>()
        try {
            val raw = Db.meta(PENDING, "")
            if (raw.isEmpty()) return out
            val arr = org.json.JSONArray(raw)
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val sid = o.optString("sid")
                val row = Db.session(sid) ?: continue
                val dir = File(row.optString("dir"))
                val files = ArrayList<String>()
                var bytes = 0L
                val fa = o.optJSONArray("files") ?: continue
                for (k in 0 until fa.length()) {
                    val n = fa.optString(k)
                    val f = File(dir, n)
                    if (f.exists() && f.length() > 0) { files.add(n); bytes += f.length() }
                }
                if (files.isNotEmpty()) out.add(Item(o.optString("anchor"), sid, files, o.optString("label"), bytes))
            }
        } catch (_: Exception) { }
        if (out.isEmpty()) Db.setMeta(PENDING, "")
        return out
    }

    private fun onWifi(ctx: Context): Boolean {
        return try {
            val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val n = cm.activeNetwork ?: return false
            val caps = cm.getNetworkCapabilities(n) ?: return false
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
        } catch (_: Exception) { true }
    }
}
