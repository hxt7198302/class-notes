package com.hxt.classnotes

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.File

/** 照片压缩：上传走压缩版（省流量），原图留在手机兜底 */
object Img {
    /** 把相机拍的原文件压缩拷贝为 out；返回 true=压缩成功，false=已直接拷原图兜底 */
    fun compress(orig: File, out: File, maxDim: Int = 1600, quality: Int = 82): Boolean {
        return try {
            val opt = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(orig.absolutePath, opt)
            var sample = 1
            while (maxOf(opt.outWidth, opt.outHeight) / (sample * 2) >= maxDim) sample *= 2
            val opt2 = BitmapFactory.Options().apply { inSampleSize = sample }
            val bmp = BitmapFactory.decodeFile(orig.absolutePath, opt2) ?: return fallback(orig, out)
            out.outputStream().use { fos ->
                bmp.compress(Bitmap.CompressFormat.JPEG, quality, fos)
            }
            bmp.recycle()
            true
        } catch (_: Exception) {
            fallback(orig, out)
        }
    }

    private fun fallback(orig: File, out: File): Boolean {
        return try {
            orig.copyTo(out, overwrite = true)
            true
        } catch (_: Exception) { false }
    }
}
