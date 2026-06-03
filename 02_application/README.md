# SC2 Adjutant Application

This directory contains the Electron application for SC2 Adjutant.

The app is built with Electron, React, TypeScript, Vite, file-based local storage, StarCraft II Client API polling, replay parsing, SC2Pulse enrichment, and a replay synchronization pipeline.

## Requirements

- Windows 10 or Windows 11.
- Node.js 20 or newer.
- npm.
- StarCraft II installed for live-match detection and replay parsing.

## Install

```powershell
npm install
```

## Run

Start the renderer and Electron shell:

```powershell
npm run dev
```

The development command starts Vite first, waits for the renderer URL, and then launches Electron through `scripts/electron-dev.cjs`. Do not run `src/main/electron/main.ts` directly with plain Node.js, because Electron APIs such as `app`, `BrowserWindow`, and `ipcMain` are only available inside Electron.

## Verification

```powershell
npm run typecheck
npm test
npm run build
npm run smoke:electron
```

Run environment diagnostics:

```powershell
npm run diagnostics
```

## Packaging

Create an unpacked Windows build:

```powershell
npm run pack:win
```

Create portable and NSIS installer artifacts:

```powershell
npm run dist:win
```

Build output is written to:

```text
release/
```

## Project Layout

```text
src/
|-- main/             # Electron main process, IPC wiring, diagnostics, console tools
|-- renderer/         # React UI
|-- application/      # use cases and orchestration services
|-- domain/           # entities, value objects, and ports
|-- infrastructure/   # SC2 API, storage, replay parsing, SC2Pulse, HTTP adapters
`-- shared/           # IPC contracts, shared errors, and shared types

tests/                # unit and integration-style tests
scripts/              # build, development, and smoke-test scripts
```

## Runtime Architecture

The renderer never reads application data files directly. UI actions call the preload IPC bridge, IPC handlers call application use cases, and use cases depend on domain ports instead of concrete storage or network adapters.

Main runtime flow:

1. Settings are loaded from local storage.
2. Live monitoring polls the local StarCraft II Client API.
3. Detected 1v1 matches are normalized into domain entities.
4. Opponent and match records are persisted through repository interfaces.
5. Optional enrichment sources, such as SC2Pulse, update opponent identity and ladder data.
6. Replay metadata can be linked to live matches or imported through replay synchronization.

## Replay Processing

Replay parsing is intentionally isolated from the Electron main process. The main process uses `ChildProcessReplayMetadataReader`, which delegates replay parsing to a worker process and falls back to sidecar metadata only when needed.

This keeps large replay batches from retaining parser state in the main Electron heap and reduces the risk of out-of-memory crashes during synchronization.

Relevant modules:

- `src/infrastructure/replay/child-process-replay-metadata-reader.ts`
- `src/infrastructure/replay/replay-metadata-worker.ts`
- `src/infrastructure/replay/sc2-replay-analysis-reader.ts`
- `src/infrastructure/replay/replay-suspicion-analyzer.ts`
- `src/application/use-cases/sync-replay-archive.ts`
- `src/application/use-cases/process-new-replay.ts`

## Voice Assistant

The Voice Assistant is an optional offline Piper-based narrator. It can announce application startup and the detected opponent card.

Voice runtime resources are local-only:

- `resources/voice-models/` contains `.onnx` model files and matching `.onnx.json` configs.
- `resources/voice-wasm/` contains ONNX Runtime and Piper phonemizer WASM assets.
- `voice-model://` is an Electron custom protocol that exposes those resources to the renderer.

Download or refresh bundled voice assets with:

```powershell
npm run voice:download
npm run voice:wasm
```

The narrator waits until settings and the Piper runtime are ready before playing the launch greeting. Live opponent announcements are debounced briefly so late MMR/race enrichment can replace the first raw SC2 Client API snapshot before it is spoken.

## Future Replay Suspicion Review

Replay suspicion analysis is currently disabled. The previous score-based panel was too noisy and should not ship as an automatic maphack detector.

Future work should be a manual-review aid instead of a verdict system. It should show concrete replay timestamps and explain why each moment is worth checking:

- camera or command movement toward hidden army, tech, or drop paths;
- no friendly unit nearby and no recent scouting memory;
- no scan, observer, overlord, creep, sensor tower, or recent army contact explaining the information;
- repeated suspicious moments across a match, shown as evidence rather than a standalone score.

See the repository `TODO.md` for the parked design notes and re-enable criteria.

## Local Storage

The application uses file-based repositories for local records:

- `FileOpponentRepository`
- `FileMatchRepository`
- `FileAppSettingsRepository`
- `FileEnrichmentCandidateRepository`

Opponent and match repositories support CSV and XML formats and write through atomic file replacement. Settings and source snapshots are JSON.

The active data directory can be opened from Settings in the app. For development, it can also be overridden with:

```powershell
$env:SC2_ASSISTANT_DATA_DIR = "path\\to\\local-data"
```

Primary local data files:

```text
opponents.csv
matches.csv
enrichment-candidates.json
opponent-source-fixtures.json
settings.json
storage-manifest.json
```

## Environment Variables

```text
SC2_ASSISTANT_DATA_DIR              Override local data directory.
SC2_ASSISTANT_PLAYER_NAME           Override configured player name.
SC2_ASSISTANT_POLL_INTERVAL_MS      Override live polling interval.
SC2_ASSISTANT_RENDERER_URL          Override renderer URL used by Electron dev mode.
SC2_ASSISTANT_SMOKE_EXIT_MS         Auto-exit delay for smoke tests.
SC2_ASSISTANT_AUTOSTART_CHECK_MS    Delay used by monitoring autostart checks.
```

## External Data Sources

External opponent enrichment must go through `OpponentDataSourcePort`. Concrete adapters belong in `src/infrastructure/`, and application code should use `OpponentEnrichmentService` instead of calling external services directly.

SC2Pulse integration is settings-aware and cache-wrapped:

- `SettingsAwareOpponentDataSource` respects global and per-source settings.
- `CachedOpponentDataSource` caches successful, empty, and failing responses.
- Repeated source failures open a temporary cooldown instead of retrying aggressively.
- Source errors are returned as warnings and should not break match detection.

## Development Notes

- Keep UI code behind IPC boundaries.
- Keep replay parsing isolated from the Electron main process.
- Prefer use cases in `src/application/` for behavior that reads or mutates local records.
- Keep network adapters replaceable behind domain ports.
- Avoid adding local machine paths, personal names, or generated build artifacts to documentation or source control.
