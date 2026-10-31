param([switch]$StageOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pluginId = 'com.local.resolveassistant'
$sdkFile = Join-Path $env:ProgramData 'Blackmagic Design\DaVinci Resolve\Support\Developer\Workflow Integrations\Examples\SamplePlugin\WorkflowIntegration.node'
if (!(Test-Path -LiteralPath $sdkFile)) { throw 'Workflow Integration SDK not found. Install DaVinci Resolve Studio.' }
$nativeRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.runtime\win32-x64'))
$nativeManifest = Get-Content -LiteralPath (Join-Path $projectRoot 'runtime-manifest.json') -Raw | ConvertFrom-Json
$nodeEntry = @($nativeManifest.artifacts | Where-Object name -eq 'node').files | Where-Object executable -eq 'node'
if (!$nodeEntry) { throw 'Pinned Node.js is missing from the runtime manifest' }
$nodePath = [IO.Path]::GetFullPath((Join-Path $nativeRoot $nodeEntry.path))
if (!$nodePath.StartsWith($nativeRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid runtime path' }
if (!(Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw 'Private runtime is missing. Run npm.cmd run runtime:setup first.' }
$nodeHasher = [Security.Cryptography.SHA256]::Create()
$nodeStream = [IO.File]::OpenRead($nodePath)
try { $nodeDigest = [BitConverter]::ToString($nodeHasher.ComputeHash($nodeStream)).Replace('-', '') }
finally { $nodeStream.Dispose(); $nodeHasher.Dispose() }
if ($nodeDigest -ine $nodeEntry.sha256) { throw 'Private Node.js checksum mismatch. Run npm.cmd run runtime:setup to repair it.' }
& $nodePath -e 'require(process.argv[1]).runtimePaths()' (Join-Path $projectRoot 'lib\runtime.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Private runtime validation failed' }
& $nodePath (Join-Path $projectRoot 'scripts\install-browser.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the isolated background browser' }
$stagePath = Join-Path $projectRoot "dist\$pluginId"
New-Item -ItemType Directory -Path $stagePath -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'plugin\loader.js') -Destination (Join-Path $stagePath 'main.js') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'plugin\manifest.xml') -Destination (Join-Path $stagePath 'manifest.xml') -Force
Copy-Item -LiteralPath $sdkFile -Destination (Join-Path $stagePath 'WorkflowIntegration.node') -Force
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $stagePath 'runtime.json'), (@{ projectRoot=$projectRoot; nodePath=$nodePath; diagnostics=$true } | ConvertTo-Json), $utf8NoBom)
[IO.File]::WriteAllText((Join-Path $stagePath 'package.json'), (@{ name='resolve-assistant'; version='0.1.0'; main='main.js'; private=$true } | ConvertTo-Json), $utf8NoBom)
if ($StageOnly) { Write-Output "Staged plugin: $stagePath"; exit 0 }
$pluginsRoot = [IO.Path]::GetFullPath((Join-Path $env:ProgramData 'Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins'))
$targetPath = [IO.Path]::GetFullPath((Join-Path $pluginsRoot $pluginId))
if (!$targetPath.StartsWith($pluginsRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid installation directory' }
if (Test-Path -LiteralPath $targetPath) {
  $oldRuntimeFile = Join-Path $targetPath 'runtime.json'
  if (!(Test-Path -LiteralPath $oldRuntimeFile)) { throw 'Existing plugin directory does not belong to this build' }
  $oldRuntime = Get-Content -LiteralPath $oldRuntimeFile -Raw | ConvertFrom-Json
  if ($oldRuntime.projectRoot -ne $projectRoot) { throw 'A prototype from another source directory is installed. Use its original directory or remove that integration manually.' }
}
New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
Get-ChildItem -LiteralPath $stagePath -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $targetPath $_.Name) -Force }
Write-Output "Installed: $targetPath"
Write-Output 'Open Resolve Studio -> Workspace -> Workflow Integrations -> Resolve Assistant.'
Write-Output 'If Resolve is already running, save your work and restart it manually.'
