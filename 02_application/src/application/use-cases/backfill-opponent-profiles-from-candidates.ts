import type { EnrichmentCandidateSnapshot } from "../../domain/entities/enrichment-candidate-snapshot.js";
import { updateOpponentProfile, type Opponent } from "../../domain/entities/opponent.js";
import type { EnrichmentCandidateRepository } from "../../domain/repositories/enrichment-candidate-repository.js";
import type { OpponentRepository } from "../../domain/repositories/opponent-repository.js";

export type BackfillOpponentProfilesFromCandidatesResult = {
  readonly inspectedCount: number;
  readonly updatedCount: number;
};

export type BackfillOpponentProfilesFromCandidatesDependencies = {
  readonly opponentRepository: OpponentRepository;
  readonly enrichmentCandidateRepository: EnrichmentCandidateRepository;
  readonly clock?: () => string;
};

export class BackfillOpponentProfilesFromCandidates {
  private readonly clock: () => string;

  constructor(private readonly dependencies: BackfillOpponentProfilesFromCandidatesDependencies) {
    this.clock = dependencies.clock ?? (() => new Date().toISOString());
  }

  async execute(): Promise<BackfillOpponentProfilesFromCandidatesResult> {
    const opponents = await this.dependencies.opponentRepository.findAll();
    let updatedCount = 0;

    for (const opponent of opponents) {
      const candidates = await this.dependencies.enrichmentCandidateRepository.findByOpponentId(opponent.id);
      const candidate = candidateForBackfill(opponent, candidates);

      if (!candidate) {
        continue;
      }

      const updatedOpponent = updateOpponentProfile(
        opponent,
        {
          race: opponent.race === "Unknown" ? candidate.race : opponent.race,
          battleTag: opponent.battleTag ?? candidate.battleTag,
          mmrAtLastMatch: opponent.mmrAtLastMatch ?? candidate.mmr,
          league: opponent.league ?? candidate.league,
          confidenceScore:
            typeof opponent.confidenceScore === "number"
              ? Math.max(opponent.confidenceScore, candidate.confidenceScore)
              : candidate.confidenceScore
        },
        this.clock()
      );

      if (profilesAreEqual(opponent, updatedOpponent)) {
        continue;
      }

      await this.dependencies.opponentRepository.save(updatedOpponent);
      updatedCount += 1;
    }

    return {
      inspectedCount: opponents.length,
      updatedCount
    };
  }
}

function candidateForBackfill(
  opponent: Opponent,
  candidates: readonly EnrichmentCandidateSnapshot[]
): EnrichmentCandidateSnapshot | undefined {
  const usefulCandidates = candidates.filter((candidate) => {
    const hasUsefulData =
      Boolean(candidate.battleTag && !opponent.battleTag) ||
      (typeof candidate.mmr === "number" && typeof opponent.mmrAtLastMatch !== "number") ||
      Boolean(candidate.league && !opponent.league);

    if (!hasUsefulData) {
      return false;
    }

    return candidate.selected || candidate.confidenceScore >= 0.5 || isExactNickname(candidate.nickname, opponent.nickname);
  });

  return usefulCandidates[0];
}

function isExactNickname(first: string, second: string): boolean {
  return first.trim().toLowerCase() === second.trim().toLowerCase();
}

function profilesAreEqual(first: Opponent, second: Opponent): boolean {
  return (
    first.race === second.race &&
    first.battleTag === second.battleTag &&
    first.mmrAtLastMatch === second.mmrAtLastMatch &&
    first.league === second.league &&
    first.confidenceScore === second.confidenceScore
  );
}
