param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$Value
)
$bytes = [Text.Encoding]::UTF8.GetBytes($Value)
$protected = [Security.Cryptography.ProtectedData]::Protect(
  $bytes,
  $null,
  [Security.Cryptography.DataProtectionScope]::LocalMachine
)
[IO.File]::WriteAllBytes($Path, $protected)
$acl = Get-Acl -LiteralPath $Path
$acl.SetAccessRuleProtection($true, $false)
$admins = New-Object Security.AccessControl.FileSystemAccessRule(
  'BUILTIN\Administrators', 'FullControl', 'Allow'
)
$system = New-Object Security.AccessControl.FileSystemAccessRule(
  'NT AUTHORITY\SYSTEM', 'FullControl', 'Allow'
)
$acl.AddAccessRule($admins)
$acl.AddAccessRule($system)
Set-Acl -LiteralPath $Path -AclObject $acl
