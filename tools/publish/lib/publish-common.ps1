# Shared helpers for the maintainer publish scripts.
#
# Design rule: fail closed.
#   * Every path that is uploaded must be a plain relative path inside -Root:
#     no drive letters, no leading separators, no "..", no backslashes.
#   * These helpers never write to a base branch and never force-update a ref.
#   * Nothing here needs network access, so dry-run stays offline.

function Get-PublishRepoRoot {
    param(
        [string]$RepoRoot,
        [Parameter(Mandatory)][string]$ScriptRoot
    )
    if ($RepoRoot) {
        $root = [IO.Path]::GetFullPath($RepoRoot)
    } else {
        $root = [IO.Path]::GetFullPath((Join-Path $ScriptRoot '..\..'))
    }
    $root = $root.TrimEnd('\', '/')
    if (-not (Test-Path -LiteralPath (Join-Path $root '.git'))) {
        throw "REPO_ROOT_INVALID: no .git directory under '$root' (pass -RepoRoot explicitly)"
    }
    return $root
}

function Assert-NoLinkChain {
    # GetFullPath does not resolve junctions/symlinks, so a reparse point anywhere between
    # -Path and the repository root can quietly redirect a "repo-internal" path outside the
    # repo. Check every component and never follow a link. This covers the root itself and
    # its ancestors; subdirectories inside the tree are checked during enumeration.
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$RepoRoot
    )
    $stop = [IO.Path]::GetFullPath($RepoRoot).TrimEnd('\', '/')
    $p = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    while ($true) {
        $item = Get-Item -LiteralPath $p -Force -ErrorAction Stop
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "LINK_IN_ROOT_CHAIN: '$p' is a junction/symlink; publish paths must be plain directories"
        }
        if ($p.Equals($stop, [StringComparison]::OrdinalIgnoreCase)) { break }
        $parent = Split-Path -Parent $p
        if (-not $parent -or $parent -eq $p) { break }
        $p = $parent
    }
}

function Resolve-PublishRoot {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$RepoRoot
    )
    if ([string]::IsNullOrWhiteSpace($Root)) { throw 'ROOT_EMPTY: -Root must point at a directory' }

    if ([IO.Path]::IsPathRooted($Root)) {
        $full = [IO.Path]::GetFullPath($Root)
    } else {
        $full = [IO.Path]::GetFullPath((Join-Path $RepoRoot $Root))
    }
    $full = $full.TrimEnd('\', '/')
    $repo = [IO.Path]::GetFullPath($RepoRoot).TrimEnd('\', '/')

    if ($full.Equals($repo, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'ROOT_IS_REPO_ROOT: point -Root at a subdirectory, not at the repository root'
    }
    $inside = $full.StartsWith($repo + '\', [StringComparison]::OrdinalIgnoreCase) -or
              $full.StartsWith($repo + '/', [StringComparison]::OrdinalIgnoreCase)
    if (-not $inside) { throw "ROOT_OUTSIDE_REPO: '$full' is not inside '$repo'" }
    if (-not (Test-Path -LiteralPath $full -PathType Container)) { throw "ROOT_NOT_FOUND: '$full' is not a directory" }
    Assert-NoLinkChain -Path $full -RepoRoot $repo
    return $full
}

function Assert-SafeRelPath {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$RelPath)
    if ([string]::IsNullOrWhiteSpace($RelPath)) { throw 'REL_EMPTY: empty relative path' }
    if ($RelPath -match '^[A-Za-z]:') { throw "REL_HAS_DRIVE: '$RelPath'" }
    if ($RelPath.StartsWith('/') -or $RelPath.StartsWith('\')) { throw "REL_ABSOLUTE: '$RelPath'" }
    if ([IO.Path]::IsPathRooted($RelPath)) { throw "REL_ROOTED: '$RelPath'" }
    if ($RelPath.Contains('\')) { throw "REL_BACKSLASH: '$RelPath' (path must use '/')" }
    foreach ($seg in $RelPath.Split('/')) {
        if ($seg -eq '' -or $seg -eq '.' -or $seg -eq '..') { throw "REL_BAD_SEGMENT: '$RelPath'" }
    }
    if ([regex]::IsMatch($RelPath, '[\x00-\x1f]')) { throw "REL_CONTROL_CHAR: '$RelPath'" }
    if ($RelPath.Length -gt 400) { throw "REL_TOO_LONG: '$RelPath'" }
}

function Get-RelPath {
    param(
        [Parameter(Mandatory)][string]$BaseFull,
        [Parameter(Mandatory)][string]$FileFull
    )
    $base = $BaseFull.TrimEnd('\', '/')
    $file = [IO.Path]::GetFullPath($FileFull)
    $prefix = $base + [IO.Path]::DirectorySeparatorChar
    if (-not $file.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "PATH_OUTSIDE_ROOT: '$file' is not under '$base'"
    }
    $rel = $file.Substring($base.Length + 1).Replace('\', '/')
    Assert-SafeRelPath $rel
    return $rel
}

function Test-SensitiveName {
    param([Parameter(Mandatory)][string]$Name)
    $lower = $Name.ToLowerInvariant()
    $exact = @('.env', '.netrc', '.npmrc', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'credentials.json')
    if ($exact -contains $lower) { return $true }
    # Templates carry no secrets and are meant to be published.
    $templates = @('.env.example', '.env.sample', '.env.template', '.env.dist')
    if ($templates -contains $lower) { return $false }
    if ($lower.StartsWith('.env.')) { return $true }
    foreach ($ext in @('.pem', '.pfx', '.p12', '.keystore', '.jks', '.key', '.ppk')) {
        if ($lower.EndsWith($ext)) { return $true }
    }
    return $false
}

function Get-PublishManifest {
    param(
        [Parameter(Mandatory)][string]$RootFull,
        [string]$Subdir = ''
    )
    $prefix = $Subdir.Replace('\', '/').Trim('/')
    if ($prefix) { Assert-SafeRelPath $prefix }

    $items = New-Object System.Collections.ArrayList
    # Directories first: a junction/symlink subdirectory (even one pointing outside the repo)
    # must be rejected before its contents are enumerated. This is not "all links": it covers
    # every directory and file under -Root; the root chain is checked in Resolve-PublishRoot.
    foreach ($d in Get-ChildItem -LiteralPath $RootFull -Recurse -Force -Directory) {
        if ($d.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "LINK_IN_TREE: '$($d.FullName)' is a junction/symlink directory (refusing: it can point outside the publish root)"
        }
    }
    foreach ($f in Get-ChildItem -LiteralPath $RootFull -Recurse -File) {
        if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "SYMLINK_IN_TREE: '$($f.FullName)' (refusing: a link can point outside the publish root)"
        }
        $rel = Get-RelPath -BaseFull $RootFull -FileFull $f.FullName
        if ($rel.Split('/')[0] -eq '.git') { throw "GIT_DIR_IN_TREE: '$($f.FullName)'" }
        $target = if ($prefix) { "$prefix/$rel" } else { $rel }
        Assert-SafeRelPath $target
        $null = $items.Add([pscustomobject]@{
            RelPath    = $rel
            TargetPath = $target
            FullName   = $f.FullName
            Size       = $f.Length
        })
    }
    return $items
}

function Write-PublishManifest {
    param($Items, [switch]$WithHash)
    $total = 0L
    foreach ($it in @($Items)) {
        $total += $it.Size
        if ($WithHash) {
            $h = (Get-FileHash -LiteralPath $it.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            Write-Output ("FILE {0}`t{1}`tsha256:{2}" -f $it.TargetPath, $it.Size, $h)
        } else {
            Write-Output ("FILE {0}`t{1}" -f $it.TargetPath, $it.Size)
        }
    }
    Write-Output ("MANIFEST_FILES {0} BYTES {1}" -f @($Items).Count, $total)
}

function Assert-SafeBranchName {
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Branch,
        [string]$BaseBranch = 'main'
    )
    if ([string]::IsNullOrWhiteSpace($Branch)) { throw 'BRANCH_REQUIRED: -Apply needs -Branch (e.g. publish/my-snapshot)' }
    if ($Branch -eq $BaseBranch -or $Branch -eq 'main' -or $Branch -eq 'master') {
        throw "BRANCH_FORBIDDEN: '$Branch' (these tools never push to the base branch)"
    }
    if ($Branch -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*$') { throw "BRANCH_INVALID: '$Branch'" }
    if ($Branch.Contains('..') -or $Branch.EndsWith('/') -or $Branch.EndsWith('.lock')) { throw "BRANCH_INVALID: '$Branch'" }
}

function Get-GitHubAuthHeaders {
    # Token comes from Git Credential Manager and is never printed or stored.
    $tmp = Join-Path $env:TEMP ("gitcred-" + [guid]::NewGuid().ToString('N') + ".txt")
    [IO.File]::WriteAllText($tmp, "protocol=https`nhost=github.com`n`n")
    try {
        $cred = cmd /c "git -c credential.helper=manager credential fill < `"$tmp`"" 2>$null
    } finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
    $pass = ($cred | Where-Object { $_ -like 'password=*' }) -replace '^password=', ''
    if (-not $pass) { throw 'NO_CREDENTIAL: no github.com credential in Windows Git Credential Manager' }
    return @{
        Authorization          = "token $pass"
        Accept                 = 'application/vnd.github+json'
        'User-Agent'           = 'classnotes-publish'
        'X-GitHub-Api-Version' = '2022-11-28'
    }
}

function Invoke-GitHub {
    param(
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][string]$Uri,
        $Body,
        [Parameter(Mandatory)][hashtable]$Headers,
        [int]$TimeoutSec = 90
    )
    $p = @{ Method = $Method; Uri = $Uri; Headers = $Headers; TimeoutSec = $TimeoutSec }
    if ($null -ne $Body) {
        $p.ContentType = 'application/json; charset=utf-8'
        $p.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 12 -Compress))
    }
    return Invoke-RestMethod @p
}

function Get-PublishBase {
    # Freeze the base branch once per run. The returned Sha is the only base used for the
    # README read, base_tree and parents; a branch moving mid-run is not mixed in.
    param(
        [Parameter(Mandatory)][string]$Owner,
        [Parameter(Mandatory)][string]$Repo,
        [Parameter(Mandatory)][string]$BaseBranch
    )
    $H = Get-GitHubAuthHeaders
    $base = "https://api.github.com/repos/$Owner/$Repo"
    $ref = Invoke-GitHub -Method GET -Uri "$base/git/ref/heads/$BaseBranch" -Headers $H
    $sha = $ref.object.sha
    $commit = Invoke-GitHub -Method GET -Uri "$base/git/commits/$sha" -Headers $H
    return [pscustomobject]@{ Sha = $sha; TreeSha = $commit.tree.sha }
}

function Get-GitHubContentUri {
    param(
        [Parameter(Mandatory)][string]$Owner,
        [Parameter(Mandatory)][string]$Repo,
        [Parameter(Mandatory)][string]$Path,
        [string]$Ref
    )
    $uri = "https://api.github.com/repos/$Owner/$Repo/contents/$Path"
    if ($Ref) { $uri += '?ref=' + [Uri]::EscapeDataString($Ref) }
    return $uri
}

function Get-GitHubFileText {
    # -Ref must be the same frozen SHA later passed to base_tree/parents; without it the API
    # reads the repository default branch, which silently overwrites a non-default base.
    param(
        [Parameter(Mandatory)][string]$Owner,
        [Parameter(Mandatory)][string]$Repo,
        [Parameter(Mandatory)][string]$Path,
        [string]$Ref
    )
    $H = Get-GitHubAuthHeaders
    $resp = Invoke-GitHub -Method GET -Uri (Get-GitHubContentUri -Owner $Owner -Repo $Repo -Path $Path -Ref $Ref) -Headers $H
    return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($resp.content))
}

function Invoke-Publish {
    # Upload $Items as blobs on a brand-new branch, commit with the base tip as parent,
    # then open a (draft) pull request. There is no code path that writes to $BaseBranch
    # and no force flag anywhere.
    param(
        [Parameter(Mandatory)][string]$Owner,
        [Parameter(Mandatory)][string]$Repo,
        [Parameter(Mandatory)][string]$BaseBranch,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Branch,
        $Items,
        $TextEntries = @(),
        [Parameter(Mandatory)][string]$CommitMessage,
        [string]$PrTitle,
        [string]$PrBody,
        [string]$BaseSha = '',
        [switch]$Draft
    )
    $base = "https://api.github.com/repos/$Owner/$Repo"
    $H = Get-GitHubAuthHeaders
    $me = Invoke-GitHub -Method GET -Uri 'https://api.github.com/user' -Headers $H
    Write-Output "AUTH_OK login=$($me.login) target=$Owner/$Repo"

    if ($BaseSha) {
        $headSha = $BaseSha
    } else {
        $headRef = Invoke-GitHub -Method GET -Uri "$base/git/ref/heads/$BaseBranch" -Headers $H
        $headSha = $headRef.object.sha
    }
    $headCommit = Invoke-GitHub -Method GET -Uri "$base/git/commits/$headSha" -Headers $H
    Write-Output "BASE_FROZEN $BaseBranch $headSha tree=$($headCommit.tree.sha)"

    $branchExists = $false
    try {
        $null = Invoke-GitHub -Method GET -Uri "$base/git/ref/heads/$Branch" -Headers $H
        $branchExists = $true
    } catch {
        $branchExists = $false
    }
    if ($branchExists) {
        throw "BRANCH_EXISTS: '$Branch' already exists; this tool never force-updates a ref - pick another name or delete the branch yourself"
    }

    $entries = New-Object System.Collections.ArrayList
    $i = 0
    $count = @($Items).Count
    foreach ($it in @($Items)) {
        $i++
        $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($it.FullName))
        $blob = Invoke-GitHub -Method POST -Uri "$base/git/blobs" -Body @{ content = $b64; encoding = 'base64' } -Headers $H
        $null = $entries.Add(@{ path = $it.TargetPath; mode = '100644'; type = 'blob'; sha = $blob.sha })
        if ($i % 20 -eq 0) { Write-Output "BLOBS $i/$count" }
    }
    Write-Output "BLOBS_DONE $count"

    foreach ($t in @($TextEntries)) {
        $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$t.text))
        $blob = Invoke-GitHub -Method POST -Uri "$base/git/blobs" -Body @{ content = $b64; encoding = 'base64' } -Headers $H
        $null = $entries.Add(@{ path = $t.path; mode = '100644'; type = 'blob'; sha = $blob.sha })
        Write-Output "TEXT_ENTRY $($t.path)"
    }

    # base_tree keeps everything already on the base branch; only listed paths change.
    $tree = Invoke-GitHub -Method POST -Uri "$base/git/trees" -Body @{ base_tree = $headCommit.tree.sha; tree = $entries.ToArray() } -Headers $H
    $commit = Invoke-GitHub -Method POST -Uri "$base/git/commits" -Body @{ message = $CommitMessage; tree = $tree.sha; parents = @($headSha) } -Headers $H
    Write-Output "COMMIT $($commit.sha) parent=$headSha"

    # Create a new ref only (no PATCH, no force).
    $null = Invoke-GitHub -Method POST -Uri "$base/git/refs" -Body @{ ref = "refs/heads/$Branch"; sha = $commit.sha } -Headers $H
    Write-Output "BRANCH_CREATED refs/heads/$Branch"

    if (-not $PrTitle) { $PrTitle = $CommitMessage }
    if (-not $PrBody) { $PrBody = "由维护者发布脚本生成；请评审后再合并。`n`n- 文件数：$count`n- 基准：$BaseBranch@$headSha" }
    $pr = Invoke-GitHub -Method POST -Uri "$base/pulls" -Headers $H -Body @{
        title = $PrTitle
        head  = $Branch
        base  = $BaseBranch
        body  = $PrBody
        draft = [bool]$Draft
    }
    Write-Output "PR #$($pr.number) $($pr.html_url)"
    return $pr
}
