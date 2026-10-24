@echo off
title Classroom Assistant (keep this window open)
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 18+ first.
  pause
  exit /b 1
)

echo [info] starting Classroom Assistant on http://127.0.0.1:3003 ...
start "" /min powershell -NoProfile -Command "for($i=0;$i -lt 120;$i++){try{$t=New-Object Net.Sockets.TcpClient('127.0.0.1',3003);$t.Close();break}catch{Start-Sleep -m 500}};Start-Process 'http://127.0.0.1:3003/'"

node server.js
echo.
echo Server exited. Press any key to close.
pause >nul
