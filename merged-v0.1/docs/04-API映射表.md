# 04 · API 映射表

## 一、合并后的 API 分区

    /api/core/*      上传 / 笔记 / 素材（对齐 pc-agent 契约，P1 落地）
    /api/assist/*    AI 助教（保留 webapp 现有实现）
    /api/eams/*      教务导入（保留 webapp）
    /api/ocr-parse   截图识别（保留 webapp）
    /api/chaoxing/*  学习通代理（已接，转发 pc-agent sidecar）
    /api/meta        版本 / 健康 / 配置

## 二、逐条映射

| 能力 | 原作者 v2.12 | Web 版现状 | 合并后 |
|---|---|---|---|
| 探活 | GET /api/ping | GET /api/health | /api/health（保留 /api/ping 别名） |
| 配对 | GET /api/pair-info | 无 | P1 增加（局域网组网用） |
| 上传元数据 | POST /api/session/meta | POST /api/sessions | P1 按他的契约实现 /api/core/session/meta |
| 分块上传 | POST /api/chunk | 二进制分段上传 | P1 移植（3MiB + md5 + 续传） |
| 收尾入队 | POST /api/session/complete | 无 | P1 |
| 笔记列表 | GET /api/notes | GET /api/sessions | P1/P2 统一返回规范结构 |
| 单篇笔记 | GET /api/note | GET /api/sessions/:id | P2 |
| 原始素材 | GET /api/source | GET /api/media/* | P2（对应前端「原始素材」页） |
| 文件下载 | GET /api/file | GET /api/media/* | P2（Range 保留） |
| 版本/APK | GET /api/version、/api/apk | 无 | P4（壳内更新） |
| 课表 | GET /api/timetable | GET /api/classes | /api/classes 为准，保留 /api/timetable 别名 |
| 健康 | GET /api/health | GET /api/system-check | P2 合并 |
| 课程列表 | GET /api/courses | 无 | P2 |
| 课程设置 | POST /api/course-config | 无 | P2 |
| 总览 | GET /api/overview | 无 | P2 |
| 待办 | GET /api/deadlines | GET /api/assist/todos | P2 双端点并存 |
| 勾选待办 | POST /api/deadline-done | 本地勾选 | P2 |
| 诊断 | POST /api/diag、/api/client-log | 无 | 可选（日志） |
| AI Key | GET/POST /api/ai-key | GET /api/ai/status | P2 统一到 /api/ai/* |
| 重新分析 | POST /api/reanalyze | 无 | P3（交给 pc-agent） |
| 修复 | /api/repair/scan、/api/session/reupload、verify、repair-done | 无 | P3（交给 pc-agent） |
| 学习通 | GET/POST /api/chaoxing/* | 无 | ✅ 已由 webapp 代理到 sidecar |
| AI 成稿 | 无（pc-agent 流水线内部） | POST /api/ai/chat + /api/sessions/:id/ai-note | 保留 webapp 版本 |
| 精简笔记 / 导图 | 无 | /api/assist/summary、/api/assist/mindmap | 保留 |
| 助教对话 | 无 | /api/assist/chat | 保留 |
| 教务导入 | 无 | /api/eams/import、/api/eams/parse-html、/api/campus/import | 保留 |
| 截图识别 | 无 | /api/ocr-parse、/api/parse-timetable | 保留 |

## 三、鉴权约定

- APP / 代理 / 上传：x-app-token（P1 引入，token 由 webapp 生成，不进仓库）
- Web 演示：可选 CHAT_PIN（请求头 x-app-pin）
- 学习通：Cookie 只存 pc-agent 本机，云后端不落地
- AI key：服务端 .env 或 BYOK 请求头，二者不落前端

## 四、兼容原则

1. 先加别名，不删旧路由。
2. 新前端只用合并后的路由，旧路由标记 deprecated。
3. 每个路由需有 curl 冒烟用例（P1 建立 tests/smoke）。
