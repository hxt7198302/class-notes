# Publish a sanitized build folder to GitHub via the REST API (maintainer tool).
# github.com git-over-https is blocked on some networks; api.github.com still works.
# Credentials: uses the existing Windows Git Credential Manager entry for github.com.
# The token is never printed.
param(
    [string]$Root = './dist',
    [string]$Owner = 'shaocongzeming',
    [string]$Repo = 'class-notes',
    [string]$CommitMessage = '课堂助手 合并版 v0.1（公开脱敏快照）',
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$env:GCM_INTERACTIVE = 'never'

# --- 1. token from credential manager (never printed) ---
$tmp = Join-Path $env:TEMP ("gitcred-" + [guid]::NewGuid().ToString('N') + ".txt")
[IO.File]::WriteAllText($tmp, "protocol=https`nhost=github.com`n`n")
try {
    $cred = cmd /c "git -c credential.helper=manager credential fill < `"$tmp`"" 2>$null
} finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}
$pass = ($cred | Where-Object { $_ -like 'password=*' }) -replace '^password=', ''
if (-not $pass) { Write-Output 'RESULT=NO_CREDENTIAL'; exit 1 }

$H = @{
    Authorization          = "token $pass"
    Accept                 = 'application/vnd.github+json'
    'User-Agent'           = 'classnotes-publish'
    'X-GitHub-Api-Version' = '2022-11-28'
}

function Invoke-GH([string]$Method, [string]$Uri, $Body = $null) {
    $p = @{ Method = $Method; Uri = $Uri; Headers = $H; TimeoutSec = 60 }
    if ($null -ne $Body) {
        $json = $Body | ConvertTo-Json -Depth 12 -Compress
        $p.ContentType = 'application/json; charset=utf-8'
        $p.Body = [Text.Encoding]::UTF8.GetBytes($json)
    }
    return Invoke-RestMethod @p
}

# --- 2. who are we ---
try { $me = Invoke-GH 'GET' 'https://api.github.com/user' }
catch { Write-Output "RESULT=AUTH_FAIL $($_.Exception.Response.StatusCode.value__)"; exit 2 }
Write-Output "AUTH_OK login=$($me.login) owner=$Owner"

if ($CheckOnly) { Write-Output 'RESULT=CHECK_ONLY_OK'; exit 0 }

# --- 3. create repo if missing ---
$repoUri = "https://api.github.com/repos/$Owner/$Repo"
$exists = $true
try { $r = Invoke-GH 'GET' $repoUri } catch { $exists = $false }
if (-not $exists) {
    $body = @{
        name        = $Repo
        description = '课堂助手 · 课堂录音转写 + 板书对齐 + 待办抽取（合并版，ACC 2026 参赛作品）'
        private     = $false
        has_issues  = $true
        has_wiki    = $false
        auto_init   = $false
    }
    $r = Invoke-GH 'POST' 'https://api.github.com/user/repos' $body
    Write-Output "REPO_CREATED $($r.full_name) private=$($r.private)"
} else {
    Write-Output "REPO_EXISTS $($r.full_name) private=$($r.private) default=$($r.default_branch)"
}

# --- 4. blobs ---
$files = Get-ChildItem -Path $Root -Recurse -File | Sort-Object FullName
$entries = @()
$i = 0
foreach ($f in $files) {
    $i++
    $rel = $f.FullName.Substring($Root.TrimEnd('\').Length + 1).Replace('\', '/')
    $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($f.FullName))
    $blob = Invoke-GH 'POST' "https://api.github.com/repos/$Owner/$Repo/git/blobs" @{ content = $b64; encoding = 'base64' }
    $entries += @{ path = $rel; mode = '100644'; type = 'blob'; sha = $blob.sha }
    if ($i % 15 -eq 0) { Write-Output "BLOBS $i/$($files.Count)" }
}
Write-Output "BLOBS_DONE $($files.Count)"

# --- 5. tree + commit ---
$tree = Invoke-GH 'POST' "https://api.github.com/repos/$Owner/$Repo/git/trees" @{ tree = $entries }
$commit = Invoke-GH 'POST' "https://api.github.com/repos/$Owner/$Repo/git/commits" @{ message = $CommitMessage; tree = $tree.sha }
Write-Output "COMMIT $($commit.sha)"

# --- 6. point main at it (create or fast-forward) ---
try {
    Invoke-GH 'POST' "https://api.github.com/repos/$Owner/$Repo/git/refs" @{ ref = 'refs/heads/main'; sha = $commit.sha } | Out-Null
    Write-Output 'REF_CREATED refs/heads/main'
} catch {
    Invoke-GH 'PATCH' "https://api.github.com/repos/$Owner/$Repo/git/refs/heads/main" @{ sha = $commit.sha; force = $true } | Out-Null
    Write-Output 'REF_UPDATED refs/heads/main'
}

Write-Output "RESULT=OK https://github.com/$Owner/$Repo"
