@echo off
rem Pure ASCII on purpose (see the launcher bat for the reason).
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

type "messages\install-head.txt"
echo.
node app\fetch-tools.mjs --all
echo.
pause
exit /b 0

:nonode
type "messages\node-missing.txt"
pause
exit /b 1
