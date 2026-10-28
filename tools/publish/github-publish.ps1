# Publish a sanitized build folder as a NEW BRANCH + draft PR.
#
# Standard git flow: freeze the base SHA, stage the folder in a temporary worktree, commit,
# push a new branch, then open a draft PR with the GitHub CLI. The base branch is never
# written to and no existing ref is overwritten.
#
# Default is a dry run: prints the manifest and the plan, touches no network.
# Add -Apply -Branch <name> to create the branch and open the PR.
#
# Installer binaries belong in a GitHub Release: use release-draft.ps1.
param(
    [string]$Root = './dist',
    [string]$Subdir = '',
    [string]$BaseBranch = 'main',
    [string]$Branch = '',
    [string]$CommitMessage = '发布快照（公开脱敏）',
    [string]$PrTitle = '',
    [string]$PrBody = '',
    [string]$RepoRoot = '',
    [switch]$Sha256,
    [switch]$AllowSensitive,
    [switch]$Apply,
    [switch]$KeepWorktree
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$env:GCM_INTERACTIVE = 'never'
$env:GIT_TERMINAL_PROMPT = '0'

. (Join-Path $PSScriptRoot 'lib\publish-common.ps1')

$repoFull = Get-PublishRepoRoot -RepoRoot $RepoRoot -ScriptRoot $PSScriptRoot
$rootFull = Resolve-PublishRoot -Root $Root -RepoRoot $repoFull
$prefix = Assert-SafeSubdir $Subdir
Write-Output "ROOT $rootFull"
if ($prefix) { Write-Output "TARGET_PREFIX $prefix" }

$items = Get-PublishManifest -RootFull $rootFull
$count = @($items).Count
if ($count -eq 0) { throw "ROOT_EMPTY_DIR: no files under '$rootFull'" }
Write-PublishManifest -Items $items -WithHash:$Sha256 -Prefix $prefix

$sensitive = @($items | Where-Object { Test-SensitiveName -Name (Split-Path -Leaf $_.FullName) })
if ($sensitive.Count -gt 0) {
    foreach ($s in $sensitive) { Write-Output "SENSITIVE_BLOCKED $($s.RelPath)" }
    if (-not $AllowSensitive) {
        throw 'SENSITIVE_FILES: credential-like files found; review the list, then rerun with -AllowSensitive if they are really meant to be public'
    }
    Write-Output 'SENSITIVE_OVERRIDE -AllowSensitive given'
}

if (-not $Apply) {
    Write-Output "RESULT=DRY_RUN_OK files=$count (no network, no writes)"
    Write-Output "NEXT add -Apply -Branch publish/<name> to push a branch and open a draft PR from '$BaseBranch'"
    exit 0
}

Assert-SafeBranchName -Branch $Branch -BaseBranch $BaseBranch
Assert-GhReady

$baseSha = Get-RemoteBranchSha -RepoRoot $repoFull -Branch $BaseBranch
Write-Output "BASE_FROZEN $BaseBranch $baseSha"
Confirm-BaseCommitLocal -RepoRoot $repoFull -BaseSha $baseSha -BaseBranch $BaseBranch
if (Test-RemoteBranchExists -RepoRoot $repoFull -Branch $Branch) {
    # Early, friendly error only. The atomic guard is the empty-expect lease in Push-NewBranch.
    throw "BRANCH_EXISTS: '$Branch' already exists; pick another name or delete it yourself"
}

$wt = Join-Path $env:TEMP ('publish-' + [guid]::NewGuid().ToString('N'))
$null = Initialize-PublishWorktree -RepoRoot $repoFull -BaseSha $baseSha -Path $wt
try {
    $target = if ($prefix) { Join-Path $wt ($prefix -replace '/', '\') } else { $wt }
    Copy-PublishItems -Items $items -TargetFull $target -TargetRoot $wt

    $null = Invoke-Git -RepoRoot $wt -GitArgs @('switch', '-c', $Branch)
    $null = Invoke-Git -RepoRoot $wt -GitArgs @('add', '-A')
    $staged = Invoke-Git -RepoRoot $wt -GitArgs @('diff', '--cached', '--name-only')
    $changed = @($staged.Lines | Where-Object { $_ })
    if ($changed.Count -eq 0) { throw 'NOTHING_TO_COMMIT: staged tree already matches the base for these files' }
    Write-Output 'STAGED'
    foreach ($line in $changed) { Write-Output "FILE $line" }
    $stat = Invoke-Git -RepoRoot $wt -GitArgs @('diff', '--cached', '--stat')
    Write-Output $stat.Text

    $null = Invoke-Git -RepoRoot $wt -GitArgs @('commit', '-m', $CommitMessage)
    $push = Push-NewBranch -RepoRoot $wt -Branch $Branch
    Write-Output $push.Text

    if (-not $PrTitle) { $PrTitle = $CommitMessage }
    if (-not $PrBody) {
        $PrBody = "由维护者发布脚本生成。`n`n- 文件数：$count`n- 基准：$BaseBranch@$baseSha`n- 不触碰 $BaseBranch，不开 Release。"
    }
    $null = Open-DraftPullRequest -Worktree $wt -BaseBranch $BaseBranch -Branch $Branch -Title $PrTitle -Body $PrBody
} finally {
    if (-not $KeepWorktree) { Remove-PublishWorktree -RepoRoot $repoFull -Path $wt }
    else { Write-Output "WORKTREE_KEPT $wt" }
}

Write-Output 'RESULT=OK'
