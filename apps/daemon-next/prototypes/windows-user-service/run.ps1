# THROWAWAY PROTOTYPE for #676. Run in a normal, non-elevated Windows x64 session.
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-StrictMode -Version Latest
if (-not $IsWindows -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'WINDOWS_X64_REQUIRED' }

$prototypeRoot = $PSScriptRoot
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ('agentbean-windows-service-' + [guid]::NewGuid().ToString('N'))
$publish = Join-Path $scratch 'publish'
$tool = Join-Path $scratch 'tools'
$msi = Join-Path $scratch 'agentbean-windows-service-prototype.msi'
$installedExe = Join-Path $env:LOCALAPPDATA 'AgentBean\DeviceServicePrototype\agentbean-windows-service-prototype.exe'
try {
  New-Item -ItemType Directory -Force -Path $publish, $tool | Out-Null
  dotnet publish (Join-Path $prototypeRoot 'AgentBean.WindowsServicePrototype.csproj') -c Release -o $publish
  dotnet tool install wix --tool-path $tool --version 4.0.6
  & (Join-Path $tool 'wix.exe') build (Join-Path $prototypeRoot 'Package.wxs') -arch x64 -d "PayloadDir=$publish" -o $msi
  $install = Start-Process msiexec.exe -ArgumentList @('/i', $msi, '/qn', '/norestart', '/l*v', (Join-Path $scratch 'install.log')) -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "MSI_INSTALL_FAILED_$($install.ExitCode)" }
  if (-not (Test-Path $installedExe)) { throw 'PER_USER_PAYLOAD_MISSING' }
  & $installedExe verify
  $uninstall = Start-Process msiexec.exe -ArgumentList @('/x', $msi, '/qn', '/norestart', '/l*v', (Join-Path $scratch 'uninstall.log')) -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) { throw "MSI_UNINSTALL_FAILED_$($uninstall.ExitCode)" }
  if (Test-Path $installedExe) { throw 'PER_USER_PAYLOAD_REMAINED' }
}
finally {
  if (Test-Path $installedExe) { try { & $installedExe uninstall } catch { } }
  if (Test-Path $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
}
