@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

cd /d "%~dp0"

echo ========================================
echo   Deploy to GitHub Pages
echo   Repo  https://github.com/62cm/YX
echo   Site  https://62cm.github.io/YX/
echo ========================================
echo.

where git >nul 2>&1
if errorlevel 1 (
  echo [ERROR] git not found
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] node not found
  pause
  exit /b 1
)

echo [1/4] Sync from NEW folder ...
call "%~dp0sync-from-NEW.bat"
if errorlevel 1 exit /b 1

if not exist ".git" (
  echo.
  echo [INIT] First run - creating git repo ...
  git init
  git branch -M main
  git remote add origin https://github.com/62cm/YX.git
)

echo.
echo [2/4] Local build test (base /YX/) ...
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
  echo [ERROR] build failed - fix before push
  pause
  exit /b 1
)

echo.
echo [3/4] git add and commit ...
git -c core.safecrlf=false add -A 2>nul
git status -sb

set "MSG=deploy from NEW"
set /p MSG=Commit message (Enter=default): 
if "!MSG!"=="" set "MSG=deploy from NEW"

git commit -m "!MSG!"
if errorlevel 1 (
  echo [NOTE] nothing new to commit, will still try push ...
)

echo.
echo [4/4] git push origin main ...
git push -u origin main
if errorlevel 1 (
  echo.
  echo [ERROR] push failed.
  echo If repo does not exist yet, run once:
  echo   gh repo create YX --public --source=. --remote=origin --push
  echo Or create https://github.com/62cm/YX manually then push again.
  pause
  exit /b 1
)

echo.
echo ========================================
echo   OK. Wait 1-3 min for GitHub Actions.
echo   Then open: https://62cm.github.io/YX/
echo   Hard refresh: Ctrl+F5
echo ========================================
pause
endlocal
