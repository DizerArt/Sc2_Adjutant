# Main Application

This folder contains the stable SC2 Assistant application code.

The current implementation is an Electron + React + TypeScript MVP shell with local StarCraft II Client API polling, persistent file storage, diagnostics, user settings, opponent notes, and a replay watcher foundation.

```text
src/
|-- main/             # console PoC and Electron main process
|-- renderer/         # React desktop UI
|-- application/      # use cases and orchestration services
|-- domain/           # entities, value objects, and ports
|-- infrastructure/   # SC2 Client API, storage, HTTP adapters
`-- shared/           # IPC contracts, shared errors, and types
```

## Requirements

- Node.js 22 or newer.
- StarCraft II running locally if you want to test the real `/game` endpoint.

## Install

```bash
npm install
```

## Run Desktop Shell

```bash
npm run dev
```

This starts the Vite renderer and then opens the Electron window.

The Electron process must be launched through the `electron` binary. In development, `scripts/electron-dev.cjs` registers `tsx` and then loads the TypeScript Electron main process. Running `tsx src/main/electron/main.ts` directly uses plain Node.js and will fail because Electron-only APIs such as `ipcMain` are not available there.

## Run SC2 Client API PoC

```bash
npm run dev:poc
```

Run one polling cycle and exit:

```bash
npm run dev:poc -- --once
```

Optional environment variables:

```bash
SC2_ASSISTANT_PLAYER_NAME=DizerArt
SC2_ASSISTANT_POLL_INTERVAL_MS=1000
SC2_ASSISTANT_DATA_DIR=D:\SC2AssistantData
```

The PoC polls:

```text
http://127.0.0.1:6119/game
```

When a new active 1v1 session is detected, it logs:

```text
New game detected: opponent name/race
```

It also saves primary local records:

```text
%APPDATA%\SC2 Assistant\data\opponents.csv
%APPDATA%\SC2 Assistant\data\matches.csv
%APPDATA%\SC2 Assistant\data\enrichment-candidates.json
%APPDATA%\SC2 Assistant\data\opponent-source-fixtures.json
%APPDATA%\SC2 Assistant\data\settings.json
%APPDATA%\SC2 Assistant\data\storage-manifest.json
```

`SC2_ASSISTANT_DATA_DIR` can override the default storage directory.

`opponent-source-fixtures.json` can be created manually to feed deterministic enrichment candidates during development:

```json
[
  {
    "source": "Local Fixture Source",
    "nickname": "RobbyG",
    "race": "Terran",
    "aliases": ["Robby"],
    "mmr": 4300,
    "league": "Master",
    "confidenceScore": 0.88
  }
]
```

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run smoke:electron
```

Run environment diagnostics:

```bash
npm run diagnostics
```

## Package Windows Build

Create an unpacked Windows app directory for local inspection:

```bash
npm run pack:win
```

Create portable and NSIS installer artifacts:

```bash
npm run dist:win
```

Build outputs are written to:

```text
02_application/release/
```

Diagnostics check:

- local SC2 Client API availability;
- local storage directory write access.

## External Source Foundation

External opponent enrichment should use `OpponentDataSourcePort`. Concrete sources such as SC2Pulse must be implemented in `src/infrastructure/` and should use the shared `HttpJsonClient` for timeout, retry, and rate-limit behavior.

Do not call external data sources directly from UI code.

`OpponentEnrichmentService` combines candidates from one or more sources, selects the best candidate by confidence score, and keeps source failures as warnings instead of breaking the whole flow.

External web sources should also be wrapped with `CachedOpponentDataSource`. The wrapper caches successful, empty, and failing responses, opens a temporary cooldown after repeated source failures, and exposes a runtime snapshot for diagnostics. This is the required integration pattern for live source adapters: no direct UI calls, no retry storms, no CAPTCHA or anti-bot bypasses, and source failures must degrade into diagnostics/enrichment warnings.

`HandleDetectedGame` is the application-level orchestration flow for the current PoC:

1. Register detected opponent and match.
2. Optionally enrich the opponent through configured sources.
3. Persist the final opponent state.
4. Return enrichment warnings without failing the whole detection flow.

The Electron app currently wires settings-aware SC2Pulse and local fixture source adapters into this flow. Live source adapters are memory-cached for the running app session. The local source reads `opponent-source-fixtures.json` from the app data directory. All are disabled when `externalSourcesEnabled` is false, and each source can also be toggled independently from Settings.

## Current Boundaries

- Electron shell and React renderer are wired through a preload IPC bridge.
- The UI can start/stop live monitoring, refresh diagnostics, show the latest sampled SC2 session, search/filter/sort known opponents, show enrichment candidates, manually edit opponent profiles, list recent matches, add opponent notes, and save user settings.
- The UI can start/stop replay watching when a replay directory is configured in Settings.
- `settings.json` stores player name, region, default race, replay directory, polling interval, the global external-source toggle, and per-source toggles for SC2Pulse and local fixtures.
- `enrichment-candidates.json` stores the latest candidate snapshots returned by opponent data sources for each opponent.
- `opponent-source-fixtures.json` is read by the local fixture-backed source adapter when external sources are enabled.
- Replay watcher recursively detects new `.SC2Replay` files and links them to the latest local match without a replay path.
- `BinaryReplayMetadataReader` parses the actual `.SC2Replay` binary via `@replaysremastered/sc2readerjs` and extracts `mapTitle`, `playedAt`, and the user's per-player `result`.
- Optional replay sidecar files named `<replay>.SC2Replay.json` are still consulted as a fallback when binary parsing throws.
- SC2Pulse is implemented as the live external ladder source.
- The PoC does not read game memory, intercept packets, inject into SC2, or automate gameplay.

## Local Storage Foundation

The application uses file-based repositories:

- `FileOpponentRepository`
- `FileMatchRepository`
- `FileAppSettingsRepository`
- `FileEnrichmentCandidateRepository`

Opponent and match repositories support `csv` and `xml` formats and use atomic file replacement for writes. Settings, enrichment candidates, and fixture source data are stored as JSON. These repositories are infrastructure adapters behind domain repository interfaces, so application use cases should depend on the interfaces, not the concrete file classes.

The storage directory also contains `storage-manifest.json`, which records the current schema version and active file names.

Match history is exposed through `ListMatchHistory` and the Electron IPC bridge. UI code reads match history from the application use case instead of reading CSV files directly.

Default Windows data directory:

```text
%APPDATA%\SC2 Assistant\data
```

Open it from PowerShell:

```powershell
explorer "$env:APPDATA\SC2 Assistant\data"
```
