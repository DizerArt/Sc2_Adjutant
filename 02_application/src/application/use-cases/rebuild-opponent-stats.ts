import type { Match } from "../../domain/entities/match.js";
import type { Opponent } from "../../domain/entities/opponent.js";
import type { MatchRepository } from "../../domain/repositories/match-repository.js";
import type { OpponentRepository } from "../../domain/repositories/opponent-repository.js";
import type { EntityId } from "../../domain/value-objects/entity-id.js";

export type RebuildOpponentStatsResult = {
  readonly inspectedCount: number;
  readonly rebuiltCount: number;
};

export type RebuildOpponentStatsDependencies = {
  readonly opponentRepository: OpponentRepository;
  readonly matchRepository: MatchRepository;
  readonly clock?: () => string;
};

export class RebuildOpponentStats {
  private readonly clock: () => string;

  constructor(private readonly dependencies: RebuildOpponentStatsDependencies) {
    this.clock = dependencies.clock ?? (() => new Date().toISOString());
  }

  async execute(): Promise<RebuildOpponentStatsResult> {
    const [opponents, matches] = await Promise.all([
      this.dependencies.opponentRepository.findAll(),
      this.dependencies.matchRepository.findAll()
    ]);

    const matchesByOpponent = groupMatchesByOpponent(matches);
    const now = this.clock();
    let rebuiltCount = 0;

    for (const opponent of opponents) {
      const opponentMatches = matchesByOpponent.get(opponent.id) ?? [];
      const stats = computeStats(opponentMatches);

      if (statsAreEqual(opponent, stats)) {
        continue;
      }

      await this.dependencies.opponentRepository.save({
        ...opponent,
        encounters: stats.encounters,
        wins: stats.wins,
        losses: stats.losses,
        lastMatchDate: stats.lastMatchDate ?? opponent.lastMatchDate,
        updatedAt: now
      });
      rebuiltCount += 1;
    }

    return {
      inspectedCount: opponents.length,
      rebuiltCount
    };
  }
}

type ComputedStats = {
  readonly encounters: number;
  readonly wins: number;
  readonly losses: number;
  readonly lastMatchDate?: string;
};

function groupMatchesByOpponent(matches: readonly Match[]): Map<EntityId, Match[]> {
  const grouped = new Map<EntityId, Match[]>();

  for (const match of matches) {
    const list = grouped.get(match.opponentId) ?? [];
    list.push(match);
    grouped.set(match.opponentId, list);
  }

  return grouped;
}

function computeStats(matches: readonly Match[]): ComputedStats {
  let wins = 0;
  let losses = 0;
  let lastMatchDate: string | undefined;

  for (const match of matches) {
    if (match.result === "win") {
      wins += 1;
    } else if (match.result === "loss") {
      losses += 1;
    }

    if (!lastMatchDate || match.playedAt.localeCompare(lastMatchDate) > 0) {
      lastMatchDate = match.playedAt;
    }
  }

  return {
    encounters: matches.length,
    wins,
    losses,
    lastMatchDate
  };
}

function statsAreEqual(opponent: Opponent, stats: ComputedStats): boolean {
  return (
    opponent.encounters === stats.encounters &&
    opponent.wins === stats.wins &&
    opponent.losses === stats.losses &&
    (stats.lastMatchDate === undefined || opponent.lastMatchDate === stats.lastMatchDate)
  );
}
