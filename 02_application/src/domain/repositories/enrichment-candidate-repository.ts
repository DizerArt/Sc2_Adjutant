import type { EnrichmentCandidateSnapshot } from "../entities/enrichment-candidate-snapshot.js";
import type { EntityId } from "../value-objects/entity-id.js";

export interface EnrichmentCandidateRepository {
  findByOpponentId(opponentId: EntityId): Promise<readonly EnrichmentCandidateSnapshot[]>;
  replaceForOpponent(opponentId: EntityId, candidates: readonly EnrichmentCandidateSnapshot[]): Promise<void>;
  clear(): Promise<void>;
}
