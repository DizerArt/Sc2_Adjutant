import {
  findOpponent,
  findUserPlayer,
  type GameSession,
  type GameSessionPlayer
} from "../../domain/entities/game-session.js";
import { createEnrichmentCandidateSnapshot } from "../../domain/entities/enrichment-candidate-snapshot.js";
import type { Opponent } from "../../domain/entities/opponent.js";
import type { OpponentSearchQuery } from "../../domain/ports/opponent-data-source-port.js";
import type { EnrichmentCandidateRepository } from "../../domain/repositories/enrichment-candidate-repository.js";
import type { OpponentRepository } from "../../domain/repositories/opponent-repository.js";
import {
  OpponentEnrichmentService,
  type OpponentEnrichmentWarning
} from "../services/opponent-enrichment-service.js";
import {
  RegisterDetectedGame,
  type RegisterDetectedGameDependencies,
  type RegisterDetectedGameResult
} from "./register-detected-game.js";

export type HandleDetectedGameInput = {
  readonly session: GameSession;
  readonly opponent?: GameSessionPlayer;
  readonly userName?: string;
  readonly region?: OpponentSearchQuery["region"];
};

export type HandleDetectedGameResult = RegisterDetectedGameResult & {
  readonly enrichedOpponent: Opponent;
  readonly enrichmentApplied: boolean;
  readonly enrichmentWarnings: readonly OpponentEnrichmentWarning[];
};

export type HandleDetectedGameDependencies = RegisterDetectedGameDependencies & {
  readonly opponentRepository: OpponentRepository;
  readonly enrichmentService?: OpponentEnrichmentService;
  readonly enrichmentCandidateRepository?: EnrichmentCandidateRepository;
};

export class HandleDetectedGame {
  private readonly registerDetectedGame: RegisterDetectedGame;

  constructor(private readonly dependencies: HandleDetectedGameDependencies) {
    this.registerDetectedGame = new RegisterDetectedGame(dependencies);
  }

  async execute(input: HandleDetectedGameInput): Promise<HandleDetectedGameResult | null> {
    const registered = await this.registerDetectedGame.execute(input);

    if (!registered) {
      return null;
    }

    if (!this.dependencies.enrichmentService) {
      return {
        ...registered,
        enrichedOpponent: registered.opponent,
        enrichmentApplied: false,
        enrichmentWarnings: []
      };
    }

    const detectedOpponent = input.opponent ?? findOpponent(input.session, input.userName);
    const enrichment = await this.dependencies.enrichmentService.enrich(registered.opponent, {
      nickname: registered.opponent.nickname,
      profileLink: detectedOpponent?.profileLink,
      race: registered.opponent.race,
      region: input.region,
      excludedNicknames: localPlayerIdentityNames(input)
    });
    const capturedAt = new Date().toISOString();
    const snapshots = enrichment.candidates.map((candidate) =>
      createEnrichmentCandidateSnapshot(
        registered.opponent.id,
        candidate,
        enrichment.bestCandidate === candidate,
        capturedAt
      )
    );

    await this.dependencies.opponentRepository.save(enrichment.opponent);
    await this.dependencies.enrichmentCandidateRepository?.replaceForOpponent(registered.opponent.id, snapshots);

    return {
      ...registered,
      enrichedOpponent: enrichment.opponent,
      enrichmentApplied: enrichment.bestCandidate !== null,
      enrichmentWarnings: enrichment.warnings
    };
  }
}

function localPlayerIdentityNames(input: HandleDetectedGameInput): readonly string[] {
  const names = new Set<string>();
  const configuredUserName = input.userName?.trim();
  if (configuredUserName) {
    names.add(configuredUserName);
  }

  const userPlayer = findUserPlayer(input.session, input.userName);
  if (userPlayer?.name.trim()) {
    names.add(userPlayer.name.trim());
  }

  return [...names];
}
