@echo off
chcp 65001 >nul
cd /d "%~dp0."
if errorlevel 1 (
  echo [ERROR] Cannot open folder
  pause
  exit /b 1
)

echo ========================================
echo   YX Preview (production build)
echo   URL  http://localhost:5180/YX/
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

call npm run build -- --base /YX/
if errorlevel 1 (
  echo [ERROR] build failed
  pause
  exit /b 1
)

call npm run preview
echo.
echo Preview stopped.
pause
