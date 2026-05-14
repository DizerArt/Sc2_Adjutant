import type { Match } from "../../domain/entities/match.js";
import type { Opponent } from "../../domain/entities/opponent.js";
import type { MatchRepository } from "../../domain/repositories/match-repository.js";
import type { OpponentRepository } from "../../domain/repositories/opponent-repository.js";

export type MatchHistoryItem = {
  readonly match: Match;
  readonly opponent: Opponent | null;
};

export type ListMatchHistoryResult = {
  readonly items: readonly MatchHistoryItem[];
};

export type ListMatchHistoryOptions = {
  readonly limit?: number;
};

export class ListMatchHistory {
  constructor(
    private readonly matchRepository: MatchRepository,
    private readonly opponentRepository: OpponentRepository
  ) {}

  async execute(options: ListMatchHistoryOptions = {}): Promise<ListMatchHistoryResult> {
    const [allMatches, allOpponents] = await Promise.all([
      this.matchRepository.findAll(),
      this.opponentRepository.findAll()
    ]);
    const opponentsById = new Map(allOpponents.map((opponent) => [opponent.id, opponent]));
    const matches = [...allMatches].sort(compareMatches);
    const limitedMatches = typeof options.limit === "number" ? matches.slice(0, Math.max(0, options.limit)) : matches;

    return {
      items: limitedMatches.map((match) => ({
        match,
        opponent: opponentsById.get(match.opponentId) ?? null
      }))
    };
  }
}

function compareMatches(first: Match, second: Match): number {
  return second.playedAt.localeCompare(first.playedAt);
}
