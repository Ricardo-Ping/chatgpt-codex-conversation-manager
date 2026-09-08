$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $repo "apps\desktop\build"
$outIco = Join-Path $buildDir "icon.ico"
$outPng = Join-Path $buildDir "icon.png"
$outPngRenderer = Join-Path $repo "apps\desktop\src\renderer\icon.png"
New-Item -ItemType Directory -Path $buildDir -Force | Out-Null

Add-Type -AssemblyName System.Drawing

# 从现有 ICO 取 256 帧，放大到 512x512（electron-builder mac 构建要求至少 512）
$sourceIcon = New-Object -TypeName System.Drawing.Icon -ArgumentList $outIco, 256, 256
Write-Output ("icon loaded: " + ($null -ne $sourceIcon) + " path-exists: " + (Test-Path $outIco))
$sourceBitmap = $sourceIcon.ToBitmap()
Write-Output ("source frame: " + $sourceBitmap.Width + "x" + $sourceBitmap.Height)

$upscaled = New-Object System.Drawing.Bitmap 512, 512
$graphics = [System.Drawing.Graphics]::FromImage($upscaled)
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.DrawImage($sourceBitmap, 0, 0, 512, 512)
$graphics.Dispose()
$upscaled.Save($outPng, [System.Drawing.Imaging.ImageFormat]::Png)
$upscaled.Dispose()
$sourceBitmap.Dispose()

# 渲染层侧边栏品牌图标同步更新
Copy-Item -LiteralPath $outPng -Destination $outPngRenderer -Force

Write-Output ("png: " + (Get-Item $outPng).Length + " bytes, ico: " + (Get-Item $outIco).Length + " bytes")
