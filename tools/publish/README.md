# 发布入口（维护者工具）

> 本文由 AI 整理。

仓库从 `hxt7198302/class-notes` 转入 `shaocongzeming/class-notes` 后，这两个发布脚本的 `Owner` 默认值改为 `shaocongzeming`（Issue #1）。

| 脚本 | 用途 |
|---|---|
| `github-publish.ps1` | 把一个已脱敏的目录整包上传，在新分支上提交并开草稿 PR |
| `github-publish-merge.ps1` | 把脱敏包追加到子目录（如 `merged-v0.1/`），可选在根 README 加一段指针，同样走新分支 + 草稿 PR |
| `lib/publish-common.ps1` | 两个脚本共用的路径校验、清单、GitHub API 封装 |
| `tests/publish-safety.tests.ps1` | 路径与分支校验的离线自测 |

## 安全约束（2026-10-28 按评审意见重写）

1. **不写 main。** 脚本只会 `POST /git/refs` 新建 `refs/heads/<Branch>`，再 `POST /pulls` 开草稿 PR；没有任何 PATCH ref 的代码路径，也没有 `force` 参数。目标分支已存在就直接报错退出，不覆盖。
2. **提交带 parent、树带 base_tree。** 提交以 `main` 当前 tip 为 parent，树以它的 tree 为 `base_tree`，未列出的文件保持原样；不会出现「无 parent 根提交把历史和源码树重置」的情况。
3. **上传路径规范化后再校验。** 用 `[IO.Path]::GetFullPath` 规范化 `-Root`，用逐段前缀比较求相对路径（PowerShell 5.1 没有 `GetRelativePath`），统一转 `/`，再逐条拒绝：盘符、`/` 或 `\` 开头、`..`/`.`/空段、反斜杠、控制字符、超出 `-Root` 的条目、符号链接、`.git` 目录。
4. **默认 dry-run。** 不带 `-Apply` 只打印清单（`FILE <target path>\t<bytes>`、`MANIFEST_FILES`），不联网、不写任何东西。加 `-Apply -Branch <name>` 才上传。
5. **凭据文件拦截。** `.env*`、`*.pem/*.pfx/*.p12/*.keystore/*.jks/*.key/*.ppk`、`id_rsa*`、`.netrc`、`.npmrc`、`credentials.json` 一律拦下；确认误报后可用 `-AllowSensitive` 放行，清单里会标明。
6. **token 不落盘、不打印。** 从 Windows Git Credential Manager 读取；`-Sha256` 只用于本地清单核对。
7. **不开 Release。** 安装包请用 `gh release upload <tag> <file...>`；本目录脚本只处理源码/快照提交。

## 用法

```powershell
# 1) 先 dry-run，把清单贴进 PR 或群里核对
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\publish\github-publish.ps1 `
    -Root .\dist -Subdir dist -Branch publish/example -Sha256

# 2) 确认后上传并开草稿 PR（分支名不能是 main/master，也不能与基准分支同名）
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\publish\github-publish.ps1 `
    -Root .\dist -Subdir dist -Branch publish/example -Apply
```

参数：

- `-Root`：本地已脱敏目录，相对路径按仓库根解析；必须在仓库内，且不能是仓库根。
- `-Subdir`：上传到仓库里的子目录前缀，留空则按 `-Root` 内的相对路径直接放在根下。
- `-Branch`：`-Apply` 时必填，例如 `publish/merged-v0.1`。
- `-BaseBranch`：默认 `main`，只从它取 tip 和 `base_tree`，不向它写。
- `-RepoRoot`：脚本不在仓库 `tools\publish` 下时显式指定仓库根。
- `-BackupDir`（仅 merge）：改动根 README 前把远端原文备份到本地，默认 `%TEMP%\classnotes-publish-backup`。

## 自测

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\publish\tests\publish-safety.tests.ps1
```

覆盖：正常相对路径、盘符、`/` 与 `\` 开头、`..` 越界、空段、反斜杠、仓库根被当发布目录、目录不存在、目录在仓库外、凭据文件名、目标分支为 `main`。

## 语法自检

```powershell
$errs = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path .\tools\publish\github-publish.ps1), [ref]$null, [ref]$errs)
$errs
```

## 变更记录

- 2026-10-28：按韶聪侧 Codex 评审（PR #2 评论）重写。旧版 `github-publish.ps1` 会创建无 parent 根提交并 `force=true` 更新 main，旧版两脚本用相对路径长度裁绝对路径（`./dist` 之类会把本机目录片段带进上传路径）。现版本改为「规范化路径 + dry-run 清单 + 新分支 + 草稿 PR」，并把脚本从纯 Owner 换址 PR 中拆出单独评审。
