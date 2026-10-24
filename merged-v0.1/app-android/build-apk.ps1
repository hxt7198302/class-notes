# 课堂助手·演示 WebView 壳 · 手动构建（不依赖 Gradle / Android Studio）
# 用法：powershell -ExecutionPolicy Bypass -File build-apk.ps1
# 依赖：JDK(含 javac/keytool) + Android build-tools 34 + platform android-34
# 注意：aapt2 不支持非 ASCII 路径，脚本会先把工程复制到纯英文临时目录再构建。

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'
Set-StrictMode -Version 2
# 统一日志：同时写进 distuild.log，便于排查（控制台编码问题不影响落盘）

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$SrcApp = Join-Path $Root 'app'
$Dist = Join-Path $Root 'dist'

$Sdk = $env:CLASSROOM_SDK
if (-not $Sdk) { throw '请先设置环境变量 CLASSROOM_SDK（Android SDK 目录）' }
$Jdk = $env:CLASSROOM_JDK
if (-not $Jdk) { throw '请先设置环境变量 CLASSROOM_JDK（JDK 目录，需含 javac/keytool）' }

$Stage = Join-Path $env:TEMP 'classroom-apk-build'
$App = Join-Path $Stage 'app'
$Build = Join-Path $Stage 'build'
$Bt = Join-Path $Sdk 'build-tools\34.0.0'
$AndroidJar = Join-Path $Sdk 'platforms\android-34\android.jar'

function Need($p, $what) {
    if (!(Test-Path $p)) { throw ('缺少 ' + $what + ': ' + $p) }
}
function Step($code, $label) {
    if ($code -ne 0) { throw ($label + ' 失败 (exit ' + $code + ')') }
}

Need $SrcApp '工程 app 目录'
Need (Join-Path $Jdk 'bin\javac.exe') 'JDK/javac'
Need (Join-Path $Jdk 'bin\keytool.exe') 'JDK/keytool'
Need (Join-Path $Bt 'aapt2.exe') 'build-tools/aapt2'
Need (Join-Path $Bt 'd8.bat') 'build-tools/d8'
Need (Join-Path $Bt 'zipalign.exe') 'build-tools/zipalign'
Need (Join-Path $Bt 'apksigner.bat') 'build-tools/apksigner'
Need $AndroidJar 'platform android.jar'

$env:JAVA_HOME = $Jdk
$env:PATH = (Join-Path $Jdk 'bin') + ';' + $Bt + ';' + $env:PATH

Write-Host '[0/7] 复制到 ASCII 临时目录 ...'
Remove-Item -Recurse -Force $Stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $App, (Join-Path $Build 'classes'), (Join-Path $Build 'dex'), $Dist | Out-Null
Copy-Item -Path (Join-Path $SrcApp '*') -Destination $App -Recurse -Force

Write-Host '[1/7] aapt2 compile ...'
& (Join-Path $Bt 'aapt2.exe') compile --dir (Join-Path $App 'res') -o (Join-Path $Build 'res.zip')
Step $LASTEXITCODE 'aapt2 compile'

Write-Host '[2/7] aapt2 link ...'
& (Join-Path $Bt 'aapt2.exe') link -o (Join-Path $Build 'app-unsigned.apk') -I $AndroidJar --manifest (Join-Path $App 'AndroidManifest.xml') -R (Join-Path $Build 'res.zip') --auto-add-overlay
Step $LASTEXITCODE 'aapt2 link'

Write-Host '[3/7] javac ...'
$JavaFiles = @(Get-ChildItem -Path (Join-Path $App 'src') -Recurse -Filter '*.java' | ForEach-Object { $_.FullName })
if ($JavaFiles.Count -eq 0) { throw 'src 下没有找到 .java 文件' }
Write-Host ('      编译 ' + $JavaFiles.Count + ' 个 java 文件: ' + (($JavaFiles | ForEach-Object { Split-Path $_ -Leaf }) -join ', '))
& (Join-Path $Jdk 'bin\javac.exe') --release 8 -Xlint:-options -encoding UTF-8 -d (Join-Path $Build 'classes') -cp $AndroidJar $JavaFiles
Step $LASTEXITCODE 'javac'

Write-Host '[4/7] R8 -> dex ...'
# 说明：本机 build-tools 34.0.0 自带的 d8(8.2.2-dev) 解析「内部类/匿名类」会抛
# NullPointerException（Cannot invoke String.length() because parameter1 is null），
# 同一 jar 里的 R8 入口正常，因此这里用 R8（保持不裁剪/不混淆/不优化）。
# 用 .NET API 递归枚举，避免部分环境下 Get-ChildItem -Filter 返回空；最多等 3 秒让文件系统落盘。
$ClsDir = Join-Path $Build 'classes'
$ClassFiles = @()
for ($i = 0; $i -lt 30; $i++) {
    if (Test-Path $ClsDir) {
        $ClassFiles = @([System.IO.Directory]::GetFiles($ClsDir, '*.class', [System.IO.SearchOption]::AllDirectories))
    }
    if ($ClassFiles.Count -gt 0) { break }
    Start-Sleep -Milliseconds 100
}
if ($ClassFiles.Count -eq 0) { throw ('javac 没有产出 .class 文件: ' + $ClsDir) }
Write-Host ('      打进 dex 的 class 数: ' + $ClassFiles.Count)
$R8Conf = Join-Path $Build 'r8.pro'
$R8Rules = @(
    '-keep class com.sczzm.classroom.** { *; }',
    '-dontshrink',
    '-dontoptimize',
    '-dontobfuscate',
    '-dontwarn **'
)
Set-Content -Path $R8Conf -Value $R8Rules -Encoding ASCII
$D8Jar = Join-Path $Bt 'lib\d8.jar'
Need $D8Jar 'build-tools/lib/d8.jar (R8)'
& (Join-Path $Jdk 'bin\java.exe') -cp $D8Jar com.android.tools.r8.R8 --release --min-api 26 --lib $AndroidJar --output (Join-Path $Build 'dex') --pg-conf $R8Conf $ClassFiles
Step $LASTEXITCODE 'R8'

Write-Host '[5/7] 把 classes.dex 打进 APK ...'
$apkPath = Join-Path $Build 'app-unsigned.apk'
$dexPath = Join-Path $Build 'dex\classes.dex'
if (!(Test-Path $dexPath)) { throw 'classes.dex 未生成，d8 失败' }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($apkPath, [System.IO.Compression.ZipArchiveMode]::Update)
try {
    $old = $zip.GetEntry('classes.dex')
    if ($old) { $old.Delete() }
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $dexPath, 'classes.dex', [System.IO.Compression.CompressionLevel]::Optimal)
} finally {
    $zip.Dispose()
}
$chk = [System.IO.Compression.ZipFile]::OpenRead($apkPath)
$hasDex = ($null -ne $chk.GetEntry('classes.dex'))
$chk.Dispose()
if (-not $hasDex) { throw 'classes.dex 没有写进 APK' }

Write-Host '[6/7] zipalign ...'
& (Join-Path $Bt 'zipalign.exe') -f -p 4 $apkPath (Join-Path $Build 'app-aligned.apk')
Step $LASTEXITCODE 'zipalign'

Write-Host '[7/7] 签名 ...'
$Ks = Join-Path $Build 'demo.keystore'
if (!(Test-Path $Ks)) {
    & (Join-Path $Jdk 'bin\keytool.exe') -genkeypair -v -keystore $Ks -alias classroom -keyalg RSA -keysize 2048 -validity 10950 -storepass classroom2026 -keypass classroom2026 -dname 'CN=Classroom Demo, OU=SCZZM, O=SCZZM, L=Beijing, ST=Beijing, C=CN'
    Step $LASTEXITCODE 'keytool'
}
$ApkStage = Join-Path $Build 'classroom-demo.apk'
& (Join-Path $Bt 'apksigner.bat') sign --ks $Ks --ks-key-alias classroom --ks-pass pass:classroom2026 --key-pass pass:classroom2026 --out $ApkStage (Join-Path $Build 'app-aligned.apk')
Step $LASTEXITCODE 'apksigner'

$chk2 = [System.IO.Compression.ZipFile]::OpenRead($ApkStage)
$hasDex2 = ($null -ne $chk2.GetEntry('classes.dex'))
$chk2.Dispose()
if (-not $hasDex2) { throw '签名后的 APK 内没有 classes.dex' }

New-Item -ItemType Directory -Force -Path $Dist | Out-Null
$Apk = Join-Path $Dist '课堂助手-演示.apk'
Copy-Item -Force $ApkStage $Apk

Write-Host ''
Write-Host '=== 验签 ==='
& (Join-Path $Bt 'apksigner.bat') verify --print-certs $ApkStage

Write-Host ''
Write-Host '=== APK 信息 ==='
& (Join-Path $Bt 'aapt2.exe') dump badging $ApkStage

Write-Host ''
$sizeKb = [Math]::Round((Get-Item $Apk).Length / 1KB)
Write-Host ('产物: ' + $Apk + '  大小: ' + $sizeKb + ' KB  classes.dex=ok')