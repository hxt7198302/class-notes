# 课堂笔记·电脑端 一键启动（开源版 v2.0）
# 做四件事：查环境 → 装依赖 → 起 API 服务（含局域网发现） → 起免费公网隧道并广播地址。
# 首次跑会自动装 Python 依赖（转写用，几分钟）；以后每次双击「启动电脑端.bat」即可。
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $base
Write-Host "== 课堂笔记·电脑端 ==" -ForegroundColor Cyan

# ---------- 1) Node ----------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "[X] 没找到 Node.js。请到 https://nodejs.org 装 LTS 版（一路下一步），装完重新双击启动。" -ForegroundColor Red
  Read-Host '按回车退出'; exit 1
}
Write-Host "[1/5] Node.js OK（$(& node -v)）"

# ---------- 2) Python + 转写依赖 ----------
$py = $null
foreach ($c in @('python','py')) { $t = Get-Command $c -ErrorAction SilentlyContinue; if ($t) { $py = $t.Source; break } }
if (-not $py) {
  Write-Host "[!] 没找到 Python：录音暂时没法转文字（其他功能不受影响）。想全功能：到 https://python.org 装 3.10+ 并勾选 Add to PATH。" -ForegroundColor Yellow
} else {
  & $py -m pip show faster-whisper *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[2/5] 首次运行：安装语音转写引擎 faster-whisper（约几分钟，只装这一次）…"
    & $py -m pip install -r requirements.txt --quiet
    if ($LASTEXITCODE -ne 0) { Write-Host "[!] 依赖没装上（网络？），转写功能暂不可用，其他照常。可稍后手动: python -m pip install -r requirements.txt" -ForegroundColor Yellow }
  } else { Write-Host "[2/5] 转写依赖 OK" }
}

# ---------- 3) 首次生成配置（随机 ntfy 频道=你的私有频道，别外传） ----------
# 注意：服务端读的是 电脑端\config.json（见 api-server/server.mjs 的 MAIN_CFG_FILE），
# 不是仓库根目录。v2.0 的启动脚本曾写错位置，导致生成出来的 ntfyTopic 服务端根本没读到
# （引擎仍是默认 template 所以看着能跑，但公网隧道地址不会广播给手机）。v2.13 修正。
$cfgFile = Join-Path $base '电脑端\config.json'
# 兼容旧版脚本已经在根目录生成的 config.json：搬过去，别让人白配一次
$legacyCfg = Join-Path $base 'config.json'
if ((-not (Test-Path $cfgFile)) -and (Test-Path $legacyCfg)) { Copy-Item $legacyCfg $cfgFile }
if (-not (Test-Path $cfgFile)) {
  $topic = 'classnotes-' + (-join ((97..122) + (48..57) | Get-Random -Count 12 | ForEach-Object { [char]$_ }))
  $cfg = @{ engine='template'; whisperModel='small'; lang='zh'; listen='0.0.0.0'; ntfyTopic=$topic } | ConvertTo-Json
  Set-Content -Path $cfgFile -Value $cfg -Encoding UTF8
  Write-Host "[3/5] 已生成 config.json（免费转写稿模式；想用 AI 整理：手机 APP 设置里填免费 API Key 即可）"
} else { Write-Host "[3/5] 配置 OK" }

# ---------- 4) API 服务 ----------
$exe = [IO.Path]::GetFileName($py)
$existing = Get-NetTCPConnection -LocalPort 8776 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "[4/5] API 服务已经在跑（端口 8776），不重复启动"
} else {
  Start-Process -WindowStyle Hidden -FilePath 'node' -ArgumentList 'api-server\server.mjs' -WorkingDirectory (Join-Path $base '电脑端') -RedirectStandardOutput (Join-Path $base 'server-out.log') -RedirectStandardError (Join-Path $base 'server-err.log')
  Start-Sleep 2
}
$lan = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress
Write-Host "[4/5] API 服务 OK  局域网地址: http://${lan}:8776" -ForegroundColor Green

# ---------- 5) 公网隧道（离开家也能传/能看；起不来不影响局域网使用） ----------
$topic = (Get-Content $cfgFile -Raw | ConvertFrom-Json).ntfyTopic
$cf = Join-Path $base 'cloudflared.exe'
if (-not (Test-Path $cf)) {
  # 开源仓库不打包二进制，引导用户自己去官方下载（约 55MB）
  Write-Host "[5/5] 没有 cloudflared.exe：公网隧道跳过，同一 WiFi 下功能不受影响。" -ForegroundColor Yellow
  Write-Host "      要用公网：到 https://github.com/cloudflare/cloudflared/releases 下 windows-amd64 版，改名 cloudflared.exe 放本目录，再双击启动。" -ForegroundColor Yellow
  $url = $null
} else {
Start-Process -WindowStyle Hidden -FilePath $cf -ArgumentList @('tunnel','--url','http://localhost:8776','--no-autoupdate') -RedirectStandardError (Join-Path $base 'tunnel.log') -RedirectStandardOutput (Join-Path $base 'tunnel-out.log')
Start-Sleep 6
$url = $null
foreach ($i in 1..10) {
  $m = Select-String -Path (Join-Path $base 'tunnel.log') -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -Last 1
  if ($m) { $url = $m.Matches[0].Value; break }
  Start-Sleep 3
}
if ($url) {
  try { Invoke-RestMethod -Method Post -Uri "https://ntfy.sh/$topic" -Body $url -Headers @{ Title = 'classnotes-url' } -TimeoutSec 15 | Out-Null } catch {}
  Write-Host "[5/5] 公网隧道 OK: $url（已广播给你的手机 APP）" -ForegroundColor Green
} else {
  Write-Host "[5/5] 公网隧道这次没起来（不影响同一 WiFi 使用；重启本脚本会重试）" -ForegroundColor Yellow
}
}

Write-Host ""
Write-Host "================ 全部就绪 ================" -ForegroundColor Cyan
Write-Host "手机（同一 WiFi）：装 releases 里的安装包 → 打开 → 「连接电脑」→ 自动找我的电脑"
Write-Host "手机（不在家）：  上述公网隧道地址会自动同步，不用管"
Write-Host "想升级 AI 笔记：  APP 里「连接电脑 & AI 设置」→ 填免费的智谱 API Key（bigmodel.cn）"
Write-Host "=========================================="
Write-Host "本窗口可以关掉，服务在后台；想停服务：任务管理器结束 node / cloudflared 即可"
Read-Host '按回车关闭本窗口'
