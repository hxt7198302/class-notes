package com.hxt.classnotes

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException

/**
 * 零依赖版 FileProvider，两个白名单目录：
 *  - content://…/photos/<名>        filesDir/camera\   相机写照片（读写）
 *  - content://…/photos/update/<名> filesDir/update\   应用内更新的 APK（只读，交给系统安装器）
 * （file:// 直传在 API 24+ 会抛 FileUriExposedException，所以走 content://）
 */
class PhotoProvider : ContentProvider() {
    private fun safeName(name: String?): String {
        if (!Regex("[A-Za-z0-9._-]{1,120}").matches(name ?: "")) throw FileNotFoundException("名字不合法")
        return name!!
    }

    /** 返回 (文件, 是否只读) */
    private fun fileFor(uri: Uri): Pair<File, Boolean> {
        val segs = uri.pathSegments
        return if (segs.size == 2 && segs[0] == "update") {
            Pair(File(File(context!!.filesDir, "update"), safeName(segs[1])), true)
        } else {
            val dir = File(context!!.filesDir, "camera").apply { mkdirs() }
            Pair(File(dir, safeName(segs.lastOrNull())), false)
        }
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val (f, readOnly) = fileFor(uri)
        val m = if (readOnly) {
            if (mode.contains("w")) throw FileNotFoundException("只读")
            ParcelFileDescriptor.MODE_READ_ONLY
        } else if (mode.contains("w")) {
            ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_READ_WRITE or ParcelFileDescriptor.MODE_TRUNCATE
        } else ParcelFileDescriptor.MODE_READ_ONLY
        return ParcelFileDescriptor.open(f, m)
    }

    override fun query(uri: Uri, p: Array<out String>?, s: String?, a: Array<out String>?, o: String?): Cursor? {
        val (f, _) = fileFor(uri)
        val c = MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE))
        c.addRow(arrayOf(f.name, if (f.exists()) f.length() else 0L))
        return c
    }

    override fun insert(uri: Uri, v: ContentValues?): Uri? = null
    override fun delete(uri: Uri, s: String?, a: Array<out String>?): Int = 0
    override fun update(uri: Uri, v: ContentValues?, s: String?, a: Array<out String>?): Int = 0
    override fun getType(uri: Uri): String {
        val (_, readOnly) = fileFor(uri)
        return if (readOnly) "application/vnd.android.package-archive" else "image/jpeg"
    }

    override fun onCreate(): Boolean = true
}
