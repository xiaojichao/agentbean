# THROWAWAY PROTOTYPE for #677. Creates an ephemeral non-admin account on a hosted Windows runner.
param(
  [switch]$Inner,
  [string]$IsolationTarget,
  [string]$ProbeDll
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-StrictMode -Version Latest

$prototypeRoot = $PSScriptRoot
$workspace = Resolve-Path (Join-Path $prototypeRoot '..\..\..\..')
$evidence = Join-Path $workspace 'phase5-windows-credential-standard-user-evidence'

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

  whoami.exe /all | Out-File -LiteralPath (Join-Path $evidence 'identity.txt') -Encoding utf8
  & dotnet.exe $ProbeDll --assert-isolation $IsolationTarget
  if ($LASTEXITCODE -ne 0) { throw "STANDARD_USER_ISOLATION_FAILED_$LASTEXITCODE" }
  & dotnet.exe $ProbeDll
  if ($LASTEXITCODE -ne 0) { throw "STANDARD_USER_CREDENTIAL_PROBE_FAILED_$LASTEXITCODE" }
  exit 0
}

$currentPrincipal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'HOSTED_ADMIN_HARNESS_REQUIRED'
}

$user = 'ABCred' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$passwordText = 'Ab9!' + [guid]::NewGuid().ToString('N').Substring(0, 16)
$securePassword = ConvertTo-SecureString $passwordText -AsPlainText -Force
$principal = "$env:COMPUTERNAME\$user"
$isolationTargetValue = "AgentBean/prototype/$([guid]::NewGuid().ToString('N'))/g1"
$project = Join-Path $prototypeRoot 'WindowsCredentialProbe.csproj'
$publishRoot = Join-Path $evidence 'publish'
$probeDllPath = Join-Path $publishRoot 'WindowsCredentialProbe.dll'

try {
  New-Item -ItemType Directory -Force -Path $evidence, $publishRoot | Out-Null
  dotnet publish $project --configuration Release --output $publishRoot
  if ($LASTEXITCODE -ne 0) { throw "PROBE_PUBLISH_FAILED_$LASTEXITCODE" }
  & dotnet.exe $probeDllPath --seed-isolation $isolationTargetValue
  if ($LASTEXITCODE -ne 0) { throw "ISOLATION_SEED_FAILED_$LASTEXITCODE" }

  New-LocalUser -Name $user -Password $securePassword -AccountNeverExpires -PasswordNeverExpires | Out-Null
  icacls.exe $workspace /grant "${principal}:(OI)(CI)RX" /C | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "WORKSPACE_READ_ACL_FAILED_$LASTEXITCODE" }
  icacls.exe $evidence /grant "${principal}:(OI)(CI)M" /T /C | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "EVIDENCE_WRITE_ACL_FAILED_$LASTEXITCODE" }

  $credential = [pscredential]::new($principal, $securePassword)
  $stdout = Join-Path $evidence 'process-stdout.txt'
  $stderr = Join-Path $evidence 'process-stderr.txt'
  $arguments = "-NoProfile -File `"$PSCommandPath`" -Inner -IsolationTarget `"$isolationTargetValue`" -ProbeDll `"$probeDllPath`""
  $process = Start-Process -FilePath (Get-Command pwsh.exe).Source `
    -ArgumentList $arguments `
    -Credential $credential `
    -LoadUserProfile `
    -WorkingDirectory $workspace `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru
  $process.WaitForExit()
  Get-Content -LiteralPath $stdout
  if (Test-Path $stderr) { Get-Content -LiteralPath $stderr }
  if ($process.ExitCode -ne 0) { throw "STANDARD_USER_PROCESS_FAILED_$($process.ExitCode)" }
}
finally {
  try { & dotnet.exe $probeDllPath --delete-isolation $isolationTargetValue 2>&1 | Out-Null } catch { }
  try { Remove-LocalUser -Name $user -ErrorAction SilentlyContinue } catch { }
  $passwordText = $null
  $securePassword.Dispose()
}
