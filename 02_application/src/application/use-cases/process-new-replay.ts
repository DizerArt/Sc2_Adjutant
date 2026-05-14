import { createEnrichmentCandidateSnapshot } from "../../domain/entities/enrichment-candidate-snapshot.js";
import { attachReplayMetadata, type Match, type ReplayMetadata, type ReplayMetadataPlayer } from "../../domain/entities/match.js";
import { updateOpponentMatchResult, type Opponent } from "../../domain/entities/opponent.js";
import type { EnrichmentCandidateRepository } from "../../domain/repositories/enrichment-candidate-repository.js";
import type { MatchRepository } from "../../domain/repositories/match-repository.js";
import type { OpponentRepository } from "../../domain/repositories/opponent-repository.js";
import { isBarcodeNickname } from "../../domain/value-objects/barcode.js";
import type { OpponentEnrichmentService } from "../services/opponent-enrichment-service.js";

export type ProcessNewReplayResult = {
  readonly match: Match;
};

export type ProcessNewReplayOptions = {
  readonly enrichmentService?: OpponentEnrichmentService;
  readonly enrichmentCandidateRepository?: EnrichmentCandidateRepository;
};

export class ProcessNewReplay {
  private readonly clock: () => string;

  constructor(
    private readonly matchRepository: MatchRepository,
    private readonly opponentRepository?: OpponentRepository,
    clock: () => string = () => new Date().toISOString(),
    private readonly options: ProcessNewReplayOptions = {}
  ) {
    this.clock = clock;
  }

  async execute(metadata: ReplayMetadata): Promise<ProcessNewReplayResult | null> {
    const match = await this.findLinkTarget(metadata);

    if (!match) {
      return null;
    }

    const effectiveMetadata = await this.resolveMetadataResult(match, metadata);
    const updatedMatch = attachReplayMetadata(match, effectiveMetadata, this.clock());
    await this.matchRepository.save(updatedMatch);
    await this.updateOpponentStats(match, updatedMatch);
    await this.enrichBarcodeOpponentFromReplay(updatedMatch, effectiveMetadata);

    return {
      match: updatedMatch
    };
  }

  private async resolveMetadataResult(match: Match, metadata: ReplayMetadata): Promise<ReplayMetadata> {
    if (metadata.result && metadata.result !== "unknown") {
      return metadata;
    }

    const inferredResult = await this.inferResultFromOpponent(match, metadata);
    return inferredResult ? { ...metadata, result: inferredResult } : metadata;
  }

  private async inferResultFromOpponent(match: Match, metadata: ReplayMetadata): Promise<Match["result"] | undefined> {
    if (!this.opponentRepository || !metadata.players || metadata.players.length === 0) {
      return undefined;
    }

    const opponent = await this.opponentRepository.findById(match.opponentId);
    if (!opponent) {
      return undefined;
    }

    const normalizedOpponentName = normalizeName(opponent.nickname);
    const replayOpponent = metadata.players.find(
      (player) =>
        normalizeName(player.name) === normalizedOpponentName &&
        (player.race === match.opponentRace || match.opponentRace === "Unknown")
    );

    if (replayOpponent?.result === "win") {
      return "loss";
    }

    if (replayOpponent?.result === "loss") {
      return "win";
    }

    return undefined;
  }

  private async findLinkTarget(metadata: ReplayMetadata): Promise<Match | null> {
    const matches = await this.matchRepository.findAll();
    const normalizedReplayPath = normalizeOptionalString(metadata.replayPath);

    if (normalizedReplayPath) {
      const linkedMatch = matches.find((match) => normalizeOptionalString(match.replayPath) === normalizedReplayPath);
      if (linkedMatch) {
        return linkedMatch;
      }
    }

    const candidates = [...matches]
      .filter((match) => !match.replayPath)
      .sort((first, second) => second.playedAt.localeCompare(first.playedAt));

    if (candidates.length === 0) {
      return null;
    }

    const replayPlayedAt = metadata.playedAt;

    if (!replayPlayedAt) {
      return candidates[0] ?? null;
    }

    return candidates.find((match) => isWithinLinkWindow(match.playedAt, replayPlayedAt)) ?? candidates[0] ?? null;
  }

  private async updateOpponentStats(previousMatch: Match, updatedMatch: Match): Promise<void> {
    if (!this.opponentRepository || previousMatch.result === updatedMatch.result) {
      return;
    }

    const opponent = await this.opponentRepository.findById(updatedMatch.opponentId);
    if (!opponent) {
      return;
    }

    await this.opponentRepository.save(
      updateOpponentMatchResult(opponent, previousMatch.result, updatedMatch.result)
    );
  }

  private async enrichBarcodeOpponentFromReplay(match: Match, metadata: ReplayMetadata): Promise<void> {
    if (!this.opponentRepository || !this.options.enrichmentService || !metadata.players) {
      return;
    }

    const opponent = await this.opponentRepository.findById(match.opponentId);
    if (!opponent || !isBarcodeNickname(opponent.nickname)) {
      return;
    }

    const replayOpponent = findReplayOpponentForMatch(match, opponent, metadata.players);
    if (!replayOpponent?.toon) {
      return;
    }

    const profileQuery = replayProfileQueryFromToon(replayOpponent.toon);
    if (!profileQuery) {
      return;
    }

    const enrichment = await this.options.enrichmentService.enrich(opponent, {
      nickname: replayOpponent.name,
      profileLink: profileQuery,
      race: replayOpponent.race
    });

    if (!enrichment.bestCandidate) {
      return;
    }

    const capturedAt = this.clock();
    const snapshots = enrichment.candidates.map((candidate) =>
      createEnrichmentCandidateSnapshot(
        opponent.id,
        candidate,
        enrichment.bestCandidate === candidate,
        capturedAt
      )
    );

    await this.opponentRepository.save(enrichment.opponent);
    await this.options.enrichmentCandidateRepository?.replaceForOpponent(opponent.id, snapshots);
  }
}

function normalizeName(value: string): string {
  return value.replace(/^(?:<[^>]+>\s*)+/, "").trim().toLowerCase();
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function isWithinLinkWindow(matchPlayedAt: string, replayPlayedAt: string): boolean {
  const matchTime = Date.parse(matchPlayedAt);
  const replayTime = Date.parse(replayPlayedAt);

  if (!Number.isFinite(matchTime) || !Number.isFinite(replayTime)) {
    return false;
  }

  return Math.abs(replayTime - matchTime) <= 60 * 60 * 1000;
}

function findReplayOpponentForMatch(
  match: Match,
  opponent: Opponent,
  players: readonly ReplayMetadataPlayer[]
): ReplayMetadataPlayer | undefined {
  const exactName = players.find(
    (player) =>
      normalizeName(player.name) === normalizeName(opponent.nickname) &&
      (player.race === match.opponentRace || match.opponentRace === "Unknown")
  );
  if (exactName) {
    return exactName;
  }

  const opponentResult = opponentReplayResult(match.result);
  if (opponentResult) {
    const byResult = players.find(
      (player) =>
        player.result === opponentResult &&
        (player.race === match.opponentRace || match.opponentRace === "Unknown")
    );
    if (byResult) {
      return byResult;
    }
  }

  return players.find((player) => player.race === match.opponentRace) ?? players[1];
}

function opponentReplayResult(result: Match["result"]): ReplayMetadataPlayer["result"] | undefined {
  if (result === "win") {
    return "loss";
  }

  if (result === "loss") {
    return "win";
  }

  return undefined;
}

function replayProfileQueryFromToon(toon: string): string | undefined {
  const match = toon.trim().match(/^(\d+)-S2-(\d+)-(\d+)$/);
  if (!match) {
    return undefined;
  }

  const [, region, realm, profileId] = match;
  if (!region || !realm || !profileId) {
    return undefined;
  }

  return `https://starcraft2.blizzard.com/profile/${region}/${realm}/${profileId}`;
}
