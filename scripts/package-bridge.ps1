$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo "packages\chatgpt-browser-bridge-extension"
$release = Join-Path $repo "release"
$stage = Join-Path $env:TEMP ("conversation-manager-bridge-" + [guid]::NewGuid().ToString("N"))
$version = (Get-Content -Raw -LiteralPath (Join-Path $repo "package.json") | ConvertFrom-Json).version
$archive = Join-Path $release "Conversation-Manager-Bridge-$version.zip"

New-Item -ItemType Directory -Path $stage -Force | Out-Null
New-Item -ItemType Directory -Path $release -Force | Out-Null
$files = @("manifest.json", "background.js", "content.js", "bridge-core.js", "popup.html", "popup.css", "popup.js")
foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $source $file) -Destination $stage }
if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $archive -CompressionLevel Optimal
Remove-Item -LiteralPath $stage -Recurse -Force
$stream = [System.IO.File]::OpenRead($archive)
try {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace("-", "").ToLowerInvariant() }
  finally { $sha.Dispose() }
} finally { $stream.Dispose() }
[System.IO.File]::WriteAllText("$archive.sha256", "$hash  $(Split-Path -Leaf $archive)`n", [System.Text.UTF8Encoding]::new($false))
