import type { EnrichmentCandidateRepository } from "../../domain/repositories/enrichment-candidate-repository.js";
import type { MatchRepository } from "../../domain/repositories/match-repository.js";
import type { OpponentRepository } from "../../domain/repositories/opponent-repository.js";

export type ClearAllStatsResult = {
  readonly clearedAt: string;
  readonly cleared: {
    readonly opponents: boolean;
    readonly matches: boolean;
    readonly enrichmentCandidates: boolean;
  };
};

export type ClearAllStatsDependencies = {
  readonly opponentRepository: OpponentRepository;
  readonly matchRepository: MatchRepository;
  readonly enrichmentCandidateRepository: EnrichmentCandidateRepository;
  readonly clock?: () => string;
};

export class ClearAllStats {
  private readonly clock: () => string;

  constructor(private readonly dependencies: ClearAllStatsDependencies) {
    this.clock = dependencies.clock ?? (() => new Date().toISOString());
  }

  async execute(): Promise<ClearAllStatsResult> {
    await Promise.all([
      this.dependencies.opponentRepository.clear(),
      this.dependencies.matchRepository.clear(),
      this.dependencies.enrichmentCandidateRepository.clear()
    ]);

    return {
      clearedAt: this.clock(),
      cleared: {
        opponents: true,
        matches: true,
        enrichmentCandidates: true
      }
    };
  }
}
