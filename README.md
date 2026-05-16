# SC2 Adjutant

SC2 Adjutant is a Windows desktop assistant for StarCraft II players. It detects live ranked 1v1 matches, identifies the opponent, stores local match history, enriches profiles with SC2Pulse data when possible, and helps review opponents through replay synchronization.

## Download and Install

The latest Windows installer is published on GitHub Releases:

https://github.com/DizerArt/Sc2_Adjutant/releases/latest

Download the latest file named like:

```text
SC2 Adjutant Setup <version>.exe
```

Run the installer and start `SC2 Adjutant` from the Start menu or desktop shortcut.

Windows SmartScreen may warn about the installer because the build is not code-signed. If you trust this repository, choose `More info`, then `Run anyway`.

## Features

- Live ranked 1v1 opponent detection.
- Opponent profiles with race, nickname, BattleTag, MMR, league, total games, encounters, wins, losses, confidence, tags, and notes.
- Barcode player resolution from Battle.net profile links and SC2Pulse when replay data provides enough identity.
- Match history with map, time, duration, APM, favorites, filters, and replay file links.
- Replay synchronization for importing past 1v1 games.
- Match details with performance graphs and build order data.
- Local database tools for storage access and statistics cleanup.
- English and Russian interface support.
- SC2-themed race cards and UI.

## Data Accuracy

SC2 Adjutant enriches opponent profiles with data from SC2Pulse and local replay analysis. MMR and league are selected for the observed race when that data is available.

`Total games` is an estimate from SC2Pulse ladder/profile aggregates, not the exact `Total Career Games` value shown inside the Blizzard client. For some accounts it can be significantly lower, sometimes by roughly half. Treat it as contextual scouting data rather than an authoritative career total.

## Run from Source

Use this path if you want to clone the repository and run the app locally.

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

## Local Data

SC2 Adjutant stores runtime data locally on your machine. This includes known opponents, match history, replay sync results, favorites, notes, and settings.

You can open the local storage location from the app settings.

## Support and Bug Reports

If you find a bug, have trouble installing the app, or want to report incorrect match/opponent detection, join the Discord:

https://discord.gg/xrY5E3VmCY

## Notes

This project is not affiliated with Blizzard Entertainment. StarCraft II and related names belong to their respective owners.
