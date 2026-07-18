# THROWAWAY PROTOTYPE for #676. Creates an ephemeral non-admin account on a hosted Windows runner.
param([switch]$Inner)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-StrictMode -Version Latest

$prototypeRoot = $PSScriptRoot
$workspace = Resolve-Path (Join-Path $prototypeRoot '..\..\..\..')
$evidence = Join-Path $workspace 'phase5-windows-standard-user-evidence'

if ($Inner) {
  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name.Split('\')[-1]
  $profileRoot = Join-Path $env:SystemDrive "Users\$currentUser"
  $localAppData = Join-Path $profileRoot 'AppData\Local'
  $roamingAppData = Join-Path $profileRoot 'AppData\Roaming'
  $tempRoot = Join-Path $localAppData 'Temp'
  New-Item -ItemType Directory -Force -Path $localAppData, $roamingAppData, $tempRoot | Out-Null
  $env:USERPROFILE = $profileRoot
  $env:LOCALAPPDATA = $localAppData
  $env:APPDATA = $roamingAppData
  $env:TEMP = $tempRoot
  $env:TMP = $tempRoot
  $env:DOTNET_CLI_HOME = Join-Path $profileRoot '.dotnet'
  $env:AGENTBEAN_WINDOWS_PROTOTYPE_EVIDENCE_DIR = $evidence
  [pscustomobject]@{
    UserProfile = $env:USERPROFILE
    LocalAppData = $env:LOCALAPPDATA
    Temp = $env:TEMP
    DotnetCliHome = $env:DOTNET_CLI_HOME
  } | Format-List | Out-File -LiteralPath (Join-Path $evidence 'environment.txt') -Encoding utf8
  whoami.exe /all | Out-File -LiteralPath (Join-Path $evidence 'identity.txt') -Encoding utf8
  Set-Location $workspace
  npm run prototype:phase5-windows-service 2>&1 |
    Tee-Object -FilePath (Join-Path $evidence 'verdict.txt')
  if ($LASTEXITCODE -ne 0) { throw "STANDARD_USER_PROTOTYPE_FAILED_$LASTEXITCODE" }
  exit 0
}

$user = 'AgentBeanProbe'
$password = 'Ab9!' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$principal = "$env:COMPUTERNAME\$user"
try {
  New-Item -ItemType Directory -Force -Path $evidence | Out-Null
  "creating $principal" | Out-File -LiteralPath (Join-Path $evidence 'harness-state.txt') -Encoding utf8
  net.exe user $user $password /add /expires:never /passwordchg:no | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "STANDARD_USER_CREATE_FAILED_$LASTEXITCODE" }
  icacls.exe $workspace /grant "${principal}:(OI)(CI)RX" /C | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "WORKSPACE_READ_ACL_FAILED_$LASTEXITCODE" }
  icacls.exe $prototypeRoot /grant "${principal}:(OI)(CI)M" /T /C | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "PROTOTYPE_WRITE_ACL_FAILED_$LASTEXITCODE" }
  icacls.exe $evidence /grant "${principal}:(OI)(CI)M" /T /C | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "EVIDENCE_WRITE_ACL_FAILED_$LASTEXITCODE" }

  $securePassword = ConvertTo-SecureString $password -AsPlainText -Force
  $credential = [pscredential]::new($principal, $securePassword)
  $stdout = Join-Path $evidence 'process-stdout.txt'
  $stderr = Join-Path $evidence 'process-stderr.txt'
  $arguments = "-NoProfile -File `"$PSCommandPath`" -Inner"
  $process = Start-Process -FilePath (Get-Command pwsh.exe).Source `
    -ArgumentList $arguments `
    -Credential $credential `
    -LoadUserProfile `
    -WorkingDirectory $workspace `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -Wait `
    -PassThru
  Get-Content -LiteralPath $stdout
  if (Test-Path $stderr) { Get-Content -LiteralPath $stderr }
  if ($process.ExitCode -ne 0) { throw "STANDARD_USER_PROCESS_FAILED_$($process.ExitCode)" }
}
finally {
  try {
    $nativePreference = $PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
    net.exe user $user /delete 2>&1 | Out-Null
    $PSNativeCommandUseErrorActionPreference = $nativePreference
  } catch { }
}
