param([string]$OutputPath)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputPath) {
    $OutputPath = Join-Path (Split-Path $projectRoot -Parent) 'ST-Reference-Panel-v1.0.0.zip'
}
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$files = @('manifest.json', 'index.js', 'core.js', 'adapter.js', 'panel.js', 'clipboard.js', 'style.css', 'README.md', 'LICENSE')
foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $file) -PathType Leaf)) {
        throw "Missing runtime file: $file"
    }
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
# CreateNew deliberately prevents overwriting an existing release package.
$stream = [IO.File]::Open($OutputPath, [IO.FileMode]::CreateNew)
$archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in $files) {
        $entry = 'ST-Reference-Panel/' + $file
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $projectRoot $file), $entry) | Out-Null
    }
} finally {
    $archive.Dispose()
    $stream.Dispose()
}
Write-Output $OutputPath
