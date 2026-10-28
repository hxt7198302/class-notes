# 发布入口（维护者工具）

> 本文由 AI 整理。

把已脱敏的目录推到**新分支 + 草稿 PR**，安装包走**草稿 Release**。全程使用现成的 `git` 与 GitHub CLI（`gh`），不自建 GitHub 对象/API 发布层。

| 文件 | 用途 |
|---|---|
| `github-publish.ps1` | 把目录整包发布到仓库（可指定子目录） |
| `github-publish-merge.ps1` | 把目录追加到子目录，可选在根 README 加一段指针 |
| `release-draft.ps1` | 为 APK/ZIP 创建**草稿** Release |
| `lib/publish-common.ps1` | 路径/链接/凭据前置检查、冻结基准、临时 worktree、git/gh 调用 |
| `tests/publish-safety.tests.ps1` | 离线自测（不联网） |

## 用法

```powershell
# 1) dry-run：只打印清单与目标前缀，不联网、不写文件
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\publish\github-publish.ps1 `
    -Root .\dist -Subdir dist -Branch publish/example -Sha256

# 2) 执行：冻结基准 → 临时 worktree 提交 → 推新分支 → 开草稿 PR
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\publish\github-publish.ps1 `
    -Root .\dist -Subdir dist -Branch publish/example -Apply

# 3) 安装包：创建草稿 Release（不会正式发布）
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\publish\release-draft.ps1 `
    -Tag v1.2.3 -Assets .\dist\app.apk -Title 'v1.2.3' -NotesFile .\dist\NOTES.md -Apply
```

## 参数

- `-Root`：本地已脱敏目录；相对路径按仓库根解析；必须在仓库内，且不能是仓库根。
- `-Subdir`：仓库内目标子目录；留空表示按 `-Root` 内的结构直接放在仓库根下。
- `-BaseBranch`：默认 `main`，只从这里取基准 SHA，不向它写。
- `-Branch`：`-Apply` 时必填，例如 `publish/merged-v0.1`。
- `-Sha256`：dry-run 清单附带每个文件的 SHA-256。
- `-AllowSensitive`：确认误报后放行凭据类文件名。
- `-KeepWorktree`：保留临时 worktree 便于排查；默认自动清理。
- `-RepoRoot`：脚本不在 `tools\publish` 下时显式指定仓库根。

## 回滚

- 关闭 PR 并删远端分支：`gh pr close <编号> --delete-branch`
- 只删远端分支：`git push origin --delete <分支名>`
- 删草稿 Release：`gh release delete <tag> --yes`
- 本地残留 worktree：`git worktree remove --force <路径>`（`git worktree list` 可查）

## 验证

```powershell
# 离线自测
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\publish\tests\publish-safety.tests.ps1

# 执行后核对
git ls-remote --heads origin <分支名>
gh pr view <编号> --json isDraft,state,headRefOid,baseRefName
```

自测覆盖：子目录参数、凭据文件名、发布目录范围、清单相对路径、冻结 blob 读取、`-Root` 为 junction、祖先为 junction、树内子目录为 junction（临时 junction 构造，离线），以及 `gh` 缺失时的报错路径。

## 安全约束

1. **不写基准分支。** 只推新分支、开草稿 PR；目标分支已存在直接报错，不覆盖。
2. **基准只冻结一次。** 每次 `-Apply` 先取一次远端基准 SHA，worktree、README 读取、提交父节点都用这枚 SHA；运行中基准前移不混用。
3. **不强制更新引用。** 无 force 参数，不 PATCH 任何分支。
4. **链接与路径前置拒绝。** `-Root` 本身、到仓库根的每级祖先、树内每个目录/文件，凡带 ReparsePoint 一律拒绝；`-Subdir` 拒绝盘符、`..`、`.`、空段与 `.git`。
5. **凭据文件拦截。** `.env*`、`*.pem/*.pfx/*.p12/*.keystore/*.jks/*.key/*.ppk`、`id_rsa*`、`.netrc`、`.npmrc`、`credentials.json` 默认拦下。
6. **默认 dry-run、默认草稿。** 不加 `-Apply` 不联网；PR 与 Release 都先建草稿。
7. **缺工具只报错。** 未安装 `gh` 时报 `GH_NOT_FOUND`，不自动安装或升级系统依赖。
8. **许可与署名保留。** 目录整包原样复制，`LICENSE`、`NOTICE`、署名文件不筛选、不改写；请确认待发布内容本身允许公开。
