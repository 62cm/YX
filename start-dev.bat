@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo Dev server - sync from NEW first if code changed
echo URL http://localhost:5180
echo.

set "NPM_CONFIG_DEVDIR="
set "npm_config_devdir="

call npm install
if errorlevel 1 pause & exit /b 1
call npm run dev
pause
