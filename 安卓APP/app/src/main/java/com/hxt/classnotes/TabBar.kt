package com.hxt.classnotes

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * v2.0 自绘底部标签栏：上课 / 笔记 / 待办 / 设置。
 * 不引 Material/AndroidX——四个线性图标用 Canvas 直接画，选中态是「浅色胶囊 + 主色图标 + 加粗文字」。
 * 底部栏高度 58dp，页面切换只改可见性，不叠返回栈。
 */
class TabBar(ctx: Context) : LinearLayout(ctx) {
    private val labels = arrayOf("上课", "笔记", "待办", "设置")
    private val items = ArrayList<LinearLayout>()
    private val icons = ArrayList<IconView>()
    private val labelViews = ArrayList<TextView>()
    private val badges = ArrayList<TextView>()
    private val row: LinearLayout

    var onSelect: ((Int) -> Unit)? = null
    var selected = 0
        private set

    init {
        orientation = VERTICAL
        background = Glass.barBg(22)
        elevation = Ui.dp(12).toFloat()
        setPadding(0, Ui.dp(2), 0, 0)
        row = LinearLayout(ctx).apply {
            orientation = HORIZONTAL
            setPadding(Ui.dp(8), Ui.dp(4), Ui.dp(8), Ui.dp(6))
        }
        addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        for (i in labels.indices) {
            val item = LinearLayout(ctx).apply {
                orientation = VERTICAL
                gravity = Gravity.CENTER
                setPadding(0, Ui.dp(6), 0, Ui.dp(4))
            }
            val lp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            lp.leftMargin = Ui.dp(2); lp.rightMargin = Ui.dp(2)
            row.addView(item, lp)

            val iconBox = FrameLayout(ctx)
            val icon = IconView(ctx, i) { if (selected == i) UiTheme.p.primary else UiTheme.p.textSub }
            iconBox.addView(icon, FrameLayout.LayoutParams(Ui.dp(22), Ui.dp(22), Gravity.CENTER))
            val badge = TextView(ctx).apply {
                setTextColor(UiTheme.p.onPrimary)
                textSize = 9f
                gravity = Gravity.CENTER
                visibility = View.GONE
                setPadding(Ui.dp(4), 0, Ui.dp(4), 0)
                background = Ui.roundBg(UiTheme.p.red, 9)
            }
            iconBox.addView(badge, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, Ui.dp(16), Gravity.END or Gravity.TOP))
            item.addView(iconBox, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(28)))

            val label = TextView(ctx).apply {
                text = labels[i]
                textSize = Ui.sp(11)
                gravity = Gravity.CENTER
                setTextColor(UiTheme.p.textSub)
            }
            item.addView(label)

            item.setOnClickListener { select(i) }
            Ui.pressable(item, 0.95f)
            items.add(item); icons.add(icon); labelViews.add(label); badges.add(badge)
        }
        render()
    }

    fun select(i: Int, notify: Boolean = true) {
        if (i !in labels.indices) return
        selected = i
        render()
        if (notify) onSelect?.invoke(i)
    }

    fun setBadge(i: Int, n: Int) {
        if (i !in badges.indices) return
        val b = badges[i]
        if (n > 0) {
            b.text = if (n > 99) "99+" else "$n"
            b.visibility = View.VISIBLE
        } else b.visibility = View.GONE
    }

    private fun render() {
        for (i in items.indices) {
            val on = i == selected
            items[i].background = if (on) Glass.cardBg(Glass.THICK, 16) else null
            items[i].elevation = if (on) Ui.dp(2).toFloat() else 0f
            labelViews[i].setTextColor(if (on) UiTheme.p.primary else UiTheme.p.textSub)
            labelViews[i].setTypeface(null, if (on) Typeface.BOLD else Typeface.NORMAL)
            icons[i].invalidate()
        }
    }

    /** 四个 22dp 线性图标，用 Path 画，颜色由外部 lambda 决定（选中变主色，不用换图） */
    private class IconView(ctx: Context, private val kind: Int, private val color: () -> Int) : View(ctx) {
        private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = 1.8f * resources.displayMetrics.density
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            if (width == 0 || height == 0) return
            val col = color()
            stroke.color = col
            fill.color = col
            val cx = width / 2f
            val cy = height / 2f
            val s = minOf(width, height) / 2f

            when (kind) {
                0 -> { // 麦克风
                    val r = s * 0.38f
                    canvas.drawRoundRect(cx - r, cy - s * 0.86f, cx + r, cy + s * 0.16f, r, r, stroke)
                    val arc = RectF(cx - s * 0.6f, cy - s * 0.34f, cx + s * 0.6f, cy + s * 0.54f)
                    canvas.drawArc(arc, 0f, 180f, false, stroke)
                    canvas.drawLine(cx, cy + s * 0.54f, cx, cy + s * 0.84f, stroke)
                    canvas.drawLine(cx - s * 0.28f, cy + s * 0.84f, cx + s * 0.28f, cy + s * 0.84f, stroke)
                }
                1 -> { // 打开的笔记本
                    val p = Path()
                    p.moveTo(cx, cy - s * 0.58f)
                    p.cubicTo(cx - s * 0.32f, cy - s * 0.82f, cx - s * 0.76f, cy - s * 0.72f, cx - s * 0.86f, cy - s * 0.56f)
                    p.lineTo(cx - s * 0.86f, cy + s * 0.62f)
                    p.cubicTo(cx - s * 0.55f, cy + s * 0.46f, cx - s * 0.2f, cy + s * 0.52f, cx, cy + s * 0.74f)
                    p.cubicTo(cx + s * 0.2f, cy + s * 0.52f, cx + s * 0.55f, cy + s * 0.46f, cx + s * 0.86f, cy + s * 0.62f)
                    p.lineTo(cx + s * 0.86f, cy - s * 0.56f)
                    p.cubicTo(cx + s * 0.76f, cy - s * 0.72f, cx + s * 0.32f, cy - s * 0.82f, cx, cy - s * 0.58f)
                    canvas.drawPath(p, stroke)
                    canvas.drawLine(cx, cy - s * 0.58f, cx, cy + s * 0.74f, stroke)
                }
                2 -> { // 对勾圆
                    canvas.drawCircle(cx, cy, s * 0.8f, stroke)
                    val p = Path()
                    p.moveTo(cx - s * 0.36f, cy + s * 0.02f)
                    p.lineTo(cx - s * 0.08f, cy + s * 0.3f)
                    p.lineTo(cx + s * 0.4f, cy - s * 0.3f)
                    canvas.drawPath(p, stroke)
                }
                else -> { // 设置：三条滑杆
                    for (i in 0..2) {
                        val y = cy + (i - 1) * s * 0.55f
                        canvas.drawLine(cx - s * 0.8f, y, cx + s * 0.8f, y, stroke)
                        val kx = when (i) {
                            0 -> cx + s * 0.3f
                            1 -> cx - s * 0.36f
                            else -> cx + s * 0.12f
                        }
                        canvas.drawCircle(kx, y, s * 0.18f, fill)
                    }
                }
            }
        }
    }
}
