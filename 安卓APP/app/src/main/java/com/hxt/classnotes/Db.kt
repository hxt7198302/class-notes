package com.hxt.classnotes

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 本地数据真相源：课程 / 课堂会话 / 照片（含相对录音的偏移）/ 笔记缓存。
 * 素材先落手机本地，上传只是把 ready 的会话推给电脑；笔记拉回来存缓存供离线看。
 * v1.8：Rec 服务搬进独立进程后两个进程并发读写本库——开 WAL + 写操作带锁重试兜底。
 */
object Db {
    private lateinit var helper: Helper

    private class Helper(ctx: Context) : SQLiteOpenHelper(ctx, "classnotes.db", null, 3) {
        override fun onCreate(db: SQLiteDatabase) {
            try { db.rawQuery("PRAGMA journal_mode=WAL", null).use { it.moveToFirst() } } catch (_: Exception) { }
            db.execSQL("CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT)")
            db.execSQL("CREATE TABLE courses(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, createdAt INTEGER)")
            db.execSQL("CREATE TABLE sessions(" +
                    "sid TEXT PRIMARY KEY, course TEXT, startedAt INTEGER, endedAt INTEGER, durMs INTEGER," +
                    "state TEXT, uploadedAt INTEGER, dir TEXT)")
            db.execSQL("CREATE INDEX idx_sessions_start ON sessions(startedAt DESC)")
            db.execSQL("CREATE TABLE photos(" +
                    "id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT, name TEXT, path TEXT, origPath TEXT," +
                    "offsetMs INTEGER, uploaded INTEGER DEFAULT 0)")
            db.execSQL("CREATE TABLE segments(" +
                    "id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT, name TEXT, startOffsetMs INTEGER, uploaded INTEGER DEFAULT 0)")
            db.execSQL("CREATE TABLE marks(" +
                    "id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT, offsetMs INTEGER, type TEXT, note TEXT, createdAt INTEGER)")
            db.execSQL("CREATE INDEX idx_marks_sid ON marks(sid)")
            db.execSQL("CREATE TABLE notecache(sid TEXT PRIMARY KEY, course TEXT, title TEXT, state TEXT, noteUpdated TEXT, summary TEXT, json TEXT, updatedAt INTEGER)")
        }

        override fun onUpgrade(db: SQLiteDatabase, o: Int, n: Int) {
            if (o < 2) {
                db.execSQL("CREATE TABLE IF NOT EXISTS marks(" +
                        "id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT, offsetMs INTEGER, type TEXT, note TEXT, createdAt INTEGER)")
                db.execSQL("CREATE INDEX IF NOT EXISTS idx_marks_sid ON marks(sid)")
            }
            // v2.4：列表卡片显示 AI 生成的真总结（旧笔记没有就回退正文截断）
            // 先查列再加：加列失败必须让异常冒出去（onUpgrade 会回滚、版本不前进、下次启动重试），
            // 不能吞掉——吞掉就会带着缺列的库升到 v3，列表查询永远报错且再无补救机会。
            if (o < 3) {
                var hasSummary = false
                try {
                    db.rawQuery("PRAGMA table_info(notecache)", null).use { c ->
                        val nameIdx = c.getColumnIndex("name")
                        while (c.moveToNext()) {
                            if (nameIdx >= 0 && c.getString(nameIdx) == "summary") hasSummary = true
                        }
                    }
                } catch (_: Exception) { }
                if (!hasSummary) db.execSQL("ALTER TABLE notecache ADD COLUMN summary TEXT DEFAULT ''")
            }
        }
    }

    fun init(ctx: Context) {
        if (!::helper.isInitialized) helper = Helper(ctx.applicationContext)
    }

    /** 写操作兜底：跨进程偶发 database is locked 时歇 60ms 重试一次（短事务，两轮足够）；再失败只记日志不崩 */
    private fun write(block: (SQLiteDatabase) -> Unit) {
        try {
            block(helper.writableDatabase)
        } catch (e: android.database.SQLException) {
            try { Thread.sleep(60); block(helper.writableDatabase) } catch (e2: Exception) {
                android.util.Log.e("classnotes", "DB写失败（重试后）: ${e2.message}")
            }
        }
    }

    // ---------- meta ----------
    fun setMeta(k: String, v: String) {
        val cv = ContentValues().apply { put("k", k); put("v", v) }
        write { it.insertWithOnConflict("meta", null, cv, SQLiteDatabase.CONFLICT_REPLACE) }
    }

    fun meta(k: String, def: String = ""): String {
        helper.readableDatabase.rawQuery("SELECT v FROM meta WHERE k=?", arrayOf(k)).use { c ->
            if (c.moveToFirst()) return c.getString(0)
        }
        return def
    }

    // ---------- 课程 ----------
    fun addCourse(name: String): Boolean {
        val cv = ContentValues().apply { put("name", name); put("createdAt", System.currentTimeMillis()) }
        return try {
            helper.writableDatabase.insertOrThrow("courses", null, cv) > 0
        } catch (_: Exception) { false }
    }

    fun courses(): List<String> {
        val out = ArrayList<String>()
        helper.readableDatabase.rawQuery("SELECT name FROM courses ORDER BY id DESC", null).use { c ->
            while (c.moveToNext()) out.add(c.getString(0))
        }
        return out
    }

    // ---------- 会话 ----------
    fun createSession(sid: String, course: String, startedAt: Long, dir: String) {
        val cv = ContentValues().apply {
            put("sid", sid); put("course", course); put("startedAt", startedAt)
            put("state", "recording"); put("dir", dir)
        }
        write { it.insertWithOnConflict("sessions", null, cv, SQLiteDatabase.CONFLICT_REPLACE) }
    }

    fun finishSession(sid: String, endedAt: Long, durMs: Long) {
        val cv = ContentValues().apply { put("endedAt", endedAt); put("durMs", durMs); put("state", "ready") }
        write { it.update("sessions", cv, "sid=?", arrayOf(sid)) }
    }

    fun setSessionState(sid: String, state: String) {
        val cv = ContentValues().apply {
            put("state", state)
            if (state == "uploaded") put("uploadedAt", System.currentTimeMillis())
        }
        write { it.update("sessions", cv, "sid=?", arrayOf(sid)) }
    }

    fun session(sid: String): JSONObject? {
        helper.readableDatabase.rawQuery("SELECT sid,course,startedAt,endedAt,durMs,state,dir FROM sessions WHERE sid=?", arrayOf(sid)).use { c ->
            if (c.moveToNext()) {
                return JSONObject()
                    .put("sid", c.getString(0)).put("course", c.getString(1))
                    .put("startedAt", c.getLong(2)).put("endedAt", c.getLong(3))
                    .put("durMs", c.getLong(4)).put("state", c.getString(5)).put("dir", c.getString(6))
            }
        }
        return null
    }

    fun sessions(limit: Int = 30): JSONArray {
        val arr = JSONArray()
        helper.readableDatabase.rawQuery(
            "SELECT sid,course,startedAt,durMs,state FROM sessions ORDER BY startedAt DESC LIMIT $limit", null
        ).use { c ->
            while (c.moveToNext()) {
                arr.put(JSONObject()
                    .put("sid", c.getString(0)).put("course", c.getString(1))
                    .put("startedAt", c.getLong(2)).put("durMs", c.getLong(3)).put("state", c.getString(4)))
            }
        }
        return arr
    }

    fun readySessions(): List<String> {
        val out = ArrayList<String>()
        helper.readableDatabase.rawQuery("SELECT sid FROM sessions WHERE state='ready' ORDER BY startedAt", null).use { c ->
            while (c.moveToNext()) out.add(c.getString(0))
        }
        return out
    }

    // ---------- 照片 ----------
    fun addPhoto(sid: String, name: String, path: String, origPath: String, offsetMs: Long) {
        val cv = ContentValues().apply {
            put("sid", sid); put("name", name); put("path", path); put("origPath", origPath); put("offsetMs", offsetMs)
        }
        write { it.insert("photos", null, cv) }
    }

    fun photos(sid: String): JSONArray {
        val arr = JSONArray()
        helper.readableDatabase.rawQuery("SELECT name,path,offsetMs FROM photos WHERE sid=? ORDER BY id", arrayOf(sid)).use { c ->
            while (c.moveToNext()) {
                arr.put(JSONObject().put("name", c.getString(0)).put("path", c.getString(1)).put("offsetMs", c.getLong(2)))
            }
        }
        return arr
    }

    fun photoFileCount(sid: String): Int {
        helper.readableDatabase.rawQuery("SELECT COUNT(*) FROM photos WHERE sid=?", arrayOf(sid)).use { c ->
            if (c.moveToFirst()) return c.getInt(0)
        }
        return 0
    }

    // ---------- 分段录音 ----------
    fun addSegment(sid: String, name: String, startOffsetMs: Long) {
        val cv = ContentValues().apply { put("sid", sid); put("name", name); put("startOffsetMs", startOffsetMs) }
        write { it.insert("segments", null, cv) }
    }

    fun markSegmentUploaded(sid: String, name: String) {
        write { it.update("segments", ContentValues().apply { put("uploaded", 1) }, "sid=? AND name=?", arrayOf(sid, name)) }
    }

    fun segments(sid: String): JSONArray {
        val arr = JSONArray()
        helper.readableDatabase.rawQuery("SELECT name,startOffsetMs FROM segments WHERE sid=? ORDER BY id", arrayOf(sid)).use { c ->
            while (c.moveToNext()) {
                arr.put(JSONObject().put("name", c.getString(0)).put("startOffsetMs", c.getLong(1)))
            }
        }
        return arr
    }

    // ---------- 课堂标记 ----------
    fun addMark(sid: String, offsetMs: Long, type: String, note: String) {
        val cv = ContentValues().apply {
            put("sid", sid); put("offsetMs", offsetMs); put("type", type); put("note", note)
            put("createdAt", System.currentTimeMillis())
        }
        write { it.insert("marks", null, cv) }
    }

    fun marks(sid: String): JSONArray {
        val arr = JSONArray()
        helper.readableDatabase.rawQuery(
            "SELECT offsetMs,type,note FROM marks WHERE sid=? ORDER BY id", arrayOf(sid)
        ).use { c ->
            while (c.moveToNext()) {
                arr.put(JSONObject()
                    .put("offsetMs", c.getLong(0))
                    .put("type", c.getString(1))
                    .put("note", c.getString(2)))
            }
        }
        return arr
    }

    fun markCount(sid: String): Int {
        helper.readableDatabase.rawQuery("SELECT COUNT(*) FROM marks WHERE sid=?", arrayOf(sid)).use { c ->
            if (c.moveToFirst()) return c.getInt(0)
        }
        return 0
    }

    // ---------- 笔记缓存 ----------
    fun saveNoteCache(sid: String, course: String, title: String, state: String, noteUpdated: String, summary: String, json: String) {
        val cv = ContentValues().apply {
            put("sid", sid); put("course", course); put("title", title); put("state", state)
            put("noteUpdated", noteUpdated); put("summary", summary); put("json", json)
            put("updatedAt", System.currentTimeMillis())
        }
        write { it.insertWithOnConflict("notecache", null, cv, SQLiteDatabase.CONFLICT_REPLACE) }
    }

    /** 只更新总结（笔记正文没变时，服务端补了 summary 也能进列表，不必重下全文） */
    fun setNoteSummary(sid: String, summary: String) {
        write {
            it.update("notecache", ContentValues().apply {
                put("summary", summary); put("updatedAt", System.currentTimeMillis())
            }, "sid=?", arrayOf(sid))
        }
    }

    fun noteCache(sid: String): JSONObject? {
        helper.readableDatabase.rawQuery("SELECT json FROM notecache WHERE sid=?", arrayOf(sid)).use { c ->
            if (c.moveToFirst()) return try { JSONObject(c.getString(0)) } catch (_: Exception) { null }
        }
        return null
    }

    fun noteCacheList(): JSONArray {
        val arr = JSONArray()
        helper.readableDatabase.rawQuery(
            "SELECT sid,course,title,state,summary FROM notecache ORDER BY sid DESC", null
        ).use { c ->
            while (c.moveToNext()) {
                arr.put(JSONObject()
                    .put("sid", c.getString(0)).put("course", c.getString(1))
                    .put("title", c.getString(2)).put("state", c.getString(3))
                    .put("summary", c.getString(4) ?: ""))
            }
        }
        return arr
    }

    /** 同步后修剪：服务端列表里没有的（如同日同课已并入锚点的碎片）从缓存清掉，返回删的条数 */
    fun pruneNoteCache(keep: Set<String>): Int {
        val ids = ArrayList<String>()
        helper.readableDatabase.rawQuery("SELECT sid FROM notecache", null).use { c ->
            while (c.moveToNext()) ids.add(c.getString(0))
        }
        var n = 0
        for (sid in ids) {
            if (sid !in keep) {
                write { it.delete("notecache", "sid=?", arrayOf(sid)) }
                n++
            }
        }
        return n
    }

    /** 用媒体元数据读各段录音的真实时长求和（毫秒）；读不出来返回 null。
     *  孤儿会话死因不同（被杀/崩溃），按文件实际时长落账最如实——v1.8 从 MainActivity 下沉共用（主进程与 :rec 都要用） */
    fun realRecordedMs(dir: File): Long? {
        return try {
            val files = dir.listFiles { f -> f.name.startsWith("recording_") && f.name.endsWith(".m4a") }?.sortedBy { it.name } ?: return null
            var sum = 0L; var any = false
            for (f in files) {
                val mm = android.media.MediaMetadataRetriever()
                try {
                    mm.setDataSource(f.absolutePath)
                    val d = mm.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
                    if (d != null && d > 0) { sum += d; any = true }
                } catch (_: Exception) { } finally { try { mm.release() } catch (_: Exception) { } }
            }
            if (any) sum else null
        } catch (_: Exception) { null }
    }
}
