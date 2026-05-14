import { describe, expect, it } from "vitest";
import { ToggleMatchFavorite } from "../../../src/application/use-cases/toggle-match-favorite.js";
import { createMatch, type Match } from "../../../src/domain/entities/match.js";
import type { MatchRepository } from "../../../src/domain/repositories/match-repository.js";
import type { EntityId } from "../../../src/domain/value-objects/entity-id.js";

describe("ToggleMatchFavorite", () => {
  it("toggles and persists a match favorite flag", async () => {
    const repository = new InMemoryMatchRepository([
      createMatch({
        id: "match_001",
        opponentId: "opponent_001",
        playedAt: "2026-05-09T10:00:00.000Z",
        playerRace: "Terran",
        opponentRace: "Zerg",
        now: "2026-05-09T10:00:00.000Z"
      })
    ]);

    const result = await new ToggleMatchFavorite(repository).execute({ matchId: "match_001" });

    expect(result.match?.favorite).toBe(true);
    await expect(repository.findById("match_001")).resolves.toMatchObject({ favorite: true });
  });
});

class InMemoryMatchRepository implements MatchRepository {
  private matches: Match[];

  constructor(matches: readonly Match[]) {
    this.matches = [...matches];
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
    this.matches = this.matches.map((candidate) => candidate.id === match.id ? match : candidate);
  }

  async clear(): Promise<void> {
    this.matches = [];
  }
}
