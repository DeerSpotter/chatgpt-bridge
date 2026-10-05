@echo off
setlocal
cd /d "%~dp0"
title ChatGPT Web Codex Agent

echo [local] ChatGPT web model + Codex local tool harness
echo [local] One launcher owns the web provider, local adapter, and Codex lifecycle.
echo [local] First run bootstraps a pinned portable Bun runtime and chatgpt-web-provider.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [local] ERROR: Node.js 20+ was not found on PATH.
  pause
  exit /b 1
)

node scripts\provider-chrome-preflight.js
if errorlevel 1 (
  echo.
  echo [local] Browser preflight failed.
  pause
  exit /b 1
)

node scripts\codex-web-provider-local.js %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [local] Agent exited with code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%
