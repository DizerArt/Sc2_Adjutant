import type { GameSession } from "../entities/game-session.js";

export interface Sc2ClientPort {
  getCurrentGame(): Promise<GameSession>;
}

