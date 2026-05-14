import type { Opponent } from "../../domain/entities/opponent.js";
import type { OpponentRepository } from "../../domain/repositories/opponent-repository.js";
import type { EntityId } from "../../domain/value-objects/entity-id.js";
import { deleteFileIfExists, readTextFileIfExists, writeTextFileAtomically } from "./atomic-file.js";
import { opponentsFromCsv, opponentsFromXml, opponentsToCsv, opponentsToXml } from "./storage-codecs.js";

export type FileStorageFormat = "csv" | "xml";

export class FileOpponentRepository implements OpponentRepository {
  constructor(
    private readonly filePath: string,
    private readonly format: FileStorageFormat
  ) {}

  async findAll(): Promise<readonly Opponent[]> {
    const content = await readTextFileIfExists(this.filePath);

    if (content === null) {
      return [];
    }

    return this.format === "csv" ? opponentsFromCsv(content) : opponentsFromXml(content);
  }

  async findById(id: EntityId): Promise<Opponent | null> {
    const opponents = await this.findAll();
    return opponents.find((opponent) => opponent.id === id) ?? null;
  }

  async save(opponent: Opponent): Promise<void> {
    const opponents = await this.findAll();
    const nextOpponents = upsertById(opponents, opponent);
    await this.replaceAll(nextOpponents);
  }

  async replaceAll(opponents: readonly Opponent[]): Promise<void> {
    const content = this.format === "csv" ? opponentsToCsv(opponents) : opponentsToXml(opponents);

    await writeTextFileAtomically(this.filePath, content);
  }

  async clear(): Promise<void> {
    await deleteFileIfExists(this.filePath);
  }
}

function upsertById(opponents: readonly Opponent[], opponent: Opponent): readonly Opponent[] {
  const index = opponents.findIndex((candidate) => candidate.id === opponent.id);

  if (index === -1) {
    return [...opponents, opponent];
  }

  return opponents.map((candidate, candidateIndex) => (candidateIndex === index ? opponent : candidate));
}
