import type { Match } from "../../domain/entities/match.js";
import type { EnrichmentCandidateSnapshot } from "../../domain/entities/enrichment-candidate-snapshot.js";
import type { Opponent } from "../../domain/entities/opponent.js";
import type { MatchRepository } from "../../domain/repositories/match-repository.js";
import type { EnrichmentCandidateRepository } from "../../domain/repositories/enrichment-candidate-repository.js";
import type { OpponentRepository } from "../../domain/repositories/opponent-repository.js";
import { isBarcodeNickname } from "../../domain/value-objects/barcode.js";
import { createStableEntityId, type EntityId } from "../../domain/value-objects/entity-id.js";
import { normalizeRace, type Race } from "../../domain/value-objects/race.js";

export type MergeDuplicateOpponentsResult = {
  readonly inspectedCount: number;
  readonly mergedCount: number;
};

export type MergeDuplicateOpponentsDependencies = {
  readonly opponentRepository: OpponentRepository;
  readonly matchRepository: MatchRepository;
  readonly enrichmentCandidateRepository?: EnrichmentCandidateRepository;
  readonly clock?: () => string;
};

export class MergeDuplicateOpponents {
  private readonly clock: () => string;

  constructor(private readonly dependencies: MergeDuplicateOpponentsDependencies) {
    this.clock = dependencies.clock ?? (() => new Date().toISOString());
  }

  async execute(): Promise<MergeDuplicateOpponentsResult> {
    const [opponents, matches] = await Promise.all([
      this.dependencies.opponentRepository.findAll(),
      this.dependencies.matchRepository.findAll()
    ]);
    const candidatesByOpponentId = await loadCandidatesByOpponentId(
      opponents,
      this.dependencies.enrichmentCandidateRepository
    );
    const groups = groupOpponentsByIdentity(opponents, candidatesByOpponentId);
    let nextOpponents: Opponent[] = [];
    const opponentIdMap = new Map<EntityId, EntityId>();
    const candidateIdMap = new Map<EntityId, EntityId>();
    const droppedCandidateIds: EntityId[] = [];
    let mergedCount = 0;

    for (const group of groups.values()) {
      if (group.length === 1) {
        nextOpponents.push(group[0]);
        continue;
      }

      const canonical = mergeOpponentGroup(group, matches, this.clock());
      nextOpponents.push(canonical);
      mergedCount += group.length - 1;

      for (const opponent of group) {
        opponentIdMap.set(opponent.id, canonical.id);
        candidateIdMap.set(opponent.id, canonical.id);
      }
    }

    const pruning = pruneZeroMatchNicknameDuplicates(nextOpponents, matches);
    nextOpponents = pruning.opponents;
    droppedCandidateIds.push(...pruning.droppedOpponentIds);
    mergedCount += pruning.droppedOpponentIds.length;

    if (mergedCount === 0) {
      return {
        inspectedCount: opponents.length,
        mergedCount
      };
    }

    await this.dependencies.opponentRepository.clear();
    for (const opponent of nextOpponents) {
      await this.dependencies.opponentRepository.save(opponent);
    }

    await this.dependencies.matchRepository.clear();
    for (const match of matches) {
      await this.dependencies.matchRepository.save(remapMatchOpponent(match, opponentIdMap));
    }

    await remapCandidateSnapshots(
      this.dependencies.enrichmentCandidateRepository,
      candidatesByOpponentId,
      candidateIdMap
    );
    await clearCandidateSnapshots(this.dependencies.enrichmentCandidateRepository, droppedCandidateIds);

    return {
      inspectedCount: opponents.length,
      mergedCount
    };
  }
}

function groupOpponentsByIdentity(
  opponents: readonly Opponent[],
  candidatesByOpponentId: ReadonlyMap<EntityId, readonly EnrichmentCandidateSnapshot[]>
): Map<string, Opponent[]> {
  const groups = new Map<string, Opponent[]>();

  for (const opponent of opponents) {
    const battleTagKey = normalizeIdentityKey(opponent.battleTag);
    if (battleTagKey) {
      const key = `battletag:${battleTagKey}`;
      const group = groups.get(key) ?? [];
      group.push(opponent);
      groups.set(key, group);
      continue;
    }

    const profileUrlKey = selectedProfileUrlKey(candidatesByOpponentId.get(opponent.id) ?? []);
    if (profileUrlKey) {
      const key = `profile:${profileUrlKey}`;
      const group = groups.get(key) ?? [];
      group.push(opponent);
      groups.set(key, group);
      continue;
    }

    const stableProfileIdKey = selectedStableProfileIdKey(opponent.id);
    if (stableProfileIdKey) {
      groups.set(`stable-profile:${stableProfileIdKey}`, [opponent]);
      continue;
    }

    // Barcode nicknames are not unique across players: many unrelated opponents
    // share the same glyphs (`IIIIIII`, `lllll`, ...). Keep unresolved barcodes
    // separate; resolved barcode duplicates are grouped above by BattleTag or
    // by selected SC2 profile URL from enrichment snapshots.
    if (isBarcodeNickname(opponent.nickname)) {
      groups.set(`barcode:${opponent.id}`, [opponent]);
      continue;
    }

    const key = `nickname:${normalizeIdentityKey(opponent.nickname)}`;
    const group = groups.get(key) ?? [];
    group.push(opponent);
    groups.set(key, group);
  }

  return groups;
}

function mergeOpponentGroup(group: readonly Opponent[], matches: readonly Match[], now: string): Opponent {
  const primary = selectPrimaryOpponent(group);
  const canonicalId = isBarcodeNickname(primary.nickname)
    ? primary.id
    : createStableEntityId("opponent", primary.nickname);
  const groupIds = new Set(group.map((opponent) => opponent.id));
  const groupMatches = matches.filter((match) => groupIds.has(match.opponentId));
  const latestMatch = [...groupMatches].sort((first, second) => second.playedAt.localeCompare(first.playedAt))[0];

  return {
    ...primary,
    id: canonicalId,
    race: latestMatch ? normalizeRace(latestMatch.opponentRace) : selectRace(group),
    raceProfiles: mergeRaceProfiles(group),
    aliases: mergeStrings(group.flatMap((opponent) => opponent.aliases)),
    notes: mergeStrings(group.flatMap((opponent) => opponent.notes)),
    strategyTags: mergeStrings(group.flatMap((opponent) => opponent.strategyTags)),
    markers: mergeStrings(group.flatMap((opponent) => opponent.markers ?? [])) as Opponent["markers"],
    battleTag: firstDefined(group.map((opponent) => opponent.battleTag)),
    mmrAtLastMatch: firstDefined(group.map((opponent) => opponent.mmrAtLastMatch)),
    league: firstDefined(group.map((opponent) => opponent.league)),
    confidenceScore: maxConfidence(group),
    lastMatchDate: latestMatch?.playedAt ?? firstDefined(group.map((opponent) => opponent.lastMatchDate)),
    updatedAt: now
  };
}

function mergeRaceProfiles(group: readonly Opponent[]): Opponent["raceProfiles"] {
  const profiles: NonNullable<Opponent["raceProfiles"]> = {};

  for (const opponent of group) {
    for (const [race, profile] of Object.entries(opponent.raceProfiles ?? {})) {
      const normalizedRace = normalizeRace(race);
      const existing = profiles[normalizedRace];

      if (!existing || profile.updatedAt.localeCompare(existing.updatedAt) > 0) {
        profiles[normalizedRace] = profile;
      }
    }
  }

  return profiles;
}

function selectPrimaryOpponent(group: readonly Opponent[]): Opponent {
  return [...group].sort((first, second) => {
    const firstDate = first.lastMatchDate ?? first.updatedAt;
    const secondDate = second.lastMatchDate ?? second.updatedAt;
    return secondDate.localeCompare(firstDate);
  })[0];
}

function selectRace(group: readonly Opponent[]): Race {
  return group.find((opponent) => opponent.race !== "Unknown")?.race ?? "Unknown";
}

function remapMatchOpponent(match: Match, opponentIdMap: ReadonlyMap<EntityId, EntityId>): Match {
  const opponentId = opponentIdMap.get(match.opponentId);
  return opponentId ? { ...match, opponentId } : match;
}

function pruneZeroMatchNicknameDuplicates(
  opponents: readonly Opponent[],
  matches: readonly Match[]
): {
  readonly opponents: Opponent[];
  readonly droppedOpponentIds: readonly EntityId[];
} {
  const matchCounts = countMatchesByOpponent(matches);
  const activeNameKeys = new Set<string>();
  const activeStableNameKeys = new Set<string>();

  for (const opponent of opponents) {
    if ((matchCounts.get(opponent.id) ?? 0) === 0) {
      continue;
    }

    for (const key of opponentNameKeys(opponent)) {
      activeNameKeys.add(key);
      if (hasStableOpponentIdentity(opponent)) {
        activeStableNameKeys.add(key);
      }
    }
  }

  const kept: Opponent[] = [];
  const droppedOpponentIds: EntityId[] = [];

  for (const opponent of opponents) {
    const matchCount = matchCounts.get(opponent.id) ?? 0;
    const isStaleDuplicate =
      matchCount === 0 &&
      !isBarcodeNickname(opponent.nickname) &&
      (!hasStableOpponentIdentity(opponent) ||
        opponentNameKeys(opponent).some((key) => activeStableNameKeys.has(key))) &&
      opponentNameKeys(opponent).some((key) => activeNameKeys.has(key));

    if (isStaleDuplicate) {
      droppedOpponentIds.push(opponent.id);
      continue;
    }

    kept.push(opponent);
  }

  return {
    opponents: kept,
    droppedOpponentIds
  };
}

function hasStableOpponentIdentity(opponent: Opponent): boolean {
  return Boolean(normalizeIdentityKey(opponent.battleTag) || selectedStableProfileIdKey(opponent.id));
}

function countMatchesByOpponent(matches: readonly Match[]): Map<EntityId, number> {
  const result = new Map<EntityId, number>();

  for (const match of matches) {
    result.set(match.opponentId, (result.get(match.opponentId) ?? 0) + 1);
  }

  return result;
}

function opponentNameKeys(opponent: Opponent): readonly string[] {
  const keys = new Set<string>();

  for (const value of [opponent.nickname, opponent.revealedNickname, ...opponent.aliases]) {
    const key = normalizeIdentityKey(value);
    if (key) {
      keys.add(key);
    }
  }

  return [...keys];
}

async function loadCandidatesByOpponentId(
  opponents: readonly Opponent[],
  repository: EnrichmentCandidateRepository | undefined
): Promise<ReadonlyMap<EntityId, readonly EnrichmentCandidateSnapshot[]>> {
  const result = new Map<EntityId, readonly EnrichmentCandidateSnapshot[]>();

  if (!repository) {
    return result;
  }

  await Promise.all(
    opponents.map(async (opponent) => {
      result.set(opponent.id, await repository.findByOpponentId(opponent.id));
    })
  );

  return result;
}

async function remapCandidateSnapshots(
  repository: EnrichmentCandidateRepository | undefined,
  candidatesByOpponentId: ReadonlyMap<EntityId, readonly EnrichmentCandidateSnapshot[]>,
  opponentIdMap: ReadonlyMap<EntityId, EntityId>
): Promise<void> {
  if (!repository || opponentIdMap.size === 0) {
    return;
  }

  const groupedCandidates = new Map<EntityId, EnrichmentCandidateSnapshot[]>();
  for (const [sourceOpponentId, candidates] of candidatesByOpponentId.entries()) {
    const targetOpponentId = opponentIdMap.get(sourceOpponentId);
    if (!targetOpponentId) {
      continue;
    }

    const current = groupedCandidates.get(targetOpponentId) ?? [];
    groupedCandidates.set(targetOpponentId, [
      ...current,
      ...candidates.map((candidate) => ({
        ...candidate,
        opponentId: targetOpponentId
      }))
    ]);
  }

  for (const [targetOpponentId, candidates] of groupedCandidates.entries()) {
    await repository.replaceForOpponent(targetOpponentId, dedupeCandidateSnapshots(candidates));
  }

  for (const [sourceOpponentId, targetOpponentId] of opponentIdMap.entries()) {
    if (sourceOpponentId !== targetOpponentId) {
      await repository.replaceForOpponent(sourceOpponentId, []);
    }
  }
}

async function clearCandidateSnapshots(
  repository: EnrichmentCandidateRepository | undefined,
  opponentIds: readonly EntityId[]
): Promise<void> {
  if (!repository) {
    return;
  }

  for (const opponentId of opponentIds) {
    await repository.replaceForOpponent(opponentId, []);
  }
}

function dedupeCandidateSnapshots(
  candidates: readonly EnrichmentCandidateSnapshot[]
): readonly EnrichmentCandidateSnapshot[] {
  const result = new Map<string, EnrichmentCandidateSnapshot>();

  for (const candidate of candidates) {
    const key = [
      normalizeIdentityKey(candidate.source),
      normalizeIdentityKey(candidate.profileUrl),
      normalizeIdentityKey(candidate.battleTag),
      normalizeIdentityKey(candidate.nickname),
      candidate.race
    ].join("|");
    const current = result.get(key);
    if (!current || candidateRank(candidate) > candidateRank(current)) {
      result.set(key, candidate);
    }
  }

  return [...result.values()];
}

function selectedProfileUrlKey(candidates: readonly EnrichmentCandidateSnapshot[]): string {
  const reliableCandidate = candidates
    .filter((candidate) => candidate.selected && candidate.profileUrl)
    .sort((first, second) => candidateRank(second) - candidateRank(first))[0];

  return normalizeIdentityKey(reliableCandidate?.profileUrl);
}

function selectedStableProfileIdKey(opponentId: EntityId): string {
  const normalized = normalizeIdentityKey(opponentId);
  if (
    normalized.startsWith("opponent_https-starcraft2-blizzard-com-profile-") ||
    normalized.startsWith("opponent_battlenet-starcraft-profile-")
  ) {
    return normalized;
  }

  return "";
}

function candidateRank(candidate: EnrichmentCandidateSnapshot): number {
  return (candidate.selected ? 1 : 0) + candidate.confidenceScore;
}

function mergeStrings(values: readonly string[]): readonly string[] {
  const result = new Set<string>();

  for (const value of values) {
    const normalized = value.trim();
    if (normalized) {
      result.add(normalized);
    }
  }

  return [...result];
}

function firstDefined<T>(values: readonly (T | undefined)[]): T | undefined {
  return values.find((value): value is T => value !== undefined);
}

function maxConfidence(group: readonly Opponent[]): number | undefined {
  const values = group
    .map((opponent) => opponent.confidenceScore)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  return values.length > 0 ? Math.max(...values) : undefined;
}

function normalizeIdentityKey(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}
