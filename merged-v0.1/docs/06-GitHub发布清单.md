# 06 · GitHub 发布清单（脱敏 + 仓库规范）

> 目标：把这个合并仓库交给原作者发布到 GitHub。以下每一条发布前必须过一遍。

## 一、禁止入库（必须删/忽略）

| 项 | 原因 |
|---|---|
| webapp/.env | 含 ZHIPU/DEEPSEEK 真实 key |
| pc-agent/api-server/api-token.txt | 设备 token |
| pc-agent/data/chaoxing/session_cookies.json | 学习通登录态 |
| data/、素材/、笔记/ | 真实课堂数据与个人信息 |
| models/ | faster-whisper 模型（数百 MB） |
| node_modules/ | 依赖目录 |
| dist 下的 apk / zip | 二进制发版物走 GitHub Releases |
| backup/、备份/ | 历史备份 |
| _tmp_*.py | 原作者的临时脚本 |
| 文档/需求确认单-20261024.md | 内部需求/对话产物，仅内部保留 |
| 开源比对.md 等内部调研 | 可留私有文档或删 |
| 个人绝对路径（D:/ai/...、C:/Users/...） | 隐私与可移植性 |

## 二、发布前必须替换/检查

1. pc-agent/api-server/ 首次运行会自动生成 api-token.txt（不要提交，.gitignore 已覆盖）
2. webapp/.env.example 只留占位符，不含真实值
3. 安卓壳 MainActivity.java 的 DEFAULT_SERVER 改为示例地址或留空
4. 旧 README 里出现过的 token/ntfy 主题要轮换并清除
5. 学习通客户端来源与许可证：自写只读实现（参考 MIT 项目思路，未整仓引入 GPL 代码），发布前由原作者确认
6. 许可证：默认 MIT（LICENSE 文件已包含）；项目作者如要调整可替换

## 三、发布前扫描（PowerShell，在仓库根执行）

    1) 明文 key/凭据：
    Get-ChildItem -Recurse -File -Include *.js,*.mjs,*.py,*.kt,*.json,*.md,*.ps1,*.bat |
      Select-String -Pattern 'sk-[A-Za-z0-9]{10,}|ghp_|AIza|api-token|session_cookies|trycloudflare|ntfy.sh|D:/ai/|C:/Users/'

    2) 32 位十六进制 token 形态：
    Get-ChildItem -Recurse -File -Include *.kt,*.mjs,*.js,*.json |
      Select-String -Pattern '[0-9a-f]{32}'

## 四、仓库结构（建议）

    /
      README.md
      LICENSE                  （默认 MIT，见仓库根 LICENSE）
      .gitignore
      docs/
      webapp/                  Web UI + 云后端
      pc-agent/                电脑端（转写 / AI / 学习通）
      app-android/             安卓 WebView 壳（含原生录音桥）
      tests/                   P1 建冒烟
      .github/workflows/       CI：node --check、python py_compile、密钥扫描

## 五、发版

- APK 放 GitHub Releases，附 sha256 与 versionCode
- 每个版本打 tag，例如 v0.1.0-merge
- README 写清模块边界、学习通前提、隐私边界

## 六、发布前自检（勾选）

- [ ] 全仓搜索无真实 key / token / Cookie
- [ ] 无真实课堂数据 / 个人路径
- [ ] .env.example 完整
- [ ] LICENSE 已定
- [ ] README 与仓库实际一致
- [ ] CI 通过
- [ ] APK 已在 Releases，仓库内无二进制大文件
