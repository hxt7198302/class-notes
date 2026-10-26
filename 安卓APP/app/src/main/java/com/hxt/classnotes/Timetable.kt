package com.hxt.classnotes

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.time.Duration
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter

/**
 * v2.8 课表（只做「今天/下一节」卡片用的最小数据层，不做整周表格）：
 * - 数据源：电脑端 timetable.json → GET /api/timetable，手机缓存一份，离线也能算；
 * - 周次以 firstMonday 为锚（第1周周一=2026-09-07，2026-09-20 修正值）；
 * - 计算全部本地进行（每次刷新只读内存/缓存，不联网），到点自动切换「正在上/下一节/上完了」。
 */
object Timetable {
    private const val CACHE = "timetable.json"

    data class Period(val no: Int, val start: LocalTime, val end: LocalTime)
    data class Course(
        val id: String, val name: String, val weekday: Int,
        val start: Int, val end: Int, val startWeek: Int, val endWeek: Int,
        val room: String, val teacher: String
    )

    class TT(
        val firstMonday: LocalDate,
        val totalWeeks: Int,
        val semesterName: String,
        val periods: Map<Int, Period>,
        val courses: List<Course>
    )

    /** 「现在该显示什么」：kind = now / next / done / empty */
    data class Status(
        val kind: String,
        val course: Course? = null,
        val date: LocalDate? = null,
        val start: LocalTime? = null,
        val end: LocalTime? = null,
        val mins: Long = 0,        // now=还剩几分钟；next=还有几分钟开始
        val progress: Float = 0f,  // now=已上比例 0~1
        val week: Int = 0
    )

    private fun cacheFile(ctx: Context) = File(ctx.filesDir, CACHE)

    fun save(ctx: Context, j: JSONObject) {
        try { cacheFile(ctx).writeText(j.toString(), Charsets.UTF_8) } catch (_: Exception) { }
    }

    fun loadCached(ctx: Context): TT? = try {
        parse(JSONObject(cacheFile(ctx).readText(Charsets.UTF_8)))
    } catch (_: Exception) { null }

    fun cacheAgeMs(ctx: Context): Long = try {
        val f = cacheFile(ctx)
        if (f.exists()) System.currentTimeMillis() - f.lastModified() else Long.MAX_VALUE
    } catch (_: Exception) { Long.MAX_VALUE }

    fun parse(j: JSONObject?): TT? {
        if (j == null) return null
        val sem = j.optJSONObject("semester") ?: return null
        val firstMonday = try { LocalDate.parse(sem.optString("firstMonday")) } catch (_: Exception) { return null }
        val periods = HashMap<Int, Period>()
        val pa = j.optJSONArray("periods") ?: return null
        for (i in 0 until pa.length()) {
            val p = pa.optJSONObject(i) ?: continue
            val no = p.optInt("no", 0)
            if (no <= 0) continue
            val s = parseTime(p.optString("start")) ?: continue
            val e = parseTime(p.optString("end")) ?: continue
            periods[no] = Period(no, s, e)
        }
        if (periods.isEmpty()) return null
        val list = ArrayList<Course>()
        val ca = j.optJSONArray("courses") ?: return null
        for (i in 0 until ca.length()) {
            val c = ca.optJSONObject(i) ?: continue
            val name = c.optString("name").trim()
            val wd = c.optInt("weekday", 0)
            if (name.isEmpty() || wd !in 1..7) continue
            val st = c.optInt("start", 0); val en = c.optInt("end", 0)
            if (st <= 0 || en < st || !periods.containsKey(st)) continue
            list.add(Course(
                c.optString("id", name), name, wd, st, en,
                c.optInt("startWeek", 1).coerceAtLeast(1),
                c.optInt("endWeek", 99).coerceAtLeast(c.optInt("startWeek", 1)),
                c.optString("room"), c.optString("teacher")
            ))
        }
        if (list.isEmpty()) return null
        return TT(firstMonday, sem.optInt("totalWeeks", 18), sem.optString("name"), periods, list)
    }

    private fun parseTime(s: String): LocalTime? = try { LocalTime.parse(s.trim()) } catch (_: Exception) { null }

    /** 某一日期属于第几周（开课前 = 0，超过总周 = totalWeeks+1，仅用于显示/过滤） */
    fun weekOf(tt: TT, date: LocalDate): Int {
        val days = Duration.between(tt.firstMonday.atStartOfDay(), date.atStartOfDay()).toDays()
        if (days < 0) return 0
        return (days / 7).toInt() + 1
    }

    fun classesOn(tt: TT, date: LocalDate, week: Int = weekOf(tt, date)): List<Course> {
        val wd = date.dayOfWeek.value
        return tt.courses
            .filter { it.weekday == wd && week >= it.startWeek && week <= it.endWeek }
            .filter { tt.periods.containsKey(it.start) && tt.periods.containsKey(it.end) }
            .sortedBy { it.start }
    }

    fun span(tt: TT, c: Course): Pair<LocalTime, LocalTime>? {
        val s = tt.periods[c.start]?.start ?: return null
        val e = tt.periods[c.end]?.end ?: return null
        return s to e
    }

    /** 核心：按当前时间算卡片要显示的状态 */
    fun now(tt: TT, now: java.time.LocalDateTime = java.time.LocalDateTime.now()): Status {
        val today = now.toLocalDate()
        val t = now.toLocalTime()
        val week = weekOf(tt, today)
        val todays = classesOn(tt, today, week)

        for (c in todays) {
            val (s, e) = span(tt, c) ?: continue
            if (!t.isBefore(s) && t.isBefore(e)) {
                val total = Duration.between(s, e).seconds.coerceAtLeast(1)
                val done = Duration.between(s, t).seconds
                return Status("now", c, today, s, e, ((total - done) / 60).coerceAtLeast(0), (done.toFloat() / total).coerceIn(0f, 1f), week)
            }
        }
        for (c in todays) {
            val (s, e) = span(tt, c) ?: continue
            if (t.isBefore(s)) {
                return Status("next", c, today, s, e, (Duration.between(t, s).seconds / 60).coerceAtLeast(0), 0f, week)
            }
        }
        // 今天没了：往后 7 天找下一节（跨周也认，课程按周次过滤）
        for (d in 1..7) {
            val day = today.plusDays(d.toLong())
            val w = weekOf(tt, day)
            val cs = classesOn(tt, day, w)
            if (cs.isEmpty()) continue
            val c = cs.first()
            val (s, e) = span(tt, c) ?: continue
            val mins = Duration.between(now, day.atTime(s)).toMinutes().coerceAtLeast(0)
            return Status("next", c, day, s, e, mins, 0f, week)
        }
        return Status("done", week = week)
    }

    fun periodText(c: Course): String = if (c.start == c.end) "第${c.start}节" else "第${c.start}-${c.end}节"

    fun timeText(s: LocalTime?, e: LocalTime?): String {
        if (s == null || e == null) return ""
        val f = DateTimeFormatter.ofPattern("HH:mm")
        return s.format(f) + "–" + e.format(f)
    }

    /** 「今天 / 明天 / 周一」 */
    fun dayLabel(d: LocalDate, today: LocalDate = LocalDate.now()): String = when (d) {
        today -> "今天"
        today.plusDays(1) -> "明天"
        else -> arrayOf("周一", "周二", "周三", "周四", "周五", "周六", "周日")[d.dayOfWeek.value - 1]
    }
}
