param([Parameter(Mandatory = $true)][string]$Path)
$protected = [IO.File]::ReadAllBytes($Path)
$bytes = [Security.Cryptography.ProtectedData]::Unprotect(
  $protected,
  $null,
  [Security.Cryptography.DataProtectionScope]::LocalMachine
)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
