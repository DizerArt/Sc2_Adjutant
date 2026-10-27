param([string]$Executable, [string]$PostmatchReplay, [switch]$RequireMapBackground, [switch]$MinimapOnly)
$ErrorActionPreference = 'Stop'
if (($RequireMapBackground -or $MinimapOnly) -and -not $PostmatchReplay) { throw 'Map smoke requires an explicit -PostmatchReplay.' }
function Read-Sha256([string]$Path) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','') }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
function Assert-ObsStopped([string]$SourceUrl) {
    $source = [Uri]$SourceUrl
    if ($source.Scheme -ne 'http' -or $source.Host -ne '127.0.0.1' -or $source.Port -lt 1024 -or $source.AbsolutePath -ne '/widgets/') {
        throw 'Smoke report returned an invalid owned OBS source address.'
    }
    # A direct loopback TCP connection bypasses all HTTP proxy configuration.
    $client = [Net.Sockets.TcpClient]::new()
    $closed = $false
    try {
        try {
            $connection = $client.BeginConnect([Net.IPAddress]::Loopback, $source.Port, $null, $null)
            try {
                if (-not $connection.AsyncWaitHandle.WaitOne(5000)) {
                    throw 'Timed out checking owned OBS listener cleanup; closure was not proven.'
                }
                $client.EndConnect($connection)
            } finally { $connection.AsyncWaitHandle.Dispose() }
        } catch {
            $failure = $_.Exception
            while ($failure.InnerException) { $failure = $failure.InnerException }
            if ($failure -is [Net.Sockets.SocketException] -and $failure.SocketErrorCode -eq [Net.Sockets.SocketError]::ConnectionRefused) {
                $closed = $true
            } else { throw }
        }
    } finally { $client.Dispose() }
    if (-not $closed) { throw 'Owned OBS endpoint remained available after the smoke application exited.' }
}
$applicationRoot = Split-Path -Parent $PSScriptRoot
if (-not $Executable) { $Executable = Join-Path $applicationRoot 'release/compose-preview/SC2 Adjutant Compose.exe' }
$Executable = (Resolve-Path -LiteralPath $Executable).Path
$beforeReplay = $null
if ($PostmatchReplay) {
    if ($PostmatchReplay -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)') { throw 'Postmatch smoke requires an explicit absolute replay path.' }
    $PostmatchReplay = (Resolve-Path -LiteralPath $PostmatchReplay).ProviderPath
    $replayItem = Get-Item -LiteralPath $PostmatchReplay
    if ($replayItem.PSIsContainer -or $replayItem.Extension -ine '.SC2Replay' -or $replayItem.Length -le 0 -or $replayItem.Length -gt 64MB -or ($replayItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Postmatch smoke requires a regular .SC2Replay file within the 64 MiB limit.' }
    $beforeReplay = Read-Sha256 $PostmatchReplay
}
$testRoot = Join-Path $applicationRoot ('.compose-test-data/smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$fixture = Get-Content -LiteralPath (Join-Path $applicationRoot 'src-tauri/tests/fixtures/storage-parity.json') -Raw -Encoding UTF8 | ConvertFrom-Json
[IO.File]::WriteAllText((Join-Path $testRoot 'opponents.csv'), $fixture.csv.opponents, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $testRoot 'matches.csv'), $fixture.csv.matches, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $testRoot 'settings.json'), '{"language":"ru","externalSourcesEnabled":false,"overlayEnabled":false,"voice":{"enabled":false}}', [Text.UTF8Encoding]::new($false))
$beforeOpponent = Read-Sha256 (Join-Path $testRoot 'opponents.csv')
$beforeMatch = Read-Sha256 (Join-Path $testRoot 'matches.csv')
$previousData = $env:SC2_ASSISTANT_DATA_DIR
$previousReport = $env:SC2_COMPOSE_SMOKE_REPORT
$previousObsPort = $env:SC2_COMPOSE_OVERLAY_PORT
$previousReplay = $env:SC2_COMPOSE_SMOKE_REPLAY
$previousMinimap = $env:SC2_COMPOSE_SMOKE_MINIMAP
$process = $null
try {
    $env:SC2_ASSISTANT_DATA_DIR = $testRoot
    $env:SC2_COMPOSE_SMOKE_REPORT = Join-Path $testRoot 'report.json'
    $env:SC2_COMPOSE_OVERLAY_PORT = '0'
    # Inherited opt-in paths must never turn an ordinary smoke into a personal-file read.
    $env:SC2_COMPOSE_SMOKE_REPLAY = if ($PostmatchReplay) { $PostmatchReplay } else { $null }
    $env:SC2_COMPOSE_SMOKE_MINIMAP = if ($MinimapOnly) { '1' } else { $null }
    foreach ($round in @(1,2)) {
    [IO.File]::WriteAllText($env:SC2_COMPOSE_SMOKE_REPORT, '', [Text.UTF8Encoding]::new($false))
    $process = Start-Process -FilePath $Executable -PassThru -WindowStyle Hidden
    $ownedStart = $process.StartTime
    # Explicit replay mode performs both a host decode and a Runtime preparation (45 s each).
    $smokeTimeout = if ($PostmatchReplay) { 120000 } else { 45000 }
    if (-not $process.WaitForExit($smokeTimeout)) {
        $currentProcess = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
        if ($currentProcess -and $currentProcess.StartTime -eq $ownedStart) { Stop-Process -Id $process.Id }
        throw 'Compose smoke timed out before native report; only the owned test instance was stopped.'
    }
    if (-not (Test-Path -LiteralPath $env:SC2_COMPOSE_SMOKE_REPORT)) { throw "Compose exited with $($process.ExitCode) without a native report." }
    $report = Get-Content -LiteralPath $env:SC2_COMPOSE_SMOKE_REPORT -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $report.ok) { throw "Compose report failed: $($report.error)" }
    if ($report.opponents.opponents.Count -ne 1 -or $report.matches.items.Count -ne 1) { throw 'Imported fixture counts changed.' }
    if ($report.opponents.opponents[0].nickname -cne $fixture.csv.expectedOpponents[0].nickname) { throw 'Unicode opponent nickname changed during native import or report serialization.' }
    if ($report.settings.settings.language -ne 'ru' -or $report.monitoring.running) { throw 'Isolated smoke settings/runtime mismatch.' }
    if ($round -eq 2 -and -not $report.persistedNote) { throw 'Native data did not survive application restart.' }
    if ($round -eq 2 -and -not $report.persistedObs) { throw 'OBS configuration did not survive application restart.' }
    if ($round -eq 2 -and -not $report.persistedSmart) { throw 'Smart overlay draft and applied configuration did not survive restart.' }
    if ($round -eq 2 -and -not $report.persistedMenuLayout) { throw 'Menu grid layout did not survive restart.' }
    if ($PostmatchReplay -and (-not $report.postmatch.requested -or $report.postmatch.status -ne 'ready' -or $report.postmatch.counts.players -lt 2 -or $report.postmatch.counts.teams -lt 2)) { throw 'Explicit native replay preparation was not verified.' }
    if ($PostmatchReplay -and $round -eq 2 -and $report.postmatch.initialStatus -ne 'ready') { throw 'Native replay facts did not survive application restart.' }
    if (($RequireMapBackground -or $MinimapOnly) -and $report.postmatch.mapBackground.status -ne 'ready') { throw 'Native map background was not verified.' }
    if ($MinimapOnly -and $report.postmatch.mapBackground.source_kind -ne 'minimap') { throw 'Native fallback did not use the minimap.' }
    if (-not $report.smartApplied.applied.enabled -or -not $report.staleSmartRejected) { throw 'Smart overlay Apply or revision conflict check failed.' }
    if (-not $report.obs.beforeClose.httpChecked -or -not $report.obs.afterClose.httpChecked -or -not $report.obs.afterClose.mainWindowHidden) { throw 'Native OBS HTTP did not remain available after closing settings.' }
    if (-not $report.obs.afterClose.assetChecked -or -not $report.obs.afterClose.privateFieldsExcluded) { throw 'OBS static assets or public state boundary were not verified.' }
    Assert-ObsStopped $report.obs.configured.url
    }
    if ((Read-Sha256 (Join-Path $testRoot 'opponents.csv')) -ne $beforeOpponent -or (Read-Sha256 (Join-Path $testRoot 'matches.csv')) -ne $beforeMatch) { throw 'Legacy fixture files were modified.' }
    Write-Output "PASS native WebView2 -> Tauri IPC -> SQLite + OBS HTTP/static assets + hidden-window continuity + restart; originals preserved; report: $testRoot/report.json"
} finally {
    $env:SC2_ASSISTANT_DATA_DIR = $previousData
    $env:SC2_COMPOSE_SMOKE_REPORT = $previousReport
    $env:SC2_COMPOSE_OVERLAY_PORT = $previousObsPort
    $env:SC2_COMPOSE_SMOKE_REPLAY = $previousReplay
    $env:SC2_COMPOSE_SMOKE_MINIMAP = $previousMinimap
    if ($PostmatchReplay -and (Read-Sha256 $PostmatchReplay) -ne $beforeReplay) { throw 'Explicit smoke replay source changed; preservation was not verified.' }
}
