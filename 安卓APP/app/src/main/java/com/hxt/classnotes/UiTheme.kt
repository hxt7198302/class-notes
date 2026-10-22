package com.hxt.classnotes

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.view.View

/**
 * v2.0 主题系统：一套「语义色板」+ 四套风格 × 明暗两版。
 * 设计方法抄 Material Theme Builder（种子色 → primary/secondary/neutral/surface 整套派生），
 * 但色板全部手调硬编码——不引任何依赖，APK 体积不变。
 *
 * 所有界面颜色都从 Ui.PRIMARY / Ui.BG / Ui.CARD … 取，运行时读当前色板；
 * 设置页改主题 = 写 Db.meta + 重建当前 Activity，录音在 :rec 进程不受影响。
 */
data class Palette(
    val bg: Int,
    val card: Int,
    val text: Int,
    val textSub: Int,
    val line: Int,
    val hilite: Int,
    val primary: Int,
    val primaryDark: Int,
    val onPrimary: Int,
    val red: Int,
    val orange: Int,
    val green: Int
)

object UiTheme {
    const val KEY_THEME = "uiTheme"
    const val KEY_DARK = "uiDarkMode"
    const val KEY_FONT = "uiFontScale"

    /** v2.1：笔记正文样式 paper=精排纸面（默认） / glass=玻璃卡片 */
    const val KEY_NOTE_BODY = "noteBody"

    const val ACADEMIC = "academic"
    const val PAPER = "paper"
    const val NIGHT = "night"
    const val MORANDI = "morandi"

    var id: String = ACADEMIC
        private set
    var dark: Boolean = false
        private set
    var fontScale: Float = 1f
        private set

    /** 从 Db 读偏好；跟随系统时按当前 uiMode 解析明暗。所有 Activity 在 onCreate/onResume 调 */
    fun load(ctx: Context) {
        val saved = Db.meta(KEY_THEME, ACADEMIC)
        id = if (saved in listOf(ACADEMIC, PAPER, NIGHT, MORANDI)) saved else ACADEMIC
        fontScale = ((Db.meta(KEY_FONT, "100").toIntOrNull() ?: 100).coerceIn(80, 130)) / 100f
        dark = when (Db.meta(KEY_DARK, "follow")) {
            "dark" -> true
            "light" -> false
            else -> (ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
                    Configuration.UI_MODE_NIGHT_YES
        }
    }

    /** 当前生效主题的指纹：Activity 在 onResume 比对，变了就重建（设置页改色/字体后自动刷新） */
    fun stamp(ctx: Context): String {
        load(ctx)
        return "$id|$dark|$fontScale"
    }

    val p: Palette get() = palette(id, dark)

    fun label(themeId: String): String = when (themeId) {
        PAPER -> "纸感墨绿"
        NIGHT -> "夜间专注"
        MORANDI -> "莫兰迪柔光"
        else -> "清爽学术"
    }

    fun desc(themeId: String): String = when (themeId) {
        PAPER -> "米白纸色 · 墨绿光晕，像纸质笔记"
        NIGHT -> "深蓝灰底 · 青色光晕，晚上看不刺眼"
        MORANDI -> "雾灰底 · 豆沙紫光晕，低饱和柔和"
        else -> "靛蓝 · 紫 · 青三团柔光，通透干净（默认）"
    }

    /** 设置页色卡用的种子色（只取 primary，浅色版） */
    fun seed(themeId: String): Int = palette(themeId, false).primary

    /**
     * v2.1 光晕三色：背景径向渐变用。顺序 = 左上 / 右侧 / 左下。
     * 浅色版偏明亮，深色版偏荧光（透明度在 Glass.GlowDrawable 里再压低）。
     */
    fun glows(themeId: String, dark: Boolean): IntArray = when (themeId) {
        PAPER -> if (dark) intArrayOf(c("#3F8F6B"), c("#C9A25B"), c("#2FA08A"))
        else intArrayOf(c("#9FD9BB"), c("#F0D9A8"), c("#BCE5C9"))

        NIGHT -> if (dark) intArrayOf(c("#2563EB"), c("#7C3AED"), c("#06B6D4"))
        else intArrayOf(c("#8FC7FF"), c("#D3BDFF"), c("#9FE8E2"))

        MORANDI -> if (dark) intArrayOf(c("#9C86C0"), c("#C98F8F"), c("#7FB39E"))
        else intArrayOf(c("#CFC2E8"), c("#EBCFC7"), c("#C4DDD1"))

        else -> if (dark) intArrayOf(c("#3B82F6"), c("#8B5CF6"), c("#06B6D4"))
        else intArrayOf(c("#7FA8FF"), c("#F2A8D8"), c("#7FE0C6"))
    }

    /** 设置状态栏/导航栏颜色并切换图标深浅，避免深色主题下白字压在浅底上 */
    fun applyWindow(a: Activity) {
        val win = a.window
        win.statusBarColor = p.bg
        win.navigationBarColor = p.bg
        val lightFlags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        var flags = win.decorView.systemUiVisibility
        flags = flags and lightFlags.inv()
        if (!dark) flags = flags or lightFlags
        win.decorView.systemUiVisibility = flags
    }

    fun palette(themeId: String, dark: Boolean): Palette = when (themeId) {
        PAPER -> if (dark) Palette(
            bg = c("#16140F"), card = c("#211E18"), text = c("#ECE6DA"), textSub = c("#A39B8C"),
            line = c("#3A342A"), hilite = c("#2A261D"), primary = c("#7FB79A"), primaryDark = c("#5E9A7D"),
            onPrimary = c("#122015"), red = c("#E07A72"), orange = c("#E0A060"), green = c("#7FB79A")
        ) else Palette(
            bg = c("#FAF7F0"), card = c("#FFFDF8"), text = c("#2B2A26"), textSub = c("#8A857C"),
            line = c("#E7E1D5"), hilite = c("#F0EBDF"), primary = c("#2F6B4F"), primaryDark = c("#245540"),
            onPrimary = c("#FFFFFF"), red = c("#B93A32"), orange = c("#B4651F"), green = c("#3F7A57")
        )

        NIGHT -> if (dark) Palette(
            bg = c("#0B1017"), card = c("#141B24"), text = c("#E6EEF6"), textSub = c("#8FA0B3"),
            line = c("#22303F"), hilite = c("#152B38"), primary = c("#22D3EE"), primaryDark = c("#06B6D4"),
            onPrimary = c("#06202A"), red = c("#F87171"), orange = c("#FB923C"), green = c("#34D399")
        ) else Palette(
            bg = c("#F2F7F9"), card = c("#FFFFFF"), text = c("#14212B"), textSub = c("#7A8B99"),
            line = c("#DBE6EC"), hilite = c("#E0F2F7"), primary = c("#0E7490"), primaryDark = c("#0B5C73"),
            onPrimary = c("#FFFFFF"), red = c("#C2413B"), orange = c("#B45309"), green = c("#047857")
        )

        MORANDI -> if (dark) Palette(
            bg = c("#141218"), card = c("#1E1B24"), text = c("#ECE8F0"), textSub = c("#A39CAF"),
            line = c("#322D3B"), hilite = c("#2A2436"), primary = c("#B9A6D8"), primaryDark = c("#9C86C0"),
            onPrimary = c("#1E1528"), red = c("#E58C8C"), orange = c("#E0A36E"), green = c("#8FC4A5")
        ) else Palette(
            bg = c("#F3F1F5"), card = c("#FFFFFF"), text = c("#2E2A33"), textSub = c("#8B8595"),
            line = c("#E6E1EA"), hilite = c("#EDE8F2"), primary = c("#7C6A9A"), primaryDark = c("#655584"),
            onPrimary = c("#FFFFFF"), red = c("#BF5B5B"), orange = c("#B9773E"), green = c("#5F8C72")
        )

        else -> if (dark) Palette(
            bg = c("#0F141C"), card = c("#1A2130"), text = c("#E8ECF3"), textSub = c("#98A2B3"),
            line = c("#2A3446"), hilite = c("#1E2A44"), primary = c("#60A5FA"), primaryDark = c("#3B82F6"),
            onPrimary = c("#0B1220"), red = c("#F87171"), orange = c("#FB923C"), green = c("#34D399")
        ) else Palette(
            bg = c("#F5F6F8"), card = c("#FFFFFF"), text = c("#1F2430"), textSub = c("#8A93A0"),
            line = c("#E8EBEF"), hilite = c("#EFF4FF"), primary = c("#2563EB"), primaryDark = c("#1D4ED8"),
            onPrimary = c("#FFFFFF"), red = c("#DC2626"), orange = c("#EA580C"), green = c("#059669")
        )
    }

    private fun c(s: String): Int = Color.parseColor(s)
}
