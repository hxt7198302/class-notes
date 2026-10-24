# 课堂助手 · 合并版 v0.1

> 2026-10-24 · 两个项目合并的第一版基线（方案 A）
> 状态：**合并骨架 + 可运行基线**。安卓优先，学习通 v1 保留。完整功能移植见文末路线图。

## 一、这是什么

把两套「课堂笔记」系统合成一个产品：

- **界面**：以发起人的 Web UI 为唯一标准（webapp/public）
- **云端后端**：以 Web 版云服务为核心（Node，AI 助教 / 教务导入 / OCR / 课表）
- **能力端**：原作者 v2.12 的电脑端完整保留（faster-whisper 转写、AI 成稿、学习通 v1、素材修复）
- **APP**：安卓 WebView 壳（先保安卓；iOS 走 PWA / 后续 WKWebView）

## 二、架构

    ┌────────────── 安卓 APP（WebView 壳）──────────────┐
    │  加载云端 Web UI（课堂助手，含 AI 助教）            │
    │  长按可改服务器地址；后续加原生录音桥               │
    └───────────────┬──────────────────────────────────┘
                    │ HTTPS
    ┌───────────────▼───────────────┐     可选      ┌────────────────────────┐
    │  webapp（Node 云服务）         │ ───────────▶ │ pc-agent（Win 电脑）     │
    │  · Web UI + PWA               │  /api/       │ · API 8776（素材/笔记）  │
    │  · 课表 / EAMS / OCR          │  chaoxing/*  │ · faster-whisper large-v3│
    │  · AI 助教（glm-5.3-flash）   │              │ · AI 成稿流水线          │
    │  · 学习通代理（可选）          │              │ · 学习通 sidecar 8781    │
    └───────────────────────────────┘              │ · 应用内更新（APK）      │
                                                   └────────────────────────┘

## 三、目录

    merged/
      README.md                 本文件
      docs/                     合并决策 / 数据契约 / API 映射 / 学习通 / 发布清单
      webapp/                   统一 Web UI + 云后端（唯一前端标准）
      pc-agent/                 电脑端能力模块（转写 / AI 成稿 / 学习通 v1 / 更新）
      app-android/              安卓 WebView 壳源码（含原生录音桥，可自行构建 APK）

> 公开版不包含：原生旧版源码、私有分析手册、真实数据与模型；APK 请按 app-android/README 自行构建。

## 四、快速开始

### 1) 云端 / Web（主产品）

    cd webapp
    copy .env.example .env      # Windows；填入 ZHIPU_API_KEY / DEEPSEEK_API_KEY
    npm install                 # 安装唯一依赖 zfnew-node
    node server.js              # 默认 3003，可用 PORT 改

浏览器打开 http://127.0.0.1:3003。AI 助教需要 key；学习通需要 pc-agent 在线。

### 2) PC 能力端（学习通 v1 / GPU 转写，可选）

    cd pc-agent
    copy config.example.json config.json   # 按需改 pythonCmd / whisperModel / ntfyTopic
    .\api-server\start-api.ps1             # 学习通 sidecar 首次请求时自动拉起
    # 在 webapp\.env 配：CHAOXING_SIDECAR=http://127.0.0.1:8781

前提：Windows + Python（faster-whisper、requests、numpy、opencv）。详细见 pc-agent/README-使用说明.md。
注意：私有 zcode 引擎与分析手册不在公开版，公开版请用 glm / template 引擎。

### 3) 安卓 APP

    cd app-android
    # 按 README-安装与演示.md 设置 CLASSROOM_JDK / CLASSROOM_SDK 后构建
    powershell -ExecutionPolicy Bypass -File .\build-apk.ps1
    # 产物 dist\课堂助手-演示.apk；也可把 APK 放 GitHub Releases 分发

## 五、本次合并完成度

| 项 | 状态 |
|---|---|
| 统一 Web UI 为唯一界面标准 | ✅ 已确立（webapp/public） |
| 云端后端（AI 助教 / EAMS / OCR / 课表） | ✅ 保留 |
| 原作者 v2.12 电脑端（转写 / 分析 / 学习通 / 更新） | ✅ 整体保留在 pc-agent |
| 学习通 v1 | ✅ pc-agent 保留 + webapp 代理接口 + 前端入口 |
| 统一数据契约文档 | ✅ docs/03 |
| 安卓 APP 可构建（含原生录音桥） | ✅ 构建脚本与源码在 app-android（APK 自行构建，见 Releases 规范） |
| 上传协议统一（/api/session/meta、chunk、complete、notes、note、source、file） | ✅ 已落地，冒烟 23/23 通过（tests/agent-api-smoke.js） |
| 原始素材 / 总纲 / 待办页移植到你的 UI | ✅ 已移植（#source / #course / #todo） |
| 安卓原生录音桥（WebView ↔ 原生服务） | ✅ 已实现（RecordingService / Uploader / Bridge，APK 60.8KB） |
| iOS 出包 | ⏳ 路线图 P4（需 Mac 或 CI + 自签） |

## 六、已知限制

1. 学习通 v1 **必须有一台在线的 Windows 电脑**（扫码二维码在电脑屏幕、Cookie 只存本机），云端不承载。
2. WebView 录音在锁屏/后台的可靠性不如原生；P3 已提供原生录音桥（ClassroomNative.start/stop/status），但录音与上传仍需真机验证。
3. 隧道地址会变（trycloudflare）：APP 长按改地址，或改 webapp 默认地址后重打。
4. P1 已统一「新上传」的数据契约（data/agent）；历史 素材/笔记 与 data/sessions 的批量迁移脚本尚未做。
5. iOS 未出原生包；当前可用 Safari 打开同一地址「添加到主屏幕」。

## 七、发布与许可

- 发布前必须脱敏：.env、token、Cookie、隧道地址、演示数据、个人路径、models、node_modules 均不入库，见 docs/06。
- 许可证：默认 MIT（见 LICENSE；学习通客户端为自写只读实现，未引入 GPL 代码，详见 THIRD-PARTY.md）。
- APK 走 GitHub Releases 分发，不进仓库正文。
- 本仓库为**公开脱敏快照**：不含个人信息、密钥、Cookie、真实课堂数据与私有手册。
