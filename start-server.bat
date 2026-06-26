@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo Preview server (production build)
echo URL http://localhost:5180/YX/
echo.

set "NPM_CONFIG_DEVDIR="
set "npm_config_devdir="

call npm install
if errorlevel 1 pause & exit /b 1
call npm run build -- --base /YX/
if errorlevel 1 pause & exit /b 1
call npm run preview
pause
