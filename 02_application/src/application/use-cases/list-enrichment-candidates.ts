import type { EnrichmentCandidateSnapshot } from "../../domain/entities/enrichment-candidate-snapshot.js";
import type { EnrichmentCandidateRepository } from "../../domain/repositories/enrichment-candidate-repository.js";
import type { EntityId } from "../../domain/value-objects/entity-id.js";

export type ListEnrichmentCandidatesInput = {
  readonly opponentId: EntityId;
};

export type ListEnrichmentCandidatesResult = {
  readonly candidates: readonly EnrichmentCandidateSnapshot[];
};

export class ListEnrichmentCandidates {
  constructor(private readonly candidateRepository: EnrichmentCandidateRepository) {}

  async execute(input: ListEnrichmentCandidatesInput): Promise<ListEnrichmentCandidatesResult> {
    return {
      candidates: await this.candidateRepository.findByOpponentId(input.opponentId)
    };
  }
}
