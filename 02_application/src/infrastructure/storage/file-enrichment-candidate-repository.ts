import type { EnrichmentCandidateSnapshot } from "../../domain/entities/enrichment-candidate-snapshot.js";
import type { EnrichmentCandidateRepository } from "../../domain/repositories/enrichment-candidate-repository.js";
import type { EntityId } from "../../domain/value-objects/entity-id.js";
import { deleteFileIfExists, readTextFileIfExists, writeTextFileAtomically } from "./atomic-file.js";

export class FileEnrichmentCandidateRepository implements EnrichmentCandidateRepository {
  constructor(private readonly filePath: string) {}

  async findAll(): Promise<readonly EnrichmentCandidateSnapshot[]> {
    return this.readAll();
  }

  async findByOpponentId(opponentId: EntityId): Promise<readonly EnrichmentCandidateSnapshot[]> {
    const candidates = await this.readAll();

    return candidates
      .filter((candidate) => candidate.opponentId === opponentId)
      .sort((first, second) => {
        if (second.selected !== first.selected) {
          return Number(second.selected) - Number(first.selected);
        }

        return second.confidenceScore - first.confidenceScore;
      });
  }

  async replaceForOpponent(
    opponentId: EntityId,
    candidates: readonly EnrichmentCandidateSnapshot[]
  ): Promise<void> {
    const existingCandidates = await this.readAll();
    const nextCandidates = [
      ...existingCandidates.filter((candidate) => candidate.opponentId !== opponentId),
      ...candidates
    ];

    await this.replaceAll(nextCandidates);
  }

  async replaceAll(candidates: readonly EnrichmentCandidateSnapshot[]): Promise<void> {
    await writeTextFileAtomically(this.filePath, `${JSON.stringify(candidates, null, 2)}\n`);
  }

  async clear(): Promise<void> {
    await deleteFileIfExists(this.filePath);
  }

  private async readAll(): Promise<readonly EnrichmentCandidateSnapshot[]> {
    const content = await readTextFileIfExists(this.filePath);

    if (!content) {
      return [];
    }

    const parsed = JSON.parse(content) as EnrichmentCandidateSnapshot[];
    return Array.isArray(parsed) ? parsed : [];
  }
}
