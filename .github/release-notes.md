# SC2 Adjutant 1.1.8

## What's new

- Hardened opponent identity matching for normal players and barcodes.
- Replay sync now uses the Battle.net profile id from replay `toon` data for all opponents, not only barcode names.
- Existing wrongly linked replay records can be repaired during sync and moved to the correct profile-id opponent card.
- SC2Pulse results are now rejected when the requested Battle.net profile id does not match the candidate returned by the source.
- Same-name players such as `Asyl` and `Showtime` are no longer merged or overwritten when their profile ids differ.
- Stale zero-game duplicate cards from older logic are removed automatically when a same-name profile-id card has real matches.
- The live overlay now shows opponent MMR.
- BattleTag from the SC2 client API is preserved and used as a trusted identity signal for live matches.

## Fixes

- Fixed nickname-only SC2Pulse enrichment assigning data from a famous or unrelated same-name player.
- Fixed replay archive sync still resolving non-barcode players by name only.
- Fixed already imported replay records keeping the wrong opponent id after the identity logic was improved.
- Fixed duplicate cleanup so profile-id-backed cards are protected from nickname-only merging.
- Fixed local player data leaking into opponent records by filtering trusted BattleTags and local player identities.
- Fixed cache keys so BattleTag and observed MMR are part of opponent-source lookups.

## Verification

- `npm.cmd test` passed: 44 test files, 237 tests.
- `npm.cmd run typecheck` passed.
- `npm.cmd run build` passed.
- `npm.cmd run dist:win` passed.

## Artifacts

- `SC2 Adjutant Setup 1.1.8.exe`
- `SC2 Adjutant 1.1.8.exe`
