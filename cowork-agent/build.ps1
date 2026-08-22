# Builds CoworkAgent.exe with the in-box .NET Framework C# compiler (csc).
# No SDK, NuGet, or admin rights required — csc ships with Windows.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path $here 'CoworkAgent.cs'
$out  = Join-Path $here 'CoworkAgent.exe'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw "csc.exe not found under $env:WINDIR\Microsoft.NET" }

# /target:winexe -> no console window; reference WinForms + Drawing for the banner.
& $csc /nologo /target:winexe /out:"$out" `
    /reference:System.Windows.Forms.dll `
    /reference:System.Drawing.dll `
    "$src"

if (Test-Path $out) { Write-Host "Built $out" } else { throw "Build failed" }
