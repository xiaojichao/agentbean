# THROWAWAY PROTOTYPE for #676. Preserves installation across real Windows sessions.
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('install', 'check', 'remove')]
  [string]$Action,
  [ValidateSet('initial', 'wake', 'login', 'reboot', 'manual')]
  [string]$Checkpoint = 'manual'
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-StrictMode -Version Latest
if (-not $IsWindows -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'WINDOWS_X64_REQUIRED' }

$prototypeRoot = $PSScriptRoot
$installedExe = Join-Path $env:LOCALAPPDATA 'AgentBean\DeviceServicePrototype\agentbean-windows-service-prototype.exe'
$installerRoot = Join-Path $env:LOCALAPPDATA 'AgentBean\DeviceServicePrototypeInstaller'
$persistentMsi = Join-Path $installerRoot 'agentbean-windows-service-prototype.msi'

if ($Action -eq 'check') {
  if (-not (Test-Path $installedExe)) { throw 'PER_USER_PAYLOAD_MISSING' }
  & $installedExe session-check $Checkpoint
  exit 0
}

if ($Action -eq 'remove') {
  if (Test-Path $installedExe) { & $installedExe uninstall }
  if (Test-Path $persistentMsi) {
    $uninstall = Start-Process msiexec.exe -ArgumentList @('/x', $persistentMsi, '/qn', '/norestart') -Wait -PassThru
    if ($uninstall.ExitCode -ne 0) { throw "MSI_UNINSTALL_FAILED_$($uninstall.ExitCode)" }
  }
  if (Test-Path $installedExe) { throw 'PER_USER_PAYLOAD_REMAINED' }
  if (Test-Path $persistentMsi) { Remove-Item -LiteralPath $persistentMsi -Force }
  exit 0
}

if (Test-Path $installedExe) { throw 'PROTOTYPE_ALREADY_INSTALLED' }
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ('agentbean-windows-service-session-' + [guid]::NewGuid().ToString('N'))
$publish = Join-Path $scratch 'publish'
$tool = Join-Path $scratch 'tools'
try {
  New-Item -ItemType Directory -Force -Path $publish, $tool, $installerRoot | Out-Null
  dotnet publish (Join-Path $prototypeRoot 'AgentBean.WindowsServicePrototype.csproj') -c Release -o $publish
  dotnet tool install wix --tool-path $tool --version 4.0.6
  & (Join-Path $tool 'wix.exe') build (Join-Path $prototypeRoot 'Package.wxs') -arch x64 -d "PayloadDir=$publish" -o $persistentMsi
  $installLog = Join-Path $installerRoot 'install.log'
  $install = Start-Process msiexec.exe -ArgumentList @('/i', $persistentMsi, '/qn', '/norestart', '/l*v', $installLog) -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "MSI_INSTALL_FAILED_$($install.ExitCode)" }
  if (-not (Test-Path $installedExe)) { throw 'PER_USER_PAYLOAD_MISSING' }
  & $installedExe install
  & $installedExe session-check initial
}
finally {
  if (Test-Path $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
}
