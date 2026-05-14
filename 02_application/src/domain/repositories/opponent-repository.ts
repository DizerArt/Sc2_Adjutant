import type { Opponent } from "../entities/opponent.js";
import type { EntityId } from "../value-objects/entity-id.js";

export interface OpponentRepository {
  findAll(): Promise<readonly Opponent[]>;
  findById(id: EntityId): Promise<Opponent | null>;
  save(opponent: Opponent): Promise<void>;
  clear(): Promise<void>;
}

