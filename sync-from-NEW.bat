@echo off
chcp 65001 >nul
setlocal

set "SRC=%~dp0..\NEW"
set "DST=%~dp0."
cd /d "%DST%"

if not exist "%SRC%\package.json" (
  echo [ERROR] NEW folder not found: %SRC%
  pause
  exit /b 1
)

echo Sync NEW -^> YX
echo   From: %SRC%
echo   To:   %CD%
echo.

robocopy "%SRC%" "%CD%" /E /XD node_modules dist .git _geology_docx_extract /XF git-push.bat deploy-github.bat sync-from-NEW.bat start-dev.bat start-server.bat /NFL /NDL /NJH /NJS

set "RC=%ERRORLEVEL%"
rem robocopy 0-7 = success, 8+ = error
if %RC% GEQ 8 (
  echo [ERROR] robocopy failed, code %RC%
  pause
  exit /b 1
)

echo.
echo Sync done.
exit /b 0
