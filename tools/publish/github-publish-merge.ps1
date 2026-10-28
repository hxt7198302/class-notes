# Add a sanitized package under a subdirectory without touching existing repo content.
# Optionally prepend a short pointer to the root README (original backed up locally first).
# Maintainer tool: needs write access to the target repository. Not used by CI.
param(
    [string]$Root = './merged-v0.1',
    [string]$Owner = 'shaocongzeming',
    [string]$Repo = 'class-notes',
    [string]$Subdir = 'merged-v0.1',
    [string]$CommitMessage = '合并版 v0.1：Web UI + 云端后端 + 电脑端能力 + 安卓 WebView 壳（公开脱敏快照）',
    [string]$BackupDir = './备份'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$env:GCM_INTERACTIVE = 'never'

$tmp = Join-Path $env:TEMP ("gitcred-" + [guid]::NewGuid().ToString('N') + ".txt")
[IO.File]::WriteAllText($tmp, "protocol=https`nhost=github.com`n`n")
try { $cred = cmd /c "git -c credential.helper=manager credential fill < `"$tmp`"" 2>$null }
finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
$pass = ($cred | Where-Object { $_ -like 'password=*' }) -replace '^password=', ''
if (-not $pass) { Write-Output 'RESULT=NO_CREDENTIAL'; exit 1 }
$H = @{ Authorization = "token $pass"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'classnotes-publish'; 'X-GitHub-Api-Version' = '2022-11-28' }

function Invoke-GH([string]$Method, [string]$Uri, $Body = $null) {
    $p = @{ Method = $Method; Uri = $Uri; Headers = $H; TimeoutSec = 90 }
    if ($null -ne $Body) {
        $p.ContentType = 'application/json; charset=utf-8'
        $p.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 12 -Compress))
    }
    return Invoke-RestMethod @p
}

$base = "https://api.github.com/repos/$Owner/$Repo"

# --- current tip ---
$ref = Invoke-GH 'GET' "$base/git/ref/heads/main"
$headSha = $ref.object.sha
$headCommit = Invoke-GH 'GET' "$base/git/commits/$headSha"
$baseTree = $headCommit.tree.sha
Write-Output "HEAD $headSha tree=$baseTree"

# --- backup current README locally ---
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$readmeResp = Invoke-GH 'GET' "$base/contents/README.md"
$readmeText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($readmeResp.content))
if (-not (Test-Path $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir | Out-Null }
$backupPath = Join-Path $BackupDir ("class-notes-README.备份$stamp.md")
[IO.File]::WriteAllText($backupPath, $readmeText, (New-Object Text.UTF8Encoding($false)))
Write-Output "README_BACKUP $backupPath"

# --- blobs for the merged package ---
$files = Get-ChildItem -Path $Root -Recurse -File | Sort-Object FullName
$entries = @()
$i = 0
foreach ($f in $files) {
    $i++
    $rel = $f.FullName.Substring($Root.TrimEnd('\').Length + 1).Replace('\', '/')
    $sha = (Invoke-GH 'POST' "$base/git/blobs" @{ content = [Convert]::ToBase64String([IO.File]::ReadAllBytes($f.FullName)); encoding = 'base64' }).sha
    $entries += @{ path = "$Subdir/$rel"; mode = '100644'; type = 'blob'; sha = $sha }
    if ($i % 20 -eq 0) { Write-Output "BLOBS $i/$($files.Count)" }
}
Write-Output "BLOBS_DONE $($files.Count)"

# --- README pointer (only if not already there) ---
$pointer = "> 📦 **合并版 v0.1（2026-10-24）**：与 Web 版合并后的公开脱敏快照在 [``merged-v0.1/``](merged-v0.1/)，含统一 Web UI、云端后端、电脑端能力模块与安卓 WebView 壳。说明见 [merged-v0.1/README.md](merged-v0.1/README.md)。`n`n"
if ($readmeText -notmatch '合并版 v0\.1') {
    $newReadme = $pointer + $readmeText
    $readmeSha = (Invoke-GH 'POST' "$base/git/blobs" @{ content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($newReadme)); encoding = 'base64' }).sha
    $entries += @{ path = 'README.md'; mode = '100644'; type = 'blob'; sha = $readmeSha }
    Write-Output 'README_POINTER_ADDED'
} else {
    Write-Output 'README_POINTER_ALREADY_THERE'
}

# --- tree (base_tree keeps every existing file) + commit + ref ---
$tree = Invoke-GH 'POST' "$base/git/trees" @{ base_tree = $baseTree; tree = $entries }
$commit = Invoke-GH 'POST' "$base/git/commits" @{ message = $CommitMessage; tree = $tree.sha; parents = @($headSha) }
Invoke-GH 'PATCH' "$base/git/refs/heads/main" @{ sha = $commit.sha } | Out-Null
Write-Output "COMMIT $($commit.sha)"
Write-Output "RESULT=OK https://github.com/$Owner/$Repo/tree/main/$Subdir"
