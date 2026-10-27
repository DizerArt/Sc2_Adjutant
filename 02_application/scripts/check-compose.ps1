$ErrorActionPreference = 'Stop'
$applicationRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $applicationRoot
try {
    foreach ($gate in @('typecheck','test','check:compose','clippy:compose','fmt:compose')) {
        & npm.cmd run $gate
        if ($LASTEXITCODE -ne 0) { throw "Compose check failed: $gate" }
    }
    $userCargo = Join-Path $env:USERPROFILE '.cargo/bin/cargo.exe'
    if (Test-Path -LiteralPath $userCargo) { $env:PATH = (Split-Path -Parent $userCargo) + ';' + $env:PATH }
    & cargo.exe test --manifest-path src-tauri/Cargo.toml --lib --locked
    if ($LASTEXITCODE -ne 0) { throw 'Native Compose tests failed' }
    Write-Output 'PASS Compose source checks; installer/native smoke are separate explicit gates.'
} finally { Pop-Location }
