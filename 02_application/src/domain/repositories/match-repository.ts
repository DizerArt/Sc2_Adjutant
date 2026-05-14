import type { Match } from "../entities/match.js";
import type { EntityId } from "../value-objects/entity-id.js";

export interface MatchRepository {
  findAll(): Promise<readonly Match[]>;
  findById(id: EntityId): Promise<Match | null>;
  findByOpponentId(opponentId: EntityId): Promise<readonly Match[]>;
  save(match: Match): Promise<void>;
  clear(): Promise<void>;
}
