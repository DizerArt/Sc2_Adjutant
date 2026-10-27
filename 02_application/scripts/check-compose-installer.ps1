[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Installer, [string]$PostmatchReplay)
$ErrorActionPreference = 'Stop'
$applicationRoot = Split-Path -Parent $PSScriptRoot
$Installer = (Resolve-Path -LiteralPath $Installer).ProviderPath
$registration = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SC2 Adjutant Compose'
if (Test-Path -LiteralPath $registration) { throw 'Compose is already installed. Use a clean Windows user for the isolated installer check.' }
$testRoot = Join-Path $applicationRoot ('.compose-test-data/installer-' + [guid]::NewGuid().ToString('N'))
$installRoot = [IO.Path]::GetFullPath((Join-Path $testRoot 'Установка Compose'))
if (-not $installRoot.StartsWith([IO.Path]::GetFullPath($testRoot) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid owned installation directory.' }
New-Item -ItemType Directory -Path $testRoot | Out-Null
function Invoke-OwnedInstaller([string]$Executable, [string]$Arguments) {
    $owned = Start-Process -FilePath $Executable -ArgumentList $Arguments -PassThru -WindowStyle Hidden
    $created = $owned.StartTime
    if (-not $owned.WaitForExit(120000)) {
        $current = Get-Process -Id $owned.Id -ErrorAction SilentlyContinue
        if ($current -and $current.StartTime -eq $created -and $current.Path -eq $Executable) { Stop-Process -Id $owned.Id }
        throw 'Owned installer timed out.'
    }
    if ($owned.ExitCode -ne 0) { throw "Installer failed with exit code $($owned.ExitCode)." }
}
$checks = [ordered]@{ installed=$false; resourcesVerified=0; nativeSmoke=$false; uninstalled=$false }
function Get-NsisExecutableHash([string]$Path) {
    # Tauri patches exactly this fixed-width marker for NSIS, then restores the build output.
    # Compare every installed byte to that expected packaged image; never alter the source EXE.
    $bytes = [IO.File]::ReadAllBytes($Path)
    $marker = '__TAURI_BUNDLE_TYPE_VAR_UNK'
    $text = [Text.Encoding]::ASCII.GetString($bytes)
    $offset = $text.IndexOf($marker, [StringComparison]::Ordinal)
    if ($offset -lt 0 -or $text.IndexOf($marker, $offset + 1, [StringComparison]::Ordinal) -ge 0) { throw 'Tauri bundle marker is not unique.' }
    [Text.Encoding]::ASCII.GetBytes('__TAURI_BUNDLE_TYPE_VAR_NSS').CopyTo($bytes, $offset)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($bytes)).Replace('-','') }
    finally { $algorithm.Dispose() }
}
try {
    # /D must be the final, unquoted NSIS argument, including when the path contains spaces.
    # /NS suppresses test shortcuts; absence of /R prevents application auto-launch.
    Invoke-OwnedInstaller $Installer "/S /NS /D=$installRoot"
    $main = Join-Path $installRoot 'sc2-adjutant-compose.exe'
    if (-not (Test-Path -LiteralPath $main) -or -not (Test-Path -LiteralPath $registration)) { throw 'Installation was not registered or the main executable is missing.' }
    $registered = Get-ItemProperty -LiteralPath $registration
    if ($registered.UninstallString -notlike "*$installRoot*") { throw 'Installer registration escaped the isolated directory.' }
    $checks.installed = $true
    if ((Get-FileHash -LiteralPath $main -Algorithm SHA256).Hash -ne (Get-NsisExecutableHash (Join-Path $applicationRoot 'src-tauri/target/release/sc2-adjutant-compose.exe'))) { throw 'Installed executable differs from the current NSIS-patched build.' }
    $pairs = @()
    foreach ($mapping in @(@('resources/compose-runtime','compose-runtime'),@('resources/map-bank','map-bank'),@('resources/voice-wasm','voice-wasm'),@('resources/voice-models','voice-models'),@('dist-obs','obs-web'))) {
        $sourceRoot = Join-Path $applicationRoot $mapping[0]
        foreach ($file in Get-ChildItem -LiteralPath $sourceRoot -File -Recurse) {
            if ($file.Name -eq '.gitignore') { continue }
            $relative = $file.FullName.Substring($sourceRoot.Length).TrimStart('\','/')
            $pairs += ,@($file.FullName, (Join-Path $mapping[1] $relative))
        }
    }
    foreach ($pair in $pairs) {
        $source = if ([IO.Path]::IsPathRooted($pair[0])) { $pair[0] } else { Join-Path $applicationRoot $pair[0] }
        $installed = Join-Path $installRoot $pair[1]
        if (-not (Test-Path -LiteralPath $installed) -or (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash) { throw "Installed resource mismatch: $($pair[1])" }
        $checks.resourcesVerified++
    }
    $smokeArgs = @{ Executable=$main }
    if ($PostmatchReplay) { $smokeArgs.PostmatchReplay=$PostmatchReplay; $smokeArgs.RequireMapBackground=$true }
    & (Join-Path $PSScriptRoot 'smoke-compose.ps1') @smokeArgs
    $checks.nativeSmoke = $true
} finally {
    # Remove only the registration and files created by this isolated test.
    $uninstaller = Join-Path $installRoot 'uninstall.exe'
    if (Test-Path -LiteralPath $uninstaller) {
        $registered = Get-ItemProperty -LiteralPath $registration -ErrorAction SilentlyContinue
        if ($registered -and $registered.UninstallString -notlike "*$installRoot*") { throw 'Uninstall identity changed; automatic cleanup refused.' }
        Invoke-OwnedInstaller $uninstaller "/S _?=$installRoot"
        $checks.uninstalled = -not (Test-Path -LiteralPath $registration) -and -not (Test-Path -LiteralPath (Join-Path $installRoot 'sc2-adjutant-compose.exe'))
        if (-not $checks.uninstalled) { throw 'Owned installation cleanup was not verified.' }
    }
    $checks | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $testRoot 'report.json') -Encoding UTF8
}
Write-Output "PASS isolated per-user installation, resource SHA256, native smoke and uninstall: $testRoot/report.json"
