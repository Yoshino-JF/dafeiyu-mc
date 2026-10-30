param([string]$OutputPath)
$ErrorActionPreference = 'Stop'
$clientRoot = Split-Path -Parent $PSScriptRoot
$playRoot = $clientRoot
if (-not $OutputPath) {
    # ASCII source also works when Windows PowerShell 5.1 reads this script without a BOM.
    $outputName = -join @([char]0x5927,[char]0x80A5,[char]0x9C7C,[char]0x542F,[char]0x52A8,[char]0x5668)
    $OutputPath = Join-Path $playRoot ($outputName + '.exe')
}
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe' }
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework C# compiler was not found.' }

# Code-drawn icon: no external assets, downloads or font dependency.
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 64,64
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$blue = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,64,103,162))
$whale = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,220,242,255))
$eye = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,47,77,123))
$graphics.FillEllipse($blue,1,1,62,62)
$graphics.FillEllipse($whale,13,23,36,25)
$tail = [System.Drawing.Point[]]@((New-Object System.Drawing.Point 43,35),(New-Object System.Drawing.Point 57,23),(New-Object System.Drawing.Point 57,37),(New-Object System.Drawing.Point 48,43))
$graphics.FillPolygon($whale,$tail)
$graphics.FillEllipse($eye,21,30,4,4)
$graphics.FillEllipse($whale,25,9,6,11)
$graphics.FillEllipse($whale,33,13,5,7)
$icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
$iconFile = Join-Path $PSScriptRoot 'launcher.ico'
$stream = [System.IO.File]::Create($iconFile)
try { $icon.Save($stream) } finally { $stream.Dispose(); $icon.Dispose(); $graphics.Dispose(); $bitmap.Dispose(); $blue.Dispose(); $whale.Dispose(); $eye.Dispose() }

$vendor = Join-Path $PSScriptRoot 'vendor/webview2'
foreach ($name in @('Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll')) {
    if (-not (Test-Path -LiteralPath (Join-Path $vendor $name))) { throw ('Missing bundled WebView2 SDK file: ' + $name) }
}
& $compiler /nologo /codepage:65001 /target:winexe /optimize+ /platform:x64 "/win32icon:$iconFile" "/win32manifest:$PSScriptRoot/Launcher.manifest" "/out:$OutputPath" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/reference:$vendor/Microsoft.Web.WebView2.Core.dll" "/reference:$vendor/Microsoft.Web.WebView2.WinForms.dll" (Join-Path $PSScriptRoot 'Launcher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
# cmd.exe requires CRLF here; UTF-8 plus bare LF can skip command prefixes after chcp.
$batchName = -join @([char]0x542F,[char]0x52A8,[char]0x5668)
$batchFile = Join-Path $playRoot ($batchName + '.bat')
if (Test-Path -LiteralPath $batchFile) {
    $batchText = [System.IO.File]::ReadAllText($batchFile, [System.Text.Encoding]::UTF8)
    [System.IO.File]::WriteAllText($batchFile, ($batchText -replace '\r?\n', "`r`n"), (New-Object System.Text.UTF8Encoding $false))
}
Write-Output 'Built launcher EXE.'


