import type { Match } from "../../domain/entities/match.js";
import type { MatchRepository } from "../../domain/repositories/match-repository.js";
import type { EntityId } from "../../domain/value-objects/entity-id.js";
import { deleteFileIfExists, readTextFileIfExists, writeTextFileAtomically } from "./atomic-file.js";
import { matchesFromCsv, matchesFromXml, matchesToCsv, matchesToXml } from "./storage-codecs.js";
import type { FileStorageFormat } from "./file-opponent-repository.js";

export class FileMatchRepository implements MatchRepository {
  constructor(
    private readonly filePath: string,
    private readonly format: FileStorageFormat
  ) {}

  async findAll(): Promise<readonly Match[]> {
    const content = await readTextFileIfExists(this.filePath);

    if (content === null) {
      return [];
    }

    return this.format === "csv" ? matchesFromCsv(content) : matchesFromXml(content);
  }

  async findById(id: EntityId): Promise<Match | null> {
    const matches = await this.findAll();
    return matches.find((match) => match.id === id) ?? null;
  }

  async findByOpponentId(opponentId: EntityId): Promise<readonly Match[]> {
    const matches = await this.findAll();
    return matches.filter((match) => match.opponentId === opponentId);
  }

  async save(match: Match): Promise<void> {
    const matches = await this.findAll();
    const nextMatches = upsertById(matches, match);
    await this.replaceAll(nextMatches);
  }

  async replaceAll(matches: readonly Match[]): Promise<void> {
    const content = this.format === "csv" ? matchesToCsv(matches) : matchesToXml(matches);

    await writeTextFileAtomically(this.filePath, content);
  }

  async clear(): Promise<void> {
    await deleteFileIfExists(this.filePath);
  }
}

function upsertById(matches: readonly Match[], match: Match): readonly Match[] {
  const index = matches.findIndex((candidate) => candidate.id === match.id);

  if (index === -1) {
    return [...matches, match];
  }

  return matches.map((candidate, candidateIndex) => (candidateIndex === index ? match : candidate));
}
