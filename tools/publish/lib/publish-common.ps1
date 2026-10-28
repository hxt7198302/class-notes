# Shared helpers for the maintainer publish scripts.
#
# Flow: freeze the base SHA once, stage files in a git worktree, commit and push a new
# branch, then open a draft PR with the GitHub CLI. There is no direct GitHub object/API
# layer here, and no code path writes to the base branch or force-updates a ref (the new
# branch is pushed with an empty-expect --force-with-lease, which only succeeds if it does
# not exist yet).
#
# Nothing in the dry-run path touches the network.

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

function Invoke-Git {
    # Native stderr (push progress, warnings) is data here, not a terminating error, even when
    # the caller runs with $ErrorActionPreference = 'Stop'.
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string[]]$GitArgs,
        [switch]$AllowFail
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & git -C $RepoRoot @GitArgs 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    $lines = @($out | ForEach-Object { "$_" })
    $text = $lines -join "`n"
    if ($code -ne 0 -and -not $AllowFail) {
        throw ("GIT_FAILED ($code): git " + ($GitArgs -join ' ') + "`n" + $text)
    }
    return [pscustomobject]@{ ExitCode = $code; Text = $text; Lines = $lines }
}

function Assert-NoLinkChain {
    # GetFullPath does not resolve junctions/symlinks, so a reparse point between -Path and
    # the repository root can redirect a "repo-internal" path outside the repo. Check every
    # component and never follow a link.
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

function Get-PublishFileSet {
    # The single enumeration used by both the link check and the manifest, so the checked set
    # and the copied set can never drift (hidden entries included, hence -Force on both).
    # Directories first: a junction subdirectory is rejected before its contents are read.
    param([Parameter(Mandatory)][string]$RootFull)
    foreach ($d in Get-ChildItem -LiteralPath $RootFull -Recurse -Force -Directory) {
        if ($d.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "LINK_IN_TREE: '$($d.FullName)' is a junction/symlink directory (it can point outside the publish root)"
        }
    }
    $files = @(Get-ChildItem -LiteralPath $RootFull -Recurse -Force -File)
    foreach ($f in $files) {
        if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "SYMLINK_IN_TREE: '$($f.FullName)' is a junction/symlink file"
        }
    }
    return $files
}

function Assert-NoLinksInTree {
    param([Parameter(Mandatory)][string]$RootFull)
    $null = Get-PublishFileSet -RootFull $RootFull
}

function Get-TargetEntry {
    # Returns the directory entry itself, without following a reparse point. Listing the parent
    # is the only way to see a link whose target is missing (which would still be written
    # through); $null means the entry does not exist yet.
    param([Parameter(Mandatory)][string]$Path)
    $parent = Split-Path -Parent $Path
    $leaf = Split-Path -Leaf $Path
    if (-not $parent) { return $null }
    if (-not [IO.Directory]::Exists($parent)) { return $null }
    return @(Get-ChildItem -LiteralPath $parent -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq $leaf } | Select-Object -First 1)
}

function Assert-NoLinksUnderRoot {
    # Target side of the copy: the frozen base may already carry a link (git mode 120000) at
    # the destination, so every existing component between -RootFull and -Path gets the same
    # ReparsePoint rule as the source tree. No path resolution is re-implemented here.
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$RootFull
    )
    $root = [IO.Path]::GetFullPath($RootFull).TrimEnd('\', '/')
    $p = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $inside = $p.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or
              $p.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or
              $p.StartsWith($root + '/', [StringComparison]::OrdinalIgnoreCase)
    if (-not $inside) { throw "TARGET_OUTSIDE_WORKTREE: '$p' is not under '$root'" }

    $segments = @()
    if (-not $p.Equals($root, [StringComparison]::OrdinalIgnoreCase)) {
        $segments = @($p.Substring($root.Length).TrimStart('\', '/').Split([char[]]('\', '/')) | Where-Object { $_ })
    }

    $cur = $root
    $rootItem = Get-TargetEntry -Path $cur
    if ($rootItem -and ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "LINK_IN_TARGET_CHAIN: '$cur' is a junction/symlink; refusing to write through it"
    }
    for ($i = 0; $i -lt $segments.Count; $i++) {
        $cur = Join-Path $cur $segments[$i]
        $item = Get-TargetEntry -Path $cur
        if (-not $item) { break }
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "LINK_IN_TARGET_CHAIN: '$cur' is a junction/symlink; refusing to write through it"
        }
        if ($i -lt $segments.Count - 1 -and -not $item.PSIsContainer) {
            throw "TARGET_PARENT_NOT_DIRECTORY: '$cur' exists and is not a directory"
        }
    }
}

function Resolve-PublishRoot {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$RepoRoot
    )
    if ([string]::IsNullOrWhiteSpace($Root)) { throw 'ROOT_EMPTY: -Root must point at a directory' }
    $full = if ([IO.Path]::IsPathRooted($Root)) { $Root } else { Join-Path $RepoRoot $Root }
    $full = [IO.Path]::GetFullPath($full).TrimEnd('\', '/')
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

function Assert-SafeSubdir {
    # Validates the -Subdir argument. Paths inside the worktree are computed by git.
    param([AllowEmptyString()][string]$Subdir)
    if ([string]::IsNullOrWhiteSpace($Subdir)) { return '' }
    $s = $Subdir.Replace('\', '/').Trim('/')
    if ($s -match '^[A-Za-z]:') { throw "SUBDIR_HAS_DRIVE: '$Subdir'" }
    if ([regex]::IsMatch($s, '[\x00-\x1f]')) { throw "SUBDIR_CONTROL_CHAR: '$Subdir'" }
    foreach ($seg in $s.Split('/')) {
        if ($seg -eq '' -or $seg -eq '.' -or $seg -eq '..') { throw "SUBDIR_BAD_SEGMENT: '$Subdir'" }
    }
    if ($s.Split('/')[0] -eq '.git') { throw "SUBDIR_GIT_DIR: '$Subdir'" }
    return $s
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
    param([Parameter(Mandatory)][string]$RootFull)
    $files = Get-PublishFileSet -RootFull $RootFull

    $items = New-Object System.Collections.ArrayList
    Push-Location -LiteralPath $RootFull
    try {
        foreach ($f in $files) {
            $rel = Resolve-Path -LiteralPath $f.FullName -Relative
            if ($rel.StartsWith('.\')) { $rel = $rel.Substring(2) }
            $rel = $rel.Replace('\', '/')
            if ($rel.Split('/')[0] -eq '.git') { throw "GIT_DIR_IN_TREE: '$($f.FullName)'" }
            $null = $items.Add([pscustomobject]@{
                RelPath  = $rel
                FullName = $f.FullName
                Size     = $f.Length
            })
        }
    } finally {
        Pop-Location
    }
    return $items
}

function Write-PublishManifest {
    param($Items, [switch]$WithHash, [string]$Prefix = '')
    $total = 0L
    foreach ($it in @($Items)) {
        $total += $it.Size
        $target = if ($Prefix) { "$Prefix/$($it.RelPath)" } else { $it.RelPath }
        if ($WithHash) {
            $h = (Get-FileHash -LiteralPath $it.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            Write-Output ("FILE {0}`t{1}`tsha256:{2}" -f $target, $it.Size, $h)
        } else {
            Write-Output ("FILE {0}`t{1}" -f $target, $it.Size)
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

function Get-RemoteBranchSha {
    # The single frozen base for this run: README read, worktree and commit parent all use it.
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$Branch)
    $r = Invoke-Git -RepoRoot $RepoRoot -GitArgs @('ls-remote', '--heads', 'origin', "refs/heads/$Branch") -AllowFail
    if ($r.ExitCode -ne 0) { throw "GIT_LS_REMOTE_FAILED: $($r.Text)" }
    if ($r.Text -notmatch '(?m)^([0-9a-f]{40})\s+refs/heads/') { throw "BRANCH_NOT_FOUND: '$Branch' on origin" }
    return $Matches[1]
}

function Test-RemoteBranchExists {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$Branch)
    $r = Invoke-Git -RepoRoot $RepoRoot -GitArgs @('ls-remote', '--heads', 'origin', "refs/heads/$Branch") -AllowFail
    if ($r.ExitCode -ne 0) { throw "GIT_LS_REMOTE_FAILED: $($r.Text)" }
    return [bool]$r.Text.Trim()
}

function Confirm-BaseCommitLocal {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$BaseSha,
        [Parameter(Mandatory)][string]$BaseBranch
    )
    $ok = Invoke-Git -RepoRoot $RepoRoot -GitArgs @('cat-file', '-e', "$BaseSha^{commit}") -AllowFail
    if ($ok.ExitCode -eq 0) { return }
    $null = Invoke-Git -RepoRoot $RepoRoot -GitArgs @('fetch', 'origin', $BaseBranch) -AllowFail
    $ok = Invoke-Git -RepoRoot $RepoRoot -GitArgs @('cat-file', '-e', "$BaseSha^{commit}") -AllowFail
    if ($ok.ExitCode -eq 0) { return }
    $f = Invoke-Git -RepoRoot $RepoRoot -GitArgs @('fetch', 'origin', $BaseSha) -AllowFail
    if ($f.ExitCode -ne 0) { throw "BASE_COMMIT_UNAVAILABLE: cannot fetch $BaseSha" }
}

function Initialize-PublishWorktree {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$BaseSha,
        [Parameter(Mandatory)][string]$Path
    )
    if (Test-Path -LiteralPath $Path) { throw "WORKTREE_PATH_EXISTS: '$Path'" }
    $null = Invoke-Git -RepoRoot $RepoRoot -GitArgs @('worktree', 'add', '--detach', '--quiet', $Path, $BaseSha)
    return $Path
}

function Remove-PublishWorktree {
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$Path)
    if (Test-Path -LiteralPath $Path) {
        $null = Invoke-Git -RepoRoot $RepoRoot -GitArgs @('worktree', 'remove', '--force', $Path) -AllowFail
    }
}

function Copy-PublishItems {
    # -TargetRoot is the frozen worktree root; every destination component is checked there
    # before writing, so a link already present in the base cannot redirect the copy.
    param(
        $Items,
        [Parameter(Mandatory)][string]$TargetFull,
        [Parameter(Mandatory)][string]$TargetRoot
    )
    Assert-NoLinksUnderRoot -Path $TargetFull -RootFull $TargetRoot
    if (-not (Test-Path -LiteralPath $TargetFull)) { $null = New-Item -ItemType Directory -Path $TargetFull -Force }
    foreach ($it in @($Items)) {
        $dest = Join-Path $TargetFull ($it.RelPath -replace '/', '\')
        Assert-NoLinksUnderRoot -Path $dest -RootFull $TargetRoot
        $parent = Split-Path -Parent $dest
        if (-not (Test-Path -LiteralPath $parent)) { $null = New-Item -ItemType Directory -Path $parent -Force }
        Copy-Item -LiteralPath $it.FullName -Destination $dest -Force
    }
}

function Get-GitBlobBytes {
    # Reads a blob exactly as stored (binary-safe), e.g. "<sha>:README.md".
    # -WorkingDirectory carries the repo path, so a RepoRoot containing spaces is not split
    # into separate arguments (ArgumentList is space-joined, not quoted).
    param([Parameter(Mandatory)][string]$RepoRoot, [Parameter(Mandatory)][string]$Spec)
    $tmp = Join-Path $env:TEMP ('gitblob-' + [guid]::NewGuid().ToString('N') + '.bin')
    try {
        $p = Start-Process -FilePath 'git' -WorkingDirectory $RepoRoot -ArgumentList @('cat-file', 'blob', $Spec) `
            -RedirectStandardOutput $tmp -NoNewWindow -Wait -PassThru
        if ($p.ExitCode -ne 0) { throw "GIT_BLOB_FAILED: '$Spec'" }
        return [IO.File]::ReadAllBytes($tmp)
    } finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
}

function Push-NewBranch {
    # Create-only push: an empty expected value in --force-with-lease means "this ref must not
    # exist", so the create decision is atomic on the remote. A prior ls-remote is only a
    # friendly early error and is not what makes this safe; there is no unconditional force.
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$Branch,
        [string]$Remote = 'origin'
    )
    $lease = "--force-with-lease=refs/heads/$Branch`:"
    $r = Invoke-Git -RepoRoot $RepoRoot -GitArgs @('push', '-u', $lease, $Remote, $Branch) -AllowFail
    if ($r.ExitCode -eq 0) { return $r }
    if ($r.Text -match 'stale info|already exists|fetch first') {
        throw "BRANCH_CREATED_CONCURRENTLY: '$Branch' already existed on '$Remote'; nothing was pushed"
    }
    throw ("GIT_PUSH_FAILED ($($r.ExitCode)): " + $r.Text)
}

function Get-GhPath {
    $c = Get-Command gh -ErrorAction SilentlyContinue
    if (-not $c) { return $null }
    return $c.Source
}

function Assert-GhReady {
    # Missing tools are reported, never installed.
    $gh = Get-GhPath
    if (-not $gh) { throw 'GH_NOT_FOUND: GitHub CLI (gh) is not installed; this script will not install or upgrade it' }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $gh auth status 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    if ($code -ne 0) {
        throw ("GH_AUTH_FAILED: " + ((@($out) | ForEach-Object { "$_" }) -join "`n"))
    }
}

function Open-DraftPullRequest {
    param(
        [Parameter(Mandatory)][string]$Worktree,
        [Parameter(Mandatory)][string]$BaseBranch,
        [Parameter(Mandatory)][string]$Branch,
        [Parameter(Mandatory)][string]$Title,
        [string]$Body = ''
    )
    $gh = Get-GhPath
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    Push-Location -LiteralPath $Worktree
    try {
        $out = & $gh pr create --draft --base $BaseBranch --head $Branch --title $Title --body $Body 2>&1
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
        $ErrorActionPreference = $prev
    }
    $text = (@($out) | ForEach-Object { "$_" }) -join "`n"
    if ($code -ne 0) { throw "GH_PR_CREATE_FAILED: $text" }
    $url = (@($out) | ForEach-Object { "$_" } | Where-Object { $_ -match '^https://' } | Select-Object -First 1)
    Write-Output "PR_DRAFT $url"
    return $url
}
