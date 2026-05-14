import type { MatchResult } from "../entities/match.js";
import type { Race } from "../value-objects/race.js";

export type ReplayAnalysisPlayer = {
  readonly name: string;
  readonly race: Race;
  readonly result?: MatchResult;
  readonly apm?: number;
};

export type ReplayAnalysisSample = {
  readonly seconds: number;
  readonly value: number;
};

export type ReplayAnalysisSeries = {
  readonly playerName: string;
  readonly race: Race;
  readonly samples: readonly ReplayAnalysisSample[];
};

export type ReplayAnalysisGraphId = "armyValue" | "resourceCollectionRate" | "workersActive";

export type ReplayAnalysisGraph = {
  readonly id: ReplayAnalysisGraphId;
  readonly label: string;
  readonly yLabel: string;
  readonly xLabel: string;
  readonly series: readonly ReplayAnalysisSeries[];
};

export type ReplayBuildOrderEntry = {
  readonly seconds: number;
  readonly action: string;
};

export type ReplayBuildOrderPlayer = {
  readonly playerName: string;
  readonly race: Race;
  readonly entries: readonly ReplayBuildOrderEntry[];
};

export type ReplayAnalysis = {
  readonly players: readonly ReplayAnalysisPlayer[];
  readonly averageApm?: number;
  readonly graphs: readonly ReplayAnalysisGraph[];
  readonly buildOrders: readonly ReplayBuildOrderPlayer[];
  readonly parseError?: string;
};

export interface ReplayAnalysisReaderPort {
  readAnalysis(replayPath: string, opponentName?: string): Promise<ReplayAnalysis>;
}
