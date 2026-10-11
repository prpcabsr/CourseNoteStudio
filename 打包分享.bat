@echo off
rem Pure ASCII on purpose (see the launcher bat for the reason).
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

type "messages\pack-head.txt"
echo.
node app\pack-share.mjs
echo.
type "messages\pack-done.txt"
pause
exit /b 0

:nonode
type "messages\node-missing.txt"
pause
exit /b 1
