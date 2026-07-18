# THROWAWAY PROTOTYPE for #677.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $IsWindows -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
  throw 'WINDOWS_X64_REQUIRED'
}

$project = Join-Path $PSScriptRoot 'WindowsCredentialProbe.csproj'
dotnet run --configuration Release --project $project
