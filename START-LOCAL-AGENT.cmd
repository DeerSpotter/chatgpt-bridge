@echo off
setlocal
cd /d "%~dp0"
title ChatGPT Local Codex Agent

echo [local] ChatGPT Playwright + Codex launcher

where node >nul 2>nul
if errorlevel 1 (
  echo [local] ERROR: Node.js was not found on PATH.
  pause
  exit /b 1
)

if not exist "node_modules\playwright\package.json" (
  echo [local] Installing local Playwright runtime 1.63.0...
  call npm install --no-save --package-lock=false playwright@1.63.0
  if errorlevel 1 (
    echo [local] ERROR: Playwright installation failed.
    pause
    exit /b 1
  )
)

node scripts\codex-playwright-local.js %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [local] Agent exited with code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%
