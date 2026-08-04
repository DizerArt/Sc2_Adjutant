import {
  enrichOpponentFromCandidate,
  type Opponent
} from "../../domain/entities/opponent.js";
import type {
  OpponentDataCandidate,
  OpponentDataSourcePort,
  OpponentSearchQuery
} from "../../domain/ports/opponent-data-source-port.js";
import { battleTagsMatch, normalizeBattleTagKey } from "../../domain/value-objects/battle-tag.js";

export type OpponentEnrichmentWarning = {
  readonly source: string;
  readonly message: string;
};

export type OpponentEnrichmentResult = {
  readonly opponent: Opponent;
  readonly bestCandidate: OpponentDataCandidate | null;
  readonly candidates: readonly OpponentDataCandidate[];
  readonly warnings: readonly OpponentEnrichmentWarning[];
};

export type OpponentEnrichmentServiceOptions = {
  readonly minConfidenceScore?: number;
  readonly maxNicknameOnlyMmrDelta?: number;
  readonly clock?: () => string;
};

export type OpponentEnrichmentQuery = Partial<OpponentSearchQuery> & {
  readonly allowedSourceNames?: readonly string[];
  readonly excludedNicknames?: readonly string[];
};

export class OpponentEnrichmentService {
  private readonly minConfidenceScore: number;
  private readonly maxNicknameOnlyMmrDelta: number;
  private readonly clock: () => string;

  constructor(
    private readonly sources: readonly OpponentDataSourcePort[],
    options: OpponentEnrichmentServiceOptions = {}
  ) {
    this.minConfidenceScore = options.minConfidenceScore ?? 0.5;
    this.maxNicknameOnlyMmrDelta = options.maxNicknameOnlyMmrDelta ?? 800;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async enrich(opponent: Opponent, query?: OpponentEnrichmentQuery): Promise<OpponentEnrichmentResult> {
    const searchQuery: OpponentSearchQuery = {
      nickname: query?.nickname ?? opponent.nickname,
      battleTag:
        query && hasOwn(query, "battleTag")
          ? query.battleTag
          : query?.profileLink?.trim()
            ? undefined
            : opponent.battleTag,
      profileLink: query?.profileLink,
      race: query?.race ?? opponent.race,
      region: query?.region,
      season: query?.season,
      observedMmr: query?.observedMmr ?? opponent.mmrAtLastMatch
    };

    const sources = filterSources(this.sources, query?.allowedSourceNames);
    const settledResults = await Promise.all(
      sources.map(async (source) => {
        try {
          return {
            status: "fulfilled" as const,
            source: source.sourceName,
            candidates: await source.searchOpponent(searchQuery)
          };
        } catch (error) {
          return {
            status: "rejected" as const,
            source: source.sourceName,
            error
          };
        }
      })
    );

    const warnings: OpponentEnrichmentWarning[] = [];
    const candidates: OpponentDataCandidate[] = [];

    for (const result of settledResults) {
      if (result.status === "fulfilled") {
        candidates.push(...result.candidates);
      } else {
        warnings.push({
          source: result.source,
          message: result.error instanceof Error ? result.error.message : String(result.error)
        });
      }
    }

    const battleTagCandidates = filterBattleTagCandidates(candidates, searchQuery.battleTag);
    const mmrCandidates = filterNicknameOnlyMmrCandidates(
      battleTagCandidates,
      searchQuery,
      this.maxNicknameOnlyMmrDelta
    );
    const eligibleCandidates = filterExcludedCandidates(mmrCandidates, query?.excludedNicknames ?? []);
    const bestCandidate = hasAmbiguousNicknameOnlyIdentity(eligibleCandidates, searchQuery)
      ? null
      : selectBestCandidate(eligibleCandidates, this.minConfidenceScore);
    const enrichmentBase = shouldReplaceStoredBattleTag(opponent, bestCandidate, searchQuery)
      ? { ...opponent, battleTag: undefined }
      : opponent;

    return {
      opponent: bestCandidate
        ? enrichOpponentFromCandidate(enrichmentBase, bestCandidate, this.clock(), searchQuery.race)
        : opponent,
      bestCandidate,
      candidates: [...eligibleCandidates].sort(compareCandidates),
      warnings
    };
  }
}

function hasAmbiguousNicknameOnlyIdentity(
  candidates: readonly OpponentDataCandidate[],
  query: OpponentSearchQuery
): boolean {
  if (normalizeBattleTagKey(query.battleTag) || query.profileLink?.trim()) {
    return false;
  }

  const requestedIdentity = normalizePlayerIdentityName(query.nickname);
  if (!requestedIdentity) {
    return false;
  }

  const exactMatchesBySource = new Map<string, number>();
  for (const candidate of candidates) {
    const isExactMatch = [candidate.nickname, ...candidate.aliases]
      .map(normalizePlayerIdentityName)
      .some((identity) => identity === requestedIdentity);
    if (!isExactMatch) {
      continue;
    }

    const sourceKey = candidate.source.trim().toLowerCase();
    const nextCount = (exactMatchesBySource.get(sourceKey) ?? 0) + 1;
    if (nextCount > 1) {
      return true;
    }
    exactMatchesBySource.set(sourceKey, nextCount);
  }

  return false;
}

function shouldReplaceStoredBattleTag(
  opponent: Opponent,
  candidate: OpponentDataCandidate | null,
  query: OpponentSearchQuery
): boolean {
  if (!query.profileLink?.trim() || !candidate) {
    return false;
  }

  const storedBattleTag = normalizeBattleTagKey(opponent.battleTag);
  const resolvedBattleTag = normalizeBattleTagKey(candidate.battleTag);
  return Boolean(storedBattleTag && resolvedBattleTag && storedBattleTag !== resolvedBattleTag);
}

function filterNicknameOnlyMmrCandidates(
  candidates: readonly OpponentDataCandidate[],
  query: OpponentSearchQuery,
  maxMmrDelta: number
): readonly OpponentDataCandidate[] {
  const hasStableLookup = Boolean(normalizeBattleTagKey(query.battleTag) || query.profileLink?.trim());
  if (hasStableLookup || !isUsableMmr(query.observedMmr)) {
    return candidates;
  }

  return candidates.filter((candidate) => {
    if (!isUsableMmr(candidate.mmr)) {
      return true;
    }

    return Math.abs(candidate.mmr - query.observedMmr!) <= maxMmrDelta;
  });
}

function isUsableMmr(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function filterBattleTagCandidates(
  candidates: readonly OpponentDataCandidate[],
  requestedBattleTag: string | undefined
): readonly OpponentDataCandidate[] {
  if (!normalizeBattleTagKey(requestedBattleTag)) {
    return candidates;
  }

  return candidates.filter((candidate) => battleTagsMatch(candidate.battleTag, requestedBattleTag));
}

function filterSources(
  sources: readonly OpponentDataSourcePort[],
  allowedSourceNames: readonly string[] | undefined
): readonly OpponentDataSourcePort[] {
  if (!allowedSourceNames || allowedSourceNames.length === 0) {
    return sources;
  }

  const allowed = new Set(allowedSourceNames.map((sourceName) => sourceName.toLowerCase()));
  return sources.filter((source) => allowed.has(source.sourceName.toLowerCase()));
}

function filterExcludedCandidates(
  candidates: readonly OpponentDataCandidate[],
  excludedNicknames: readonly string[]
): readonly OpponentDataCandidate[] {
  const excludedIdentities = new Set(
    excludedNicknames
      .map(normalizePlayerIdentityName)
      .filter((identity) => identity.length > 0)
  );

  if (excludedIdentities.size === 0) {
    return candidates;
  }

  return candidates.filter((candidate) => !candidateMatchesExcludedIdentity(candidate, excludedIdentities));
}

function candidateMatchesExcludedIdentity(
  candidate: OpponentDataCandidate,
  excludedIdentities: ReadonlySet<string>
): boolean {
  const candidateIdentities = [
    candidate.nickname,
    candidate.battleTag,
    ...candidate.aliases
  ]
    .map(normalizePlayerIdentityName)
    .filter((identity) => identity.length > 0);

  return candidateIdentities.some((identity) => excludedIdentities.has(identity));
}

function selectBestCandidate(
  candidates: readonly OpponentDataCandidate[],
  minConfidenceScore: number
): OpponentDataCandidate | null {
  const sortedCandidates = [...candidates]
    .filter((candidate) => candidate.confidenceScore >= minConfidenceScore)
    .sort(compareCandidates);

  return sortedCandidates[0] ?? null;
}

function compareCandidates(first: OpponentDataCandidate, second: OpponentDataCandidate): number {
  if (second.confidenceScore !== first.confidenceScore) {
    return second.confidenceScore - first.confidenceScore;
  }

  const firstHasProfile = first.profileUrl ? 1 : 0;
  const secondHasProfile = second.profileUrl ? 1 : 0;

  if (secondHasProfile !== firstHasProfile) {
    return secondHasProfile - firstHasProfile;
  }

  const firstHasMmr = typeof first.mmr === "number" ? 1 : 0;
  const secondHasMmr = typeof second.mmr === "number" ? 1 : 0;

  return secondHasMmr - firstHasMmr;
}

function normalizePlayerIdentityName(value: string | undefined): string {
  return (value ?? "")
    .replace(/^(?:<[^>]+>\s*)+/, "")
    .replace(/(?:\s*<[^>]+>)+$/, "")
    .replace(/#\d+$/, "")
    .trim()
    .toLowerCase();
}

function hasOwn<T extends object, K extends PropertyKey>(value: T, key: K): value is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}
