import type { Match } from "../../domain/entities/match.js";
import type { Opponent } from "../../domain/entities/opponent.js";
import type { MatchRepository } from "../../domain/repositories/match-repository.js";
import type { OpponentRepository } from "../../domain/repositories/opponent-repository.js";
import type {
  ReplayAnalysis,
  ReplayAnalysisGraph,
  ReplayAnalysisPlayer,
  ReplayAnalysisReaderPort,
  ReplayBuildOrderPlayer,
  ReplaySuspicionAnalysis
} from "../../domain/ports/replay-analysis-reader-port.js";

export type GetMatchDetailsRequest = {
  readonly matchId: string;
};

export type MatchDetails = {
  readonly match: Match;
  readonly opponent: Opponent | null;
  readonly mapName: string;
  readonly playedAt: string;
  readonly durationSeconds?: number;
  readonly averageApm?: number;
  readonly replayPath?: string;
  readonly players: readonly ReplayAnalysisPlayer[];
  readonly graphs: readonly ReplayAnalysisGraph[];
  readonly buildOrders: readonly ReplayBuildOrderPlayer[];
  readonly suspicion?: ReplaySuspicionAnalysis;
  readonly parseError?: string;
};

export type GetMatchDetailsResponse = {
  readonly details: MatchDetails | null;
};

export class GetMatchDetails {
  constructor(
    private readonly matchRepository: MatchRepository,
    private readonly opponentRepository: OpponentRepository,
    private readonly replayAnalysisReader: ReplayAnalysisReaderPort
  ) {}

  async execute(request: GetMatchDetailsRequest): Promise<GetMatchDetailsResponse> {
    const match = await this.matchRepository.findById(request.matchId);
    if (!match) {
      return { details: null };
    }

    const opponent = await this.opponentRepository.findById(match.opponentId);
    const analysis = match.replayPath
      ? await this.readReplayAnalysis(match.replayPath, opponent?.nickname)
      : emptyAnalysis();

    return {
      details: {
        match,
        opponent,
        mapName: match.map ?? "Unknown map",
        playedAt: match.playedAt,
        durationSeconds: match.durationSeconds,
        averageApm: analysis.averageApm,
        replayPath: match.replayPath,
        players: analysis.players,
        graphs: analysis.graphs,
        buildOrders: analysis.buildOrders,
        suspicion: analysis.suspicion,
        parseError: analysis.parseError
      }
    };
  }

  private async readReplayAnalysis(replayPath: string, opponentName: string | undefined): Promise<ReplayAnalysis> {
    try {
      return await this.replayAnalysisReader.readAnalysis(replayPath, opponentName);
    } catch (error) {
      return {
        ...emptyAnalysis(),
        parseError: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

function emptyAnalysis(): ReplayAnalysis {
  return {
    players: [],
    graphs: [],
    buildOrders: []
  };
}
