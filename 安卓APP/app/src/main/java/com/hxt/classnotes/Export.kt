package com.hxt.classnotes

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * v2.8 导出/分享：把手机里缓存的 note.md 拿出来，可以
 *  ① 复制 Markdown 文本；② 分享 .md 文件；③ 打包 Markdown + 图片 zip。
 * 全程本地生成，不依赖电脑在线（图片缺了才回头找电脑补）。
 * 分享走 PhotoProvider 的 exports/ 白名单（content:// + 临时读权限），不碰 file://。
 */
object Export {
    private const val AUTHORITY = "com.hxt.classnotes.photos"

    fun noteFile(ctx: Context, sid: String) = File(File(File(ctx.filesDir, "notes"), sid), "note.md")

    fun markdown(ctx: Context, sid: String): String? {
        val f = noteFile(ctx, sid)
        return try { if (f.exists()) f.readText(Charsets.UTF_8) else null } catch (_: Exception) { null }
    }

    /** 文件名去掉 Windows/安卓非法字符；全空就用 sid；去掉首尾的点（防隐藏文件/穿越） */
    fun safeBase(title: String, sid: String): String {
        val t = title.replace(Regex("[\\\\/:*?\"<>|\\r\\n\\t]"), " ").replace(Regex("\\s+"), " ")
            .replace("..", ".").trim().trim('.', ' ').take(40)
        return t.ifEmpty { sid }.ifEmpty { "课堂笔记" }
    }

    fun shareText(activity: Activity, text: String) {
        val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("课堂笔记", text))
        Ui.toast(activity, "Markdown 已复制到剪贴板")
    }

    private fun dirFor(ctx: Context) = File(ctx.filesDir, "exports").apply { mkdirs() }

    /** 只分享 .md 单文件（轻，适合发给同学/自己存档） */
    fun buildMdFile(ctx: Context, sid: String, title: String): File? {
        val md = markdown(ctx, sid) ?: return null
        val f = File(dirFor(ctx), "${safeBase(title, sid)}.md")
        return try { f.writeText(md, Charsets.UTF_8); f } catch (_: Exception) { null }
    }

    /** Markdown + 图片打成一个 zip（微信/QQ 发文件不丢图）。
     *  图片名改写成 assets/<原名>；手机里缺的图跳过（调用方会先尝试 refreshNote 补齐）。 */
    fun buildZip(ctx: Context, sid: String, title: String): File? {
        val md = markdown(ctx, sid) ?: return null
        val noteDir = File(File(ctx.filesDir, "notes"), sid)
        val imgs = Regex("!\\[[^\\]]*\\]\\(([^)\\s]+)\\)").findAll(md)
            .map { it.groupValues[1] }
            .filter { !it.startsWith("http") && !it.startsWith("assets/") && !it.contains('/') }
            .distinct()
            .toList()
        val out = File(dirFor(ctx), "${safeBase(title, sid)}.zip")
        return try {
            var body = md
            ZipOutputStream(out.outputStream().buffered()).use { z ->
                val base = safeBase(title, sid)
                for (name in imgs) {
                    if (File(noteDir, name).exists()) body = body.replace("]($name)", "](assets/$name)")
                }
                z.putNextEntry(ZipEntry("$base.md"))
                z.write(body.toByteArray(Charsets.UTF_8))
                z.closeEntry()
                for (name in imgs) {
                    val local = File(noteDir, name)
                    if (!local.exists()) continue
                    z.putNextEntry(ZipEntry("assets/$name"))
                    local.inputStream().use { it.copyTo(z) }
                    z.closeEntry()
                }
            }
            out
        } catch (_: Exception) {
            null
        }
    }

    /** 中文文件名必须百分号编码，否则部分接收方解析 content URI 会失败 */
    fun uriFor(f: File): Uri = Uri.parse("content://$AUTHORITY/exports/${Uri.encode(f.name)}")

    /** 系统分享面板（微信/QQ/邮件/网盘都在里面） */
    fun share(activity: Activity, f: File, mime: String, subject: String) {
        val uri = uriFor(f)
        val i = Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_SUBJECT, subject)
            putExtra(Intent.EXTRA_TITLE, subject)
            // 部分接收方（微信/QQ）只认 ClipData 里的 URI，靠它传播临时读权限
            clipData = ClipData.newUri(activity.contentResolver, "课堂笔记", uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(i, "分享课堂笔记")
        chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        activity.startActivity(chooser)
    }

    /** 分享纯文本（给没有文件的场景，例如短信/聊天框） */
    fun sharePlainText(activity: Activity, text: String, subject: String) {
        val i = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, text)
            putExtra(Intent.EXTRA_SUBJECT, subject)
        }
        activity.startActivity(Intent.createChooser(i, "分享课堂笔记"))
    }
}
