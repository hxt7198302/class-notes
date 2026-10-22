package com.hxt.classnotes

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RadialGradient
import android.graphics.Rect
import android.graphics.Shader
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable

/**
 * v2.1 玻璃视觉基础件（纯 Kotlin，零依赖）。
 *
 * 设计参考（见 开源比对.md 第十一节）：
 * - chrisbanes/haze 的 thin/regular/thick 三档材质；
 * - skydoves/Cloudy 的「低端机降级」思路；
 * - QWEA0/Liquid-Glass-Android 的 View 分层 + 1dp 高光描边。
 *
 * 实现取舍：背景不是实时模糊，而是用 3 个 RadialGradient 画出柔和的彩色光晕（尺寸变化时
 * 重建着色器，滚动/切页不重算）。观感接近磨砂玻璃，性能稳定，API 26+ 一致，不依赖 RenderEffect。
 */
object Glass {
    /** 薄：底栏、浮层、输入框 */
    const val THIN = 40

    /** 常规：卡片 */
    const val REGULAR = 55

    /** 厚：阅读正文、需要高对比度的区域 */
    const val THICK = 70

    /** 半透明卡片底：取当前主题 card 的 RGB + 指定不透明度 */
    fun fillColor(alphaPercent: Int): Int {
        val c = UiTheme.p.card
        val a = alphaPercent.coerceIn(0, 100) * 255 / 100
        return Color.argb(a, Color.red(c), Color.green(c), Color.blue(c))
    }

    /** 玻璃高光描边：浅色下接近白色，深色下是一道很淡的白线 */
    fun strokeColor(): Int =
        if (UiTheme.dark) Color.argb(26, 255, 255, 255)
        else Color.argb(205, 255, 255, 255)

    fun cardBg(alphaPercent: Int = REGULAR, radiusDp: Int = 20): GradientDrawable =
        GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = Ui.dp(radiusDp).toFloat()
            setColor(fillColor(alphaPercent))
            setStroke(Ui.dp(1).coerceAtLeast(1), strokeColor())
        }

    /** 底栏：只圆上面两角，下面是屏幕边 */
    fun barBg(radiusTopDp: Int = 22): GradientDrawable {
        val r = Ui.dp(radiusTopDp).toFloat()
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
            setColor(fillColor(THIN))
            setStroke(Ui.dp(1).coerceAtLeast(1), strokeColor())
        }
    }

    /** 次级按钮/可点卡片：按下时更实一点，给手指反馈 */
    fun secondaryBg(radiusDp: Int = 18): StateListDrawable {
        val normal = cardBg(THIN, radiusDp)
        val pressed = cardBg(REGULAR, radiusDp).apply { setStroke(Ui.dp(1), Ui.PRIMARY) }
        return StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_pressed), pressed)
            addState(intArrayOf(), normal)
        }
    }

    /** 主按钮：主色 → 深主色的柔和渐变 + 圆角 */
    fun primaryBg(radiusDp: Int = 18): GradientDrawable =
        GradientDrawable(
            GradientDrawable.Orientation.TL_BR,
            intArrayOf(Ui.PRIMARY, Ui.PRIMARY_DARK)
        ).apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = Ui.dp(radiusDp).toFloat()
        }

    /** 设置页色卡：把当前主题的主色和三种光晕色拼成一条渐变色带 */
    fun swatch(themeId: String): GradientDrawable {
        val p = UiTheme.palette(themeId, false)
        val g = UiTheme.glows(themeId, false)
        return GradientDrawable(
            GradientDrawable.Orientation.TL_BR,
            intArrayOf(p.primary, g[0], g[1], g[2])
        ).apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = Ui.dp(10).toFloat()
        }
    }

    private fun withAlpha(color: Int, alpha: Int): Int =
        Color.argb(alpha.coerceIn(0, 255), Color.red(color), Color.green(color), Color.blue(color))

    /**
     * 全屏光晕背景：底色 + 左上/右侧/左下三团柔光。
     * onSizeChanged 里重建 RadialGradient；draw 只做 4 次矩形填充，滚动时不触发重算。
     */
    class GlowDrawable(
        private val themeId: String = UiTheme.id,
        private val dark: Boolean = UiTheme.dark
    ) : Drawable() {
        private val basePaint = Paint(Paint.ANTI_ALIAS_FLAG)
        private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG)
        private val glowColors = UiTheme.glows(themeId, dark)
        private var shaders: Array<RadialGradient> = emptyArray()
        private var centers: Array<FloatArray> = emptyArray()

        init {
            basePaint.color = UiTheme.palette(themeId, dark).bg
        }

        override fun onBoundsChange(bounds: Rect) {
            val w = bounds.width().toFloat()
            val h = bounds.height().toFloat()
            if (w <= 0f || h <= 0f) return
            val specs = arrayOf(
                floatArrayOf(0.10f, 0.04f, 0.58f),
                floatArrayOf(0.96f, 0.22f, 0.52f),
                floatArrayOf(0.16f, 0.94f, 0.60f)
            )
            val maxR = maxOf(w, h)
            shaders = Array(specs.size) { i ->
                val cx = bounds.left + w * specs[i][0]
                val cy = bounds.top + h * specs[i][1]
                val r = maxOf(maxR * specs[i][2], 1f)
                val c = glowColors[i % glowColors.size]
                val a = if (dark) 88 else 150
                RadialGradient(
                    cx, cy, r,
                    intArrayOf(withAlpha(c, a), withAlpha(c, 0)),
                    floatArrayOf(0f, 1f),
                    Shader.TileMode.CLAMP
                )
            }
            centers = Array(specs.size) { i ->
                floatArrayOf(
                    bounds.left + w * specs[i][0],
                    bounds.top + h * specs[i][1]
                )
            }
        }

        override fun draw(canvas: Canvas) {
            canvas.drawRect(bounds, basePaint)
            if (shaders.isEmpty()) return
            val save = canvas.save()
            canvas.clipRect(bounds)
            val r = Rect(bounds)
            for (s in shaders) {
                glowPaint.shader = s
                canvas.drawRect(r, glowPaint)
            }
            canvas.restoreToCount(save)
        }

        override fun setAlpha(alpha: Int) {
            basePaint.alpha = alpha
            glowPaint.alpha = alpha
        }

        override fun setColorFilter(colorFilter: ColorFilter?) {
            basePaint.colorFilter = colorFilter
            glowPaint.colorFilter = colorFilter
        }

        @Deprecated("Deprecated in Java")
        override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
    }
}
