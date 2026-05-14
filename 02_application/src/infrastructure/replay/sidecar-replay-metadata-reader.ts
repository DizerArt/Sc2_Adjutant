import { readTextFileIfExists } from "../storage/atomic-file.js";
import type { MatchResult, ReplayMetadata } from "../../domain/entities/match.js";
import type { ReplayFile, ReplayMetadataReaderPort } from "../../domain/ports/replay-metadata-reader-port.js";

type ReplaySidecar = {
  readonly playedAt?: string;
  readonly map?: string;
  readonly result?: MatchResult;
  readonly durationSeconds?: number;
};

export class SidecarReplayMetadataReader implements ReplayMetadataReaderPort {
  async readMetadata(file: ReplayFile): Promise<ReplayMetadata> {
    const sidecar = await readSidecar(file.path);

    return {
      replayPath: file.path,
      playedAt: sidecar?.playedAt ?? file.modifiedAt,
      map: sidecar?.map,
      result: sidecar?.result,
      durationSeconds: sidecar?.durationSeconds
    };
  }
}

async function readSidecar(replayPath: string): Promise<ReplaySidecar | null> {
  const content = await readTextFileIfExists(`${replayPath}.json`);

  if (!content) {
    return null;
  }

  const parsed = JSON.parse(content) as Partial<ReplaySidecar>;

  return {
    playedAt: normalizeOptionalString(parsed.playedAt),
    map: normalizeOptionalString(parsed.map),
    result: normalizeResult(parsed.result),
    durationSeconds: normalizeDuration(parsed.durationSeconds)
  };
}

function normalizeResult(value: string | undefined): MatchResult | undefined {
  if (value === "win" || value === "loss" || value === "unknown") {
    return value;
  }

  return undefined;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeDuration(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}
