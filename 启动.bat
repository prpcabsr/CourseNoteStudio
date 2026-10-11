@echo off
rem Pure ASCII on purpose: cmd.exe parses .bat with the system code page (GBK on
rem Chinese Windows), so any non-ASCII text here would be mangled. Chinese
rem messages live in messages\*.txt (UTF-8) and are printed with `type`, which
rem outputs raw bytes and shows correctly once the code page is 65001.
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

if not exist "node_modules\katex\package.json" (
  type "messages\installing-deps.txt"
  call npm install --omit=dev --no-audit --no-fund --loglevel=error
  if errorlevel 1 goto npmfail
)

type "messages\starting.txt"
echo.
node app\main.mjs serve --port 7788 %*
if errorlevel 1 goto startfail
exit /b 0

:nonode
type "messages\node-missing.txt"
pause
exit /b 1

:npmfail
type "messages\npm-failed.txt"
pause
exit /b 1

:startfail
type "messages\start-failed.txt"
pause
exit /b 1
