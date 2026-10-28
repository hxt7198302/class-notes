# Offline tests for the publish helpers. No network, no uploads, no GitHub calls.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\publish\tests\publish-safety.tests.ps1
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot '..\lib\publish-common.ps1')

$script:fail = 0
$script:pass = 0

function Check-Throws {
    param([string]$Name, [scriptblock]$Block, [string]$Pattern)
    try {
        & $Block | Out-Null
        Write-Output "FAIL $Name (expected throw '$Pattern', nothing thrown)"
        $script:fail++
    } catch {
        if ($_.Exception.Message -match $Pattern) {
            Write-Output "PASS $Name"
            $script:pass++
        } else {
            Write-Output "FAIL $Name (expected '$Pattern', got '$($_.Exception.Message)')"
            $script:fail++
        }
    }
}

function Check-Equal {
    param([string]$Name, $Actual, $Expected)
    if ("$Actual" -eq "$Expected") {
        Write-Output "PASS $Name"
        $script:pass++
    } else {
        Write-Output "FAIL $Name (expected '$Expected', got '$Actual')"
        $script:fail++
    }
}

# --- Assert-SafeSubdir ---
Check-Equal 'plain subdir accepted' (Assert-SafeSubdir 'dist') 'dist'
Check-Equal 'nested subdir accepted' (Assert-SafeSubdir 'merged/v0.1') 'merged/v0.1'
Check-Equal 'empty subdir accepted' (Assert-SafeSubdir '') ''
Check-Throws 'drive letter subdir rejected' { Assert-SafeSubdir 'C:/windows/x' } 'SUBDIR_HAS_DRIVE'
Check-Throws 'dotdot subdir rejected' { Assert-SafeSubdir 'a/../../b' } 'SUBDIR_BAD_SEGMENT'
Check-Throws 'empty segment subdir rejected' { Assert-SafeSubdir 'a//b' } 'SUBDIR_BAD_SEGMENT'
Check-Throws 'git dir subdir rejected' { Assert-SafeSubdir '.git/hooks' } 'SUBDIR_GIT_DIR'

# --- Test-SensitiveName ---
Check-Equal 'dotenv blocked' (Test-SensitiveName '.env') $true
Check-Equal 'keystore blocked' (Test-SensitiveName 'demo.keystore') $true
Check-Equal 'pem blocked' (Test-SensitiveName 'server.pem') $true
Check-Equal 'dotenv template allowed' (Test-SensitiveName '.env.example') $false
Check-Equal 'readme allowed' (Test-SensitiveName 'README.md') $false

# --- Resolve-PublishRoot ---
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..')).TrimEnd('\', '/')
Check-Throws 'repo root itself rejected' { Resolve-PublishRoot -Root '.' -RepoRoot $repoRoot } 'ROOT_IS_REPO_ROOT'
Check-Throws 'missing relative root rejected' { Resolve-PublishRoot -Root './no-such-dir-xyz' -RepoRoot $repoRoot } 'ROOT_NOT_FOUND'
Check-Throws 'root outside repo rejected' { Resolve-PublishRoot -Root $env:TEMP -RepoRoot $repoRoot } 'ROOT_OUTSIDE_REPO'
Check-Equal 'in-repo absolute root accepted' ((Resolve-PublishRoot -Root (Join-Path $repoRoot 'tools') -RepoRoot $repoRoot) -eq (Join-Path $repoRoot 'tools')) $true

# --- manifest paths come from the built-in relative resolver ---
$tmp = Join-Path $env:TEMP ('publish-test-' + [guid]::NewGuid().ToString('N'))
try {
    $null = New-Item -ItemType Directory -Path (Join-Path $tmp 'sub') -Force
    [IO.File]::WriteAllText((Join-Path $tmp 'sub\a.txt'), 'x')
    [IO.File]::WriteAllText((Join-Path $tmp 'b.txt'), 'y')
    $man = @(Get-PublishManifest -RootFull $tmp)
    Check-Equal 'manifest file count' $man.Count 2
    $rels = ($man | ForEach-Object { $_.RelPath } | Sort-Object) -join ','
    Check-Equal 'manifest relative paths' $rels 'b.txt,sub/a.txt'
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# --- frozen blob read (same SHA, binary-safe) ---
$headSpec = 'HEAD:tools/publish/lib/publish-common.ps1'
$bytes = Get-GitBlobBytes -RepoRoot $repoRoot -Spec $headSpec
$expectedSize = [int](& git -C $repoRoot cat-file -s $headSpec)
Check-Equal 'blob read matches git object size' $bytes.Length $expectedSize

# --- offline counterexamples: junction as root / ancestor / subdirectory ---
$linkTmp = Join-Path $env:TEMP ('publish-link-' + [guid]::NewGuid().ToString('N'))
$fakeRepo = Join-Path $linkTmp 'repo'
$outsideRoot = Join-Path $linkTmp 'outside-root'
$outsideAnc = Join-Path $linkTmp 'outside-anc'
$outsideSub = Join-Path $linkTmp 'outside-sub'
$junctions = @()
try {
    $null = New-Item -ItemType Directory -Path (Join-Path $fakeRepo '.git') -Force
    $null = New-Item -ItemType Directory -Path $outsideRoot -Force
    [IO.File]::WriteAllText((Join-Path $outsideRoot 'leak.txt'), 'outside')
    $null = New-Item -ItemType Directory -Path (Join-Path $outsideAnc 'pkg') -Force
    [IO.File]::WriteAllText((Join-Path $outsideAnc 'pkg\leak.txt'), 'outside')
    $null = New-Item -ItemType Directory -Path $outsideSub -Force
    [IO.File]::WriteAllText((Join-Path $outsideSub 'leak.txt'), 'outside')

    # 1) -Root itself is a junction pointing outside the repo.
    $rootLink = Join-Path $fakeRepo 'root-link'
    $null = New-Item -ItemType Junction -Path $rootLink -Target $outsideRoot
    $junctions += $rootLink
    Check-Throws 'junction used as -Root rejected' { Resolve-PublishRoot -Root $rootLink -RepoRoot $fakeRepo } 'LINK_IN_ROOT_CHAIN'

    # 2) An ancestor of -Root is a junction pointing outside the repo.
    $ancLink = Join-Path $fakeRepo 'anc'
    $null = New-Item -ItemType Junction -Path $ancLink -Target $outsideAnc
    $junctions += $ancLink
    Check-Throws 'junction ancestor of -Root rejected' { Resolve-PublishRoot -Root (Join-Path $ancLink 'pkg') -RepoRoot $fakeRepo } 'LINK_IN_ROOT_CHAIN'

    # 3) A subdirectory inside -Root is a junction pointing outside the repo.
    $plainRoot = Join-Path $fakeRepo 'publish\pkg'
    $null = New-Item -ItemType Directory -Path $plainRoot -Force
    [IO.File]::WriteAllText((Join-Path $plainRoot 'ok.txt'), 'x')
    $subLink = Join-Path $plainRoot 'linked'
    $null = New-Item -ItemType Junction -Path $subLink -Target $outsideSub
    $junctions += $subLink
    Check-Throws 'junction subdirectory rejected' { Get-PublishManifest -RootFull $plainRoot } 'LINK_IN_TREE'

    # 4) Control: after the link is removed the same plain directory is accepted.
    $null = cmd /c "rmdir `"$subLink`""
    $junctions = @($junctions | Where-Object { $_ -ne $subLink })
    Check-Equal 'plain directory accepted after link removed' (@(Get-PublishManifest -RootFull $plainRoot).Count) 1
    Check-Equal 'resolved plain root accepted' ((Resolve-PublishRoot -Root $plainRoot -RepoRoot $fakeRepo) -eq $plainRoot) $true
} finally {
    foreach ($j in $junctions) { $null = cmd /c "rmdir `"$j`"" 2>$null }
    Remove-Item -LiteralPath $linkTmp -Recurse -Force -ErrorAction SilentlyContinue
}

# --- Assert-SafeBranchName ---
Assert-SafeBranchName -Branch 'publish/v0.1' -BaseBranch 'main'
Check-Equal 'normal branch accepted' 'ok' 'ok'
Check-Throws 'main rejected as target' { Assert-SafeBranchName -Branch 'main' -BaseBranch 'main' } 'BRANCH_FORBIDDEN'
Check-Throws 'base branch rejected as target' { Assert-SafeBranchName -Branch 'release' -BaseBranch 'release' } 'BRANCH_FORBIDDEN'
Check-Throws 'dotdot branch rejected' { Assert-SafeBranchName -Branch 'a..b' -BaseBranch 'main' } 'BRANCH_INVALID'
Check-Throws 'empty branch rejected' { Assert-SafeBranchName -Branch '' -BaseBranch 'main' } 'BRANCH_REQUIRED'

# --- tool check reports, never installs ---
if (-not (Get-GhPath)) {
    Check-Throws 'missing gh reported, not installed' { Assert-GhReady } 'GH_NOT_FOUND'
} else {
    Write-Output 'PASS gh present (auth checked only in -Apply runs)'
    $script:pass++
}

Write-Output "TESTS pass=$script:pass fail=$script:fail"
if ($script:fail -gt 0) { exit 1 }
exit 0
