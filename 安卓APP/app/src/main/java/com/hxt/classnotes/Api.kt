package com.hxt.classnotes

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * 与家里电脑的通讯层（同英语阅读APP模式）。
 * 服务器地址不用手填：电脑端隧道变化自动广播 ntfy，APP 启动/失败时来取最新。
 * 上传采用 3MB 分块 + 服务端按字节续传：隧道抖动从断点继续，不重传整堂课。
 */
object Api {
    // v2.0：token/ntfy 频道可配（「连接电脑」配对后写进 Db）
    // 开源版：不内置任何配对口令与通知频道——首次使用在 APP 里点「连接电脑」配对后自动写入（见 PairActivity）。
    // 想给自己的班级预置固定口令，可在打包时改这两个常量，别把改动后的版本公开。
    const val DEFAULT_TOKEN = ""
    private const val DEFAULT_TOPIC = ""
    @Volatile var TOKEN: String = DEFAULT_TOKEN
    @Volatile private var ntfyTopicV: String = DEFAULT_TOPIC
    private const val KEY_URL = "serverUrl"
    private const val CHUNK = 3 * 1024 * 1024

    /** 进 APP 时调一次：把配对保存的 token/频道装进来 */
    fun initCredentials() {
        val t = Db.meta("appToken"); if (t.isNotEmpty()) TOKEN = t
        val tp = Db.meta("ntfyTopic"); if (tp.isNotEmpty()) ntfyTopicV = tp
    }

    fun ntfyTopic(): String = ntfyTopicV

    /** 配对成功：token/频道/服务器地址一次存好，立即生效 */
    fun saveCredentials(server: String, token: String, topic: String) {
        if (token.isNotEmpty()) { TOKEN = token; Db.setMeta("appToken", token) }
        if (topic.isNotEmpty()) { ntfyTopicV = topic; Db.setMeta("ntfyTopic", topic) }
        if (server.isNotEmpty()) { setSavedUrl(server); cachedUrl = server; cachedAt = System.currentTimeMillis() }
    }

    /** 是否已经配过对（没配过=烧录默认部署，照样能用） */
    fun paired(): Boolean = Db.meta("appToken").isNotEmpty()

    // ---------- 基础请求 ----------
    private fun conn(url: String, timeout: Int): HttpURLConnection {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = timeout
        c.readTimeout = timeout
        c.setRequestProperty("x-app-token", TOKEN)
        return c
    }

    private fun http(url: String, method: String = "GET", body: String? = null, timeout: Int = 20000): Pair<Int, String> {
        val c = conn(url, timeout)
        c.requestMethod = method
        try {
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("content-type", "application/json")
                val bytes = body.toByteArray(Charsets.UTF_8)
                c.setFixedLengthStreamingMode(bytes.size)
                c.outputStream.use { it.write(bytes) }
            }
            val code = c.responseCode
            val text = (if (code in 200..299) c.inputStream else c.errorStream)?.readBytes()?.toString(Charsets.UTF_8) ?: ""
            c.disconnect()
            return Pair(code, text)
        } catch (e: Exception) {
            // 连不上/被重置：缓存的网址多半已失效（隧道换线），作废它下次重新发现
            invalidateUrl()
            throw e
        }
    }

    private fun postBytes(url: String, data: ByteArray, timeout: Int): Pair<Int, String> {
        val c = conn(url, timeout)
        c.requestMethod = "POST"
        c.doOutput = true
        try {
            c.setRequestProperty("content-type", "application/octet-stream")
            c.setFixedLengthStreamingMode(data.size)
            c.outputStream.use { it.write(data) }
            val code = c.responseCode
            val text = (if (code in 200..299) c.inputStream else c.errorStream)?.readBytes()?.toString(Charsets.UTF_8) ?: ""
            c.disconnect()
            return Pair(code, text)
        } catch (e: Exception) {
            invalidateUrl()
            throw e
        }
    }

    private fun getBytes(url: String, timeout: Int = 60000): Pair<Int, ByteArray?> {
        val c = conn(url, timeout)
        val code = c.responseCode
        val data = if (code in 200..299) c.inputStream?.readBytes() else null
        c.disconnect()
        return Pair(code, data)
    }

    // ---------- 服务器地址发现 ----------
    fun savedUrl(): String = Db.meta(KEY_URL)
    fun setSavedUrl(u: String) = Db.setMeta(KEY_URL, u)

    // 网址缓存（v1.5）：隧道网址稳定后，一次页面打开里的多个请求不该各跑一遍「ping+发现」。
    // 成功结果 90 秒内直接复用；彻底失败后 20 秒内不再反复折腾（原来每次都要 12s ping + 12s ntfy）。
    @Volatile private var cachedUrl: String? = null
    @Volatile private var cachedAt = 0L
    @Volatile private var lastFailAt = 0L

    /** 网络请求真失败时调用：作废缓存的网址，下次走完整发现 */
    fun invalidateUrl() { cachedUrl = null; cachedAt = 0L }

    /** 正在上传的会话（uploading 卡死自愈用：不把正在传的拨回 ready） */
    val activeUploads = java.util.Collections.synchronizedSet(HashSet<String>())

    fun discoverUrl(): String? {
        return try {
            val (code, text) = http("https://ntfy.sh/${ntfyTopic()}/json?poll=1&since=2h", timeout = 8000)
            if (code != 200) return null
            var last: String? = null
            for (line in text.split("\n")) {
                if (line.isBlank()) continue
                try {
                    val o = JSONObject(line)
                    if (o.optString("event") == "message" && o.optString("title") == "classnotes-url") {
                        val u = o.optString("message")
                        if (u.startsWith("https://")) last = u
                    }
                } catch (_: Exception) { }
            }
            last
        } catch (_: Exception) { null }
    }

    private fun pingOk(url: String): Boolean {
        return try {
            val (code, text) = http("$url/api/ping", timeout = 6000)
            code == 200 && JSONObject(text).optBoolean("ok", false)
        } catch (_: Exception) { false }
    }

    fun workingUrl(): String? {
        val now = System.currentTimeMillis()
        cachedUrl?.let { if (now - cachedAt < 90_000) return it }
        if (now - lastFailAt < 20_000) return null
        val saved = savedUrl()
        if (saved.isNotEmpty() && pingOk(saved)) { cachedUrl = saved; cachedAt = now; return saved }
        val found = discoverUrl() ?: run { lastFailAt = now; return null }
        if (pingOk(found)) { setSavedUrl(found); cachedUrl = found; cachedAt = now; return found }
        lastFailAt = now
        return null
    }

    // ---------- 上传一个会话 ----------
    /** 同一会话同时只允许一个上传线程（v2.2）：多个线程并发传同一文件，正是电脑上分块被写坏的源头 */
    private val uploading = java.util.Collections.synchronizedSet(java.util.HashSet<String>())

    /** 把一个 ready 会话整包推给电脑；返回 null=成功，否则人话错误 */
    fun uploadSession(sid: String): String? {
        if (!uploading.add(sid)) return null   // 已有线程在传这一节，后到的直接当成功，别并发
        activeUploads.add(sid)
        try {
            return uploadSessionInner(sid)
        } finally {
            activeUploads.remove(sid)
            uploading.remove(sid)
        }
    }

    /** v2.3 只重传指定文件（自动修复损坏录音用）：其余素材原样保留在电脑上 */
    fun uploadSessionFiles(sid: String, names: List<String>): String? {
        if (names.isEmpty()) return null
        if (!uploading.add(sid)) return "这一节正在上传，稍后自动重试"
        activeUploads.add(sid)
        try {
            return uploadSessionInner(sid, names.toHashSet())
        } finally {
            activeUploads.remove(sid)
            uploading.remove(sid)
        }
    }

    // ---------- 素材重传修复（v2.2） ----------
    /** 让电脑把这一课现有素材挪进 files_备份（不删），手机随后从 0 字节重传。
     *  返回 (是否成功, 锚点会话 id 或人话错误) */
    fun prepareReupload(sid: String, files: List<String> = emptyList()): Pair<Boolean, String> {
        return try {
            val url = workingUrl() ?: return Pair(false, "连不上电脑（隧道没通/电脑关机）")
            // files 非空=只重传这些损坏文件（自动体检修复）；空=整会话重传（长按菜单）
            val fs = if (files.isEmpty()) "" else "&files=" + java.net.URLEncoder.encode(files.joinToString(","), "UTF-8")
            val (code, text) = http("$url/api/session/reupload?id=$sid$fs", "POST", null, 30000)
            if (code == 200) Pair(true, JSONObject(text).optString("anchor"))
            else Pair(false, try { JSONObject(text).optString("error") } catch (_: Exception) { "HTTP $code" })
        } catch (e: Exception) { Pair(false, e.message ?: "连不上电脑") }
    }

    /** v2.3 损坏素材体检：返回 {groups:[{anchor,course,startedAt,sessions:[{id,course,files:[...]}]}], totalFiles, totalBytes} */
    fun repairScan(): JSONObject? {
        return try {
            val url = workingUrl() ?: return null
            val (code, text) = http("$url/api/repair/scan", timeout = 180000)
            if (code == 200) JSONObject(text) else null
        } catch (_: Exception) { null }
    }

    /** 整组素材都重传完了：让电脑统一重新整理一次（锚点会话 id） */
    fun finishReupload(anchor: String): Boolean {
        return try {
            val url = workingUrl() ?: return false
            val (code, _) = http("$url/api/session/repair-done?id=$anchor", "POST", null, 30000)
            code == 200
        } catch (_: Exception) { false }
    }

    private fun uploadSessionInner(sid: String, only: Set<String>? = null): String? {
        val url = workingUrl() ?: return "连不上电脑（隧道没通/电脑关机），素材还在手机里，稍后再传"
        val s = Db.session(sid) ?: return "会话不存在"
        val segs = Db.segments(sid)
        val photos = Db.photos(sid)

        val ph = JSONArray()
        for (i in 0 until photos.length()) {
            val p = photos.getJSONObject(i)
            ph.put(JSONObject()
                .put("name", p.getString("name"))
                .put("offsetMs", p.getLong("offsetMs"))
                .put("takenAt", s.getLong("startedAt") + p.getLong("offsetMs")))
        }
        val mk = Db.marks(sid)
        val meta = JSONObject()
            .put("id", sid)
            .put("course", s.getString("course"))
            .put("startedAt", s.getLong("startedAt"))
            .put("endedAt", s.getLong("endedAt"))
            .put("durationMs", s.getLong("durMs"))
            .put("device", "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}")
            .put("segments", segs)
            .put("photos", ph)
            .put("markers", mk)
        val (mc, mt) = http("$url/api/session/meta", "POST", meta.toString(), 30000)
        if (mc != 200) return "登记会话失败（$mc）：$mt"
        val received = HashMap<String, Long>()
        try {
            val rj = JSONObject(mt).getJSONObject("received")
            for (k in rj.keys()) received[k] = rj.getLong(k)
        } catch (_: Exception) { }

        val dir = File(s.getString("dir"))
        try {
            for (i in 0 until segs.length()) {
                val name = segs.getJSONObject(i).getString("name")
                if (only != null && name !in only) continue
                uploadFile(url, sid, File(dir, name), name, received)
            }
            for (i in 0 until ph.length()) {
                val name = ph.getJSONObject(i).getString("name")
                if (only != null && name !in only) continue
                uploadFile(url, sid, File(dir, name), name, received)
            }
        } catch (e: Exception) {
            return e.message ?: "上传中断"
        }
        val (cc, ct) = http("$url/api/session/complete", "POST", JSONObject().put("id", sid).toString(), 30000)
        if (cc != 200) return "收尾失败（$cc）：$ct"
        Db.setSessionState(sid, "uploaded")
        return null
    }

    private fun uploadFile(base: String, sid: String, f: File, name: String, received: HashMap<String, Long>) {
        if (!f.exists()) throw Exception("手机上缺文件：$name")
        var attempt = 0
        while (true) {
            val local = f.length()
            val off = received[name] ?: 0L
            // v2.2：电脑上的字节数比手机原文件还大 = 旧版并发上传把分块重复追加了（2×3MiB 重复块），
            // 这时绝不能当作“已传完”跳过，否则坏文件永远留在电脑上、整段笔记一直缺。
            if (off > local) throw Exception("电脑上的 $name 比手机大（$off/${local} 字节，疑似传坏），请在「课堂记录」长按这一组选「重新上传素材」修复")
            if (off >= local) return
            val end = minOf(off + CHUNK, local)
            val buf = ByteArray((end - off).toInt())
            RandomAccessFile(f, "r").use { it.seek(off); it.readFully(buf) }
            // 分块带 md5：传输/落盘损坏会被服务端当场打回重传（旧服务端忽略此参数）
            val md5 = MessageDigest.getInstance("MD5").digest(buf).joinToString("") { "%02x".format(it) }
            val (code, text) = postBytes("$base/api/chunk?id=$sid&name=$name&offset=$off&md5=$md5", buf, 180000)
            when {
                code == 200 -> {
                    try { received[name] = JSONObject(text).getLong("received") } catch (_: Exception) { }
                    attempt = 0
                }
                code == 409 -> {
                    // 服务端字节数与本地认知不一致：以服务端为准续传
                    try { received[name] = JSONObject(text).getLong("received") } catch (_: Exception) { }
                    attempt = 0
                }
                else -> {
                    attempt++
                    if (attempt >= 5) throw Exception("上传 $name 连续失败（HTTP $code）")
                    Thread.sleep(1500L * attempt)
                }
            }
        }
    }

    // ---------- 课程页（v1.2） ----------
    /** 课程聚合：每门课的笔记列表 + 待办；失败返回 null */
    fun courseAgg(): org.json.JSONObject? {
        return try {
            val url = workingUrl() ?: return null
            val (code, text) = http("$url/api/courses", timeout = 20000)
            if (code != 200) null else JSONObject(text)
        } catch (_: Exception) { null }
    }

    /** 课程总纲：带 haveMs（手机缓存的 md 修改时间）增量核对，没变服务端只回几十字节；失败返回 null */
    fun overview(course: String, haveMs: Long): org.json.JSONObject? {
        return try {
            val url = workingUrl() ?: return null
            val (code, text) = http("$url/api/overview?course=" + java.net.URLEncoder.encode(course, "UTF-8") + "&have=$haveMs", timeout = 20000)
            if (code != 200) null else JSONObject(text)
        } catch (_: Exception) { null }
    }

    // ---------- 北信科小助手倒计时（v1.7：完整结构 items/overdue/recentDone） ----------
    /** 拉倒计时三堆：items=未完成未过期、overdue=过期未完成（默认折叠展示）、recentDone=最近勾掉的（可撤销）；失败返回 null */
    fun deadlines(): org.json.JSONObject? {
        return try {
            val url = workingUrl() ?: return null
            val (code, text) = http("$url/api/deadlines", timeout = 20000)
            if (code == 200) JSONObject(text) else null
        } catch (_: Exception) { null }
    }

    /** 勾掉/撤销一条待办（id 形如 dl:xxx / cls:sid:n）；失败返回 false（调用方先本地生效再补推） */
    fun deadlineDone(id: String, done: Boolean, title: String): Boolean {
        return try {
            val url = workingUrl() ?: return false
            val body = JSONObject().put("id", id).put("done", done).put("title", title).toString()
            val (code, _) = http("$url/api/deadline-done", "POST", body, 15000)
            code == 200
        } catch (_: Exception) { false }
    }

    // ---------- 本地勾选记账（v1.7：勾一下就消。断网时先记手机，连上电脑自动补推） ----------
    private fun donePendingFile(ctx: android.content.Context) = java.io.File(ctx.filesDir, "done-pending.json")

    /** 已在本地勾掉、等服务端确认的记录：{id: {done, title, at}} */
    fun localDone(ctx: android.content.Context): JSONObject {
        return try { JSONObject(donePendingFile(ctx).readText()) } catch (_: Exception) { JSONObject() }
    }

    private fun saveLocalDone(ctx: android.content.Context, o: JSONObject) {
        try { donePendingFile(ctx).writeText(o.toString()) } catch (_: Exception) { }
    }

    /** 本地记一笔勾选（立即生效于显示）；title 同时存，供服务端校验防 reanalyze 序号漂移 */
    fun setLocalDone(ctx: android.content.Context, id: String, done: Boolean, title: String) {
        val o = localDone(ctx)
        o.put(id, JSONObject().put("done", done).put("title", title).put("at", System.currentTimeMillis()))
        saveLocalDone(ctx, o)
    }

    /** 服务端确认成功后清掉记账（文件是运行时缓存，清空无损） */
    fun clearLocalDone(ctx: android.content.Context, id: String) {
        val o = localDone(ctx)
        o.remove(id)
        saveLocalDone(ctx, o)
    }

    /** 把本地记的勾选补推给服务端（syncAll 里捎带）；返回还剩几条没推出去 */
    fun pushLocalDone(ctx: android.content.Context): Int {
        val o = localDone(ctx)
        var left = 0
        val ids = ArrayList<String>()
        val it = o.keys()
        while (it.hasNext()) ids.add(it.next())
        for (id in ids) {
            val rec = o.optJSONObject(id) ?: continue
            if (Api.deadlineDone(id, rec.optBoolean("done"), rec.optString("title"))) {
                o.remove(id)
            } else left++
        }
        saveLocalDone(ctx, o)
        return left
    }

    // ---------- 课程偏好（v1.6 例题汇总开关） ----------
    /** 把「哪些课要例题汇总」推给电脑（只推手机上明确设过的课，服务端按课合并）；
     *  失败返回 false 不抛——设置已存本地，下次同步会再推 */
    fun pushCourseConfig(prefs: Map<String, Boolean>): Boolean {
        return try {
            val url = workingUrl() ?: return false
            val courses = JSONObject()
            for ((k, v) in prefs) courses.put(k, v)
            val (code, _) = http("$url/api/course-config", "POST", JSONObject().put("courses", courses).toString(), 15000)
            code == 200
        } catch (_: Exception) { false }
    }

    /** 手机上明确设过例题汇总开关的课程（"1"/"0"），没设过的不在返回里（不覆盖服务端） */
    fun examplePrefs(): Map<String, Boolean> {
        val m = HashMap<String, Boolean>()
        for (c in Db.courses()) {
            val v = Db.meta("ex_$c")
            if (v == "1" || v == "0") m[c] = v == "1"
        }
        return m
    }

    // ---------- 连接电脑（v2.0：同 WiFi 自动发现 / 手动输入地址，配对一次永久记住） ----------

    /** 同 WiFi 自动找电脑：UDP 广播 classnotes-discover（全1广播+各网卡网段广播都发一份），
     *  电脑端回应 {server,token,topic,name}；2.5 秒收不到返回 null */
    fun discoverLocal(): JSONObject? {
        return try {
            java.net.DatagramSocket().use { sock ->
                sock.broadcast = true
                sock.soTimeout = 2500
                val msg = "classnotes-discover".toByteArray(Charsets.US_ASCII)
                val targets = HashSet<java.net.InetAddress>()
                try { targets.add(java.net.InetAddress.getByName("255.255.255.255")) } catch (_: Exception) { }
                try {
                    val en = java.net.NetworkInterface.getNetworkInterfaces()
                    while (en.hasMoreElements()) {
                        for (a in en.nextElement().interfaceAddresses) {
                            a.broadcast?.let { targets.add(it) }
                        }
                    }
                } catch (_: Exception) { }
                for (t in targets) {
                    try { sock.send(java.net.DatagramPacket(msg, msg.size, t, 8779)) } catch (_: Exception) { }
                }
                val buf = ByteArray(4096)
                val deadline = System.currentTimeMillis() + 2500
                while (System.currentTimeMillis() < deadline) {
                    val pkt = java.net.DatagramPacket(buf, buf.size)
                    try { sock.receive(pkt) } catch (_: Exception) { break }
                    val s = String(pkt.data, 0, pkt.length, Charsets.UTF_8)
                    if (!s.contains("classnotes")) continue
                    val j = JSONObject(s)
                    if (j.optString("server").startsWith("http")) return j
                }
                null
            }
        } catch (_: Exception) { null }
    }

    /** 手动连接：只输入电脑地址（http://192.168.x.x:8776 或隧道网址），
     *  从 /api/pair-info 免 token 拿配对信息；返回 null=连不上或对方没开局域网直连 */
    fun pairManual(server: String): JSONObject? {
        return try {
            val base = server.trim().removeSuffix("/")
            val (code, text) = http("$base/api/pair-info", timeout = 6000)
            if (code != 200) null else JSONObject(text)
        } catch (_: Exception) { null }
    }

    /** 连接并记住（发现/手动两条路共用）：拿配对信息验证可达后落库（pingOk 用的是本文件原有的探活函数） */
    fun connect(info: JSONObject): Boolean {
        val server = info.optString("server")
        if (server.isEmpty()) return false
        if (!pingOk(server)) return false
        saveCredentials(server, info.optString("token"), info.optString("topic"))
        return true
    }

    // ---------- AI 引擎设置（v2.0：免费 key 模式，填一次自动从转写稿升级成 AI 整理） ----------
    fun aiStatus(): JSONObject? {
        return try {
            val url = workingUrl() ?: return null
            val (code, text) = http("$url/api/ai-key", timeout = 10000)
            if (code == 200) JSONObject(text) else null
        } catch (_: Exception) { null }
    }

    /** 填 key 开启 AI（key 为空串=关掉回转写稿模式）；返回服务端响应或 null（连不上） */
    fun setApiKey(key: String): JSONObject? {
        return try {
            val url = workingUrl() ?: return null
            val (code, text) = http("$url/api/ai-key", "POST", JSONObject().put("apiKey", key).toString(), 15000)
            if (code == 200) JSONObject(text) else JSONObject().put("ok", false).put("error", "HTTP $code：$text")
        } catch (_: Exception) { null }
    }

    // ---------- 笔记 ----------
    private val syncGate = Any()
    @Volatile private var syncing = false

    /** 全量同步：上传 ready 会话 + 拉笔记列表 + 下载有更新的笔记（含照片）到本地缓存 */
    fun syncAll(ctx: android.content.Context): String {
        // v2.2：全局互斥。主页/笔记页/课程页原来各自起裸线程调 syncAll，两个线程会同时上传同一会话，
        // 服务端就会收到同一 offset 的并发分块——2026-10-16 多门课录音被写坏的根因。
        synchronized(syncGate) {
            if (syncing) return "正在同步，稍等"
            syncing = true
        }
        try { return syncAllInner(ctx) } finally { syncing = false }
    }

    private fun syncAllInner(ctx: android.content.Context): String {
        val url = workingUrl()
            ?: return "连不上电脑（可能关机了）。素材都还在手机里，不会丢"

        val parts = ArrayList<String>()

        // 1) 上传（v2.0：按设置页的「自动上传」策略；手动上传入口不受影响）
        val ready = Db.readySessions()
        if (ready.isNotEmpty() && !autoUploadAllowed(ctx)) {
            parts.add("有 ${ready.size} 节待上传（设置里没开自动传，去「笔记」页点课堂记录手动传）")
        } else {
            var up = 0; var fail = 0
            for (sid in ready) {
                val err = uploadSession(sid)
                if (err == null) up++ else { fail++; android.util.Log.e("classnotes", "上传 $sid: $err") }
            }
            if (up > 0) parts.add("传了 $up 节课")
            if (fail > 0) parts.add("$fail 节没传上（稍后自动重试）")
        }

        // 2) 笔记列表
        var notes = 0
        try {
            val (code, text) = http("$url/api/notes")
            if (code == 200) {
                val list = JSONObject(text).getJSONArray("list")
                val keep = HashSet<String>()
                for (i in 0 until list.length()) {
                    val e = list.getJSONObject(i)
                    val sid = e.getString("id")
                    keep.add(sid)
                    val cached = Db.noteCache(sid)
                    val cachedUpd = cached?.optString("noteUpdated") ?: ""
                    val newUpd = e.optString("noteUpdated")
                    val stateChanged = cached?.optString("state") != e.optString("state")
                    // v1.7 缺图自愈：笔记没更新但手机照片数对不上（上次下载中途断网）也要补
                    val photoLack = cached != null && e.optString("state") == "done" &&
                            missingPhotos(ctx, sid, cached.optInt("photoCount"))
                    if (cached == null || stateChanged || photoLack || (newUpd.isNotEmpty() && newUpd != cachedUpd)) {
                        if (refreshNote(ctx, url, sid)) notes++
                    }
                    // 正文没变、服务端后来补了总结：只更新这一列，免得为一句摘要重下全文
                    val sm = e.optString("summary")
                    if (sm.isNotEmpty() && sm != (cached?.optString("summary") ?: "")) {
                        Db.setNoteSummary(sid, sm)
                    }
                }
                // 服务端已把同日同课并成一条：手机上旧的碎片笔记缓存跟着清掉，列表才不会重复
                val pruned = Db.pruneNoteCache(keep)
                if (pruned > 0) parts.add("清理 $pruned 条已合并的旧笔记")
            }
        } catch (_: Exception) { }
        if (notes > 0) parts.add("更新 $notes 份笔记")

        // 3) 课程设置（例题汇总开关）顺手推给电脑：手机本地是真相源，失败不报错下次再推
        try {
            val prefs = examplePrefs()
            if (prefs.isNotEmpty()) pushCourseConfig(prefs)
        } catch (_: Exception) { }

        // 4) 本地勾掉的待办补推（v1.7：断网时记手机的勾选，连上电脑这里补上）
        try {
            val left = pushLocalDone(ctx)
            if (left > 0) parts.add("$left 条勾选待补推")
        } catch (_: Exception) { }

        // 5) 黑匣子（v1.8）：崩溃日志 + 录音服务日志捎给电脑存档——录音再出「无痕死亡」就有死因铁证
        try {
            if (pushDiag(ctx, url)) parts.add("已回报诊断日志")
        } catch (_: Exception) { }

        if (parts.isEmpty()) parts.add("已是最新")
        return "同步完成：" + parts.joinToString("，")
    }

    /** 把 crash-*.txt（未捕获异常）与 rec-log.txt（录音服务面包屑）里新增的内容 POST /api/diag；
     *  以 meta.diagAt 为水位线只传新增；文件留在手机不删。返回 true=这次真的传了东西 */
    fun pushDiag(ctx: android.content.Context, base: String): Boolean {
        val lastAt = Db.meta("diagAt").toLongOrNull() ?: 0L
        val logs = JSONArray()
        var newest = lastAt
        val dir = ctx.filesDir
        val crashes = dir.listFiles { f -> f.name.startsWith("crash-") && f.name.endsWith(".txt") }
            ?.sortedBy { it.name } ?: emptyList()
        for (f in crashes) {
            if (f.lastModified() <= lastAt) continue
            logs.put(JSONObject().put("name", f.name).put("text", f.readText().take(60 * 1024)))
            if (f.lastModified() > newest) newest = f.lastModified()
        }
        for (name in arrayOf("rec-log.txt", "rec-log.old.txt")) {
            val f = java.io.File(dir, name)
            if (f.exists() && f.lastModified() > lastAt && f.length() > 0) {
                // 面包屑只捎最近 32KB（环形日志，旧的电脑里已有存档）
                val text = f.readText().let { if (it.length > 32 * 1024) it.substring(it.length - 32 * 1024) else it }
                logs.put(JSONObject().put("name", name).put("text", text))
                if (f.lastModified() > newest) newest = f.lastModified()
            }
        }
        if (logs.length() == 0) return false
        val (code, _) = http("$base/api/diag", "POST", JSONObject().put("logs", logs).toString(), 30000)
        if (code == 200) Db.setMeta("diagAt", newest.toString())
        return code == 200
    }

    /** 下载单份笔记（html+照片）到本地，存缓存；失败返回 false。
     *  v1.7：一张照片下载失败只跳过这张，不再整包放弃（原来一张超时，后面的照片全不下，
     *  而笔记 html 已先落盘，之后笔记没更新就永远不补图——笔记里就一直是裂图）。缺的靠
     *  syncAll 的照片数核对和打开笔记页时的体检补齐。 */
    fun refreshNote(ctx: android.content.Context, base: String, sid: String): Boolean {
        return try {
            val (code, text) = http("$base/api/note?id=$sid", timeout = 30000)
            if (code != 200) return false
            val j = JSONObject(text)
            val dir = File(File(ctx.filesDir, "notes"), sid).apply { mkdirs() }
            val html = j.optString("html")
            if (html.isNotEmpty()) File(dir, "note.html").writeText(html, Charsets.UTF_8)
            val photos = j.optJSONArray("photos") ?: JSONArray()
            for (i in 0 until photos.length()) {
                val name = photos.getJSONObject(i).optString("name")
                if (name.isEmpty()) continue
                val f = File(dir, name)
                if (!f.exists() || f.length() == 0L) {
                    try {
                        val (pc, data) = getBytes("$base/api/file?id=$sid&name=$name")
                        if (pc == 200 && data != null && data.isNotEmpty()) f.writeBytes(data)
                    } catch (_: Exception) { }   // 这张先跳过，别拖死后面的照片
                }
            }
            val items = j.optJSONArray("items")
            Db.saveNoteCache(
                sid, j.optString("course"), j.optString("title"), j.optString("state"),
                j.optString("noteUpdated"), j.optString("summary"),
                JSONObject()
                    .put("sid", sid)
                    .put("course", j.optString("course"))
                    .put("title", j.optString("title"))
                    .put("state", j.optString("state"))
                    .put("noteUpdated", j.optString("noteUpdated"))
                    .put("summary", j.optString("summary"))
                    .put("error", j.optString("error"))
                    .put("items", items ?: JSONArray())
                    .put("photoCount", j.optInt("photoCount"))
                    .toString()
            )
            true
        } catch (_: Exception) {
            false
        }
    }

    /** 本地笔记的照片体检（v1.7）：done 笔记的缓存登记有 N 张照片，手机目录里缺了就是裂图 */
    fun missingPhotos(ctx: android.content.Context, sid: String, expect: Int): Boolean {
        if (expect <= 0) return false
        val dir = File(File(ctx.filesDir, "notes"), sid)
        val local = dir.listFiles { f -> f.name.endsWith(".jpg") }?.size ?: 0
        return local < expect
    }

    // ---------- 自动上传策略（v2.0 设置页） ----------
    /** auto=连上就传（默认）；wifi=仅 WiFi；manual=不自动传（「笔记」页点课堂记录手动传） */
    fun autoUploadAllowed(ctx: android.content.Context): Boolean = when (Db.meta("autoUpload", "auto")) {
        "manual" -> false
        "wifi" -> onWifi(ctx)
        else -> true
    }

    private fun onWifi(ctx: android.content.Context): Boolean {
        return try {
            val cm = ctx.getSystemService(android.content.Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
            val n = cm.activeNetwork ?: return false
            val caps = cm.getNetworkCapabilities(n) ?: return false
            caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)
        } catch (_: Exception) {
            true   // 判不出来时按可传处理，别把该传的卡死
        }
    }
}
