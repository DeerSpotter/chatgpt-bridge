@echo off
setlocal
cd /d "%~dp0"
title ChatGPT Local Codex Agent

echo [local] ChatGPT web session + Codex local harness
echo [local] One launcher: starts the local bridge if needed, then starts Codex.
echo [local] Existing signed-in Chrome session is reused; no second ChatGPT login is required.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [local] ERROR: Node.js was not found on PATH.
  pause
  exit /b 1
)

node scripts\codex-local.js %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [local] Agent exited with code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%
