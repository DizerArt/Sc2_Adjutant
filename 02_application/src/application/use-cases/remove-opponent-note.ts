import { removeOpponentNote, type Opponent } from "../../domain/entities/opponent.js";
import type { OpponentRepository } from "../../domain/repositories/opponent-repository.js";
import type { EntityId } from "../../domain/value-objects/entity-id.js";
import type { Race } from "../../domain/value-objects/race.js";

export type RemoveOpponentNoteInput = {
  readonly opponentId: EntityId;
  readonly noteIndex: number;
  readonly race?: Race;
};

export type RemoveOpponentNoteResult = {
  readonly opponent: Opponent;
};

export class RemoveOpponentNote {
  constructor(private readonly opponentRepository: OpponentRepository) {}

  async execute(input: RemoveOpponentNoteInput): Promise<RemoveOpponentNoteResult> {
    const opponent = await this.opponentRepository.findById(input.opponentId);

    if (!opponent) {
      throw new Error(`Opponent ${input.opponentId} was not found.`);
    }

    const updatedOpponent = removeOpponentNote(opponent, input.noteIndex, input.race);
    await this.opponentRepository.save(updatedOpponent);

    return {
      opponent: updatedOpponent
    };
  }
}
