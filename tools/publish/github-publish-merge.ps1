# Append a sanitized package under a subdirectory of the repository, optionally prepending a
# pointer to the root README. Same flow as github-publish.ps1: frozen base SHA, temporary
# worktree, new branch, draft PR. The base branch is never written to and no ref is forced.
#
# Default is a dry run: prints the manifest and the README pointer preview, no network.
# Add -Apply -Branch <name> to create the branch and open the PR.
param(
    [string]$Root = './merged-v0.1',
    [string]$Subdir = 'merged-v0.1',
    [string]$BaseBranch = 'main',
    [string]$Branch = '',
    [string]$CommitMessage = '追加合并版快照到子目录（公开脱敏）',
    [string]$PrTitle = '',
    [string]$PrBody = '',
    [string]$RepoRoot = '',
    [switch]$NoReadmePointer,
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
if (-not $prefix) { throw 'SUBDIR_REQUIRED: -Subdir must name the target directory' }
Write-Output "ROOT $rootFull"
Write-Output "TARGET_PREFIX $prefix"

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

$pointer = "> **合并版快照**：公开脱敏包在 [``$prefix/``]($prefix/)，说明见 [$prefix/README.md]($prefix/README.md)。`n`n"
if ($NoReadmePointer) {
    Write-Output 'README_POINTER_SKIPPED (-NoReadmePointer)'
} else {
    Write-Output 'README_POINTER_PREVIEW_BEGIN'
    Write-Output $pointer.TrimEnd()
    Write-Output 'README_POINTER_PREVIEW_END'
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
    throw "BRANCH_EXISTS: '$Branch' already exists; pick another name or delete it yourself"
}

$wt = Join-Path $env:TEMP ('publish-merge-' + [guid]::NewGuid().ToString('N'))
$null = Initialize-PublishWorktree -RepoRoot $repoFull -BaseSha $baseSha -Path $wt
try {
    $target = Join-Path $wt ($prefix -replace '/', '\')
    Copy-PublishItems -Items $items -TargetFull $target

    if (-not $NoReadmePointer) {
        # Read the README from the same frozen SHA, not from whatever the default branch has.
        $blob = Get-GitBlobBytes -RepoRoot $wt -Spec "$baseSha`:README.md"
        $readme = [Text.Encoding]::UTF8.GetString($blob)
        if ($readme -match '合并版快照') {
            Write-Output 'README_POINTER_ALREADY_THERE'
        } else {
            [IO.File]::WriteAllText((Join-Path $wt 'README.md'), ($pointer + $readme), (New-Object Text.UTF8Encoding($false)))
            Write-Output 'README_POINTER_ADDED'
        }
    }

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
    $push = Invoke-Git -RepoRoot $wt -GitArgs @('push', '-u', 'origin', $Branch)
    Write-Output $push.Text

    if (-not $PrTitle) { $PrTitle = $CommitMessage }
    if (-not $PrBody) {
        $PrBody = "由维护者发布脚本生成。`n`n- 文件数：$count`n- 子目录：$prefix`n- 基准：$BaseBranch@$baseSha`n- 不触碰 $BaseBranch，不开 Release。"
    }
    $null = Open-DraftPullRequest -Worktree $wt -BaseBranch $BaseBranch -Branch $Branch -Title $PrTitle -Body $PrBody
} finally {
    if (-not $KeepWorktree) { Remove-PublishWorktree -RepoRoot $repoFull -Path $wt }
    else { Write-Output "WORKTREE_KEPT $wt" }
}

Write-Output 'RESULT=OK'
