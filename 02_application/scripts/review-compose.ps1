param(
    [switch]$NoBuild,
    [switch]$PrepareOnly,
    [string]$Profile,
    [string]$Executable
)
$ErrorActionPreference = 'Stop'
$applicationRoot = Split-Path -Parent $PSScriptRoot
$utf8 = [Text.UTF8Encoding]::new($false)
function Write-ReviewJson([string]$Path, $Value) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 30), $utf8)
}
function Assert-ReviewProfile([string]$Path) {
    if ($Path -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)') { throw 'Review profile must be an explicit absolute path.' }
    $resolved = (Resolve-Path -LiteralPath $Path).ProviderPath
    $markerPath = Join-Path $resolved '.compose-visual-review.json'
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { throw 'Existing review profile requires its own visual review marker.' }
    if ((Get-Item -LiteralPath $markerPath).Length -gt 4096) { throw 'Review marker exceeds its limit.' }
    $marker = Get-Content -LiteralPath $markerPath -Encoding UTF8 -Raw | ConvertFrom-Json
    $identity = [guid]::Empty
    if ($marker.schemaVersion -ne 1 -or $marker.kind -ne 'sc2-compose-visual-review' -or -not [guid]::TryParse([string]$marker.instanceId, [ref]$identity)) { throw 'Invalid review profile marker.' }
    $markedRoot = (Resolve-Path -LiteralPath ([string]$marker.profile)).ProviderPath
    if ($markedRoot.TrimEnd('\') -ine $resolved.TrimEnd('\')) { throw 'Review marker belongs to another profile.' }
    return $resolved
}
function New-ReviewImage([string]$Path, [int]$Width, [int]$Height, [string]$Label, [bool]$Jpeg) {
    $bitmap = [Drawing.Bitmap]::new($Width, $Height)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $font = [Drawing.Font]::new('Arial', 24)
    try {
        $graphics.Clear([Drawing.Color]::FromArgb(32, 55, 75))
        $graphics.FillRectangle([Drawing.Brushes]::SteelBlue, 0, 0, [int]($Width / 2), $Height)
        $graphics.DrawString("SYNTHETIC REVIEW - $Label", $font, [Drawing.Brushes]::White, 20, 20)
        $graphics.DrawRectangle([Drawing.Pens]::Orange, 10, 10, ($Width - 21), ($Height - 21))
        $format = if ($Jpeg) { [Drawing.Imaging.ImageFormat]::Jpeg } else { [Drawing.Imaging.ImageFormat]::Png }
        $bitmap.Save($Path, $format)
    } finally { $font.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
}
Push-Location $applicationRoot
try {
    if (-not $NoBuild) {
        if ($Executable) { throw 'A custom executable requires -NoBuild; the default build stages current source.' }
        & node.exe (Join-Path $PSScriptRoot 'compose.cjs') build --no-bundle
        if ($LASTEXITCODE -ne 0) { throw 'Current-source Compose build failed.' }
        & npm.cmd run stage:compose
        if ($LASTEXITCODE -ne 0) { throw 'Compose staging failed.' }
    }
    if (-not $Executable) { $Executable = Join-Path $applicationRoot 'release/compose-preview/SC2 Adjutant Compose.exe' }
    $Executable = (Resolve-Path -LiteralPath $Executable).ProviderPath
    if ($Profile) {
        $Profile = Assert-ReviewProfile $Profile
    } else {
        $instanceId = [guid]::NewGuid().ToString()
        $Profile = Join-Path $applicationRoot ('.compose-test-data/visual-review-' + $instanceId)
        New-Item -ItemType Directory -Path $Profile | Out-Null
        $Profile = (Resolve-Path -LiteralPath $Profile).ProviderPath
        Write-ReviewJson (Join-Path $Profile '.compose-visual-review.json') @{
            schemaVersion = 1; kind = 'sc2-compose-visual-review'; instanceId = $instanceId; profile = $Profile
        }
        $fixture = Get-Content -LiteralPath (Join-Path $applicationRoot 'src-tauri/tests/fixtures/storage-parity.json') -Encoding UTF8 -Raw | ConvertFrom-Json
        [IO.File]::WriteAllText((Join-Path $Profile 'opponents.csv'), $fixture.csv.opponents, $utf8)
        [IO.File]::WriteAllText((Join-Path $Profile 'matches.csv'), $fixture.csv.matches, $utf8)
        Write-ReviewJson (Join-Path $Profile 'settings.json') @{
            language = 'ru'; externalSourcesEnabled = $false; overlayEnabled = $false
            voice = @{ enabled = $false }; replayWatchEnabled = $false
        }
        $fixtures = Join-Path $Profile 'fixtures'
        New-Item -ItemType Directory -Path $fixtures | Out-Null
        Add-Type -AssemblyName System.Drawing
        New-ReviewImage (Join-Path $fixtures 'wide-review.png') 1600 400 'WIDE 1600 x 400' $false
        New-ReviewImage (Join-Path $fixtures 'tall-review.png') 600 1200 'TALL 600 x 1200' $false
        New-ReviewImage (Join-Path $fixtures 'photo-review.jpg') 900 600 'JPEG 900 x 600' $true
        [IO.File]::WriteAllText((Join-Path $fixtures 'invalid-review.png'), 'Synthetic invalid image: this is plain text.', $utf8)
    }
    $Profile = Assert-ReviewProfile $Profile
    $replays = Join-Path $Profile 'fixtures/replays'
    foreach ($fixtureDirectory in @((Join-Path $Profile 'fixtures'), $replays)) {
        if ((Test-Path -LiteralPath $fixtureDirectory) -and ((Get-Item -LiteralPath $fixtureDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Review fixture directories cannot be filesystem links.'
        }
    }
    New-Item -ItemType Directory -Path $replays -Force | Out-Null
    $resolvedReplays = (Resolve-Path -LiteralPath $replays).ProviderPath
    $settingsPath = Join-Path $Profile 'settings.json'
    $reviewSettings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $reviewSettings | Add-Member -MemberType NoteProperty -Name replayDirectory -Value $resolvedReplays -Force
    Write-ReviewJson $settingsPath $reviewSettings
    Write-Output "Visual review profile: $Profile"
    Write-Output "Synthetic picker images: $Profile\fixtures"
    Write-Output 'Review: draft versus Apply; mode switches; wide/tall/JPEG selection; invalid image rejection; cancel picker; reopen marked profile to check persistence.'
    Write-Output 'Monitoring is offline. Close hides the main window; reopen from tray. Use tray Exit to finish this review instance.'
    Write-Output "Replay reads are restricted to the owned fixture folder: $resolvedReplays"
    if ($PrepareOnly) { Write-Output 'Prepared only; no native application was launched.'; return }
    $processRecord = Join-Path $Profile 'review-process.json'
    if (Test-Path -LiteralPath $processRecord -PathType Leaf) {
        $record = Get-Content -LiteralPath $processRecord -Encoding UTF8 -Raw | ConvertFrom-Json
        if ($record.kind -eq 'sc2-compose-visual-review-process') {
            $existingProcess = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
            if ($existingProcess -and $existingProcess.StartTime.ToUniversalTime().Ticks -eq ([DateTimeOffset]::Parse([string]$record.startedAtUtc)).UtcDateTime.Ticks) {
                throw 'This review profile is already open. Exit its owned instance from the tray before reopening.'
            }
        }
    }
    $names = @('SC2_ASSISTANT_DATA_DIR', 'SC2_COMPOSE_VISUAL_REVIEW', 'SC2_COMPOSE_SMOKE_REPORT', 'SC2_COMPOSE_OVERLAY_PORT')
    $previous = @{}
    foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    try {
        $env:SC2_ASSISTANT_DATA_DIR = $Profile
        $env:SC2_COMPOSE_VISUAL_REVIEW = '1'
        $env:SC2_COMPOSE_SMOKE_REPORT = $null
        $env:SC2_COMPOSE_OVERLAY_PORT = '0'
        # This launcher is explicitly interactive: the user needs the window for visual QA.
        $reviewProcess = Start-Process -FilePath $Executable -PassThru -WindowStyle Normal
        Write-ReviewJson $processRecord @{
            schemaVersion = 1; kind = 'sc2-compose-visual-review-process'; profile = $Profile
            executable = $Executable; pid = $reviewProcess.Id; startedAtUtc = $reviewProcess.StartTime.ToUniversalTime().ToString('o')
            executableSha256 = (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash
            executableModifiedAtUtc = (Get-Item -LiteralPath $Executable).LastWriteTimeUtc.ToString('o')
        }
        Write-Output "Launched owned review process $($reviewProcess.Id). Ownership record: $Profile\review-process.json"
    } finally {
        foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
    }
} finally { Pop-Location }
