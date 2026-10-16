@echo off
rem DeepSeek Harness Remote - desktop companion launcher
rem
rem WHY THIS FILE EXISTS
rem The companion is a GUI app: it owns a tray icon and a pairing window. An
rem automated session cannot keep it alive, because the process is a child of the
rem controlling shell and dies with it. Run this from your own desktop session
rem (double-click, or from a normal PowerShell window) so it stays up.
rem
rem The harness port is auto-discovered (19387 first, then any port a Harness
rem process actually holds). The permanent hostname is pinned so the pairing QR
rem carries https://dsh.xinqiaopsy.top instead of a throwaway address.

setlocal
set "APPDIR=F:\dsh-remote-build\desktop"
set "ELECTRON=%APPDIR%\node_modules\electron\dist\electron.exe"

rem A harness-set variable that makes require('electron') return undefined.
set "ELECTRON_RUN_AS_NODE="

if not exist "%ELECTRON%" (
  echo [ERROR] Electron not found at:
  echo         %ELECTRON%
  echo         Run "npm ci" in %APPDIR% first.
  pause
  exit /b 1
)

echo Starting DeepSeek Harness Remote...
echo   upstream : auto-discovered (falls back to 32145 if none answers)
echo   hostname : dsh.xinqiaopsy.top  (permanent)
echo.
echo A tray icon should appear. Right-click it for the phone-remote menu.
echo Close this window if you like; the app keeps running in the tray.
echo.

start "" "%ELECTRON%" "%APPDIR%" --hostname dsh.xinqiaopsy.top
endlocal
