import { type Match, type ReplayMetadata } from "../../domain/entities/match.js";
import type { ReplayMetadataReaderPort } from "../../domain/ports/replay-metadata-reader-port.js";
import type { MatchRepository } from "../../domain/repositories/match-repository.js";
import type { ProcessNewReplay } from "./process-new-replay.js";

export type BackfillReplayMetadataResult = {
  readonly inspectedCount: number;
  readonly updatedCount: number;
  readonly failedCount: number;
};

export type BackfillReplayMetadataDependencies = {
  readonly matchRepository: MatchRepository;
  readonly replayMetadataReader: ReplayMetadataReaderPort;
  readonly processNewReplay: ProcessNewReplay;
  readonly maxItems?: number;
};

export class BackfillReplayMetadata {
  constructor(private readonly dependencies: BackfillReplayMetadataDependencies) {}

  async execute(): Promise<BackfillReplayMetadataResult> {
    const matches = await this.dependencies.matchRepository.findAll();
    const allTargets = matches.filter(needsReplayMetadataBackfill);
    const targets = this.dependencies.maxItems === undefined
      ? allTargets
      : allTargets.slice(0, Math.max(0, Math.floor(this.dependencies.maxItems)));
    let updatedCount = 0;
    let failedCount = 0;

    for (const match of targets) {
      try {
        const metadata = await this.dependencies.replayMetadataReader.readMetadata({
          path: match.replayPath ?? "",
          modifiedAt: match.playedAt
        });
        const before = snapshot(match);
        const result = await this.dependencies.processNewReplay.execute(metadata);

        if (result && snapshot(result.match) !== before) {
          updatedCount += 1;
        }
      } catch {
        failedCount += 1;
      }
    }

    return {
      inspectedCount: targets.length,
      updatedCount,
      failedCount
    };
  }
}

function needsReplayMetadataBackfill(match: Match): boolean {
  return Boolean(match.replayPath) && (
    match.result === "unknown" ||
    !match.map ||
    typeof match.durationSeconds !== "number"
  );
}

function snapshot(match: Match): string {
  const metadata: Pick<ReplayMetadata, "replayPath" | "playedAt" | "map" | "result" | "durationSeconds"> = {
    replayPath: match.replayPath ?? "",
    playedAt: match.playedAt,
    map: match.map,
    result: match.result,
    durationSeconds: match.durationSeconds
  };

  return JSON.stringify(metadata);
}
