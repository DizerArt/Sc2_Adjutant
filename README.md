# SC2 Adjutant

SC2 Adjutant is a desktop assistant for StarCraft II players. It watches live ranked 1v1 games, identifies the opponent, enriches the profile with SC2Pulse data when possible, stores local match history, and helps review recurring opponents from replays.

The project is a standalone application forked from the earlier `Starcraft2_Companion` workspace. The production Electron app lives in `02_application/`. Packaged installers are published through GitHub Releases instead of being committed to Git.

## Download

Installers are available on the Releases page:

```text
https://github.com/DizerArt/Sc2_Adjutant/releases/latest
```

For a normal Windows install, download the latest file named like:

```text
SC2 Adjutant Setup <version>.exe
```

Windows SmartScreen may warn about the file because this build is not code-signed. If you trust this repository, choose `More info` and then `Run anyway`.

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

1. Open the latest release:
   ```text
   https://github.com/DizerArt/Sc2_Adjutant/releases/latest
   ```
2. Download `SC2 Adjutant Setup <version>.exe`.
3. Run the installer.
4. Follow the installer prompts.
5. Start `SC2 Adjutant` from the Start menu or desktop shortcut.

## Run from Command Line

For development or local testing, run the Electron application directly from source.

Requirements:

- Windows 10 or Windows 11.
- Node.js 20 or newer.
- npm.
- StarCraft II installed for live-game detection and replay parsing.

Commands:

```powershell
git clone https://github.com/DizerArt/Sc2_Adjutant.git
cd Sc2_Adjutant\02_application
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

## Publishing a Release

GitHub Releases are created automatically when a version tag is pushed.

Example:

```powershell
git tag v1.0.1
git push origin v1.0.1
```

The GitHub Actions workflow will:

1. Install dependencies.
2. Run tests.
3. Build the Windows installer with `npm run dist:win`.
4. Attach the generated `.exe` and `.blockmap` files to the GitHub Release.

Installer files are intentionally ignored by Git. Do not commit generated `.exe` files into the repository.

## Repository Layout

```text
.
|-- .github/workflows/     # Release automation
|-- 02_application/        # Electron, React, domain logic, storage, replay sync, tests
|-- README.md              # Project overview and setup instructions
|-- .gitignore
`-- .editorconfig
```

## Local Data

SC2 Adjutant stores its runtime data locally on the user's machine. Local data and generated build output are intentionally ignored by Git.

Ignored examples:

- `node_modules/`
- `02_application/release/`
- `02_application/local-data/`
- `installers/`
- `dist/`, `build/`, coverage, cache, and test output directories.

## Notes

This project is not affiliated with Blizzard Entertainment. StarCraft II and related names belong to their respective owners.
