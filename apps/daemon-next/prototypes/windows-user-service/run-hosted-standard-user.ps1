# THROWAWAY PROTOTYPE for #676. Creates an ephemeral non-admin account on a hosted Windows runner.
param([switch]$Inner)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-StrictMode -Version Latest

$prototypeRoot = $PSScriptRoot
$workspace = Resolve-Path (Join-Path $prototypeRoot '..\..\..\..')
$evidence = Join-Path $workspace 'phase5-windows-standard-user-evidence'

if ($Inner) {
  $env:AGENTBEAN_WINDOWS_PROTOTYPE_EVIDENCE_DIR = $evidence
  whoami.exe /all | Out-File -LiteralPath (Join-Path $evidence 'identity.txt') -Encoding utf8
  Set-Location $workspace
  npm run prototype:phase5-windows-service 2>&1 |
    Tee-Object -FilePath (Join-Path $evidence 'verdict.txt')
  if ($LASTEXITCODE -ne 0) { throw "STANDARD_USER_PROTOTYPE_FAILED_$LASTEXITCODE" }
  exit 0
}

$user = 'AgentBeanProbe'
$password = 'Ab9!' + [guid]::NewGuid().ToString('N')
$principal = "$env:COMPUTERNAME\$user"
try {
  net.exe user $user $password /add /expires:never /passwordchg:no | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "STANDARD_USER_CREATE_FAILED_$LASTEXITCODE" }
  New-Item -ItemType Directory -Force -Path $evidence | Out-Null
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
  try { net.exe user $user /delete | Out-Null } catch { }
}
