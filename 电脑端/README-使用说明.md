# pc-agent · 电脑端能力模块

原作者「课堂笔记 APP」电脑端（Node + Python），在合并版中作为可选能力端保留：
GPU 转写（faster-whisper）、AI 成稿流水线、学习通 v1（扫码只读）、素材修复、更新清单。

## 目录

    api-server/server.mjs      HTTP API（默认 8776，x-app-token 鉴权）
    pipeline.mjs               转写 → AI 分析 → 推送 一条龙
    engines.mjs                AI 引擎适配（glm / template；zcode 需自备）
    transcribe.py              faster-whisper 转写（GPU 优先，CPU 兜底）
    md2html.mjs                note.md → note.html
    chaoxing/                  学习通 sidecar（Python，127.0.0.1:8781）
    chaoxing/vendor/           学习通只读客户端
    config.example.json        配置模板
    同日合并-补跑.mjs / 补转写成员段.mjs   历史修复工具

## 依赖

- Windows（脚本按 Windows 编写）
- Node.js 18+（零 npm 依赖）
- Python 3.10+：faster-whisper、requests、numpy、opencv-python-headless
- 可选：NVIDIA GPU + CUDA（转写加速；无 GPU 自动退 CPU small）

## 启动

    copy config.example.json config.json
    # 按需修改：pythonCmd / whisperModel / ntfyTopic / engine
    .\api-server\start-api.ps1

- 鉴权 token 首次运行自动生成到 api-server/api-token.txt（不入库）。
- 学习通 sidecar 在首次请求 /api/chaoxing/* 时自动拉起。
- 私有 zcode 引擎与其分析手册不在公开版；公开版请使用 engine: glm（BYOK）或 engine: template（无 AI）。
- 数据目录：素材/<会话ID>/、笔记/<会话ID>/，均为本地文件，不上传云端。

## 与 webapp 的关系

webapp（云端/主产品）可通过 /api/chaoxing/* 代理访问本机学习通 sidecar；
上传/笔记数据契约见 docs/03-统一数据契约.md。

## 边界

- 学习通：只读，不签到、不刷课、不答题、不提交；登录态只存本机。
- 真实课堂数据、登录态、密钥均不进入仓库。
