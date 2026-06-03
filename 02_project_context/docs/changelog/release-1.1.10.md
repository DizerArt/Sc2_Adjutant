# Release 1.1.10

## Summary

This release focuses on the opponent card workflow, replay history accuracy, overlay placement, and the new English-only offline voice assistant.

## User-facing changes

- Added an offline Piper-based Voice Assistant.
  - The assistant can announce app launch and the detected opponent card.
  - Voice narration is English-only for both Russian and English UI modes.
  - Russian voices and experimental Federation/HAL voice integrations were removed.
  - Added a speaker button on the opponent card to manually test how the current opponent card is narrated.
  - Opponent narration is limited to the start of the match and no longer repeats mid-game or after victory.

- Added bundled local voice runtime resources.
  - Bundled Piper/ONNX WASM assets for offline playback.
  - Bundled English voice model resources.
  - Added scripts for refreshing voice models and WASM runtime files.

- Reworked overlay setup behavior.
  - Removed overlay position presets.
  - Added a single overlay setup checkbox.
  - When setup mode is enabled, the overlay becomes interactive and draggable.
  - When setup mode is disabled, the overlay becomes locked and ignores input again.
  - Custom overlay position is saved in app settings.

- Improved overlay opponent display.
  - Overlay MMR and random-race display now follow the same opponent data path as the main application.
  - Overlay favorite handling was fixed so the star state persists correctly when toggled.

- Improved opponent card tags.
  - Maximum strategy tags increased to 12.
  - Maximum tag length increased to 16 characters.
  - Tags can be added from the main opponent card with the plus button.
  - Tags can be removed directly from the main opponent card.
  - Tag chips were made smaller and now shrink to their content instead of leaving a large empty area.
  - Tag styling was tuned for all race themes.
  - Add Info no longer contains the old tag entry section.

- Improved opponent race card layout.
  - Nickname placement was simplified.
  - Race tabs, BattleTag, notes, match-history button, and tag controls were refined.
  - Redundant duplicate headings were removed from local database panels.
  - Known-opponents list density was increased.

- Added opponent card match history.
  - The opponent card now has a Match History button under Notes.
  - The popup shows matches across all races for that opponent.
  - Match history supports pagination.
  - Clicking an opponent-card match opens the selected replay details and statistics.
  - Fixed selected-match highlighting so the clicked replay is selected, not the nearest match.

- Improved replay synchronization and identity handling.
  - Replay sync now keeps opponent identity tied to profile/toon identifiers instead of relying only on nickname matches.
  - Fixed cases where normal players such as Showtime or Asyl could be replaced by unrelated SC2Pulse profiles with the same name.
  - Fixed barcode handling so local player data is not written into the opponent card.
  - Added cleanup/merge behavior for stale zero-game duplicate opponents from older identity logic.
  - Improved race recovery from replay data when SC2Pulse or live sync reports `Unknown`.
  - Improved match result handling for games where the client disconnects before the final result is available.

- Added replay details improvements.
  - Match details can mark a replay as favorite from inside the replay card, not only from the match list.
  - Replay build order and details remain the primary review view.

- Parked the automatic replay suspicion detector.
  - The previous automatic score-based maphack suspicion panel is disabled.
  - A future manual-review approach is documented in `TODO.md`.
  - Replay suspicion analyzer code and tests are kept as groundwork, but the feature is not shipped as an automatic verdict system.

- Updated app documentation.
  - Documented Voice Assistant runtime assets and scripts.
  - Documented that the app can be started before StarCraft II and will pick up the game after launch.
  - Documented that voice narration is English-only and reads English words only.
  - Documented the parked replay suspicion review approach.

## Packaging

- Version bumped from `1.1.9` to `1.1.10`.
- Built Windows artifacts:
  - `SC2 Adjutant Setup 1.1.10.exe`
  - `SC2 Adjutant 1.1.10.exe`

## Verification

- `npm.cmd test` passed: 48 test files, 279 tests.
- `npm.cmd run typecheck` passed.
- `npm.cmd run build` passed.
- `npm.cmd run dist:win` passed.

