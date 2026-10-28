# Append a sanitized package under a subdirectory of an existing repository, optionally
# prepending a pointer to the root README. Same safety model as github-publish.ps1:
# a NEW BRANCH + draft PR, base_tree preserved, never a write to the base branch,
# never a force update.
#
# Default is a dry run: prints the manifest and the README pointer preview, no network.
# Add -Apply -Branch <name> to actually create the branch and PR.
param(
    [string]$Root = './merged-v0.1',
    [string]$Subdir = 'merged-v0.1',
    [string]$Owner = 'shaocongzeming',
    [string]$Repo = 'class-notes',
    [string]$BaseBranch = 'main',
    [string]$Branch = '',
    [string]$CommitMessage = '追加合并版快照到子目录（公开脱敏）',
    [string]$PrTitle = '',
    [string]$PrBody = '',
    [string]$RepoRoot = '',
    [string]$BackupDir = '',
    [switch]$NoReadmePointer,
    [switch]$Sha256,
    [switch]$AllowSensitive,
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$env:GCM_INTERACTIVE = 'never'

. (Join-Path $PSScriptRoot 'lib\publish-common.ps1')

$repoFull = Get-PublishRepoRoot -RepoRoot $RepoRoot -ScriptRoot $PSScriptRoot
$rootFull = Resolve-PublishRoot -Root $Root -RepoRoot $repoFull
Write-Output "ROOT $rootFull"

$items = Get-PublishManifest -RootFull $rootFull -Subdir $Subdir
$count = @($items).Count
if ($count -eq 0) { throw "ROOT_EMPTY_DIR: no files under '$rootFull'" }
Write-PublishManifest -Items $items -WithHash:$Sha256

$sensitive = @($items | Where-Object { Test-SensitiveName -Name (Split-Path -Leaf $_.FullName) })
if ($sensitive.Count -gt 0) {
    foreach ($s in $sensitive) { Write-Output "SENSITIVE_BLOCKED $($s.TargetPath)" }
    if (-not $AllowSensitive) {
        throw 'SENSITIVE_FILES: credential-like files found; review the list, then rerun with -AllowSensitive if they are really meant to be public'
    }
    Write-Output 'SENSITIVE_OVERRIDE -AllowSensitive given'
}

$pointer = "> 📦 **合并版 v0.1（2026-10-24）**：与 Web 版合并后的公开脱敏快照在 [``$Subdir/``]($Subdir/)，含统一 Web UI、云端后端、电脑端能力模块与安卓 WebView 壳。说明见 [$Subdir/README.md]($Subdir/README.md)。`n`n"
if ($NoReadmePointer) {
    Write-Output 'README_POINTER_SKIPPED (-NoReadmePointer)'
} else {
    Write-Output 'README_POINTER_PREVIEW_BEGIN'
    Write-Output $pointer.TrimEnd()
    Write-Output 'README_POINTER_PREVIEW_END'
}

if (-not $Apply) {
    Write-Output "RESULT=DRY_RUN_OK files=$count (no network, no writes)"
    Write-Output "NEXT add -Apply -Branch publish/<name> to create a draft PR from '$BaseBranch'"
    exit 0
}

Assert-SafeBranchName -Branch $Branch -BaseBranch $BaseBranch

# Freeze the base once: the README read, base_tree and parents must all use this same SHA.
$baseInfo = Get-PublishBase -Owner $Owner -Repo $Repo -BaseBranch $BaseBranch
Write-Output "BASE_FROZEN $BaseBranch $($baseInfo.Sha) tree=$($baseInfo.TreeSha)"

$textEntries = @()
if (-not $NoReadmePointer) {
    $remoteReadme = Get-GitHubFileText -Owner $Owner -Repo $Repo -Path 'README.md' -Ref $baseInfo.Sha
    if ($remoteReadme -match '合并版 v0\.1') {
        Write-Output 'README_POINTER_ALREADY_THERE'
    } else {
        # Keep a local copy of the current remote README before the PR proposes a change.
        if (-not $BackupDir) {
            $backupRoot = Join-Path $env:TEMP 'classnotes-publish-backup'
        } else {
            $backupRoot = if ([IO.Path]::IsPathRooted($BackupDir)) { $BackupDir } else { Join-Path $repoFull $BackupDir }
        }
        if (-not (Test-Path -LiteralPath $backupRoot)) { $null = New-Item -ItemType Directory -Path $backupRoot }
        $backupPath = Join-Path $backupRoot ("class-notes-README.备份" + (Get-Date -Format 'yyyyMMdd-HHmm') + ".md")
        [IO.File]::WriteAllText($backupPath, $remoteReadme, (New-Object Text.UTF8Encoding($false)))
        Write-Output "README_BACKUP $backupPath"
        $textEntries += @{ path = 'README.md'; text = $pointer + $remoteReadme }
        Write-Output 'README_POINTER_ADDED'
    }
}

if (-not $PrBody) {
    $PrBody = "由维护者发布脚本生成（dry-run 清单见脚本输出）；请评审后合并。`n`n- 新增/覆盖路径：$count 个文件`n- 子目录：$Subdir`n- 不触碰 main，不开 Release。"
}
if (-not $PrTitle) { $PrTitle = $CommitMessage }

Invoke-Publish -Owner $Owner -Repo $Repo -BaseBranch $BaseBranch -BaseSha $baseInfo.Sha -Branch $Branch `
    -Items $items -TextEntries $textEntries -CommitMessage $CommitMessage `
    -PrTitle $PrTitle -PrBody $PrBody -Draft | Out-Null

Write-Output 'RESULT=OK'
