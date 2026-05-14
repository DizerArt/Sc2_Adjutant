import type { Race } from "../value-objects/race.js";

export type OpponentSearchQuery = {
  readonly nickname: string;
  readonly profileLink?: string;
  readonly race?: Race;
  readonly region?: "US" | "EU" | "KR" | "CN" | "Unknown";
  readonly season?: number;
};

export type OpponentDataCandidate = {
  readonly source: string;
  readonly nickname: string;
  readonly race: Race;
  readonly region?: "US" | "EU" | "KR" | "CN" | "Unknown";
  readonly battleTag?: string;
  readonly aliases: readonly string[];
  readonly mmr?: number;
  readonly league?: string;
  readonly totalGames?: number;
  readonly wins?: number;
  readonly losses?: number;
  readonly lastPlayedAt?: string;
  readonly profileUrl?: string;
  readonly confidenceScore: number;
  readonly raw?: unknown;
};

export interface OpponentDataSourcePort {
  readonly sourceName: string;
  searchOpponent(query: OpponentSearchQuery): Promise<readonly OpponentDataCandidate[]>;
}
