package com.hxt.classnotes

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.os.Bundle
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import java.io.File
import org.json.JSONArray

/**
 * 大图查看页（v1.8 拍照即时查看）：录音中缩略图条点进来，看板书照片拍得清不清楚。
 * 零依赖自绘：后台线程按屏幕档采样解码原图，双击放大/缩小、单指拖动、双指捏合、
 * 横向快滑切上一张/下一张（缩放状态下不切，防误触）；顶部显示「第 N/M 张 · 拍于第 mm:ss」。
 */
class PhotoActivity : Activity() {
    private var sid = ""
    private var idx = 0
    private lateinit var photos: JSONArray
    private lateinit var img: ImageView
    private lateinit var titleText: TextView

    private var bmpW = 0f
    private var bmpH = 0f
    private var baseScale = 1f
    private var scale = 1f
    private var transX = 0f
    private var transY = 0f
    private var gen = 0   // 解码代数：慢解码回来时已是上一张，丢弃防错图

    private lateinit var scaleDet: ScaleGestureDetector
    private lateinit var gesture: GestureDetector

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        sid = intent.getStringExtra("sid") ?: ""
        idx = intent.getIntExtra("index", 0)
        // v2.6：原始素材页会传一份跨会话聚合过的照片清单（同日同课合并后，照片不全在 sid 目录）
        val listJson = intent.getStringExtra("photosJson")
        photos = if (!listJson.isNullOrEmpty()) {
            try { JSONArray(listJson) } catch (_: Exception) { Db.photos(sid) }
        } else Db.photos(sid)

        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.setBackgroundColor(Color.BLACK)

        titleText = TextView(this)
        titleText.setTextColor(0xFFE8EBEF.toInt())
        titleText.textSize = 14f
        titleText.setPadding(Ui.dp(16), Ui.dp(16), Ui.dp(16), Ui.dp(8))
        root.addView(titleText)

        img = ImageView(this)
        img.scaleType = ImageView.ScaleType.MATRIX
        img.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        root.addView(img)

        val nav = LinearLayout(this)
        nav.orientation = LinearLayout.HORIZONTAL
        nav.setPadding(Ui.dp(16), Ui.dp(8), Ui.dp(16), Ui.dp(20))
        val prev = Ui.button(this, "← 上一张", false)
        prev.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).also { it.rightMargin = Ui.dp(6) }
        prev.setOnClickListener { show(idx - 1) }
        val next = Ui.button(this, "下一张 →", false)
        next.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).also { it.leftMargin = Ui.dp(6) }
        next.setOnClickListener { show(idx + 1) }
        nav.addView(prev)
        nav.addView(next)
        root.addView(nav)

        // v2.6：从原始素材页进来时，给一个「跳到录音这里」的出口
        if (intent.getBooleanExtra("seekEnabled", false)) {
            val jump = Ui.button(this, "🎧 跳到录音这里", true)
            val jlp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            )
            jlp.setMargins(Ui.dp(16), 0, Ui.dp(16), Ui.dp(18))
            jump.layoutParams = jlp
            jump.setOnClickListener {
                val off = if (photos.length() > 0) photos.optJSONObject(idx)?.optLong("offsetMs") ?: 0L else 0L
                setResult(RESULT_OK, Intent().putExtra("seekMs", off))
                finish()
            }
            root.addView(jump)
        }

        setContentView(root)

        // 手势：双击=放大/还原；拖动=平移（放大时）；横向快滑=换张（未放大时）
        scaleDet = ScaleGestureDetector(this, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(det: ScaleGestureDetector): Boolean {
                val ns = (scale * det.scaleFactor).coerceIn(baseScale * 0.8f, baseScale * 6f)
                // 以双指中点为锚缩放
                val ax = det.focusX - img.width / 2f
                val ay = det.focusY - img.height / 2f
                val k = ns / scale
                transX = ax - k * (ax - transX)
                transY = ay - k * (ay - transY)
                scale = ns
                if (scale < baseScale * 1.02f) resetView()
                applyMatrix()
                return true
            }
        })
        gesture = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDoubleTap(e: MotionEvent): Boolean {
                if (scale > baseScale * 1.02f) {
                    resetView()
                } else {
                    val ax = e.x - img.width / 2f
                    val ay = e.y - img.height / 2f
                    val k = baseScale * 2.5f / scale
                    transX = ax - k * (ax - transX)
                    transY = ay - k * (ay - transY)
                    scale = baseScale * 2.5f
                    applyMatrix()
                }
                return true
            }

            override fun onScroll(e1: MotionEvent?, e2: MotionEvent, dx: Float, dy: Float): Boolean {
                if (scale > baseScale * 1.02f) {
                    transX -= dx
                    transY -= dy
                    clampPan()
                    applyMatrix()
                }
                return true
            }

            override fun onFling(e1: MotionEvent?, e2: MotionEvent, vx: Float, vy: Float): Boolean {
                if (scale <= baseScale * 1.02f && kotlin.math.abs(vx) > 800 && kotlin.math.abs(vx) > kotlin.math.abs(vy) * 1.5f) {
                    show(if (vx < 0) idx + 1 else idx - 1)
                    return true
                }
                return false
            }
        })
        img.setOnTouchListener { _, e ->
            scaleDet.onTouchEvent(e)
            if (!scaleDet.isInProgress) gesture.onTouchEvent(e)
            true
        }

        if (photos.length() == 0) {
            titleText.text = "这节课还没有照片"
        } else {
            show(idx.coerceIn(0, photos.length() - 1))
        }
    }

    /** 换到第 i 张（越界停住）；后台采样解码原图，回来摆图并复位视角 */
    private fun show(i: Int) {
        if (photos.length() == 0) return
        if (i < 0 || i >= photos.length()) {
            Ui.toast(this, if (i < 0) "已经是第一张" else "已经是最后一张")
            return
        }
        idx = i
        val p = photos.getJSONObject(i)
        val off = p.optLong("offsetMs")
        titleText.text = "第 ${idx + 1}/${photos.length()} 张 · 拍于第 ${Ui.dur(off)}（录音里的位置，笔记里照片会插在这）"
        val comp = File(p.optString("path"))
        val orig = File(comp.parentFile, "orig_" + comp.name)
        val file = if (orig.exists() && orig.length() > 0) orig else comp
        gen++
        val myGen = gen
        titleText.text = titleText.text.toString() + "　加载中…"
        Thread {
            val bmp = decodeSampled(file, 2048)
            runOnUiThread {
                if (isFinishing || isDestroyed || myGen != gen) return@runOnUiThread
                if (bmp == null) {
                    titleText.text = "第 ${idx + 1}/${photos.length()} 张 · 这张图读取失败（文件：${file.name}）"
                    img.setImageBitmap(null)
                    return@runOnUiThread
                }
                img.setImageBitmap(bmp)
                bmpW = bmp.width.toFloat()
                bmpH = bmp.height.toFloat()
                img.post { if (!isFinishing && !isDestroyed && myGen == gen) resetView() }
            }
        }.start()
    }

    private fun decodeSampled(f: File, maxDim: Int): Bitmap? {
        return try {
            val opt = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(f.absolutePath, opt)
            if (opt.outWidth <= 0) return null
            var sample = 1
            while (maxOf(opt.outWidth, opt.outHeight) / (sample * 2) >= maxDim) sample *= 2
            BitmapFactory.decodeFile(f.absolutePath, BitmapFactory.Options().apply { inSampleSize = sample })
        } catch (_: Exception) { null }
    }

    /** 适配窗口大小（等比缩放居中）——所有平移/缩放都相对这个基准 */
    private fun resetView() {
        val vw = img.width.toFloat()
        val vh = img.height.toFloat()
        if (vw <= 0 || vh <= 0 || bmpW <= 0) return
        baseScale = minOf(vw / bmpW, vh / bmpH)
        scale = baseScale
        transX = 0f
        transY = 0f
        applyMatrix()
    }

    /** 放大状态下来回拖，不许把图拖出视野留白 */
    private fun clampPan() {
        val vw = img.width.toFloat()
        val vh = img.height.toFloat()
        val w = bmpW * scale
        val h = bmpH * scale
        // 图片以画布中心为原点摆放：允许的平移边界 = 超出窗口的部分的一半；没超出的轴锁回 0
        val maxX = if (w > vw) (w - vw) / 2f else 0f
        val maxY = if (h > vh) (h - vh) / 2f else 0f
        transX = transX.coerceIn(-maxX, maxX)
        transY = transY.coerceIn(-maxY, maxY)
    }

    private fun applyMatrix() {
        val m = Matrix()
        m.postScale(scale, scale, bmpW / 2f, bmpH / 2f)
        m.postTranslate(img.width / 2f - bmpW * scale / 2f + transX, img.height / 2f - bmpH * scale / 2f + transY)
        img.imageMatrix = m
    }
}
