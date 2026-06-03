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

export type ReplaySuspicionLevel = "low" | "medium" | "high";

export type ReplaySuspicionEvidenceType =
  | "hiddenCamera"
  | "hiddenTarget"
  | "hiddenEnemyCamera"
  | "hiddenEnemyCommand";

export type ReplaySuspicionEvidence = {
  readonly seconds: number;
  readonly playerName: string;
  readonly type: ReplaySuspicionEvidenceType;
  readonly label: string;
  readonly details: string;
  readonly weight: number;
};

export type ReplaySuspicionPlayer = {
  readonly playerName: string;
  readonly race: Race;
  readonly score: number;
  readonly confidence: number;
  readonly level: ReplaySuspicionLevel;
  readonly evidence: readonly ReplaySuspicionEvidence[];
};

export type ReplaySuspicionAnalysis = {
  readonly players: readonly ReplaySuspicionPlayer[];
  readonly parseError?: string;
};

export type ReplayAnalysis = {
  readonly players: readonly ReplayAnalysisPlayer[];
  readonly averageApm?: number;
  readonly graphs: readonly ReplayAnalysisGraph[];
  readonly buildOrders: readonly ReplayBuildOrderPlayer[];
  readonly suspicion?: ReplaySuspicionAnalysis;
  readonly parseError?: string;
};

export interface ReplayAnalysisReaderPort {
  readAnalysis(replayPath: string, opponentName?: string): Promise<ReplayAnalysis>;
}
