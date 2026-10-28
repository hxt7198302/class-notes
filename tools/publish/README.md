# 发布入口（维护者工具）

> 本文由 AI 整理。

仓库从 `hxt7198302/class-notes` 原生转入 `shaocongzeming/class-notes` 后，这两个发布脚本的 `Owner` 默认值已改为 `shaocongzeming`（Issue #1）。

| 脚本 | 用途 |
|---|---|
| `github-publish.ps1` | 把一个已脱敏的构建目录整包发布到 `main`（用于首次建仓/整包替换） |
| `github-publish-merge.ps1` | 在保留现有文件的前提下，把一个脱敏包追加到子目录，并可选在根 README 加指针 |

使用前提：

- 需要目标仓库的写权限；凭据从 Windows Git Credential Manager 读取，脚本不保存也不打印 token。
- 参数 `-Root` 指向本地已脱敏的构建目录，默认值为相对路径，按实际产物位置传入。
- 这两个脚本只给维护者手工使用，不接入 CI，不随发布产物分发。
- 本 Issue 的改动本身按流程走 `huang/*` 分支 + PR，不由这两个脚本推送。

语法自检（不实际发布）：

```powershell
$null = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path .\github-publish.ps1), [ref]$null, [ref]$errs)
```
