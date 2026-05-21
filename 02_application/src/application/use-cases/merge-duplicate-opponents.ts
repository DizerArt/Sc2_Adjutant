import type { Match } from "../../domain/entities/match.js";
import type { Opponent } from "../../domain/entities/opponent.js";
import type { MatchRepository } from "../../domain/repositories/match-repository.js";
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
    const groups = groupOpponentsByIdentity(opponents);
    const nextOpponents: Opponent[] = [];
    const opponentIdMap = new Map<EntityId, EntityId>();
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
      }
    }

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

    return {
      inspectedCount: opponents.length,
      mergedCount
    };
  }
}

function groupOpponentsByIdentity(opponents: readonly Opponent[]): Map<string, Opponent[]> {
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

    // Barcode nicknames are not unique across players: many unrelated opponents
    // share the same glyphs (`IIIIIII`, `lllll`, ...). Keep unresolved barcodes
    // separate; resolved barcode duplicates are grouped above by BattleTag.
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
