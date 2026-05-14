# SC2 Adjutant

SC2 Adjutant is a desktop assistant for StarCraft II players. It watches live ranked 1v1 games, identifies the opponent, enriches the profile with SC2Pulse data when possible, stores local match history, and helps review recurring opponents from replays.

The project is a standalone application forked from the earlier `Starcraft2_Companion` workspace. This repository contains the production Electron app in `02_application/` and a packaged Windows installer in `installers/`.

## Features

- Live ranked 1v1 opponent detection.
- Opponent profiles with race, nickname, BattleTag, MMR, league, total games, encounter count, wins, losses, confidence, and notes.
- Barcode player resolution through Battle.net profile links and SC2Pulse lookup when replay data provides enough identity.
- Match history with map, time, duration, APM, favorite marking, filters, and replay links.
- Replay archive synchronization for importing past 1v1 games.
- Match detail view with performance graphs and build order data.
- Local database storage with clear-stats and storage access tools.
- English and Russian interface support.
- SC2-themed UI and race-specific opponent cards.

## Install on Windows

The easiest way to install the app is to use the packaged installer:

```text
installers/SC2 Adjutant Setup 1.0.0.exe
```

Steps:

1. Download or clone this repository.
2. Open the `installers` folder.
3. Run `SC2 Adjutant Setup 1.0.0.exe`.
4. Follow the installer prompts.
5. Start `SC2 Adjutant` from the Start menu or desktop shortcut.

Windows SmartScreen may warn about the file because this build is not code-signed. If you trust this repository, choose `More info` and then `Run anyway`.

## Run from Command Line

For development or local testing, run the Electron application directly from source.

Requirements:

- Windows 10 or Windows 11.
- Node.js 20 or newer.
- npm.
- StarCraft II installed for live-game detection and replay parsing.

Commands:

```powershell
cd A:\Coding\AI_Project\Sc2_Adjutant\02_application
npm install
npm run dev
```

Useful checks:

```powershell
npm test
npm run typecheck
npm run build
```

Create a Windows installer locally:

```powershell
npm run dist:win
```

The generated installer will appear under:

```text
02_application/release/
```

## Repository Layout

```text
.
├── 02_application/        # Electron, React, domain logic, storage, replay sync, tests
├── installers/            # Packaged Windows installer kept with this standalone repo
├── README.md              # Project overview and setup instructions
├── .gitignore
└── .editorconfig
```

## Local Data

SC2 Adjutant stores its runtime data locally on the user's machine. Local data and generated build output are intentionally ignored by Git.

Ignored examples:

- `node_modules/`
- `02_application/release/`
- `02_application/local-data/`
- `dist/`, `build/`, coverage, cache, and test output directories.

## Notes

This project is not affiliated with Blizzard Entertainment. StarCraft II and related names belong to their respective owners.
