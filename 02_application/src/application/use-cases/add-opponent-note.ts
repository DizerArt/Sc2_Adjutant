import { addOpponentNote, type Opponent } from "../../domain/entities/opponent.js";
import type { OpponentRepository } from "../../domain/repositories/opponent-repository.js";
import type { EntityId } from "../../domain/value-objects/entity-id.js";
import type { Race } from "../../domain/value-objects/race.js";

export type AddOpponentNoteInput = {
  readonly opponentId: EntityId;
  readonly note: string;
  readonly race?: Race;
};

export type AddOpponentNoteResult = {
  readonly opponent: Opponent;
};

export class AddOpponentNote {
  constructor(private readonly opponentRepository: OpponentRepository) {}

  async execute(input: AddOpponentNoteInput): Promise<AddOpponentNoteResult> {
    const opponent = await this.opponentRepository.findById(input.opponentId);

    if (!opponent) {
      throw new Error(`Opponent ${input.opponentId} was not found.`);
    }

    const updatedOpponent = addOpponentNote(opponent, input.note, input.race);
    await this.opponentRepository.save(updatedOpponent);

    return {
      opponent: updatedOpponent
    };
  }
}
