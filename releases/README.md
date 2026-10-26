# 安装包

APK 不放仓库里（二进制不进 git，`.gitignore` 里有 `*.apk`），发布时挂到 GitHub Releases：

- 文件：`课堂笔记-v2.13.apk`
- 校验：同时上传 `课堂笔记-v2.13.apk.sha256`，装之前可自行核对
- 说明：从**本仓库源码**（`安卓APP/`，versionCode 26）用 `clean assembleDebug` 构建的公开版，**不内置任何配对口令**；首次使用需在 APP 里与自己的电脑配对（手机和电脑连同一个 WiFi → APP「连接电脑」→「自动找我的电脑」）

## v2.13（2026-10-26）

| 项 | 值 |
|---|---|
| versionCode | 26 |
| versionName | 2.13 |
| 大小 | 1,105,685 字节 |
| SHA-256 | `8B3F2F42FC21EDE504D873F74AD06B28CD11E85A31F8B052DC61601C26146032` |
| 签名 | Android 默认 debug 证书，SHA-256 `981cde98…e6794`（与作者的 2.12 同证书，可直接覆盖升级） |
| 最低系统 | Android 8.0（API 26） |

校验命令：

```bash
sha256sum 课堂笔记-v2.13.apk
# Windows PowerShell：Get-FileHash .\课堂笔记-v2.13.apk -Algorithm SHA256
```

## 本次改动

- `Api.connect()` 修复空白安装的配对自举：默认 token 是占位符时，先把配对下发的 token 装进内存再探活，探通才落库；原来「先探活」会拿占位 token 打 `/api/ping` 吃 401，第一次永远配不上。
- 源码里的 token / ntfy 频道全部换成占位符；本机路径、私有分析手册、临时脚本一律没进仓库。
- 其余功能与作者日常在用的 2.12 一致。

## 构建方法

见根目录 README「从源码构建」，或 `安卓APP/README-构建与安装.md`。
