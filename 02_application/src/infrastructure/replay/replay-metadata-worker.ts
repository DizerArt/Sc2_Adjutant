import sc2Reader from "@replaysremastered/sc2readerjs";
import type { ReplayPlayerSummary, ReplaySummary } from "@replaysremastered/sc2readerjs";
import type { MatchResult, ReplayMetadata, ReplayMetadataPlayer } from "../../domain/entities/match.js";
import type { ReplayFile } from "../../domain/ports/replay-metadata-reader-port.js";
import { normalizeRace } from "../../domain/value-objects/race.js";

type WorkerRequest = {
  readonly id: number;
  readonly file: ReplayFile;
  readonly userName?: string;
};

type WorkerResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly metadata: ReplayMetadata;
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly message: string;
    };

process.on("message", (message: unknown) => {
  void handleMessage(message);
});

async function handleMessage(message: unknown): Promise<void> {
  const request = normalizeRequest(message);
  if (!request) {
    return;
  }

  try {
    const summary = await sc2Reader.loadReplaySummary(request.file.path);
    sendResponse({
      id: request.id,
      ok: true,
      metadata: metadataFromSummary(summary, request.file, request.userName)
    });
  } catch (error) {
    sendResponse({
      id: request.id,
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

function metadataFromSummary(
  summary: ReplaySummary,
  file: ReplayFile,
  userName: string | undefined
): ReplayMetadata {
  return {
    replayPath: file.path,
    playedAt: summary.playedAt ?? file.modifiedAt,
    map: summary.mapTitle ?? undefined,
    result: matchResultForUser(summary.players, userName?.trim()),
    players: replayPlayersFromSummary(summary.players),
    durationSeconds: normalizeDuration(summary.durationSeconds)
  };
}

function normalizeRequest(value: unknown): WorkerRequest | null {
  if (!isRecord(value) || typeof value.id !== "number" || !isRecord(value.file)) {
    return null;
  }

  const path = value.file.path;
  const modifiedAt = value.file.modifiedAt;
  if (typeof path !== "string" || typeof modifiedAt !== "string") {
    return null;
  }

  return {
    id: value.id,
    file: { path, modifiedAt },
    userName: typeof value.userName === "string" ? value.userName : undefined
  };
}

function replayPlayersFromSummary(
  players: readonly ReplayPlayerSummary[] | undefined
): readonly ReplayMetadataPlayer[] | undefined {
  if (!players || players.length === 0) {
    return undefined;
  }

  return players
    .filter((player) => player.name !== null)
    .map((player) => ({
      name: normalizeReplayPlayerName(player.name ?? ""),
      race: normalizeRace(player.race),
      result: normalizeReplayResult(player.result),
      toon: normalizeOptionalString(player.toon ?? undefined)
    }));
}

function normalizeReplayPlayerName(value: string): string {
  return value.replace(/^(?:<[^>]+>\s*)+/, "").trim();
}

function normalizeDuration(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function matchResultForUser(
  players: readonly ReplayPlayerSummary[] | undefined,
  userName: string | undefined
): MatchResult | undefined {
  if (!userName || !players || players.length === 0) {
    return undefined;
  }

  const normalizedUserName = normalizeReplayPlayerName(userName).toLowerCase();
  const userPlayer = players.find((player) =>
    player.name !== null && normalizeReplayPlayerName(player.name).toLowerCase() === normalizedUserName
  );

  if (!userPlayer) {
    return undefined;
  }

  if (userPlayer.result === "win" || userPlayer.result === "loss") {
    return userPlayer.result;
  }

  return "unknown";
}

function normalizeReplayResult(value: ReplayPlayerSummary["result"]): MatchResult | undefined {
  if (value === "win" || value === "loss") {
    return value;
  }

  if (value === "tie") {
    return "unknown";
  }

  return undefined;
}

function sendResponse(response: WorkerResponse): void {
  if (process.send) {
    process.send(response);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
