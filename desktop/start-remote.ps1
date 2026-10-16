# DeepSeek Harness Remote - start the phone-remote companion.
#
# Run from your own desktop session (double-click start-desktop.cmd, or
# right-click this file -> Run with PowerShell).
#
# What it does:
#   1. stops any previous instance, so the single-instance lock cannot silently
#      swallow the launch (which looks exactly like "nothing happened"),
#   2. starts the companion detached, pinned to the permanent hostname,
#   3. waits for the gateway to actually report a port, then verifies the public
#      address answers,
#   4. registers login auto-start.
#
# Parameters:
#   -NoAutoStart         launch only; do not register login auto-start
#   -UninstallAutoStart  remove login auto-start and exit
#
# Written for Windows PowerShell 5.1 (the default on this machine), so it avoids
# 7.x-only switch parameters.

[CmdletBinding()]
param(
  [switch]$NoAutoStart,
  [switch]$UninstallAutoStart
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$AppDir = $PSScriptRoot
$Electron = Join-Path $AppDir 'node_modules\electron\dist\electron.exe'
$Hostname = 'dsh.xinqiaopsy.top'
$StateDir = Join-Path $env:APPDATA 'deepseek-harness-remote-desktop'
$NamedConfig = Join-Path $StateDir 'cloudflared-named.yml'
$LogFile = Join-Path $StateDir 'logs\remote.log'
$StartupDir = [Environment]::GetFolderPath('Startup')
$LauncherPath = Join-Path $StartupDir 'DeepSeek Harness Remote.cmd'

function Write-Step([string]$Message) { Write-Host "  $Message" }

# Ask the address for its status code without throwing on 4xx/5xx.
# Invoke-WebRequest -SkipHttpErrorCheck is 7.x-only, and this machine's
# `powershell.exe` is 5.1, where a 401 arrives as an exception instead.
function Get-HttpStatus([string]$Uri) {
  try {
    $response = Invoke-WebRequest -Uri $Uri -TimeoutSec 30 -UseBasicParsing
    return [int]$response.StatusCode
  } catch {
    $response = $_.Exception.Response
    if ($null -ne $response) { return [int]$response.StatusCode }
    return $null
  }
}

# --- uninstall path ---------------------------------------------------------

if ($UninstallAutoStart) {
  if (Test-Path -LiteralPath $LauncherPath) {
    Remove-Item -LiteralPath $LauncherPath -Force
    Write-Host "Removed auto-start: $LauncherPath"
  } else {
    Write-Host 'Auto-start was not installed.'
  }
  return
}

# --- preflight --------------------------------------------------------------

if (-not (Test-Path -LiteralPath $Electron -PathType Leaf)) {
  throw "Electron not found at $Electron. Run 'npm ci' in $AppDir first."
}

# Without this, require('electron') returns undefined and the app dies before it
# can log anything.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

Write-Host 'DeepSeek Harness Remote'
Write-Host ''

# --- stop a previous instance ----------------------------------------------

Write-Host 'Stopping any previous instance...'
$stopped = 0
Get-Process -Name electron -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    Stop-Process -Id $_.Id -Force -ErrorAction Stop
    $stopped += 1
  } catch {
    # A process that vanished between enumeration and stop is fine.
  }
}
if ($stopped -gt 0) { Write-Step "stopped $stopped process(es)" } else { Write-Step 'none running' }

# cloudflared is started as a child, but it survives a hard kill and would then
# hold the hostname against the new instance.
Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*deepseek-harness-remote-desktop*' } |
  ForEach-Object {
    try {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
      Write-Step "stopped leftover tunnel (pid $($_.ProcessId))"
    } catch {
    }
  }

Start-Sleep -Milliseconds 900

# --- start ------------------------------------------------------------------

Write-Host ''
Write-Host 'Starting...'
$process = Start-Process -FilePath $Electron `
  -ArgumentList @($AppDir, '--hostname', $Hostname) `
  -WorkingDirectory $AppDir -PassThru
Write-Step "pid $($process.Id), permanent hostname $Hostname"

# --- auto-start -------------------------------------------------------------

if (-not $NoAutoStart) {
  New-Item -ItemType Directory -Force -Path $StartupDir | Out-Null
  $launcherBody = @"
@echo off
rem Installed by start-remote.ps1. Delete this file, or run
rem   powershell -File "$AppDir\start-remote.ps1" -UninstallAutoStart
rem to stop launching the phone-remote companion at login.
powershell -NoProfile -ExecutionPolicy Bypass -File "$AppDir\start-remote.ps1" -NoAutoStart
"@
  Set-Content -LiteralPath $LauncherPath -Value $launcherBody -Encoding ASCII
  Write-Step "auto-start registered: $(Split-Path $LauncherPath -Leaf)"
}

# --- wait for the gateway ---------------------------------------------------
# The gateway picks an ephemeral port and rewrites the named-tunnel config, so
# the port is read from that config only after the app has written it. Reading a
# stale port here is what makes a healthy launch look broken.

Write-Host ''
Write-Host 'Waiting for the gateway...'
$port = $null
for ($attempt = 1; $attempt -le 40; $attempt += 1) {
  Start-Sleep -Milliseconds 1000
  if (-not (Test-Path -LiteralPath $NamedConfig)) { continue }
  $match = [regex]::Match((Get-Content -LiteralPath $NamedConfig -Raw), 'service:\s*http://127\.0\.0\.1:(\d+)')
  if (-not $match.Success) { continue }
  $candidate = [int]$match.Groups[1].Value
  # Only accept it once something is really listening there.
  $listening = Get-NetTCPConnection -State Listen -LocalPort $candidate -ErrorAction SilentlyContinue
  if ($listening) { $port = $candidate; break }
}

if ($null -eq $port) {
  Write-Warning 'The gateway did not start listening within 40s.'
  Write-Host "  Log: $LogFile"
  return
}
Write-Step "gateway listening on 127.0.0.1:$port"

# --- verify the public address ---------------------------------------------

Write-Host 'Verifying the public address...'
$status = Get-HttpStatus -Uri "https://$Hostname/"
if ($null -eq $status) {
  Write-Warning "https://$Hostname did not answer at all."
  Write-Host '  Usually the local VPN intercepting the domain. The phone is unaffected unless it is on the same VPN.'
} elseif ($status -eq 401) {
  Write-Step "HTTP 401 - correct: no phone is paired yet, the gateway is guarding itself"
} else {
  Write-Step "HTTP $status"
}

# --- summary ----------------------------------------------------------------

Write-Host ''
Write-Host 'Ready.'
Write-Host ''
Write-Host "  Permanent address : https://$Hostname"
Write-Host '  App window        : "DeepSeek Harness 手机远程"'
Write-Host '  Tray menu         : right-click the DeepSeek icon in the notification area'
Write-Host '  Log               : '"$LogFile"
Write-Host ''
Write-Host 'Next: open the app window, click 配对新手机, then scan the QR code with the phone app.'
