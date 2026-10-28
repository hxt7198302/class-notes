# 安卓端：构建与安装

本目录是**作者日常在用的原生 Kotlin 手机端**（不是 `merged-v0.1/app-android` 那个 WebView 壳）。
零第三方依赖、全代码手写 UI，`minSdk 26 / targetSdk 34`，versionCode 26 / versionName 2.13。

## 一、直接装现成的

到 [Releases](https://github.com/shaocongzeming/class-notes/releases/latest) 下载 `classnotes-v2.13.apk`：

1. 手机允许「安装未知来源应用」；
2. 装完先别急着开，**先把电脑端跑起来**（见仓库根 README「三步用起来」）；
3. 手机连**和电脑同一个 WiFi**，打开 APP →「🔗 第一次使用？点这里连接电脑」→「🔍 自动找我的电脑」；
4. 连上后回主页，点「开始上课」即可。

> 首次配对必须同一局域网（配对信息走 UDP 广播发现）。配好之后人在外面也能走 Cloudflare 隧道连回家。

## 二、自己构建

工具链：**JDK 17 + Android SDK Platform 34 + Build-Tools 34 + Gradle 8.x**（仓库没带 wrapper，用本机 gradle）。

```bash
# 1) 指向你的 SDK
echo "sdk.dir=/你的/Android/Sdk" > local.properties     # Windows 例：sdk.dir=Y:\\sdk

# 2) 构建（发版必须 clean，增量构建出过 classes3.dex 膨胀的异常包）
gradle clean assembleDebug

# 3) 产物
#    app/build/outputs/apk/debug/app-debug.apk
```

- 工程已开 `android.overridePathCheck=true`，放在含中文的路径下也能构建。
- debug 构建用 Android 默认 debug 证书自动签名；要发布就自己在 `app/build.gradle` 加 `signingConfigs`。
- 别把 `local.properties`、`build/`、`备份/` 提交进仓库（`.gitignore` 已覆盖前两个）。

## 三、源码里为什么不带 token

`Api.kt` 顶部两个常量是**占位符**：

```kotlin
const val DEFAULT_TOKEN = "请先与你的电脑配对"
private const val DEFAULT_TOPIC = "your-ntfy-topic"
```

真正的 token 由你自己的电脑端首次运行时随机生成（`电脑端/api-server/api-token.txt`），通过局域网 UDP 发现下发、存在手机本地数据库里。
所以空白安装必须先配对；`Api.connect()` 在 v2.13 里改成「先把下发的 token 装进内存再探活」，否则会拿占位 token 打 `/api/ping` 吃 401、永远配不上。

## 四、文件地图

| 文件 | 干什么 |
|---|---|
| `Api.kt` | 与电脑端通讯：配对/鉴权/分块续传/ntfy 地址同步/AI 设置/更新 |
| `Rec.kt` `Sync.kt` `Watch.kt` | 录音前台服务（独立进程）、上传前台服务、中断看门狗 |
| `MainActivity.kt` | 主页、课程卡、设置页、连接体检 |
| `NoteActivity.kt` `NotesView.kt` `SourceActivity.kt` | 笔记详情 / 列表 / 原文与源码视图 |
| `PairActivity.kt` | 连接电脑（UDP 自动发现 + 手动地址 + AI Key） |
| `CourseActivity.kt` `Timetable.kt` `TodoView.kt` | 课程总纲、课表、待办 |
| `ChaoxingActivity.kt` | 学习通只读查询（作业/通知/考试/章节进度） |
| `Db.kt` | 本地 SQLite（笔记缓存、待办、meta） |
| `Upd.kt` | 应用内更新（向电脑端要 `/api/version`，sha256 校验后唤起系统安装器） |
| `Ui.kt` `UiTheme.kt` `Glass.kt` `TabBar.kt` `Img.kt` | 手写 UI 组件与主题 |
