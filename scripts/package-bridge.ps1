$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo "packages\chatgpt-browser-bridge-extension"
$release = Join-Path $repo "release"
$stage = Join-Path $env:TEMP ("conversation-manager-bridge-" + [guid]::NewGuid().ToString("N"))
$version = (Get-Content -Raw -LiteralPath (Join-Path $repo "package.json") | ConvertFrom-Json).version
$archive = Join-Path $release "Conversation-Manager-Bridge-$version.zip"

function Get-Sha256([string]$path) {
  $stream = [System.IO.File]::OpenRead($path)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace("-", "").ToLowerInvariant() }
    finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
}

New-Item -ItemType Directory -Path $stage -Force | Out-Null
New-Item -ItemType Directory -Path $release -Force | Out-Null
$files = @("manifest.json", "background.js", "content.js", "bridge-core.js", "popup.html", "popup.css", "popup.js")
foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $source $file) -Destination $stage }
$stagedManifest = Join-Path $stage "manifest.json"
$manifestText = [System.IO.File]::ReadAllText($stagedManifest)
$manifestText = ([regex]'("version"\s*:\s*")[^"]*(")').Replace($manifestText, ('${1}' + $version + '${2}'), 1)
[System.IO.File]::WriteAllText($stagedManifest, $manifestText, [System.Text.UTF8Encoding]::new($false))
if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $archive -CompressionLevel Optimal
Remove-Item -LiteralPath $stage -Recurse -Force

$releaseFiles = @(
  "Conversation-Manager-$version-setup-x64.exe",
  "Conversation-Manager-$version-portable-x64.exe",
  "Conversation-Manager-$version-setup-x64.exe.blockmap",
  "latest.yml",
  "Conversation-Manager-Bridge-$version.zip"
)
$sums = foreach ($name in $releaseFiles) {
  $path = Join-Path $release $name
  if (Test-Path -LiteralPath $path) { "{0}  {1}" -f (Get-Sha256 $path), $name }
}
[System.IO.File]::WriteAllText((Join-Path $release "SHA256SUMS.txt"), ($sums -join "`n") + "`n", [System.Text.UTF8Encoding]::new($false))
