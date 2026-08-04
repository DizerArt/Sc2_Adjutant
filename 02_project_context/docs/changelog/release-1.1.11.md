# Release 1.1.11

## Summary

Version 1.1.11 hardens opponent identity resolution. SC2 Adjutant now prioritizes the exact profile link supplied by StarCraft II and refuses to enrich a player from ambiguous nickname-only SC2Pulse results.

## Fixed

- Prevented unrelated accounts with the same nickname from being merged.
- Made every SC2 `battlenet::` profile link a stable opponent key, including non-barcode players.
- Accepted direct SC2Pulse deep-link results only when exactly one account is returned in the requested region.
- Kept strict region, realm, and character-ID verification for Blizzard web profile URLs.
- Blocked BattleTag, MMR, league, and total-games enrichment when a nickname search returns multiple exact-name candidates from one source.
- Allowed a verified profile lookup to replace a stale BattleTag stored by an older application version.
- Disabled nickname/alias merging whenever the live player has a stable profile link.

## Regression coverage

- Added SC2Pulse adapter tests for opaque `battlenet::` IDs, singleton responses, wrong regions, and ambiguous responses.
- Added enrichment tests for duplicate exact nicknames and stale BattleTag replacement.
- Added live registration tests proving that identical nicknames with different profile links remain separate opponents.

## Editions

- Voice EN: English offline Piper assistant.
- Silero Russian Voice: English Piper plus Russian Silero voices `xenia` and `baya`.
- No Voice: voice assistant and voice resources removed.

## Versioning

- Application version: `1.1.11`.
- Combined release tag: `1.1.11+voiceEN+sileroRU`.
