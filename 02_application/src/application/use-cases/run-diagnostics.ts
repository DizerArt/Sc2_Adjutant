import type { Sc2ClientPort } from "../../domain/ports/sc2-client-port.js";
import type { StorageHealthPort } from "../../domain/ports/storage-health-port.js";
import type { MatchRepository } from "../../domain/repositories/match-repository.js";
import type { OpponentRepository } from "../../domain/repositories/opponent-repository.js";

export type DiagnosticStatus = "ok" | "warning" | "error";

export type DiagnosticItem = {
  readonly name: string;
  readonly status: DiagnosticStatus;
  readonly message: string;
  readonly details?: Record<string, unknown>;
};

export type ExternalSourceDiagnostic = {
  readonly name: string;
  readonly state: "ready" | "cached" | "cooling-down";
  readonly cacheEntries?: number;
  readonly consecutiveFailures?: number;
  readonly cooldownUntil?: string;
  readonly lastFailureMessage?: string;
};

export type DiagnosticsReport = {
  readonly checkedAt: string;
  readonly overallStatus: DiagnosticStatus;
  readonly items: readonly DiagnosticItem[];
};

export type RunDiagnosticsDependencies = {
  readonly sc2Client: Sc2ClientPort;
  readonly storageHealth: StorageHealthPort;
  readonly opponentRepository?: OpponentRepository;
  readonly matchRepository?: MatchRepository;
  readonly externalSourcesEnabled?: boolean;
  readonly externalSourceNames?: readonly string[];
  readonly externalSourceDiagnostics?: readonly ExternalSourceDiagnostic[];
  readonly clock?: () => string;
};

export class RunDiagnostics {
  private readonly clock: () => string;

  constructor(private readonly dependencies: RunDiagnosticsDependencies) {
    this.clock = dependencies.clock ?? (() => new Date().toISOString());
  }

  async execute(): Promise<DiagnosticsReport> {
    const checks: Array<Promise<DiagnosticItem>> = [
      this.checkSc2Client(),
      this.checkStorage(),
      this.checkExternalSources()
    ];

    if (this.dependencies.opponentRepository && this.dependencies.matchRepository) {
      checks.push(this.checkStatsHealth(this.dependencies.opponentRepository, this.dependencies.matchRepository));
    }

    const items = await Promise.all(checks);

    return {
      checkedAt: this.clock(),
      overallStatus: getOverallStatus(items),
      items
    };
  }

  private async checkStatsHealth(
    opponentRepository: OpponentRepository,
    matchRepository: MatchRepository
  ): Promise<DiagnosticItem> {
    try {
      const [opponents, matches] = await Promise.all([opponentRepository.findAll(), matchRepository.findAll()]);

      const matchCountByOpponent = new Map<string, number>();
      for (const match of matches) {
        matchCountByOpponent.set(match.opponentId, (matchCountByOpponent.get(match.opponentId) ?? 0) + 1);
      }

      const orphanMatchCount = matches.filter(
        (match) => !opponents.some((opponent) => opponent.id === match.opponentId)
      ).length;

      const inflated: string[] = [];
      const drifting: string[] = [];

      for (const opponent of opponents) {
        if (opponent.wins + opponent.losses > opponent.encounters) {
          inflated.push(opponent.nickname);
          continue;
        }

        const actualMatches = matchCountByOpponent.get(opponent.id) ?? 0;
        if (opponent.encounters !== actualMatches) {
          drifting.push(opponent.nickname);
        }
      }

      const issuesFound = inflated.length + drifting.length + orphanMatchCount;

      if (issuesFound === 0) {
        return {
          name: "Stats Health",
          status: "ok",
          message: `${opponents.length} opponent(s) consistent with ${matches.length} match record(s).`,
          details: {
            opponents: opponents.length,
            matches: matches.length
          }
        };
      }

      const messageParts: string[] = [];
      if (inflated.length > 0) {
        messageParts.push(`${inflated.length} opponent(s) with inflated wins/losses`);
      }
      if (drifting.length > 0) {
        messageParts.push(`${drifting.length} opponent(s) with encounter drift`);
      }
      if (orphanMatchCount > 0) {
        messageParts.push(`${orphanMatchCount} orphan match record(s)`);
      }

      return {
        name: "Stats Health",
        status: "warning",
        message: messageParts.join("; ") + ". Run rebuild to recompute from the match log.",
        details: {
          opponents: opponents.length,
          matches: matches.length,
          inflatedOpponents: inflated.slice(0, 5),
          driftingOpponents: drifting.slice(0, 5),
          orphanMatchCount
        }
      };
    } catch (error) {
      return {
        name: "Stats Health",
        status: "error",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async checkSc2Client(): Promise<DiagnosticItem> {
    try {
      const session = await this.dependencies.sc2Client.getCurrentGame();

      if (!session.isActive) {
        return {
          name: "SC2 Client API",
          status: "warning",
          message: "SC2 Client API is reachable, but no active game session is available.",
          details: {
            mode: session.mode,
            players: session.players.length
          }
        };
      }

      return {
        name: "SC2 Client API",
        status: "ok",
        message: "SC2 Client API is reachable.",
        details: {
          mode: session.mode,
          players: session.players.map((player) => `${player.name}/${player.race}`)
        }
      };
    } catch (error) {
      return {
        name: "SC2 Client API",
        status: "error",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async checkStorage(): Promise<DiagnosticItem> {
    try {
      const result = await this.dependencies.storageHealth.verifyWritable();

      return {
        name: "Local Storage",
        status: result.writable ? "ok" : "error",
        message: result.writable ? "Local storage directory is writable." : "Local storage directory is not writable.",
        details: {
          directory: result.directory
        }
      };
    } catch (error) {
      return {
        name: "Local Storage",
        status: "error",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async checkExternalSources(): Promise<DiagnosticItem> {
    const enabled = this.dependencies.externalSourcesEnabled ?? true;
    const sourceNames = this.dependencies.externalSourceNames ?? [];
    const sourceDiagnostics = this.dependencies.externalSourceDiagnostics ?? [];

    if (!enabled) {
      return {
        name: "External Sources",
        status: "warning",
        message: "External opponent sources are disabled.",
        details: {
          enabled,
          configuredSources: sourceNames,
          sourceDiagnostics
        }
      };
    }

    if (sourceNames.length === 0) {
      return {
        name: "External Sources",
        status: "warning",
        message: "No external opponent source adapters are configured; local fallback profiles are used.",
        details: {
          enabled,
          configuredSources: []
        }
      };
    }

    const degradedSources = sourceDiagnostics.filter(
      (source) => source.state === "cooling-down" || (source.consecutiveFailures ?? 0) > 0
    );

    if (degradedSources.length > 0) {
      return {
        name: "External Sources",
        status: "warning",
        message: `${sourceNames.length} external opponent source adapter(s) configured; ${degradedSources.length} degraded.`,
        details: {
          enabled,
          configuredSources: sourceNames,
          sourceDiagnostics
        }
      };
    }

    return {
      name: "External Sources",
      status: "ok",
      message: `${sourceNames.length} external opponent source adapter(s) configured.`,
      details: {
        enabled,
        configuredSources: sourceNames,
        sourceDiagnostics
      }
    };
  }
}

function getOverallStatus(items: readonly DiagnosticItem[]): DiagnosticStatus {
  if (items.some((item) => item.status === "error")) {
    return "error";
  }

  if (items.some((item) => item.status === "warning")) {
    return "warning";
  }

  return "ok";
}
