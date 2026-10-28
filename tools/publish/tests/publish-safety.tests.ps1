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

# --- hidden entries: the link check and the manifest share one -Force enumeration ---
$hidTmp = Join-Path $env:TEMP ('publish-hidden-' + [guid]::NewGuid().ToString('N'))
$hidOutside = Join-Path $env:TEMP ('publish-hidden-outside-' + [guid]::NewGuid().ToString('N'))
$hidLink = Join-Path $hidTmp '.linkdir'
try {
    $null = New-Item -ItemType Directory -Path (Join-Path $hidTmp '.h'), $hidOutside -Force
    [IO.File]::WriteAllText((Join-Path $hidTmp 'a.txt'), 'x')
    [IO.File]::WriteAllText((Join-Path $hidTmp '.hidden.txt'), 'y')
    [IO.File]::WriteAllText((Join-Path $hidTmp '.h\f.txt'), 'z')
    (Get-Item -LiteralPath (Join-Path $hidTmp '.hidden.txt') -Force).Attributes = 'Hidden, Archive'

    $hidMan = @(Get-PublishManifest -RootFull $hidTmp)
    $hidFiles = @(Get-PublishFileSet -RootFull $hidTmp)
    Check-Equal 'hidden file counted in manifest' $hidMan.Count 3
    Check-Equal 'manifest and link-check see the same file set' $hidFiles.Count $hidMan.Count
    Check-Equal 'hidden file present in manifest paths' (@($hidMan | Where-Object { $_.RelPath -eq '.hidden.txt' }).Count) 1

    # Hidden directory holding a junction: -Force must not skip it.
    $null = New-Item -ItemType Junction -Path $hidLink -Target $hidOutside
    (Get-Item -LiteralPath $hidLink -Force).Attributes = [IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Hidden
    Check-Throws 'hidden junction directory rejected' { Get-PublishManifest -RootFull $hidTmp } 'LINK_IN_TREE'
    $null = cmd /c "rmdir `"$hidLink`""

    # Hidden file symlink: needs admin/Developer Mode on Windows, so build it when possible and
    # say so when not. The attribute rule is the same one exercised for files above.
    $hiddenFileLink = Join-Path $hidTmp '.link.txt'
    $madeHiddenLink = $false
    try {
        $null = New-Item -ItemType SymbolicLink -Path $hiddenFileLink -Target (Join-Path $hidTmp 'a.txt') -ErrorAction Stop
        $madeHiddenLink = $true
    } catch { }
    if ($madeHiddenLink) {
        Check-Throws 'hidden file symlink rejected' { Get-PublishManifest -RootFull $hidTmp } 'SYMLINK_IN_TREE'
    } else {
        Write-Output 'SKIP hidden file symlink counterexample (file symlink creation needs admin/Developer Mode; hidden file is still checked by the shared enumeration)'
    }
} finally {
    if (Test-Path -LiteralPath $hidLink) { $null = cmd /c "rmdir `"$hidLink`"" 2>$null }
    Remove-Item -LiteralPath $hidTmp, $hidOutside -Recurse -Force -ErrorAction SilentlyContinue
}

# --- target side of the copy: links already present in the frozen worktree ---
$tgtTmp = Join-Path $env:TEMP ('publish-target-' + [guid]::NewGuid().ToString('N'))
$tgtWt = Join-Path $tgtTmp 'wt'
$tgtSrc = Join-Path $tgtTmp 'src'
$tgtOutside = Join-Path $tgtTmp 'outside'
$targetLinks = @()
try {
    $null = New-Item -ItemType Directory -Path $tgtWt, $tgtSrc, $tgtOutside -Force
    [IO.File]::WriteAllText((Join-Path $tgtSrc 'a.txt'), 'payload')
    $tgtItems = @(Get-PublishManifest -RootFull $tgtSrc)

    # 1) The destination directory itself is a junction to outside the worktree.
    $dirLink = Join-Path $tgtWt 'pkg'
    $null = New-Item -ItemType Junction -Path $dirLink -Target $tgtOutside
    $targetLinks += $dirLink
    Check-Throws 'target directory junction rejected' {
        Copy-PublishItems -Items $tgtItems -TargetFull $dirLink -TargetRoot $tgtWt
    } 'LINK_IN_TARGET_CHAIN'
    Check-Equal 'nothing written outside after target-dir rejection' (Test-Path -LiteralPath (Join-Path $tgtOutside 'a.txt')) $false

    # 2) An ancestor of the destination is a junction to outside.
    Check-Throws 'target ancestor junction rejected' {
        Copy-PublishItems -Items $tgtItems -TargetFull (Join-Path $dirLink 'deep') -TargetRoot $tgtWt
    } 'LINK_IN_TARGET_CHAIN'
    Check-Equal 'nothing written outside after ancestor rejection' (Test-Path -LiteralPath (Join-Path $tgtOutside 'deep\a.txt')) $false
    $null = cmd /c "rmdir `"$dirLink`""
    $targetLinks = @($targetLinks | Where-Object { $_ -ne $dirLink })

    # 3) The destination file path is itself a link (git mode 120000 entry in the base).
    $fileLink = Join-Path $tgtWt 'a.txt'
    $null = New-Item -ItemType Junction -Path $fileLink -Target $tgtOutside
    $targetLinks += $fileLink
    Check-Throws 'target file-path link rejected' {
        Copy-PublishItems -Items $tgtItems -TargetFull $tgtWt -TargetRoot $tgtWt
    } 'LINK_IN_TARGET_CHAIN'

    # 4) The root README written by the merge script is a link in the base.
    $readmeLink = Join-Path $tgtWt 'README.md'
    $null = New-Item -ItemType Junction -Path $readmeLink -Target $tgtOutside
    $targetLinks += $readmeLink
    Check-Throws 'target README link rejected' {
        Assert-NoLinksUnderRoot -Path $readmeLink -RootFull $tgtWt
    } 'LINK_IN_TARGET_CHAIN'
    Check-Equal 'outside README untouched' (Test-Path -LiteralPath (Join-Path $tgtOutside 'README.md')) $false
    $null = cmd /c "rmdir `"$fileLink`""
    $null = cmd /c "rmdir `"$readmeLink`""
    $targetLinks = @()

    # 5) Control: a plain worktree still accepts the copy, including new nested directories.
    Copy-PublishItems -Items $tgtItems -TargetFull (Join-Path $tgtWt 'plain\deeper') -TargetRoot $tgtWt
    Check-Equal 'plain target copied' ([IO.File]::ReadAllText((Join-Path $tgtWt 'plain\deeper\a.txt'))) 'payload'
    Check-Throws 'target outside worktree root rejected' {
        Copy-PublishItems -Items $tgtItems -TargetFull $tgtOutside -TargetRoot $tgtWt
    } 'TARGET_OUTSIDE_WORKTREE'
} finally {
    foreach ($j in $targetLinks) { if (Test-Path -LiteralPath $j) { $null = cmd /c "rmdir `"$j`"" 2>$null } }
    Remove-Item -LiteralPath $tgtTmp -Recurse -Force -ErrorAction SilentlyContinue
}

# --- blob read from a repository whose path contains spaces ---
$spaceRepo = Join-Path $env:TEMP ('publish repo with space ' + [guid]::NewGuid().ToString('N'))
try {
    $null = New-Item -ItemType Directory -Path $spaceRepo -Force
    $null = Invoke-Git -RepoRoot $spaceRepo -GitArgs @('init', '-q')
    [IO.File]::WriteAllText((Join-Path $spaceRepo 'r.txt'), 'hello')
    $null = Invoke-Git -RepoRoot $spaceRepo -GitArgs @('add', 'r.txt')
    $null = Invoke-Git -RepoRoot $spaceRepo -GitArgs @('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 't')
    $spaceBytes = Get-GitBlobBytes -RepoRoot $spaceRepo -Spec 'HEAD:r.txt'
    Check-Equal 'blob read from path with spaces' ([Text.Encoding]::UTF8.GetString($spaceBytes).Trim()) 'hello'
} finally {
    Remove-Item -LiteralPath $spaceRepo -Recurse -Force -ErrorAction SilentlyContinue
}

# --- create-only push: concurrent branch creation is rejected, remote SHA unchanged ---
$pushTmp = Join-Path $env:TEMP ('publish-push-' + [guid]::NewGuid().ToString('N'))
try {
    $bare = Join-Path $pushTmp 'origin.git'
    $cloneA = Join-Path $pushTmp 'a'
    $cloneB = Join-Path $pushTmp 'b'
    $null = New-Item -ItemType Directory -Path $pushTmp -Force
    $null = Invoke-Git -RepoRoot $pushTmp -GitArgs @('init', '--bare', '-q', $bare)
    $null = Invoke-Git -RepoRoot $pushTmp -GitArgs @('init', '-q', $cloneA)
    $null = Invoke-Git -RepoRoot $cloneA -GitArgs @('remote', 'add', 'origin', $bare)
    $null = Invoke-Git -RepoRoot $cloneA -GitArgs @('-c', 'user.name=t', '-c', 'user.email=t@t', 'switch', '-q', '-c', 'feat')
    [IO.File]::WriteAllText((Join-Path $cloneA 'a.txt'), 'a')
    $null = Invoke-Git -RepoRoot $cloneA -GitArgs @('add', 'a.txt')
    $null = Invoke-Git -RepoRoot $cloneA -GitArgs @('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a')
    $null = Push-NewBranch -RepoRoot $cloneA -Branch 'feat'
    $shaAfterCreate = (Invoke-Git -RepoRoot $bare -GitArgs @('rev-parse', 'refs/heads/feat')).Text.Trim()
    Check-Equal 'create-only push succeeded on absent branch' $shaAfterCreate ($(Invoke-Git -RepoRoot $cloneA -GitArgs @('rev-parse', 'HEAD')).Text.Trim())

    $null = Invoke-Git -RepoRoot $pushTmp -GitArgs @('init', '-q', $cloneB)
    $null = Invoke-Git -RepoRoot $cloneB -GitArgs @('remote', 'add', 'origin', $bare)
    $null = Invoke-Git -RepoRoot $cloneB -GitArgs @('fetch', '-q', 'origin')
    $null = Invoke-Git -RepoRoot $cloneB -GitArgs @('-c', 'user.name=t', '-c', 'user.email=t@t', 'switch', '-q', '-c', 'feat', 'origin/feat')
    [IO.File]::WriteAllText((Join-Path $cloneB 'b.txt'), 'b')
    $null = Invoke-Git -RepoRoot $cloneB -GitArgs @('add', 'b.txt')
    $null = Invoke-Git -RepoRoot $cloneB -GitArgs @('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'b')
    Check-Throws 'concurrent branch creation rejected' { Push-NewBranch -RepoRoot $cloneB -Branch 'feat' } 'BRANCH_CREATED_CONCURRENTLY'
    $shaAfterReject = (Invoke-Git -RepoRoot $bare -GitArgs @('rev-parse', 'refs/heads/feat')).Text.Trim()
    Check-Equal 'remote SHA unchanged after rejection' $shaAfterReject $shaAfterCreate
} finally {
    Remove-Item -LiteralPath $pushTmp -Recurse -Force -ErrorAction SilentlyContinue
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
