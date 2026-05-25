# SC2 Adjutant v1.1.7

## Highlights

- Improved barcode opponent handling so resolved barcode records can be merged safely by stable BattleTag or selected SC2 profile URL.
- Fixed replay result recovery for disconnect cases where the live SC2 client API left the match result as `unknown`.
- Added a favorite star directly inside the selected replay details card.
- Improved race and MMR repair paths for barcode and `Unknown` race profiles.
- Added a release runbook for future `Сделай Релиз в Гитхаб` requests.

## Fixes

- Barcode opponents are still kept separate while unresolved, but once enrichment snapshots identify the same selected SC2 profile URL, duplicate barcode records are merged into one opponent.
- Existing BattleTag-based duplicate merging remains supported and now preserves/remaps enrichment candidate snapshots to the canonical opponent.
- Replay archive sync now passes enrichment candidate storage into duplicate merging, allowing profile URL based barcode merging after replay imports.
- Replay processing now checks the local replay player result before falling back to opponent-based inference. This fixes disconnect losses that previously stayed as `UNK`.
- Replay processing can repair `Unknown` opponent/player races from replay metadata and promote MMR/league data from the `Unknown` profile into the concrete race profile.
- Barcode replay enrichment now avoids using non-barcode replay players to enrich barcode opponents, reducing local-player data contamination.
- Local player names from settings are passed into replay processing from both IPC and the replay watcher, so local player candidates can be filtered during barcode enrichment.
- SC2 client API parsing now prefers concrete race fields such as `playedRace`, `actualRace`, `raceActual`, `selectedRace`, and `raceSelected` when the generic `race` field is `Unknown`.
- Candidate enrichment now preserves locally known MMR/league data across race profiles when SC2 Pulse does not provide a replacement value.
- Favorite state in the selected replay details card now updates from the live match list state instead of stale cached replay details.

## UI

- Added a star button to the selected replay details header, next to `Replay File`, so matches can be marked or unmarked as favorites without using the right-side match list.
- The selected replay favorite button uses the same favorite action and translations as the match history list.

## Release Process

- Added `02_project_context/docs/007_github-release-webhook.md` with the required release workflow for the trigger phrase `Сделай Релиз в Гитхаб`.
- Updated application version from `1.1.6` to `1.1.7`.
- Added local security audit report patterns to `.gitignore`.

## Verification

- `npm test` passed: 44 test files, 221 tests.
- `npm run typecheck` passed.
- `npm run dist:win` passed.

## Artifacts

- `SC2 Adjutant Setup 1.1.7.exe`
- `SC2 Adjutant 1.1.7.exe`
