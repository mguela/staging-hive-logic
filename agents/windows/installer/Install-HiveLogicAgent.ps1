[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [string]$InstallPath = "$env:ProgramFiles\HiveLogic Agent"
)

$principal = New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this installer from an elevated PowerShell window.'
}
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
  throw "Config file not found: $ConfigPath"
}
if (Get-Service -DisplayName 'HiveLogic Agent' -ErrorAction SilentlyContinue) {
  throw 'HiveLogic Agent is already installed. Remove or update the existing installation first.'
}
$node = Get-Command node.exe -ErrorAction SilentlyContinue
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) {
  throw 'Node.js 20 or newer is required. Install the current Node.js LTS release and run this installer again.'
}
$major = [int]((& $node.Source --version).TrimStart('v').Split('.')[0])
if ($major -lt 20) { throw 'Node.js 20 or newer is required.' }

$sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (Test-Path -LiteralPath $InstallPath) {
  throw "Install path already exists: $InstallPath"
}
New-Item -ItemType Directory -Path $InstallPath | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceRoot 'package.json') -Destination $InstallPath
Copy-Item -LiteralPath (Join-Path $sourceRoot 'src') -Destination $InstallPath -Recurse
Copy-Item -LiteralPath (Join-Path $sourceRoot 'scripts') -Destination $InstallPath -Recurse
Copy-Item -LiteralPath $ConfigPath -Destination (Join-Path $InstallPath 'config.json')

Push-Location $InstallPath
try {
  & $npm.Source install --omit=dev
  if ($LASTEXITCODE -ne 0) { throw 'Agent dependency installation failed.' }
  & $npm.Source run enroll -- (Join-Path $InstallPath 'config.json')
  if ($LASTEXITCODE -ne 0) { throw 'Agent enrollment failed.' }
  & $npm.Source run service:install
  if ($LASTEXITCODE -ne 0) { throw 'Windows service installation failed.' }
} finally {
  Pop-Location
}
Write-Host 'HiveLogic Agent installed. Verify this computer appears online in HiveLogic Devices.'
