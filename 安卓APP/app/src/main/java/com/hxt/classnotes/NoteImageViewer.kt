package com.hxt.classnotes

import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.drawable.ColorDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import java.io.File

/**
 * v2.1 笔记图片查看器：全屏、双指缩放、双击放大、拖动。
 * 只用系统 API（ScaleGestureDetector + 自绘），不引第三方图片库。
 */
object NoteImageViewer {

    fun show(act: Activity, file: File) {
        if (!file.exists()) {
            Ui.toast(act, "这张图还没下载到手机，连上电脑后会自动补")
            return
        }
        val bmp = load(file) ?: run {
            Ui.toast(act, "图片打不开（可能已损坏）")
            return
        }

        val dialog = Dialog(act)
        dialog.requestWindowFeature(android.view.Window.FEATURE_NO_TITLE)
        val root = FrameLayout(act)
        root.setBackgroundColor(Color.BLACK)

        val zoom = ZoomView(act)
        zoom.setBitmap(bmp)
        root.addView(zoom, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        val close = TextView(act)
        close.text = "✕"
        close.textSize = 18f
        close.setTextColor(Color.WHITE)
        close.gravity = Gravity.CENTER
        close.background = Glass.cardBg(Glass.THIN, 999)
        close.setOnClickListener { dialog.dismiss() }
        val clp = FrameLayout.LayoutParams(Ui.dp(40), Ui.dp(40), Gravity.END or Gravity.TOP)
        clp.topMargin = Ui.dp(28); clp.rightMargin = Ui.dp(16)
        root.addView(close, clp)

        val name = TextView(act)
        name.text = file.name
        name.textSize = 11f
        name.setTextColor(Color.argb(170, 255, 255, 255))
        val nlp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL)
        nlp.bottomMargin = Ui.dp(28)
        root.addView(name, nlp)

        dialog.setContentView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        dialog.window?.let { win ->
            win.setBackgroundDrawable(ColorDrawable(Color.BLACK))
            win.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
            win.decorView.systemUiVisibility =
                View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        }
        root.alpha = 0f
        dialog.setOnShowListener {
            dialog.window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            root.animate().alpha(1f).setDuration(160).start()
        }
        dialog.show()
    }

    private fun load(f: File): Bitmap? = try {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(f.absolutePath, bounds)
        var sample = 1
        while (bounds.outWidth / sample > 2400 || bounds.outHeight / sample > 2400) sample *= 2
        BitmapFactory.decodeFile(f.absolutePath, BitmapFactory.Options().apply { inSampleSize = sample })
    } catch (_: Exception) { null }

    /** 自绘可缩放图片：fit-center 起始，最大 6 倍，边界内拖动 */
    private class ZoomView(ctx: Context) : View(ctx) {
        private var bmp: Bitmap? = null
        private val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
        private var scale = 1f
        private var dx = 0f
        private var dy = 0f

        private val scaleDetector = ScaleGestureDetector(ctx, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(detector: ScaleGestureDetector): Boolean {
                scale = (scale * detector.scaleFactor).coerceIn(1f, 6f)
                clamp()
                invalidate()
                return true
            }
        })

        private val gestureDetector = android.view.GestureDetector(ctx, object : android.view.GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent): Boolean = true

            override fun onDoubleTap(e: MotionEvent): Boolean {
                scale = if (scale > 1.4f) 1f else 2.6f
                if (scale == 1f) { dx = 0f; dy = 0f }
                clamp()
                invalidate()
                return true
            }

            override fun onScroll(e1: MotionEvent?, e2: MotionEvent, distanceX: Float, distanceY: Float): Boolean {
                if (scale > 1.02f) {
                    dx -= distanceX
                    dy -= distanceY
                    clamp()
                    invalidate()
                }
                return true
            }
        })

        fun setBitmap(b: Bitmap) {
            bmp = b
            scale = 1f
            dx = 0f
            dy = 0f
            invalidate()
        }

        override fun onTouchEvent(event: MotionEvent): Boolean {
            scaleDetector.onTouchEvent(event)
            gestureDetector.onTouchEvent(event)
            if (event.actionMasked == MotionEvent.ACTION_UP ||
                event.actionMasked == MotionEvent.ACTION_CANCEL) clamp()
            return true
        }

        private fun baseScale(): Float {
            val b = bmp ?: return 1f
            if (b.width == 0 || b.height == 0 || width == 0 || height == 0) return 1f
            return minOf(width.toFloat() / b.width, height.toFloat() / b.height)
        }

        private fun clamp() {
            val b = bmp ?: return
            val total = baseScale() * scale
            val maxX = ((b.width * total - width) / 2f).coerceAtLeast(0f)
            val maxY = ((b.height * total - height) / 2f).coerceAtLeast(0f)
            dx = dx.coerceIn(-maxX, maxX)
            dy = dy.coerceIn(-maxY, maxY)
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val b = bmp ?: return
            val s = baseScale() * scale
            canvas.save()
            canvas.translate(width / 2f + dx, height / 2f + dy)
            canvas.scale(s, s)
            canvas.drawBitmap(b, -b.width / 2f, -b.height / 2f, paint)
            canvas.restore()
        }
    }
}
