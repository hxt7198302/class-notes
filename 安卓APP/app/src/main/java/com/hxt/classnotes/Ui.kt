package com.hxt.classnotes

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

/**
 * 程序式 UI 小工具集（v2.0：颜色全部从 UiTheme 当前色板实时取，支持四套风格 + 明暗）。
 * 圆角/间距保持 8dp 栅格；这是全 APP 唯一的样式入口，改主题不用逐页找颜色。
 */
object Ui {
    val PRIMARY: Int get() = UiTheme.p.primary
    val PRIMARY_DARK: Int get() = UiTheme.p.primaryDark
    val ON_PRIMARY: Int get() = UiTheme.p.onPrimary
    val BG: Int get() = UiTheme.p.bg
    val CARD: Int get() = UiTheme.p.card
    val TEXT: Int get() = UiTheme.p.text
    val TEXT_SUB: Int get() = UiTheme.p.textSub
    val LINE: Int get() = UiTheme.p.line
    val HILITE: Int get() = UiTheme.p.hilite
    val RED: Int get() = UiTheme.p.red
    val ORANGE: Int get() = UiTheme.p.orange
    val GREEN: Int get() = UiTheme.p.green

    fun dp(v: Int): Int = (v * android.content.res.Resources.getSystem().displayMetrics.density + 0.5f).toInt()

    /** 字号按设置页的「字体大小」缩放（默认 1.0） */
    fun sp(v: Int): Float = v * UiTheme.fontScale

    fun toast(ctx: Context, s: String) = Toast.makeText(ctx, s, Toast.LENGTH_SHORT).show()

    /** 圆角纯色底：主按钮、选中胶囊、色卡都用它，避免各处重复写 GradientDrawable */
    fun roundBg(color: Int, radiusDp: Int = 20): GradientDrawable =
        GradientDrawable().apply {
            setColor(color)
            cornerRadius = dp(radiusDp).toFloat()
        }

    /** 全屏光晕背景（v2.1）。放在页面根 View 上，滚动内容保持透明叠在上面 */
    fun glowBg(): Glass.GlowDrawable = Glass.GlowDrawable()

    fun card(ctx: Context): LinearLayout = card(ctx, Glass.REGULAR, 20)

    /** 玻璃卡片：alphaPercent 见 Glass.THIN/REGULAR/THICK */
    fun card(ctx: Context, alphaPercent: Int, radiusDp: Int = 20): LinearLayout {
        val l = LinearLayout(ctx)
        l.orientation = LinearLayout.VERTICAL
        l.setPadding(dp(16), dp(14), dp(16), dp(14))
        l.background = Glass.cardBg(alphaPercent, radiusDp)
        l.elevation = dp(3).toFloat()
        val p = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        p.topMargin = dp(10)
        l.layoutParams = p
        return l
    }

    /** 统一按压反馈：按下轻微缩小，松开/滑动取消时弹回 */
    @SuppressLint("ClickableViewAccessibility")
    fun pressable(v: View, scale: Float = 0.97f) {
        v.setOnTouchListener { view, e ->
            when (e.actionMasked) {
                android.view.MotionEvent.ACTION_DOWN ->
                    view.animate().scaleX(scale).scaleY(scale).setDuration(90).start()
                android.view.MotionEvent.ACTION_UP,
                android.view.MotionEvent.ACTION_CANCEL ->
                    view.animate().scaleX(1f).scaleY(1f).setDuration(150).start()
            }
            false
        }
    }

    /** 课程色：同一门课永远同一个颜色，用来给笔记卡片做色条/小圆点 */
    private val COURSE_COLORS = intArrayOf(
        0xFF2563EB.toInt(), 0xFF7C3AED.toInt(), 0xFF0891B2.toInt(), 0xFF059669.toInt(),
        0xFFD97706.toInt(), 0xFFDC2626.toInt(), 0xFFDB2777.toInt(), 0xFF4F46E5.toInt()
    )

    fun courseColor(name: String): Int {
        val idx = (name.hashCode() and 0x7fffffff) % COURSE_COLORS.size
        val base = COURSE_COLORS[idx]
        if (!UiTheme.dark) return base
        // 深色下提亮，避免色条在深底上发闷
        val r = Color.red(base) + ((255 - Color.red(base)) * 0.32f).toInt()
        val g = Color.green(base) + ((255 - Color.green(base)) * 0.32f).toInt()
        val b = Color.blue(base) + ((255 - Color.blue(base)) * 0.32f).toInt()
        return Color.rgb(r, g, b)
    }

    fun text(ctx: Context, s: String, size: Int, color: Int = Ui.TEXT, bold: Boolean = false): TextView {
        val t = TextView(ctx)
        t.text = s
        t.textSize = sp(size)
        t.setTextColor(color)
        if (bold) t.setTypeface(null, Typeface.BOLD)
        return t
    }

    fun button(ctx: Context, label: String, primary: Boolean = true): Button {
        val b = Button(ctx)
        b.text = label
        b.textSize = sp(15)
        b.setAllCaps(false)
        if (primary) {
            b.background = Glass.primaryBg(18)
            b.elevation = dp(3).toFloat()
        } else {
            b.background = Glass.secondaryBg(18)
            b.elevation = 0f
        }
        b.setTextColor(if (primary) ON_PRIMARY else PRIMARY)
        b.setPadding(dp(18), dp(8), dp(18), dp(8))
        pressable(b)
        return b
    }

    /** 首页主行动：大号圆角按钮（「开始上课」），选中态由调用方按录音状态换底色 */
    fun bigButton(ctx: Context, label: String): Button {
        val b = Button(ctx)
        b.text = label
        b.textSize = sp(20)
        b.setAllCaps(false)
        b.setTypeface(null, Typeface.BOLD)
        b.setTextColor(ON_PRIMARY)
        b.background = Glass.primaryBg(18)
        b.elevation = dp(6).toFloat()
        b.setPadding(dp(18), dp(12), dp(18), dp(12))
        pressable(b, 0.98f)
        return b
    }

    fun list(ctx: Context): LinearLayout {
        val l = LinearLayout(ctx)
        l.orientation = LinearLayout.VERTICAL
        l.setPadding(dp(12), dp(4), dp(12), dp(24))
        return l
    }

    /** 页面滚动容器，自带光晕背景；内容卡片浮在上面 */
    fun scroll(ctx: Context, child: View): ScrollView {
        val s = ScrollView(ctx)
        s.addView(child)
        s.background = glowBg()
        s.isFillViewport = true
        s.clipToPadding = false
        return s
    }

    fun chip(ctx: Context, label: String): TextView {
        val t = TextView(ctx)
        t.text = label
        t.textSize = sp(13)
        t.setPadding(dp(13), dp(7), dp(13), dp(7))
        t.background = Glass.cardBg(Glass.THIN, 999)
        val p = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        p.rightMargin = dp(8); p.topMargin = dp(2); p.bottomMargin = dp(2)
        p.gravity = Gravity.CENTER_VERTICAL
        t.layoutParams = p
        pressable(t, 0.94f)
        return t
    }

    fun badge(ctx: Context, s: String, color: Int): TextView {
        val t = chip(ctx, s)
        t.setTextColor(color)
        return t
    }

    fun line(ctx: Context): View {
        val v = View(ctx)
        v.background = ColorDrawable(LINE)
        v.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)).also {
            it.topMargin = dp(8); it.bottomMargin = dp(2)
        }
        return v
    }

    @SuppressLint("DefaultLocale")
    fun dur(ms: Long): String {
        val m = ms / 60000
        val s = ms % 60000 / 1000
        return String.format("%d:%02d", m, s)
    }
}
