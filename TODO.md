# TODO

## Replay Suspicion Review

Status: parked. Do not ship as an automatic maphack detector.

The previous score-based replay suspicion panel is disabled for now. The current heuristic is not reliable enough to identify cheaters, especially when the replay requires full context around scouting, fog of war, standard map paths, scans, observers, creep, and player game sense.

Future direction:

- Build a review tool, not a verdict system.
- Show concrete suspicious replay moments with timestamps.
- Explain each marker in plain language, for example: no friendly unit nearby, no recent scouting memory, command/camera moved toward hidden army or tech.
- Reconstruct legal information as accurately as possible before scoring: scouting history, scans, observers, overlords, creep, sensor towers, army contact, and known expansion timings.
- Compare suspicious moments against normal ladder/high-level replay baselines before raising severity.
- Keep any global score secondary to the actual evidence list.

Useful output format:

```text
Replay Suspicion Review
- 03:12 camera moved to hidden drop path; no friendly vision in last 90s.
- 05:48 army pre-split before unseen attack; no prior contact found.
- 07:10 command issued near hidden tech; no scan/observer/scout found.
```

Acceptance bar before re-enabling:

- confirmed-cheater replays produce reviewable timestamps, not just a high score;
- clean high-level replays do not produce high severity from normal map awareness;
- each marker has a clear explanation and can be manually verified in the replay.
