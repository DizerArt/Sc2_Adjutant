import type { Opponent } from "../../domain/entities/opponent.js";
import type { OpponentRepository } from "../../domain/repositories/opponent-repository.js";

export type ListKnownOpponentsResult = {
  readonly opponents: readonly Opponent[];
};

export class ListKnownOpponents {
  constructor(private readonly opponentRepository: OpponentRepository) {}

  async execute(): Promise<ListKnownOpponentsResult> {
    const opponents = await this.opponentRepository.findAll();

    return {
      opponents: [...opponents].sort(compareOpponents)
    };
  }
}

function compareOpponents(first: Opponent, second: Opponent): number {
  const firstDate = first.lastMatchDate ?? first.updatedAt;
  const secondDate = second.lastMatchDate ?? second.updatedAt;

  return secondDate.localeCompare(firstDate);
}

