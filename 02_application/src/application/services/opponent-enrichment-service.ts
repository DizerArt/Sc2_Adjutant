import {
  enrichOpponentFromCandidate,
  type Opponent
} from "../../domain/entities/opponent.js";
import type {
  OpponentDataCandidate,
  OpponentDataSourcePort,
  OpponentSearchQuery
} from "../../domain/ports/opponent-data-source-port.js";

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
  readonly clock?: () => string;
};

export type OpponentEnrichmentQuery = Partial<OpponentSearchQuery> & {
  readonly allowedSourceNames?: readonly string[];
  readonly excludedNicknames?: readonly string[];
};

export class OpponentEnrichmentService {
  private readonly minConfidenceScore: number;
  private readonly clock: () => string;

  constructor(
    private readonly sources: readonly OpponentDataSourcePort[],
    options: OpponentEnrichmentServiceOptions = {}
  ) {
    this.minConfidenceScore = options.minConfidenceScore ?? 0.5;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async enrich(opponent: Opponent, query?: OpponentEnrichmentQuery): Promise<OpponentEnrichmentResult> {
    const searchQuery: OpponentSearchQuery = {
      nickname: query?.nickname ?? opponent.nickname,
      profileLink: query?.profileLink,
      race: query?.race ?? opponent.race,
      region: query?.region,
      season: query?.season
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

    const eligibleCandidates = filterExcludedCandidates(candidates, query?.excludedNicknames ?? []);
    const bestCandidate = selectBestCandidate(eligibleCandidates, this.minConfidenceScore);

    return {
      opponent: bestCandidate ? enrichOpponentFromCandidate(opponent, bestCandidate, this.clock(), searchQuery.race) : opponent,
      bestCandidate,
      candidates: [...eligibleCandidates].sort(compareCandidates),
      warnings
    };
  }
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
