# 演示前自检：云端服务 + AI 助教链路（只读，不烧 token）
# 用法：powershell -ExecutionPolicy Bypass -File check-cloud.ps1
# 如需换服务器：set CLASSROOM_SERVER=https://xxx.trycloudflare.com

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$base = 'https://your-server.example.com'
if ($env:CLASSROOM_SERVER) { $base = $env:CLASSROOM_SERVER }
$base = $base.TrimEnd('/')

Write-Host ('服务器: ' + $base)
Write-Host ''

$fail = 0

function Check($name, $url) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        $r = Invoke-WebRequest -Uri $url -TimeoutSec 25 -UseBasicParsing
        $ms = [Math]::Round($sw.Elapsed.TotalMilliseconds)
        Write-Host ('[OK]   ' + $name + '  HTTP ' + $r.StatusCode + '  ' + $ms + 'ms')
        return $r.Content
    } catch {
        $script:fail = $script:fail + 1
        Write-Host ('[FAIL] ' + $name + '  ' + $_.Exception.Message)
        return $null
    }
}

$classes = Check '课表接口 /api/classes' ($base + '/api/classes')
$sessions = Check '课堂记录 /api/sessions' ($base + '/api/sessions')
$todos = Check '待办汇总 /api/assist/todos' ($base + '/api/assist/todos')

if ($sessions) {
    try {
        $j = $sessions | ConvertFrom-Json
        Write-Host ('       课堂记录数: ' + @($j.sessions).Count)
    } catch {}
}
if ($todos) {
    try {
        $j2 = $todos | ConvertFrom-Json
        Write-Host ('       待办条数: ' + @($j2.items).Count)
    } catch {}
}

Write-Host ''
if ($fail -eq 0) {
    Write-Host '结论: 云端链路正常，可以演示。'
} else {
    Write-Host ('结论: ' + $fail + ' 项异常。先处理再演示；若隧道地址变了，长按 APP 页面改地址，或改本脚本里的 $base。')
    exit 1
}
