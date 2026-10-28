# Create a DRAFT GitHub Release for installer binaries (APK/ZIP).
#
# Always creates a draft: publishing a release is an outward-facing action and needs an
# explicit human decision afterwards. This script does not publish, delete or edit releases.
#
# Default is a dry run: prints the gh command and checks the assets, no network.
# Add -Apply to create the draft release.
param(
    [Parameter(Mandatory)][string]$Tag,
    [string[]]$Assets = @(),
    [string]$Title = '',
    [string]$NotesFile = '',
    [string]$RepoRoot = '',
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot 'lib\publish-common.ps1')

$repoFull = Get-PublishRepoRoot -RepoRoot $RepoRoot -ScriptRoot $PSScriptRoot
if ($Tag -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "TAG_INVALID: '$Tag'" }

$assetPaths = @()
foreach ($a in @($Assets)) {
    if ([string]::IsNullOrWhiteSpace($a)) { continue }
    $full = if ([IO.Path]::IsPathRooted($a)) { $a } else { Join-Path $repoFull $a }
    $full = [IO.Path]::GetFullPath($full)
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "ASSET_NOT_FOUND: '$a'" }
    $assetPaths += $full
}
if ($assetPaths.Count -eq 0) { throw 'ASSETS_REQUIRED: pass -Assets <file>[,<file>...]' }

if ($NotesFile) {
    $notesFull = if ([IO.Path]::IsPathRooted($NotesFile)) { $NotesFile } else { Join-Path $repoFull $NotesFile }
    $notesFull = [IO.Path]::GetFullPath($notesFull)
    if (-not (Test-Path -LiteralPath $notesFull -PathType Leaf)) { throw "NOTES_NOT_FOUND: '$NotesFile'" }
} else {
    $notesFull = ''
}

$ghArgs = @('release', 'create', $Tag, '--draft')
if ($Title) { $ghArgs += @('--title', $Title) }
if ($notesFull) { $ghArgs += @('--notes-file', $notesFull) }
else { $ghArgs += @('--notes', "Draft release $Tag") }
$ghArgs += $assetPaths

if (-not $Apply) {
    Write-Output 'RESULT=DRY_RUN_OK (draft release, no network)'
    Write-Output ('NEXT gh ' + ($ghArgs -join ' '))
    exit 0
}

Assert-GhReady
Push-Location -LiteralPath $repoFull
try {
    $out = & gh @ghArgs 2>&1
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($code -ne 0) {
    throw ("GH_RELEASE_CREATE_FAILED: " + ((@($out) | ForEach-Object { "$_" }) -join "`n"))
}
Write-Output ((@($out) | ForEach-Object { "$_" }) -join "`n")
Write-Output 'RESULT=OK (draft only; publishing needs a separate explicit decision)'
