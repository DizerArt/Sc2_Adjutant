# SC2 Adjutant v1.1.8

## Highlights

- Hardened opponent identity matching around BattleTag, replay `toon`, Battle.net profile id, and observed MMR.
- Replay sync now resolves all opponents through replay profile ids when available, not only barcode opponents.
- Already imported replays can be repaired during sync if they were linked to a wrong same-name opponent card.
- Same-name players such as `Asyl` and `Showtime` are protected from SC2Pulse nickname collisions.
- The overlay now displays opponent MMR.
- Version bumped from `1.1.7` to `1.1.8`.

## Opponent Identity

- Added a BattleTag value object and BattleTag parsing from SC2 client API payloads.
- Live match registration now stores BattleTag and uses it as a stable identity signal.
- Same-name opponents with different BattleTags are kept as separate records.
- Enrichment now rejects candidates whose BattleTag conflicts with the trusted live BattleTag.
- Nickname-only enrichment now checks observed local MMR to avoid assigning unrelated SC2Pulse profiles.
- Existing local BattleTag data is preserved when a candidate does not provide a better trusted value.
- Opponent source cache keys now include BattleTag and observed MMR to avoid stale cross-player lookups.

## Replay Sync And Repair

- Replay archive sync now builds opponent ids from replay `toon` profile links for every opponent with a profile id.
- Replay sync now sends the replay-derived profile link into enrichment for normal nicknames and barcode names.
- Replay sync avoids falling back to same-name alias matching when a replay profile id is available.
- Already linked replay records are reconciled against the replay profile id and can be moved to the correct opponent card.
- Replay sync repairs the match opponent race from replay metadata during reconciliation.
- New replay processing after live matches now also uses replay `toon` for normal opponent enrichment.
- Duplicate cleanup now removes stale zero-match nickname duplicates when a same-name profile-id card has real matches.
- Profile-id-backed cards are protected from later nickname-only merging.

## SC2Pulse Matching

- SC2Pulse adapter now verifies requested Battle.net profile links against returned candidate profile ids.
- Candidates with mismatched profile ids are rejected even when nickname, race, or MMR look plausible.
- Adapter tests cover the `Asyl` / `Rod#2146` style mismatch where name search returns the wrong player.

## Overlay

- Added MMR to the in-game overlay stat row.
- Updated overlay stat layout to fit the additional MMR value.

## Tests

- Added coverage for BattleTag extraction from client API payloads.
- Added coverage for stable BattleTag registration and same-name/different-BattleTag separation.
- Added coverage for BattleTag mismatch rejection and nickname-only MMR mismatch rejection.
- Added coverage for replay sync profile-id lookup for normal players.
- Added coverage for already imported replay repair from replay profile id.
- Added coverage for stale zero-game duplicate cleanup.
- Added coverage for strict SC2Pulse profile-link verification.

## Verification

- `npm.cmd test` passed: 44 test files, 237 tests.
- `npm.cmd run typecheck` passed.
- `npm.cmd run build` passed.
- `npm.cmd run dist:win` passed.

## Artifacts

- `SC2 Adjutant Setup 1.1.8.exe`
- `SC2 Adjutant 1.1.8.exe`
