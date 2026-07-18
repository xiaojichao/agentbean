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
$evidence = if ($env:AGENTBEAN_WINDOWS_PROTOTYPE_EVIDENCE_DIR) {
  $env:AGENTBEAN_WINDOWS_PROTOTYPE_EVIDENCE_DIR
} else {
  Join-Path $scratch 'evidence'
}
$installLog = Join-Path $evidence 'install.log'
$uninstallLog = Join-Path $evidence 'uninstall.log'
$taskXml = Join-Path $evidence 'task.xml'
$taskInfo = Join-Path $evidence 'task-info.txt'
$taskEvents = Join-Path $evidence 'task-scheduler-operational.txt'
try {
  New-Item -ItemType Directory -Force -Path $publish, $tool, $evidence | Out-Null
  dotnet publish (Join-Path $prototypeRoot 'AgentBean.WindowsServicePrototype.csproj') -c Release -o $publish
  $publishedExe = Join-Path $publish 'agentbean-windows-service-prototype.exe'
  & $publishedExe install
  & $publishedExe uninstall
  dotnet tool install wix --tool-path $tool --version 4.0.6
  & (Join-Path $tool 'wix.exe') build (Join-Path $prototypeRoot 'Package.wxs') -arch x64 -d "PayloadDir=$publish" -o $msi
  $install = Start-Process msiexec.exe -ArgumentList @('/i', $msi, '/qn', '/norestart', '/l*v', $installLog) -Wait -PassThru
  if ($install.ExitCode -ne 0) {
    Get-Content -LiteralPath $installLog -Tail 160
    throw "MSI_INSTALL_FAILED_$($install.ExitCode)"
  }
  if (-not (Test-Path $installedExe)) { throw 'PER_USER_PAYLOAD_MISSING' }
  & $installedExe install
  & $installedExe verify
  & $installedExe uninstall
  $uninstall = Start-Process msiexec.exe -ArgumentList @('/x', $msi, '/qn', '/norestart', '/l*v', $uninstallLog) -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) {
    Get-Content -LiteralPath $uninstallLog -Tail 160
    throw "MSI_UNINSTALL_FAILED_$($uninstall.ExitCode)"
  }
  if (Test-Path $installedExe) { throw 'PER_USER_PAYLOAD_REMAINED' }
}
catch {
  try {
    Export-ScheduledTask -TaskName 'AgentBean Device Service Prototype' | Out-File -LiteralPath $taskXml -Encoding utf8
    Get-ScheduledTaskInfo -TaskName 'AgentBean Device Service Prototype' | Format-List * | Out-File -LiteralPath $taskInfo -Encoding utf8
  } catch { }
  try {
    wevtutil.exe qe Microsoft-Windows-TaskScheduler/Operational /q:"*[System[TimeCreated[timediff(@SystemTime) <= 900000]]]" /rd:true /f:text 2>&1 |
      Out-File -LiteralPath $taskEvents -Encoding utf8
  } catch { }
  throw
}
finally {
  if (Test-Path $installedExe) { try { & $installedExe uninstall } catch { } }
  if (Test-Path $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
}
