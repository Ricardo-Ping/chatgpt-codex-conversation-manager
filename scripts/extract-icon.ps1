$ErrorActionPreference = "Stop"
$sourceExe = "E:\chatgpt-codex-conversation-manager\release\win-unpacked\Conversation Manager.exe"
$outIco = "E:\chatgpt-codex-conversation-manager\apps\desktop\build\icon.ico"
$outPng = "E:\chatgpt-codex-conversation-manager\apps\desktop\src\renderer\icon.png"
New-Item -ItemType Directory -Path (Split-Path $outIco) -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path $outPng) -Force | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Native -Name Shell -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("shell32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern int SHDefExtractIcon(string pszIconFile, int nIconIndex, uint uFlags, out System.IntPtr hiconLarge, out System.IntPtr hiconSmall, uint nIconSize);
"@

$large = [System.IntPtr]::Zero; $small = [System.IntPtr]::Zero
$size = (256) -bor (32 -shl 16)
$result = [Native.Shell]::SHDefExtractIcon($sourceExe, 0, 0, [ref]$large, [ref]$small, $size)
if ($result -ne 0 -or $large -eq [System.IntPtr]::Zero) { throw "SHDefExtractIcon failed: $result" }

$bitmap = [System.Drawing.Icon]::FromHandle($large).ToBitmap()
$bitmap.Save($outPng, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

$icon = [System.Drawing.Icon]::FromHandle($large)
$stream = [System.IO.File]::Create($outIco)
$icon.Save($stream)
$stream.Dispose()
$icon.Dispose()

Write-Output ("png: " + (Get-Item $outPng).Length + " bytes, ico: " + (Get-Item $outIco).Length + " bytes")
