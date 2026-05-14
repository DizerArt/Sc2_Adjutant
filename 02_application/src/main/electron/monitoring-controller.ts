import type { HandleDetectedGame } from "../../application/use-cases/handle-detected-game.js";
import { Sc2GamePollingService } from "../../application/services/sc2-game-polling-service.js";
import type { AppRegion } from "../../domain/entities/app-settings.js";
import { findUserPlayer } from "../../domain/entities/game-session.js";
import type { OpponentSearchQuery } from "../../domain/ports/opponent-data-source-port.js";
import type { Sc2ClientPort } from "../../domain/ports/sc2-client-port.js";
import type { MonitoringStatus } from "../../shared/ipc/contracts.js";

export type MonitoringControllerOptions = {
  readonly sc2Client: Sc2ClientPort;
  readonly handleDetectedGame: HandleDetectedGame;
  readonly userName?: string;
  readonly region?: AppRegion;
  readonly intervalMs?: number;
};

export class MonitoringController {
  private readonly pollingService: Sc2GamePollingService;
  private userName?: string;
  private region: AppRegion;
  private status: MonitoringStatus = {
    running: false
  };

  constructor(options: MonitoringControllerOptions) {
    this.userName = normalizeOptionalString(options.userName);
    this.region = options.region ?? "unknown";
    this.pollingService = new Sc2GamePollingService(options.sc2Client, {
      intervalMs: options.intervalMs ?? 1000,
      idleIntervalMs: Math.max((options.intervalMs ?? 1000) * 4, 4000),
      userName: this.userName
    });

    this.pollingService.on("session", (session) => {
      this.status = {
        ...this.status,
        currentSession: {
          active: session.isActive,
          mode: session.mode,
          detectedAt: session.detectedAt,
          players: session.players.map((player) => ({
            name: player.name,
            race: player.race,
            mmr: player.mmr,
            isUser: player.isUser,
            result: player.result
          }))
        }
      };

      if (session.isActive && session.mode === "ranked-1v1") {
        if (!findUserPlayer(session, this.userName)) {
          this.status = {
            ...this.status,
            lastError: "Set SC2 name in Settings so the opponent can be identified."
          };
          return;
        }
      }
    });

    this.pollingService.on("newGameDetected", ({ session }) => {
      void options.handleDetectedGame
        .execute({
          session,
          userName: this.userName,
          region: opponentSearchRegionFromAppRegion(this.region)
        })
        .then((result) => {
          if (!result) {
            return;
          }

          this.status = {
            ...this.status,
            lastDetectedOpponent: result.enrichedOpponent.nickname,
            lastSavedMatchId: result.match.id,
            lastError: undefined
          };
        })
        .catch((error: unknown) => {
          this.status = {
            ...this.status,
            lastError: error instanceof Error ? error.message : String(error)
          };
        });
    });

    this.pollingService.on("error", (error) => {
      this.status = {
        ...this.status,
        lastError: error instanceof Error ? error.message : String(error)
      };
    });
  }

  start(): MonitoringStatus {
    this.pollingService.start();
    this.status = {
      ...this.status,
      running: true
    };
    return this.getStatus();
  }

  stop(): MonitoringStatus {
    this.pollingService.stop();
    this.status = {
      ...this.status,
      running: false
    };
    return this.getStatus();
  }

  getStatus(): MonitoringStatus {
    return {
      ...this.status,
      running: this.pollingService.isRunning()
    };
  }

  setUserName(userName: string | undefined): MonitoringStatus {
    this.userName = normalizeOptionalString(userName);
    this.pollingService.setUserName(this.userName);

    return this.getStatus();
  }

  setRegion(region: AppRegion): MonitoringStatus {
    this.region = region;
    return this.getStatus();
  }
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function opponentSearchRegionFromAppRegion(region: AppRegion): OpponentSearchQuery["region"] | undefined {
  if (region === "us" || region === "eu" || region === "kr" || region === "cn") {
    return region.toUpperCase() as OpponentSearchQuery["region"];
  }

  return undefined;
}
