# SC2 Adjutant 1.0.4

## What's new

- Fixed live MMR capture from the SC2 Client API when MMR appears on a later poll of the same match.
- Fixed barcode/random opponent identity handling so local player profile links and BattleTags cannot overwrite the opponent card.
- Improved local player name matching when StarCraft II appends a clan tag, such as `RetorieS <RTS>`.
- Made the `ADD INFO` button thinner so it stays inside the opponent card after tags are added.

## Notes

- Windows installer and portable builds are published by the release workflow.
- The installer is unsigned, so Windows SmartScreen can show a warning on first launch.
