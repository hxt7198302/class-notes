# app-android · 安卓壳（WebView + 原生录音桥）

用系统 WebView 承载云端 Web UI；内置原生录音服务，解决浏览器在锁屏/后台录音不可靠的问题。

## 基本信息

- 包名：com.sczzm.classroom
- 版本：1.0-demo
- minSdk 26 / targetSdk 34
- 权限：INTERNET、ACCESS_NETWORK_STATE、RECORD_AUDIO、FOREGROUND_SERVICE、FOREGROUND_SERVICE_MICROPHONE、POST_NOTIFICATIONS

## 构建

前置：
- JDK 17+（环境变量 CLASSROOM_JDK，需含 javac/keytool）
- Android SDK：build-tools 34.0.0 + platform android-34（环境变量 CLASSROOM_SDK）

    powershell -ExecutionPolicy Bypass -File .\build-apk.ps1
    # 产物：dist\课堂助手-演示.apk（本地演示签名，keystore 不入库）

## 服务器地址

- 源码默认值为占位地址 https://your-server.example.com（MainActivity.DEFAULT_SERVER）。
- 首次打开前可改源码后重新构建；或在 APP 内长按页面修改并保存。

## 原生录音桥（ClassroomNative）

WebView 注入 window.ClassroomNative：

| 方法 | 说明 |
|---|---|
| start(course) | 申请权限并启动前台录音服务；生成会话 ID，上传 meta |
| stop() | 停止录音并收尾 |
| mark(note) | 记录课堂标记 |
| status() | 返回 JSON：recording / segments / bytes / sessionId 等 |
| setToken(token) | 同步接口令牌（原生上传用；Web UI 保存令牌时会自动调用） |
| setServer(url) | 同步服务器地址 |

上传协议：POST /api/session/meta（JSON）与 /api/chunk?id=&name=&offset=&md5=（原始字节，x-app-token），与 webapp 的 P1 契约一致。

## 演示 / 限制

- 录屏权限：首次使用会请求麦克风；Android 13+ 还需通知权限。
- 当前 Web UI 的录音入口仍走浏览器 MediaRecorder；原生桥已就绪，接入 UI 属于后续工作。
- 真机录音/后台持续/通知栏/上传链路尚未在真机验证（无设备环境）。
- iOS 原生包未包含（需 Mac + Xcode 或 CI 自签）。

## 目录

    app/AndroidManifest.xml
    app/src/com/sczzm/classroom/
      MainActivity.java     WebView 壳，注入桥
      RecordingService.java 前台录音服务（AAC 16k，30s 切段）
      Uploader.java         meta/chunk 上传（409 对齐续传）
      Bridge.java           JS 桥
    build-apk.ps1           aapt2 + javac + R8/d8 + zipalign + apksigner
    tools/gen_icon.py       图标生成（Pillow）
