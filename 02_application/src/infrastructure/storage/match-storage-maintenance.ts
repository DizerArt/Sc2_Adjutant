import type { Match } from "../../domain/entities/match.js";
import { readTextFileIfExists, writeTextFileAtomically } from "./atomic-file.js";
import type { FileStorageFormat } from "./file-opponent-repository.js";
import { matchesFromCsv, matchesFromXml, matchesToCsv, matchesToXml } from "./storage-codecs.js";

export type CompactMatchStorageOptions = {
  readonly filePath: string;
  readonly format: FileStorageFormat;
  readonly duplicateWindowMs?: number;
};

export type CompactMatchStorageResult = {
  readonly beforeCount: number;
  readonly afterCount: number;
  readonly removedCount: number;
};

const DEFAULT_DUPLICATE_WINDOW_MS = 15_000;
const STALE_REPLAYLESS_AFTER_REPLAY_WINDOW_MS = 10 * 60 * 1000;

export async function compactMatchStorage(
  options: CompactMatchStorageOptions
): Promise<CompactMatchStorageResult> {
  const content = await readTextFileIfExists(options.filePath);
  if (content === null || !content.trim()) {
    return { beforeCount: 0, afterCount: 0, removedCount: 0 };
  }

  const matches = options.format === "csv" ? matchesFromCsv(content) : matchesFromXml(content);
  const compacted = compactMatches(matches, options.duplicateWindowMs ?? DEFAULT_DUPLICATE_WINDOW_MS);

  if (compacted.length !== matches.length) {
    const nextContent = options.format === "csv" ? matchesToCsv(compacted) : matchesToXml(compacted);
    await writeTextFileAtomically(options.filePath, nextContent);
  }

  return {
    beforeCount: matches.length,
    afterCount: compacted.length,
    removedCount: matches.length - compacted.length
  };
}

export function compactMatches(
  matches: readonly Match[],
  duplicateWindowMs = DEFAULT_DUPLICATE_WINDOW_MS
): readonly Match[] {
  const sorted = [...matches].sort(compareByPlayedAtThenCreatedAt);
  const compacted: Match[] = [];

  for (const match of sorted) {
    const previous = compacted[compacted.length - 1];

    if (previous && isDuplicateMatch(previous, match, duplicateWindowMs)) {
      compacted[compacted.length - 1] = mergeDuplicateMatches(previous, match);
      continue;
    }

    compacted.push(match);
  }

  return compacted.sort(compareByCreatedAtThenPlayedAt);
}

function isDuplicateMatch(first: Match, second: Match, duplicateWindowMs: number): boolean {
  if (first.id === second.id) {
    return true;
  }

  if (first.replayPath && first.replayPath === second.replayPath) {
    return true;
  }

  if (isStaleReplaylessDuplicate(first, second)) {
    return true;
  }

  if (matchSignature(first) !== matchSignature(second)) {
    return false;
  }

  const firstTime = Date.parse(first.playedAt);
  const secondTime = Date.parse(second.playedAt);

  if (!Number.isFinite(firstTime) || !Number.isFinite(secondTime)) {
    return false;
  }

  return Math.abs(secondTime - firstTime) <= duplicateWindowMs;
}

function isStaleReplaylessDuplicate(first: Match, second: Match): boolean {
  const replayMatch = first.replayPath ? first : second.replayPath ? second : null;
  const replaylessMatch = replayMatch === first ? second : replayMatch === second ? first : null;

  if (!replayMatch || !replaylessMatch) {
    return false;
  }

  if (replaylessMatch.replayPath || replaylessMatch.map || replaylessMatch.durationSeconds !== undefined) {
    return false;
  }

  if (
    replayMatch.opponentId !== replaylessMatch.opponentId ||
    replayMatch.playerRace !== replaylessMatch.playerRace ||
    replayMatch.opponentRace !== replaylessMatch.opponentRace ||
    replayMatch.result !== replaylessMatch.result
  ) {
    return false;
  }

  const replayTime = Date.parse(replayMatch.playedAt);
  const replaylessTime = Date.parse(replaylessMatch.playedAt);

  return (
    Number.isFinite(replayTime) &&
    Number.isFinite(replaylessTime) &&
    Math.abs(replaylessTime - replayTime) <= STALE_REPLAYLESS_AFTER_REPLAY_WINDOW_MS
  );
}

function mergeDuplicateMatches(first: Match, second: Match): Match {
  return {
    ...first,
    playedAt: earlierIso(first.playedAt, second.playedAt),
    map: first.map ?? second.map,
    result: first.result !== "unknown" ? first.result : second.result,
    mmrBefore: first.mmrBefore ?? second.mmrBefore,
    mmrAfter: first.mmrAfter ?? second.mmrAfter,
    durationSeconds: first.durationSeconds ?? second.durationSeconds,
    replayPath: first.replayPath ?? second.replayPath,
    favorite: first.favorite || second.favorite,
    notes: uniqueStrings([...first.notes, ...second.notes]),
    createdAt: earlierIso(first.createdAt, second.createdAt),
    updatedAt: laterIso(first.updatedAt, second.updatedAt)
  };
}

function matchSignature(match: Match): string {
  return [
    match.opponentId,
    match.playerRace,
    match.opponentRace,
    match.map ?? "",
    match.result,
    match.replayPath ?? ""
  ].join("|");
}

function compareByPlayedAtThenCreatedAt(first: Match, second: Match): number {
  return compareIso(first.playedAt, second.playedAt) || compareIso(first.createdAt, second.createdAt);
}

function compareByCreatedAtThenPlayedAt(first: Match, second: Match): number {
  return compareIso(first.createdAt, second.createdAt) || compareIso(first.playedAt, second.playedAt);
}

function compareIso(first: string, second: string): number {
  return Date.parse(first) - Date.parse(second);
}

function earlierIso(first: string, second: string): string {
  return compareIso(first, second) <= 0 ? first : second;
}

function laterIso(first: string, second: string): string {
  return compareIso(first, second) >= 0 ? first : second;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
