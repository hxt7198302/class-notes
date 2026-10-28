# Publish a sanitized build folder to GitHub as a NEW BRANCH + draft PR.
#
# Why not push to main: GitHub API "publish" used to create a parentless commit and then
# force-update refs/heads/main, which resets history and the source tree (or gets rejected
# by branch protection). This version only ever creates a new ref and opens a PR; there is
# no force flag and no write to the base branch.
#
# Default is a dry run: it prints the exact upload manifest and touches no network.
# Add -Apply -Branch <name> to actually create the branch and PR.
#
# Installer binaries belong in a GitHub Release (gh release upload), not here.
param(
    [string]$Root = './dist',
    [string]$Owner = 'shaocongzeming',
    [string]$Repo = 'class-notes',
    [string]$BaseBranch = 'main',
    [string]$Branch = '',
    [string]$Subdir = '',
    [string]$CommitMessage = '发布快照：课堂助手构建产物（公开脱敏）',
    [string]$PrTitle = '',
    [string]$PrBody = '',
    [string]$RepoRoot = '',
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

if (-not $Apply) {
    Write-Output "RESULT=DRY_RUN_OK files=$count (no network, no writes)"
    Write-Output "NEXT add -Apply -Branch publish/<name> to create a draft PR from '$BaseBranch'"
    exit 0
}

Assert-SafeBranchName -Branch $Branch -BaseBranch $BaseBranch

if (-not $PrBody) {
    $PrBody = "由维护者发布脚本生成（dry-run 清单见脚本输出）；请评审后合并。`n`n- 新增/覆盖路径：$count 个文件`n- 范围：$Subdir`n- 不触碰 main，不开 Release。"
}
if (-not $PrTitle) { $PrTitle = $CommitMessage }

Invoke-Publish -Owner $Owner -Repo $Repo -BaseBranch $BaseBranch -Branch $Branch `
    -Items $items -CommitMessage $CommitMessage -PrTitle $PrTitle -PrBody $PrBody -Draft | Out-Null

Write-Output 'RESULT=OK'
