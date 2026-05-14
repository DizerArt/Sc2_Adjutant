import type { EnrichmentCandidateSnapshot } from "../../domain/entities/enrichment-candidate-snapshot.js";
import type { Match } from "../../domain/entities/match.js";
import type { Opponent } from "../../domain/entities/opponent.js";
import type { EnrichmentCandidateRepository } from "../../domain/repositories/enrichment-candidate-repository.js";
import type { MatchRepository } from "../../domain/repositories/match-repository.js";
import type { OpponentRepository } from "../../domain/repositories/opponent-repository.js";
import type { EntityId } from "../../domain/value-objects/entity-id.js";
import type { FileEnrichmentCandidateRepository } from "./file-enrichment-candidate-repository.js";
import type { FileMatchRepository } from "./file-match-repository.js";
import type { FileOpponentRepository } from "./file-opponent-repository.js";

export class BufferedMatchRepository implements MatchRepository {
  private matches: Match[];
  private dirty = false;

  private constructor(
    private readonly target: FileMatchRepository,
    matches: readonly Match[]
  ) {
    this.matches = [...matches];
  }

  static async create(target: FileMatchRepository): Promise<BufferedMatchRepository> {
    return new BufferedMatchRepository(target, await target.findAll());
  }

  async findAll(): Promise<readonly Match[]> {
    return this.matches;
  }

  async findById(id: EntityId): Promise<Match | null> {
    return this.matches.find((match) => match.id === id) ?? null;
  }

  async findByOpponentId(opponentId: EntityId): Promise<readonly Match[]> {
    return this.matches.filter((match) => match.opponentId === opponentId);
  }

  async save(match: Match): Promise<void> {
    this.matches = upsertById(this.matches, match);
    this.dirty = true;
  }

  async clear(): Promise<void> {
    this.matches = [];
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.dirty) {
      return;
    }

    await this.target.replaceAll(this.matches);
    this.dirty = false;
  }
}

export class BufferedOpponentRepository implements OpponentRepository {
  private opponents: Opponent[];
  private dirty = false;

  private constructor(
    private readonly target: FileOpponentRepository,
    opponents: readonly Opponent[]
  ) {
    this.opponents = [...opponents];
  }

  static async create(target: FileOpponentRepository): Promise<BufferedOpponentRepository> {
    return new BufferedOpponentRepository(target, await target.findAll());
  }

  async findAll(): Promise<readonly Opponent[]> {
    return this.opponents;
  }

  async findById(id: EntityId): Promise<Opponent | null> {
    return this.opponents.find((opponent) => opponent.id === id) ?? null;
  }

  async save(opponent: Opponent): Promise<void> {
    this.opponents = upsertById(this.opponents, opponent);
    this.dirty = true;
  }

  async clear(): Promise<void> {
    this.opponents = [];
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.dirty) {
      return;
    }

    await this.target.replaceAll(this.opponents);
    this.dirty = false;
  }
}

export class BufferedEnrichmentCandidateRepository implements EnrichmentCandidateRepository {
  private candidates: EnrichmentCandidateSnapshot[];
  private dirty = false;

  private constructor(
    private readonly target: FileEnrichmentCandidateRepository,
    candidates: readonly EnrichmentCandidateSnapshot[]
  ) {
    this.candidates = [...candidates];
  }

  static async create(
    target: FileEnrichmentCandidateRepository
  ): Promise<BufferedEnrichmentCandidateRepository> {
    return new BufferedEnrichmentCandidateRepository(target, await target.findAll());
  }

  async findByOpponentId(opponentId: EntityId): Promise<readonly EnrichmentCandidateSnapshot[]> {
    return this.candidates
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
    this.candidates = [
      ...this.candidates.filter((candidate) => candidate.opponentId !== opponentId),
      ...candidates
    ];
    this.dirty = true;
  }

  async clear(): Promise<void> {
    this.candidates = [];
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.dirty) {
      return;
    }

    await this.target.replaceAll(this.candidates);
    this.dirty = false;
  }
}

function upsertById<T extends { readonly id: EntityId }>(items: readonly T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);

  if (index === -1) {
    return [...items, item];
  }

  return items.map((candidate, candidateIndex) => (candidateIndex === index ? item : candidate));
}
