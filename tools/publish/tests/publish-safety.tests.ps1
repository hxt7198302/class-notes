# Safety tests for the publish helpers. No network, no uploads.
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

# --- Assert-SafeRelPath ---
Assert-SafeRelPath 'a/b.txt'
Check-Equal 'safe rel accepted' 'ok' 'ok'

Check-Throws 'drive letter rejected' { Assert-SafeRelPath 'C:/windows/x' } 'REL_HAS_DRIVE'
Check-Throws 'unix absolute rejected' { Assert-SafeRelPath '/etc/passwd' } 'REL_ABSOLUTE'
Check-Throws 'leading backslash rejected' { Assert-SafeRelPath '\windows\x' } 'REL_ABSOLUTE'
Check-Throws 'dotdot rejected' { Assert-SafeRelPath 'a/../../b' } 'REL_BAD_SEGMENT'
Check-Throws 'empty segment rejected' { Assert-SafeRelPath 'a//b' } 'REL_BAD_SEGMENT'
Check-Throws 'backslash rejected' { Assert-SafeRelPath 'a\b' } 'REL_BACKSLASH'
Check-Throws 'empty string rejected' { Assert-SafeRelPath '' } 'REL_EMPTY'

# --- Get-RelPath ---
$tmp = Join-Path $env:TEMP ('publish-test-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path (Join-Path $tmp 'sub') -Force
[IO.File]::WriteAllText((Join-Path $tmp 'sub\a.txt'), 'x')
try {
    $rel = Get-RelPath -BaseFull $tmp -FileFull (Join-Path $tmp 'sub\a.txt')
    Check-Equal 'relative path derived from absolute file' $rel 'sub/a.txt'

    $sibling = Join-Path (Split-Path -Parent $tmp) 'outside.txt'
    [IO.File]::WriteAllText($sibling, 'x')
    try {
        Check-Throws 'file outside root rejected' { Get-RelPath -BaseFull $tmp -FileFull $sibling } 'PATH_OUTSIDE_ROOT'
    } finally {
        Remove-Item -LiteralPath $sibling -Force -ErrorAction SilentlyContinue
    }
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# --- Resolve-PublishRoot ---
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..')).TrimEnd('\', '/')
Check-Throws 'repo root itself rejected' { Resolve-PublishRoot -Root '.' -RepoRoot $repoRoot } 'ROOT_IS_REPO_ROOT'
Check-Throws 'missing relative root rejected' { Resolve-PublishRoot -Root './no-such-dir-xyz' -RepoRoot $repoRoot } 'ROOT_NOT_FOUND'
Check-Throws 'root outside repo rejected' { Resolve-PublishRoot -Root $env:TEMP -RepoRoot $repoRoot } 'ROOT_OUTSIDE_REPO'
Check-Equal 'in-repo absolute root accepted' ((Resolve-PublishRoot -Root (Join-Path $repoRoot 'tools') -RepoRoot $repoRoot) -eq (Join-Path $repoRoot 'tools')) $true

# --- Test-SensitiveName ---
Check-Equal 'dotenv blocked' (Test-SensitiveName '.env') $true
Check-Equal 'keystore blocked' (Test-SensitiveName 'demo.keystore') $true
Check-Equal 'pem blocked' (Test-SensitiveName 'server.pem') $true
Check-Equal 'dotenv template allowed' (Test-SensitiveName '.env.example') $false
Check-Equal 'readme allowed' (Test-SensitiveName 'README.md') $false

# --- Assert-SafeBranchName ---
Assert-SafeBranchName -Branch 'publish/v0.1' -BaseBranch 'main'
Check-Equal 'normal branch accepted' 'ok' 'ok'
Check-Throws 'main rejected as target' { Assert-SafeBranchName -Branch 'main' -BaseBranch 'main' } 'BRANCH_FORBIDDEN'
Check-Throws 'dotdot branch rejected' { Assert-SafeBranchName -Branch 'a..b' -BaseBranch 'main' } 'BRANCH_INVALID'
Check-Throws 'empty branch rejected' { Assert-SafeBranchName -Branch '' -BaseBranch 'main' } 'BRANCH_REQUIRED'

Write-Output "TESTS pass=$script:pass fail=$script:fail"
if ($script:fail -gt 0) { exit 1 }
exit 0
