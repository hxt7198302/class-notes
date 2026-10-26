# Start the Class Notes API service (hidden window). ASCII-only: no Chinese in this file,
# so it is immune to PowerShell 5.1 reading no-BOM files as ANSI (the mojibake-path trap).
# v1.6: node stdout/stderr captured to server-runtime.log / server-runtime.err.log
# (black box for silent-death forensics - server died without a trace once on 2026-10-01).
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node -ErrorAction Stop).Source
$out = Join-Path $here 'server-runtime.log'
$err = Join-Path $here 'server-runtime.err.log'
Start-Process -FilePath $node -ArgumentList ('"' + (Join-Path $here 'server.mjs') + '"') -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
