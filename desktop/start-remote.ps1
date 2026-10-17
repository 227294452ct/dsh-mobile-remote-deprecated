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

# Verify the public address, preferring IPv6.
#
# A local VPN or TUN-mode proxy commonly breaks IPv4 TLS to Cloudflare while
# leaving IPv6 intact (and vice versa). Probing only one family reports a healthy
# tunnel as dead, so both are tried with a short deadline before giving up.
function Get-PublicStatus([string]$Uri) {
  $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
  if (-not (Test-Path -LiteralPath $curl)) { return Get-HttpStatus -Uri $Uri }
  foreach ($family in @('-6', '-4')) {
    try {
      $code = & $curl $family -s -o NUL -w '%{http_code}' --max-time 12 $Uri 2>$null
      $value = 0
      if ([int]::TryParse([string]$code, [ref]$value) -and $value -ne 0) { return $value }
    } catch {
      # Try the other address family.
    }
  }
  return $null
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
# The app holds a single-instance lock, so a survivor silently swallows the new
# launch: the window never appears and nothing is logged. Kill, then confirm the
# processes are actually gone before starting.

Write-Host 'Stopping any previous instance...'
$stopped = 0
for ($round = 1; $round -le 3; $round += 1) {
  $running = @(Get-Process -Name electron -ErrorAction SilentlyContinue)
  if ($running.Count -eq 0) { break }
  foreach ($candidate in $running) {
    try {
      Stop-Process -Id $candidate.Id -Force -ErrorAction Stop
      $stopped += 1
    } catch {
      # Already gone between enumeration and stop: fine.
    }
  }
  Start-Sleep -Milliseconds 700
}
$survivors = @(Get-Process -Name electron -ErrorAction SilentlyContinue)
if ($survivors.Count -gt 0) {
  Write-Step "stopped $stopped process(es), but $($survivors.Count) survived a force-kill"
  Write-Warning 'A surviving instance holds the single-instance lock; close it from Task Manager if the new launch does not appear.'
} elseif ($stopped -gt 0) {
  Write-Step "stopped $stopped process(es)"
} else {
  Write-Step 'none running'
}

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
# The gateway picks an ephemeral port, so it is read from the port the NEW
# process actually listens on. Reading the named-tunnel config would risk a stale
# port from a previous run, which makes a healthy launch look broken.

Write-Host ''
Write-Host 'Waiting for the gateway...'
$port = $null
for ($attempt = 1; $attempt -le 60; $attempt += 1) {
  Start-Sleep -Milliseconds 1000
  if ($process.HasExited) {
    Write-Warning "The app exited immediately (code $($process.ExitCode))."
    Write-Host '  This usually means another instance still held the single-instance lock.'
    Write-Host "  Log: $LogFile"
    return
  }
  $listening = Get-NetTCPConnection -State Listen -OwningProcess $process.Id -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::1', '::') } |
    Select-Object -First 1
  if ($listening) { $port = [int]$listening.LocalPort; break }
}

if ($null -eq $port) {
  Write-Warning 'The gateway did not start listening within 60s.'
  Write-Host "  Log: $LogFile"
  return
}
Write-Step "gateway listening on 127.0.0.1:$port"

# --- verify the public address ---------------------------------------------
# cloudflared registers a few seconds after the gateway. Checking too early
# reports a 502 from the Cloudflare edge, which looks like a failure when the
# setup is actually fine.

Write-Host 'Waiting for the tunnel to register...'
$status = $null
for ($attempt = 1; $attempt -le 30; $attempt += 1) {
  Start-Sleep -Milliseconds 1000
  $status = Get-PublicStatus -Uri "https://$Hostname/"
  # 502/530 mean the edge cannot reach the tunnel yet; anything else is a real answer.
  if ($null -ne $status -and $status -ne 502 -and $status -ne 530) { break }
}

if ($null -eq $status) {
  Write-Warning "https://$Hostname did not answer at all."
  Write-Host '  Usually the local VPN intercepting the domain. The phone is unaffected unless it is on the same VPN.'
} elseif ($status -eq 401) {
  Write-Step "public address answering (HTTP 401: no phone paired yet, the gateway is guarding itself)"
} elseif ($status -eq 502 -or $status -eq 530) {
  Write-Warning "The tunnel never registered (HTTP $status)."
  Write-Host "  Log: $LogFile"
} else {
  Write-Step "public address answering (HTTP $status)"
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
