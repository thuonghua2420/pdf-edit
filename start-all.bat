@echo off
setlocal

cd /d "%~dp0"
title Support PDF - Servers

echo.
echo Starting Support PDF...
echo Project: %CD%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed or is not in PATH.
  echo Install Node.js, then run this file again.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm is not installed or is not in PATH.
  echo Install Node.js, then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo.
    echo ERROR: npm install failed.
    pause
    exit /b 1
  )
  echo.
)

echo Client: http://127.0.0.1:5173
echo API:    http://127.0.0.1:8787
echo.
echo Keep this window open while using the app.
echo Press Ctrl+C in this window to stop the servers.
echo.

start "Open Support PDF" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://127.0.0.1:5173'"

call npm run dev

echo.
echo Servers stopped.
pause
