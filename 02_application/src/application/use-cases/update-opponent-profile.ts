import {
  updateOpponentProfile,
  type Opponent,
  type UpdateOpponentProfileInput
} from "../../domain/entities/opponent.js";
import type { OpponentRepository } from "../../domain/repositories/opponent-repository.js";
import type { EntityId } from "../../domain/value-objects/entity-id.js";

export type UpdateOpponentProfileRequest = UpdateOpponentProfileInput & {
  readonly opponentId: EntityId;
};

export type UpdateOpponentProfileResult = {
  readonly opponent: Opponent;
};

export class UpdateOpponentProfile {
  private readonly clock: () => string;

  constructor(
    private readonly opponentRepository: OpponentRepository,
    clock: () => string = () => new Date().toISOString()
  ) {
    this.clock = clock;
  }

  async execute(input: UpdateOpponentProfileRequest): Promise<UpdateOpponentProfileResult> {
    const opponent = await this.opponentRepository.findById(input.opponentId);

    if (!opponent) {
      throw new Error(`Opponent ${input.opponentId} was not found.`);
    }

    const updatedOpponent = updateOpponentProfile(opponent, input, this.clock());
    await this.opponentRepository.save(updatedOpponent);

    return {
      opponent: updatedOpponent
    };
  }
}
