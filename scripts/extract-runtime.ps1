param([Parameter(Mandatory=$true)][string]$Archive,[Parameter(Mandatory=$true)][string]$Destination,[Parameter(Mandatory=$true)][string]$Entries)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
if ((Get-Item -LiteralPath $Destination).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected runtime extraction root' }
$spec = Get-Content -Raw -LiteralPath $Entries | ConvertFrom-Json
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
    foreach ($file in $spec) {
        foreach ($value in @($file.entry, $file.path)) {
            if ($value -match '[\\:< >"|?*\x00-\x1f]' -or $value -match '(^/|/$|//)' -or ($value.Split('/') | Where-Object { $_ -eq '.' -or $_ -eq '..' -or $_ -match '[. ]$' -or $_ -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])($|\.)' })) { throw 'Unsafe runtime ZIP path' }
        }
        $matches = @($zip.Entries | Where-Object { $_.FullName -ceq $file.entry })
        if ($matches.Count -ne 1) { throw "Missing or duplicate runtime ZIP entry: $($file.entry)" }
        $entry = $matches[0]
        if (($entry.ExternalAttributes -band 0xF0000000) -eq 0xA0000000) { throw 'Runtime ZIP entry is a symbolic link' }
        if ($entry.Length -gt 512MB) { throw 'Runtime ZIP entry exceeds size limit' }
        $output = [IO.Path]::GetFullPath((Join-Path $Destination $file.path))
        if (-not $output.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime ZIP entry escapes destination' }
        $parent = [IO.Path]::GetDirectoryName($output)
        [IO.Directory]::CreateDirectory($parent) | Out-Null
        $current = $parent
        while ($current.Length -ge $root.TrimEnd('\').Length) {
            if ((Get-Item -LiteralPath $current).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected runtime ZIP destination' }
            $current = [IO.Path]::GetDirectoryName($current)
        }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$output,$false)
    }
} finally { $zip.Dispose() }
