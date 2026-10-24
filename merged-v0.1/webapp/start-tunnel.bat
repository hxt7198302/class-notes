@echo off
chcp 65001 >nul
title Classroom Assistant - HTTPS Tunnel
echo.
echo  Starting HTTPS tunnel for http://127.0.0.1:3003 ...
echo.
set "CF=%~dp0cloudflared.exe"
if not exist "%CF%" (
  where cloudflared >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] cloudflared.exe not found.
    echo Download: https://github.com/cloudflare/cloudflared/releases/latest
    echo Put cloudflared.exe next to this file, or install it to PATH.
    pause
    exit /b 1
  )
  set "CF=cloudflared"
)
echo  Wait until it prints:  https://xxxx.trycloudflare.com
echo  Open that address on your phone (HTTPS is required for microphone).
echo.
"%CF%" tunnel --url http://127.0.0.1:3003 --no-autoupdate
pause >nul