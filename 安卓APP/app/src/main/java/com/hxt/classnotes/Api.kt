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
    // v2.0：token/ntfy 频道可配（「连接电脑」配对后写进 Db）。
    // 开源版不内置任何口令：这两个是占位符，空白安装必须靠下面 connect() 的「先装凭证再探活」完成首次配对。
    const val DEFAULT_TOKEN = "请先与你的电脑配对"
    private const val DEFAULT_TOPIC = "your-ntfy-topic"
    @Volatile var TOKEN: String = DEFAULT_TOKEN
    @Volatile private var ntfyTopicV: String = DEFAULT_TOPIC
    private const val KEY_URL = "serverUrl"
    // v2.10：3 MiB → 512 KiB。服务端是「收满一块才落盘」，弱网/切后台时一块废掉就是全白传；
    // 512 KiB 在隧道里 6~8 秒一块，被掐断的概率低得多，重传代价也小。局域网下这点开销可忽略。
    private const val CHUNK = 512 * 1024

    /** 进 APP 时调一次：把配对保存的 token/频道装进来 */
    fun initCredentials() {
        val t = Db.meta("appToken"); if (t.isNotEmpty()) TOKEN = t
        val tp = Db.meta("ntfyTopic"); if (tp.isNotEmpty()) ntfyTopicV = tp
    }

    // v2.9：上传保活用的 Application Context（App.onCreate 里塞进来）
    @Volatile private var appCtx: android.content.Context? = null
    fun initCtx(c: android.content.Context) { appCtx = c.applicationContext }

    // 上传引用计数：第一节开始时拉起前台服务，最后一节结束时撤掉
    private val uploadBusy = java.util.concurrent.atomic.AtomicInteger()
    private fun uploadBegin() {
        if (uploadBusy.incrementAndGet() == 1) {
            appCtx?.let { Sync.ensure(it) }
            Sync.progress("正在上传课堂笔记", "可以切后台或锁屏，传完自动收尾")
        }
    }
    private fun uploadEnd() {
        if (uploadBusy.decrementAndGet() <= 0) {
            uploadBusy.set(0)
            appCtx?.let { Sync.stop(it) }
        }
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

    // v2.9：电脑同时广播两条——隧道的 https 网址（classnotes-url）和局域网地址（classnotes-lan）。
    // 同一 WiFi 时优先走局域网（速度是隧道的几十倍）；不在同一 WiFi 就 1.5 秒探不通，自动退回隧道。
    @Volatile private var ntfyAt = 0L
    @Volatile private var ntfyUrl: String? = null
    @Volatile private var ntfyLan: String? = null

    private fun ntfyFetch() {
        val now = System.currentTimeMillis()
        if (now - ntfyAt < 60_000) return
        ntfyAt = now
        ntfyUrl = null
        ntfyLan = null
        try {
            val (code, text) = http("https://ntfy.sh/${ntfyTopic()}/json?poll=1&since=2h", timeout = 8000)
            if (code != 200) return
            for (line in text.split("\n")) {
                if (line.isBlank()) continue
                try {
                    val o = JSONObject(line)
                    if (o.optString("event") != "message") continue
                    val u = o.optString("message")
                    when (o.optString("title")) {
                        "classnotes-url" -> if (u.startsWith("https://")) ntfyUrl = u
                        "classnotes-lan" -> if (u.startsWith("http://")) ntfyLan = u
                    }
                } catch (_: Exception) { }
            }
        } catch (_: Exception) { }
    }

    fun discoverUrl(): String? { ntfyFetch(); return ntfyUrl }

    private fun pingOk(url: String, timeout: Int = 6000): Boolean {
        return try {
            val (code, text) = http("$url/api/ping", timeout = timeout)
            code == 200 && JSONObject(text).optBoolean("ok", false)
        } catch (_: Exception) { false }
    }

    // 局域网地址：探通就缓存 10 分钟；探不通 1 分钟内不再试（免得每次请求都白等 1.5 秒）
    @Volatile private var lanTryAt = 0L
    @Volatile private var lanGood: String? = null

    fun lanUrl(): String? {
        val now = System.currentTimeMillis()
        lanGood?.let { if (now - lanTryAt < 10 * 60_000) return it }
        if (now - lanTryAt < 60_000) return null
        lanTryAt = now
        lanGood = null
        ntfyFetch()
        val cand = ntfyLan
        if (cand != null && pingOk(cand, 1500)) lanGood = cand
        return lanGood
    }

    fun workingUrl(): String? {
        val now = System.currentTimeMillis()
        cachedUrl?.let { if (now - cachedAt < 90_000) return it }
        if (now - lastFailAt < 20_000) return null
        lanUrl()?.let { cachedUrl = it; cachedAt = now; route = ROUTE_LAN; return it }   // v2.9 局域网优先
        val saved = savedUrl()
        if (saved.isNotEmpty() && pingOk(saved)) { cachedUrl = saved; cachedAt = now; route = ROUTE_NET; return saved }
        val found = discoverUrl() ?: run { lastFailAt = now; return null }
        if (pingOk(found)) { setSavedUrl(found); cachedUrl = found; cachedAt = now; route = ROUTE_NET; return found }
        lastFailAt = now
        return null
    }

    // v2.10：把当前线路亮出来（局域网 / 隧道），传得慢或断了，一眼就知道走的是哪条
    const val ROUTE_LAN = "局域网"
    const val ROUTE_NET = "隧道"
    @Volatile private var route = ROUTE_NET

    fun currentRoute(): String = route

    /** 局域网连着失败两次：5 分钟内不再走局域网，直接用隧道（坏线路别反复卡） */
    fun markLanBad() {
        lanGood = null
        lanTryAt = System.currentTimeMillis() + 4 * 60_000   // 让 lanUrl() 的 60 秒冷却直接跳到 5 分钟后
        route = ROUTE_NET
        invalidateUrl()
    }

    /** v2.10：手机端出了什么错也送回电脑（尽力而为，不打扰用户），免得只能靠猜 */
    fun reportClientLog(kind: String, text: String) {
        Thread {
            try {
                val url = workingUrl() ?: return@Thread
                val body = JSONObject()
                    .put("kind", kind)
                    .put("text", text.take(4000))
                    .put("route", route)
                    .toString()
                http("$url/api/client-log", "POST", body, 8000)
            } catch (_: Exception) { }
        }.start()
    }

    // ---------- 上传一个会话 ----------
    /** 同一会话同时只允许一个上传线程（v2.2）：多个线程并发传同一文件，正是电脑上分块被写坏的源头 */
    private val uploading = java.util.Collections.synchronizedSet(java.util.HashSet<String>())

    /** 把一个 ready 会话整包推给电脑；返回 null=成功，否则人话错误 */
    fun uploadSession(sid: String): String? {
        if (!uploading.add(sid)) return null   // 已有线程在传这一节，后到的直接当成功，别并发
        activeUploads.add(sid)
        uploadBegin()
        try {
            return uploadSessionInner(sid)
        } finally {
            activeUploads.remove(sid)
            uploading.remove(sid)
            uploadEnd()
        }
    }

    /** v2.3 只重传指定文件（自动修复损坏录音用）：其余素材原样保留在电脑上 */
    fun uploadSessionFiles(sid: String, names: List<String>): String? {
        if (names.isEmpty()) return null
        if (!uploading.add(sid)) return "这一节正在上传，稍后自动重试"
        activeUploads.add(sid)
        uploadBegin()
        try {
            return uploadSessionInner(sid, names.toHashSet())
        } finally {
            activeUploads.remove(sid)
            uploading.remove(sid)
            uploadEnd()
        }
    }

    // ---------- 带进度事件的上传（2026-10-24 由测试版并入生产） ----------
    /** 每块上传后的实测数据；UI 只消费这些数，不自己推算 */
    data class TxEvent(
        val sid: String, val name: String, val fileSize: Long,
        val chunkStart: Long, val chunkBytes: Long, val received: Long,
        val retry: Int, val ok: Boolean, val offsetMismatch: Boolean = false
    )

    /** 上传结果：忙不能当成成功（原 uploadSession 在“已有线程在传”时返回 null，有二义性） */
    data class UploadOutcome(val ok: Boolean, val busy: Boolean, val error: String?)

    /** 重传面板用：结果三态 + 每块进度回调 */
    fun uploadSessionTracked(sid: String, only: Set<String>? = null, onEvent: (TxEvent) -> Unit): UploadOutcome {
        if (!uploading.add(sid)) return UploadOutcome(false, true, "这一节正在上传，请等它结束")
        activeUploads.add(sid)
        uploadBegin()
        try {
            val err = uploadSessionInner(sid, only, onEvent)
            return UploadOutcome(err == null, false, err)
        } finally {
            activeUploads.remove(sid)
            uploading.remove(sid)
            uploadEnd()
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

    private fun uploadSessionInner(
        sid: String, only: Set<String>? = null,
        onEvent: ((TxEvent) -> Unit)? = null
    ): String? {
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
                uploadFile(url, sid, File(dir, name), name, received, onEvent)
            }
            for (i in 0 until ph.length()) {
                val name = ph.getJSONObject(i).getString("name")
                if (only != null && name !in only) continue
                uploadFile(url, sid, File(dir, name), name, received, onEvent)
            }
        } catch (e: Exception) {
            return e.message ?: "上传中断"
        }
        val (cc, ct) = http("$url/api/session/complete", "POST", JSONObject().put("id", sid).toString(), 30000)
        if (cc != 200) return "收尾失败（$cc）：$ct"
        Db.setSessionState(sid, "uploaded")
        return null
    }

    /** v2.10：网络中断的退避（1s→2s→4s→8s→15s 封顶） */
    private fun backoffMs(n: Int): Long = when {
        n <= 1 -> 1000L
        n <= 3 -> 2000L * n
        n <= 5 -> 8000L
        else -> 15000L
    }

    private fun uploadFile(
        base0: String, sid: String, f: File, name: String, received: HashMap<String, Long>,
        onEvent: ((TxEvent) -> Unit)? = null
    ) {
        if (!f.exists()) throw Exception("手机上缺文件：$name")
        var base = base0
        var attempt = 0
        var netFails = 0
        while (true) {
            val local = f.length()
            val off = received[name] ?: 0L
            // v2.2：电脑上的字节数比手机原文件还大 = 旧版并发上传把分块重复追加了（2×3MiB 重复块），
            // 这时绝不能当作“已传完”跳过，否则坏文件永远留在电脑上、整段笔记一直缺。
            if (off > local) throw Exception("电脑上的 $name 比手机大（$off/${local} 字节，疑似传坏），请在「课堂记录」长按这一组选「重新上传素材」修复")
            if (off >= local) {
                onEvent?.invoke(TxEvent(sid, name, local, local, 0, off, attempt, true))
                return
            }
            val end = minOf(off + CHUNK, local)
            val buf = ByteArray((end - off).toInt())
            RandomAccessFile(f, "r").use { it.seek(off); it.readFully(buf) }
            // 分块带 md5：传输/落盘损坏会被服务端当场打回重传（旧服务端忽略此参数）
            val md5 = MessageDigest.getInstance("MD5").digest(buf).joinToString("") { "%02x".format(it) }
            var code = -1
            var text = ""
            try {
                val r = postBytes("$base/api/chunk?id=$sid&name=$name&offset=$off&md5=$md5", buf, 180000)
                code = r.first
                text = r.second
            } catch (e: Exception) {
                // v2.10：断线 / 被系统冻结 / 隧道抖一下，以前直接整段判失败（用户看到「重传中断」）。
                // 现在当成一次可重试的尝试：退避后按服务端已收字节续传；局域网连挂两次就退回隧道。
                netFails++
                attempt++
                val msg = e.message ?: "网络中断"
                if (route == ROUTE_LAN && netFails >= 2) markLanBad()
                onEvent?.invoke(TxEvent(sid, name, local, off, 0L, received[name] ?: off, attempt, false))
                if (netFails >= 12) throw Exception("$name 连续 $netFails 次网络中断（$msg），已暂停等网络恢复")
                Thread.sleep(backoffMs(netFails))
                workingUrl()?.let { base = it }   // 线路可能换了，重试前重新解析一次
                continue
            }
            netFails = 0
            when {
                code == 200 -> {
                    try { received[name] = JSONObject(text).getLong("received") } catch (_: Exception) { }
                    onEvent?.invoke(TxEvent(sid, name, local, off, buf.size.toLong(),
                        received[name] ?: (off + buf.size), attempt, true))
                    attempt = 0
                }
                code == 409 -> {
                    // 服务端字节数与本地认知不一致：以服务端为准续传
                    try { received[name] = JSONObject(text).getLong("received") } catch (_: Exception) { }
                    onEvent?.invoke(TxEvent(sid, name, local, off, buf.size.toLong(),
                        received[name] ?: 0L, attempt, false, true))
                    attempt = 0
                }
                else -> {
                    attempt++
                    onEvent?.invoke(TxEvent(sid, name, local, off, buf.size.toLong(),
                        received[name] ?: 0L, attempt, false))
                    if (attempt >= 5) throw Exception("上传 $name 连续失败（HTTP $code）")
                    Thread.sleep(1500L * attempt)
                }
            }
        }
    }

    // ---------- 重传后的整文件核对（2026-10-24 由测试版并入生产） ----------
    data class VerifyFile(
        val name: String, val clientSize: Long, val serverSize: Long, val exists: Boolean,
        val sizeMatch: Boolean, val clientMd5: String, val serverMd5: String, val md5Match: Boolean,
        val error: String = ""
    )
    data class VerifyResult(
        val ok: Boolean, val allMatch: Boolean, val files: List<VerifyFile>,
        val missing: List<String>, val extra: List<String>, val error: String?
    )

    /** 流式算整文件 MD5（64KB 一段，不整文件进内存） */
    fun fileMd5(f: File): String {
        val md = MessageDigest.getInstance("MD5")
        f.inputStream().use { ins ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = ins.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /** 把客户端每个文件的 size+md5 发给电脑，由电脑流式计算后逐项比对 */
    fun verifySession(sid: String, files: List<File>): VerifyResult {
        return try {
            val url = workingUrl() ?: return VerifyResult(false, false, emptyList(), emptyList(), emptyList(), "连不上电脑（隧道没通/电脑关机）")
            val arr = JSONArray()
            for (f in files) {
                if (!f.exists()) continue
                arr.put(JSONObject().put("name", f.name).put("size", f.length()).put("md5", fileMd5(f)))
            }
            val (code, text) = http("$url/api/session/verify", "POST",
                JSONObject().put("id", sid).put("files", arr).toString(), 120000)
            if (code != 200) {
                val msg = try { JSONObject(text).optString("error") } catch (_: Exception) { "HTTP $code" }
                return VerifyResult(false, false, emptyList(), emptyList(), emptyList(), msg)
            }
            val j = JSONObject(text)
            val out = ArrayList<VerifyFile>()
            val fa = j.optJSONArray("files") ?: JSONArray()
            for (i in 0 until fa.length()) {
                val o = fa.getJSONObject(i)
                out.add(VerifyFile(
                    o.optString("name"), o.optLong("clientSize"), o.optLong("serverSize"),
                    o.optBoolean("exists"), o.optBoolean("sizeMatch"),
                    o.optString("clientMd5"), o.optString("serverMd5"), o.optBoolean("md5Match"),
                    o.optString("error")
                ))
            }
            VerifyResult(true, j.optBoolean("allMatch", false), out,
                strList(j.optJSONArray("missing")), strList(j.optJSONArray("extra")), null)
        } catch (e: Exception) {
            VerifyResult(false, false, emptyList(), emptyList(), emptyList(), e.message ?: "校验失败")
        }
    }

    private fun strList(a: JSONArray?): List<String> {
        if (a == null) return emptyList()
        val out = ArrayList<String>()
        for (i in 0 until a.length()) out.add(a.optString(i))
        return out
    }

    /** 查一节课的整理状态（结果页轮询用） */
    fun noteState(sid: String): String? {
        return try {
            val url = workingUrl() ?: return null
            val (code, text) = http("$url/api/note?id=$sid", timeout = 15000)
            if (code != 200) null else JSONObject(text).optString("state")
        } catch (_: Exception) { null }
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
    fun pushCourseConfig(prefs: Map<String, Boolean>, terms: Map<String, String>? = null): Boolean {
        return try {
            val url = workingUrl() ?: return false
            val courses = JSONObject()
            for ((k, v) in prefs) courses.put(k, v)
            val body = JSONObject().put("courses", courses)
            if (!terms.isNullOrEmpty()) {
                val ts = JSONObject()
                for ((k, v) in terms) ts.put(k, v)
                body.put("terms", ts)
            }
            val (code, _) = http("$url/api/course-config", "POST", body.toString(), 15000)
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

    /** v2.8 课程术语（空格分隔的专业名词，供电脑转写当热词）：只推用户明确设过的课，
     *  空串也推——服务端据此删掉该课术语（用户清空要能生效） */
    fun termPrefs(): Map<String, String> {
        val m = HashMap<String, String>()
        for (c in Db.courses()) {
            if (Db.meta("termsSet_$c") == "1") m[c] = Db.meta("terms_$c")
        }
        return m
    }

    // ---------- v2.8 课表 / 连接体检 ----------
    /** 拉课表（电脑端 timetable.json）。失败返回 null，调用方保留旧缓存 */
    fun timetable(): JSONObject? {
        return try {
            val url = workingUrl() ?: return null
            val (code, text) = http("$url/api/timetable", timeout = 12000)
            if (code == 200) JSONObject(text) else null
        } catch (_: Exception) { null }
    }

    /** 连接体检：/api/health 汇总电脑端状态（模型、磁盘、笔记数、课表是否就位） */
    fun health(): JSONObject? {
        return try {
            val url = workingUrl() ?: return null
            val (code, text) = http("$url/api/health", timeout = 10000)
            if (code == 200) JSONObject(text) else null
        } catch (_: Exception) { null }
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

    /** 连接并记住（发现/手动两条路共用）：拿配对信息验证可达后落库。
     *  v2.13 开源版：默认 token 是占位符。若照旧「先探活再落库」，空白安装会带着占位 token
     *  打 /api/ping 吃 401，导致第一次永远配不上。改为先临时装入本次下发的 token 再探活，
     *  探通才落库；探不通回滚，不留脏凭证。 */
    fun connect(info: JSONObject): Boolean {
        val server = info.optString("server")
        if (server.isEmpty()) return false
        val token = info.optString("token")
        val topic = info.optString("topic")
        val prev = TOKEN
        if (token.isNotEmpty()) TOKEN = token
        if (!pingOk(server)) { TOKEN = prev; return false }
        saveCredentials(server, token, topic)
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

        // 3) 课程设置（例题汇总开关 / v2.8 课程术语）顺手推给电脑：手机本地是真相源，失败不报错下次再推
        try {
            val prefs = examplePrefs()
            val terms = termPrefs()
            if (prefs.isNotEmpty() || terms.isNotEmpty()) pushCourseConfig(prefs, terms)
        } catch (_: Exception) { }

        // 3b) v2.8 课表：每轮同步顺手拉一次（JSON 只有几 KB），保证「今天/下一节」卡是最新的
        try {
            val t = timetable()
            if (t != null) Timetable.save(ctx, t)
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
            // v2.8 导出：Markdown 原文一并落地，离线也能分享/复制
            val md = j.optString("md")
            if (md.isNotEmpty()) File(dir, "note.md").writeText(md, Charsets.UTF_8)
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

    // ---------- 原始素材（v2.6：录音/原文/照片） ----------
    /** 拉一节课的原始素材元数据 + 逐句转写（只读）。失败返回 null，调用方用本地缓存兜底 */
    fun source(base: String, sid: String): JSONObject? {
        return try {
            val (code, text) = http("$base/api/source?id=$sid", timeout = 25000)
            if (code != 200) return null
            val j = JSONObject(text)
            if (j.optBoolean("ok", false)) j else null
        } catch (_: Exception) {
            null
        }
    }

    private fun sourceCacheFile(ctx: android.content.Context, sid: String) =
        File(File(ctx.filesDir, "source"), "$sid.json")

    /** 原文/分段清单落本地：断网时还能看上次拉到的原文 */
    fun saveSourceCache(ctx: android.content.Context, sid: String, j: JSONObject) {
        try {
            val f = sourceCacheFile(ctx, sid)
            f.parentFile?.mkdirs()
            f.writeText(j.toString(), Charsets.UTF_8)
        } catch (_: Exception) { }
    }

    fun cachedSource(ctx: android.content.Context, sid: String): JSONObject? = try {
        val f = sourceCacheFile(ctx, sid)
        if (!f.exists() || f.length() == 0L) null else JSONObject(f.readText(Charsets.UTF_8))
    } catch (_: Exception) { null }

    /** 素材文件直链。MediaPlayer 加不了请求头，token 只能走查询参数（服务端已支持）。
     *  srcId：同日合并的成员段与锚点段同名（recording_00.m4a…），必须带上才知道取哪一份。 */
    fun fileUrl(base: String, sid: String, name: String, srcId: String = ""): String {
        val e = { s: String -> java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20") }
        val src = if (srcId.isEmpty()) "" else "&src=${e(srcId)}"
        return "$base/api/file?id=${e(sid)}&name=${e(name)}$src&token=${e(TOKEN)}"
    }

    fun fileBytes(url: String, timeout: Int = 60000): ByteArray? = try {
        val (code, data) = getBytes(url, timeout)
        if (code in 200..299) data else null
    } catch (_: Exception) { null }

    /** 把电脑上的原图下到本地缓存（本机没有这张时用），返回缓存文件 */
    fun cachePhoto(ctx: android.content.Context, base: String, sid: String, name: String, srcId: String = ""): File? {
        val safe = name.replace("\\", "_").replace("/", "_")
        if (safe.isEmpty()) return null
        val dir = File(File(ctx.filesDir, "source-photos"), sid)
        val f = File(dir, safe)
        if (f.exists() && f.length() > 0L) return f
        val data = fileBytes(fileUrl(base, sid, name, srcId)) ?: return null
        if (data.isEmpty()) return null
        return try {
            dir.mkdirs()
            val tmp = File(dir, "$safe.part")
            tmp.writeBytes(data)
            if (!tmp.renameTo(f)) return null
            f
        } catch (_: Exception) { null }
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

    // ---------- 学习通（v2.11，全程只读：作业/通知/考试/任务点） ----------
    /** 电脑端转发到本机 sidecar；null=连不上电脑。出错时也尽量把服务端的人话错误带回来 */
    private fun cxJson(path: String, method: String = "GET", timeout: Int = 25000): JSONObject? {
        return try {
            val url = workingUrl() ?: return null
            val body = if (method == "POST") "{}" else null
            val (_, text) = http("$url$path", method, body, timeout)
            if (text.isBlank()) return null
            try { JSONObject(text) } catch (_: Exception) { null }
        } catch (_: Exception) { null }
    }

    /** 登录态 + 姓名/学校（sidecar 会顺手拉资料） */
    fun cxStatus(): JSONObject? = cxJson("/api/chaoxing/status", timeout = 25000)

    /** 让电脑生成二维码并在浏览器弹出；返回 {loginUrl,state,message} */
    fun cxLoginStart(): JSONObject? = cxJson("/api/chaoxing/login/start", "POST", 45000)

    /** 轮询扫码进度：state=waiting/scanned/success/expired/failed */
    fun cxLoginStatus(): JSONObject? = cxJson("/api/chaoxing/login/status", timeout = 12000)

    /** 四类数据汇总；force=true 强制重拉（默认读电脑端 5 分钟缓存）。
     *  首次调用通常立刻返回 state=loading，随后轮询同一接口拿结果 */
    fun cxSummary(force: Boolean = false): JSONObject? =
        cxJson("/api/chaoxing/summary" + if (force) "?force=1" else "", timeout = 20000)

    /** 退出学习通登录（电脑端会先备份 cookie 再清空） */
    fun cxLogout(): JSONObject? = cxJson("/api/chaoxing/logout", "POST", 20000)

    /** 学习通要验证码时：让电脑浏览器弹出验证页（用户亲手输入） */
    fun cxOpenVerify(): JSONObject? = cxJson("/api/chaoxing/verify/open", "POST", 12000)
}
