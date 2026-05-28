import { createEnrichmentCandidateSnapshot } from "../../domain/entities/enrichment-candidate-snapshot.js";
import {
  attachReplayMetadata,
  createMatch,
  type Match,
  type MatchResult,
  type ReplayMetadata,
  type ReplayMetadataPlayer
} from "../../domain/entities/match.js";
import {
  createOpponent,
  recordOpponentMatch,
  updateOpponentMatchResult,
  type Opponent
} from "../../domain/entities/opponent.js";
import type { OpponentSearchQuery } from "../../domain/ports/opponent-data-source-port.js";
import type { ReplayFileScannerPort } from "../../domain/ports/replay-file-scanner-port.js";
import type { ReplayFile, ReplayMetadataReaderPort } from "../../domain/ports/replay-metadata-reader-port.js";
import type { EnrichmentCandidateRepository } from "../../domain/repositories/enrichment-candidate-repository.js";
import type { MatchRepository } from "../../domain/repositories/match-repository.js";
import type { OpponentRepository } from "../../domain/repositories/opponent-repository.js";
import { isBarcodeNickname } from "../../domain/value-objects/barcode.js";
import { createStableEntityId } from "../../domain/value-objects/entity-id.js";
import type { Race } from "../../domain/value-objects/race.js";
import type { OpponentEnrichmentService } from "../services/opponent-enrichment-service.js";
import { MergeDuplicateOpponents } from "./merge-duplicate-opponents.js";
import { RebuildOpponentStats } from "./rebuild-opponent-stats.js";

export type ReplaySyncMode = "full" | "partial";

export type SyncReplayArchiveInput = {
  readonly directory: string;
  readonly userName: string;
  readonly mode: ReplaySyncMode;
  readonly limit?: number;
  readonly region?: OpponentSearchQuery["region"];
};

export type SyncReplayArchiveResult = {
  readonly scannedCount: number;
  readonly inspectedCount: number;
  readonly processedCount: number;
  readonly importedCount: number;
  readonly linkedCount: number;
  readonly skippedExistingCount: number;
  readonly skippedUnsupportedCount: number;
  readonly failedCount: number;
};

export type SyncReplayArchiveDependencies = {
  readonly replayFileScanner: ReplayFileScannerPort;
  readonly replayMetadataReader: ReplayMetadataReaderPort;
  readonly matchRepository: MatchRepository;
  readonly opponentRepository: OpponentRepository;
  readonly enrichmentService?: OpponentEnrichmentService;
  readonly enrichmentCandidateRepository?: EnrichmentCandidateRepository;
  readonly onBatchProcessed?: (result: SyncReplayArchiveResult) => Promise<void>;
  readonly batchSize?: number;
  readonly clock?: () => string;
};

type ReplayMatchPlayers = {
  readonly user: ReplayMetadataPlayer;
  readonly opponent: ReplayMetadataPlayer;
};

type DuplicateMatch = {
  readonly match: Match;
  readonly alreadyLinked: boolean;
};

export class SyncReplayArchive {
  private readonly clock: () => string;

  constructor(private readonly dependencies: SyncReplayArchiveDependencies) {
    this.clock = dependencies.clock ?? (() => new Date().toISOString());
  }

  async execute(input: SyncReplayArchiveInput): Promise<SyncReplayArchiveResult> {
    const directory = input.directory.trim();
    const userName = input.userName.trim();

    if (!directory) {
      throw new Error("Replay directory is not configured.");
    }

    if (!userName) {
      throw new Error("SC2 name is not configured.");
    }

    const files = await this.dependencies.replayFileScanner.scan(directory);
    const replayFiles = sortNewestFirst(files);
    const selectedFiles = input.mode === "partial"
      ? replayFiles.slice(0, normalizeLimit(input.limit))
      : replayFiles;
    const result: MutableSyncReplayArchiveResult = {
      scannedCount: replayFiles.length,
      inspectedCount: selectedFiles.length,
      processedCount: 0,
      importedCount: 0,
      linkedCount: 0,
      skippedExistingCount: 0,
      skippedUnsupportedCount: 0,
      failedCount: 0
    };

    let processedCount = 0;
    const batchSize = normalizeBatchSize(this.dependencies.batchSize);
    await this.dependencies.onBatchProcessed?.(result);

    for (const file of selectedFiles) {
      try {
        await this.importReplay(file, userName, input.region, result);
      } catch {
        result.failedCount += 1;
      }

      processedCount += 1;
      result.processedCount = processedCount;
      if (this.dependencies.onBatchProcessed && processedCount % batchSize === 0) {
        await this.dependencies.onBatchProcessed(result);
      }
    }

    await new MergeDuplicateOpponents({
      opponentRepository: this.dependencies.opponentRepository,
      matchRepository: this.dependencies.matchRepository,
      enrichmentCandidateRepository: this.dependencies.enrichmentCandidateRepository,
      clock: this.clock
    }).execute();
    await new RebuildOpponentStats({
      opponentRepository: this.dependencies.opponentRepository,
      matchRepository: this.dependencies.matchRepository,
      clock: this.clock
    }).execute();

    return result;
  }

  private async importReplay(
    file: ReplayFile,
    userName: string,
    region: OpponentSearchQuery["region"] | undefined,
    result: MutableSyncReplayArchiveResult
  ): Promise<void> {
    const metadata = await this.dependencies.replayMetadataReader.readMetadata(file);
    const players = replayMatchPlayers(metadata, userName);

    if (!players) {
      result.skippedUnsupportedCount += 1;
      return;
    }

    const duplicate = await this.findDuplicateMatch(metadata, players);
    if (duplicate?.alreadyLinked) {
      await this.reconcileAlreadyLinkedReplayMatch(duplicate.match, players, region, userName);
      result.skippedExistingCount += 1;
      return;
    }

    if (duplicate) {
      await this.linkExistingMatch(duplicate.match, metadata, players, region, userName);
      result.linkedCount += 1;
      return;
    }

    await this.createMatchFromReplay(metadata, file, players, region, userName);
    result.importedCount += 1;
  }

  private async findDuplicateMatch(
    metadata: ReplayMetadata,
    players: ReplayMatchPlayers
  ): Promise<DuplicateMatch | null> {
    const [matches, opponents] = await Promise.all([
      this.dependencies.matchRepository.findAll(),
      this.dependencies.opponentRepository.findAll()
    ]);
    const replayPath = normalizePath(metadata.replayPath);

    if (replayPath) {
      const byReplayPath = matches.find((match) => normalizePath(match.replayPath) === replayPath);
      if (byReplayPath) {
        return {
          match: byReplayPath,
          alreadyLinked: true
        };
      }
    }

    const replayPlayedAt = metadata.playedAt ? Date.parse(metadata.playedAt) : Number.NaN;
    if (!Number.isFinite(replayPlayedAt)) {
      return null;
    }

    const opponentsById = new Map(opponents.map((opponent) => [opponent.id, opponent]));
    const candidate = matches
      .filter((match) => !match.replayPath)
      .filter((match) =>
        isLikelySameReplaylessMatch(match, metadata, players, opponentsById.get(match.opponentId), replayPlayedAt)
      )
      .sort((first, second) => replaylessDistance(first, replayPlayedAt) - replaylessDistance(second, replayPlayedAt))[0];

    return candidate
      ? {
        match: candidate,
        alreadyLinked: false
      }
      : null;
  }

  private async linkExistingMatch(
    match: Match,
    metadata: ReplayMetadata,
    players: ReplayMatchPlayers,
    region: OpponentSearchQuery["region"] | undefined,
    userName: string
  ): Promise<void> {
    const effectiveMetadata = {
      ...metadata,
      result: metadata.result && metadata.result !== "unknown" ? metadata.result : resultFromUserPlayer(players.user)
    };
    const now = this.clock();
    const raceRepairedMatch = repairMatchRacesFromReplay(match, players, now);
    const updatedMatch = attachReplayMetadata(raceRepairedMatch, effectiveMetadata, now);
    await this.dependencies.matchRepository.save(updatedMatch);

    const opponent = await this.dependencies.opponentRepository.findById(updatedMatch.opponentId);
    if (!opponent) {
      return;
    }

    const statsOpponent = mergeReplayOpponentSample(
      updateOpponentMatchResult(opponent, match.result, updatedMatch.result),
      players.opponent,
      now
    );
    await this.enrichOpponent(statsOpponent, players.opponent, region, [userName, players.user.name], updatedMatch.opponentRace);
  }

  private async createMatchFromReplay(
    metadata: ReplayMetadata,
    file: ReplayFile,
    players: ReplayMatchPlayers,
    region: OpponentSearchQuery["region"] | undefined,
    userName: string
  ): Promise<void> {
    const now = this.clock();
    const playedAt = metadata.playedAt ?? file.modifiedAt ?? now;
    const opponent = await this.findOrCreateOpponent(players.opponent, playedAt, now);
    const match = createMatch({
      id: createStableEntityId("match", metadata.replayPath),
      opponentId: opponent.id,
      playedAt,
      map: metadata.map,
      playerRace: players.user.race,
      opponentRace: players.opponent.race,
      result: metadata.result && metadata.result !== "unknown" ? metadata.result : resultFromUserPlayer(players.user),
      durationSeconds: metadata.durationSeconds,
      replayPath: metadata.replayPath,
      now
    });
    const updatedOpponent = recordOpponentMatch(opponent, match.result, match.playedAt);

    await this.dependencies.opponentRepository.save(updatedOpponent);
    await this.dependencies.matchRepository.save(match);
    await this.enrichOpponent(updatedOpponent, players.opponent, region, [userName, players.user.name], match.opponentRace);
  }

  private async findOrCreateOpponent(
    replayOpponent: ReplayMetadataPlayer,
    playedAt: string,
    now: string
  ): Promise<Opponent> {
    const opponentId = buildOpponentId(replayOpponent, playedAt);
    const byId = await this.dependencies.opponentRepository.findById(opponentId);
    if (byId) {
      return mergeReplayOpponentSample(byId, replayOpponent, now);
    }

    if (replayProfileQuery(replayOpponent)) {
      return createOpponent({
        id: opponentId,
        nickname: replayOpponent.name,
        race: replayOpponent.race,
        now
      });
    }

    if (!isBarcodeNickname(replayOpponent.name)) {
      const normalizedReplayName = normalizePlayerIdentityName(replayOpponent.name);
      const existing = (await this.dependencies.opponentRepository.findAll()).find((opponent) =>
        opponentMatchesPlayerIdentity(opponent, normalizedReplayName)
      );
      if (existing) {
        return mergeReplayOpponentSample(existing, replayOpponent, now);
      }
    }

    return createOpponent({
      id: opponentId,
      nickname: replayOpponent.name,
      race: replayOpponent.race,
      now
    });
  }

  private async enrichOpponent(
    opponent: Opponent,
    replayOpponent: ReplayMetadataPlayer,
    region: OpponentSearchQuery["region"] | undefined,
    excludedNicknames: readonly string[],
    targetRace: Race
  ): Promise<void> {
    if (!this.dependencies.enrichmentService) {
      await this.dependencies.opponentRepository.save(opponent);
      return;
    }

    const profileLink = replayProfileQuery(replayOpponent);
    const enrichment = await this.dependencies.enrichmentService.enrich(opponent, {
      nickname: replayOpponent.name,
      profileLink,
      race: targetRace,
      region,
      excludedNicknames
    });
    const capturedAt = this.clock();
    const snapshots = enrichment.candidates.map((candidate) =>
      createEnrichmentCandidateSnapshot(
        opponent.id,
        candidate,
        enrichment.bestCandidate === candidate,
        capturedAt
      )
    );

    await this.dependencies.opponentRepository.save(enrichment.opponent);
    await this.dependencies.enrichmentCandidateRepository?.replaceForOpponent(opponent.id, snapshots);
  }

  private async reconcileAlreadyLinkedReplayMatch(
    match: Match,
    players: ReplayMatchPlayers,
    region: OpponentSearchQuery["region"] | undefined,
    userName: string
  ): Promise<void> {
    const now = this.clock();
    const raceRepairedMatch = repairMatchRacesFromReplay(match, players, now);
    const profileLink = replayProfileQuery(players.opponent);
    if (!profileLink) {
      if (raceRepairedMatch !== match) {
        await this.dependencies.matchRepository.save(raceRepairedMatch);
        const existingOpponent = await this.dependencies.opponentRepository.findById(match.opponentId);
        if (existingOpponent) {
          await this.dependencies.opponentRepository.save(
            mergeReplayOpponentSample(existingOpponent, players.opponent, now)
          );
        }
      }
      return;
    }

    const expectedOpponentId = createStableEntityId("opponent", profileLink);
    let opponent = await this.dependencies.opponentRepository.findById(expectedOpponentId);
    if (!opponent) {
      opponent = createOpponent({
        id: expectedOpponentId,
        nickname: players.opponent.name,
        race: players.opponent.race,
        now
      });
      await this.dependencies.opponentRepository.save(opponent);
    }

    if (raceRepairedMatch.opponentId !== expectedOpponentId) {
      await this.dependencies.matchRepository.save({
        ...raceRepairedMatch,
        opponentId: expectedOpponentId,
        updatedAt: now
      });
    } else if (raceRepairedMatch !== match) {
      await this.dependencies.matchRepository.save(raceRepairedMatch);
    }

    await this.enrichOpponent(opponent, players.opponent, region, [userName, players.user.name], players.opponent.race);
  }
}

type MutableSyncReplayArchiveResult = {
  -readonly [Key in keyof SyncReplayArchiveResult]: SyncReplayArchiveResult[Key];
};

function replayMatchPlayers(metadata: ReplayMetadata, userName: string): ReplayMatchPlayers | null {
  if (!metadata.players || metadata.players.length !== 2) {
    return null;
  }

  const user = metadata.players.find((player) => playerMatchesUser(player, userName));
  if (!user) {
    return null;
  }

  const opponent = metadata.players.find((player) => player !== user);
  return opponent ? { user, opponent } : null;
}

function playerMatchesUser(player: ReplayMetadataPlayer, userName: string): boolean {
  const playerIdentity = normalizePlayerIdentityName(player.name);
  const configuredIdentity = normalizePlayerIdentityName(userName);
  return Boolean(playerIdentity && configuredIdentity && playerIdentity === configuredIdentity);
}

function resultFromUserPlayer(player: ReplayMetadataPlayer): MatchResult {
  if (player.result === "win" || player.result === "loss") {
    return player.result;
  }

  return "unknown";
}

function isLikelySameReplaylessMatch(
  match: Match,
  metadata: ReplayMetadata,
  players: ReplayMatchPlayers,
  opponent: Opponent | undefined,
  replayPlayedAt: number
): boolean {
  if (!racesAreCompatible(match.playerRace, players.user.race) ||
    !racesAreCompatible(match.opponentRace, players.opponent.race)) {
    return false;
  }

  if (match.map && metadata.map && normalizeLookup(match.map) !== normalizeLookup(metadata.map)) {
    return false;
  }

  if (opponent && !opponentMatchesReplayPlayer(opponent, players.opponent.name)) {
    return false;
  }

  const matchTime = Date.parse(match.playedAt);
  if (!Number.isFinite(matchTime)) {
    return false;
  }

  return Math.abs(replayPlayedAt - matchTime) <= 60 * 60 * 1000;
}

function opponentMatchesReplayPlayer(opponent: Opponent, replayName: string): boolean {
  const normalizedReplayName = normalizePlayerIdentityName(replayName);
  if (!normalizedReplayName) {
    return false;
  }

  if (isBarcodeNickname(replayName) && isBarcodeNickname(opponent.nickname)) {
    return normalizedReplayName === normalizePlayerIdentityName(opponent.nickname);
  }

  return opponentMatchesPlayerIdentity(opponent, normalizedReplayName);
}

function opponentMatchesPlayerIdentity(opponent: Opponent, normalizedIdentity: string): boolean {
  return [opponent.nickname, ...opponent.aliases].some(
    (identity) => normalizePlayerIdentityName(identity) === normalizedIdentity
  );
}

function replaylessDistance(match: Match, replayPlayedAt: number): number {
  const matchTime = Date.parse(match.playedAt);
  return Number.isFinite(matchTime) ? Math.abs(matchTime - replayPlayedAt) : Number.POSITIVE_INFINITY;
}

function racesAreCompatible(first: Race, second: Race): boolean {
  return first === second || first === "Unknown" || second === "Unknown";
}

function repairMatchRacesFromReplay(match: Match, players: ReplayMatchPlayers, now: string): Match {
  const nextPlayerRace =
    match.playerRace === "Unknown" && players.user.race !== "Unknown"
      ? players.user.race
      : match.playerRace;
  const nextOpponentRace =
    match.opponentRace === "Unknown" && players.opponent.race !== "Unknown"
      ? players.opponent.race
      : match.opponentRace;

  if (nextPlayerRace === match.playerRace && nextOpponentRace === match.opponentRace) {
    return match;
  }

  return {
    ...match,
    playerRace: nextPlayerRace,
    opponentRace: nextOpponentRace,
    updatedAt: now
  };
}

function mergeReplayOpponentSample(opponent: Opponent, replayOpponent: ReplayMetadataPlayer, now: string): Opponent {
  const race = opponent.race === "Unknown" ? replayOpponent.race : opponent.race;
  return {
    ...opponent,
    race,
    raceProfiles: {
      ...opponent.raceProfiles,
      [replayOpponent.race]: {
        ...opponent.raceProfiles?.[replayOpponent.race],
        updatedAt: now
      }
    },
    updatedAt: race !== opponent.race ? now : opponent.updatedAt
  };
}

function buildOpponentId(replayOpponent: ReplayMetadataPlayer, playedAt: string): string {
  const profileLink = replayProfileQuery(replayOpponent);
  if (profileLink) {
    return createStableEntityId("opponent", profileLink);
  }

  if (isBarcodeNickname(replayOpponent.name)) {
    return createStableEntityId("opponent", `${replayOpponent.name}-${playedAt}`);
  }

  return createStableEntityId("opponent", replayOpponent.name);
}

function replayProfileQuery(replayOpponent: ReplayMetadataPlayer): string | undefined {
  if (!replayOpponent.toon) {
    return undefined;
  }

  const match = replayOpponent.toon.trim().match(/^(\d+)-S2-(\d+)-(\d+)$/);
  if (!match) {
    return undefined;
  }

  const [, region, realm, profileId] = match;
  return region && realm && profileId
    ? `https://starcraft2.blizzard.com/profile/${region}/${realm}/${profileId}`
    : undefined;
}

function normalizePlayerIdentityName(value: string | undefined): string {
  return (value ?? "")
    .replace(/^(?:<[^>]+>\s*)+/, "")
    .replace(/#\d+$/, "")
    .trim()
    .toLowerCase();
}

function normalizeLookup(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePath(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value < 1) {
    return 25;
  }

  return Math.min(Math.floor(value), 10000);
}

function normalizeBatchSize(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value < 1) {
    return 100;
  }

  return Math.floor(value);
}

function sortNewestFirst(files: readonly ReplayFile[]): readonly ReplayFile[] {
  return [...files].sort((first, second) => {
    const firstTime = Date.parse(first.modifiedAt ?? "");
    const secondTime = Date.parse(second.modifiedAt ?? "");
    const safeFirstTime = Number.isFinite(firstTime) ? firstTime : 0;
    const safeSecondTime = Number.isFinite(secondTime) ? secondTime : 0;
    return safeSecondTime - safeFirstTime;
  });
}
