@echo off
chcp 65001 >nul
cd /d "%~dp0."
if errorlevel 1 (
  echo [ERROR] Cannot open folder
  pause
  exit /b 1
)

echo ========================================
echo   YX Dev Server
echo   URL  http://localhost:5180
echo ========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] node not found - install Node.js first
  pause
  exit /b 1
)

set "NPM_CONFIG_DEVDIR="
set "npm_config_devdir="

call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed
  pause
  exit /b 1
)

call npm run dev
echo.
echo Dev server stopped.
pause
