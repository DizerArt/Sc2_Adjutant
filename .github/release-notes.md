# SC2 Adjutant 1.1.9

## What's new

- Added replay tracker-event race inference for imported and synchronized replays.
- When the replay summary reports `Unknown` race, SC2 Adjutant now inspects unit creation events and derives the player race from the units actually used in the match.
- The fallback is applied to both replay archive sync and the selected replay detail card.
- Existing replay records with `Unknown` player/opponent races can now be repaired during a full replay sync when the replay file is still available.
- The fallback only runs for replays that contain an `Unknown` race in the summary, keeping normal sync performance unchanged.

## Fixes

- Fixed match history showing `UNKNOWN` race for some synchronized replays even when the replay contains enough data to determine the real race.
- Fixed selected replay details showing both players as `Unknown` in player/APM pills for affected replay files.
- Fixed race-specific encounter, win, and loss counters staying at zero when old linked matches were stored as `Unknown/Unknown`.
- Fixed already linked live matches keeping stale `Unknown` races after replay sync attaches the replay file.
- Fixed opponent profile race samples not being refreshed when sync repairs an old `Unknown` replay match.

## Verification

- `npm.cmd test` passed: 44 test files, 240 tests.
- `npm.cmd run typecheck` passed.
- `npm.cmd run build` passed.
- `npm.cmd run dist:win` passed.

## Artifacts

- `SC2 Adjutant Setup 1.1.9.exe`
- `SC2 Adjutant 1.1.9.exe`
