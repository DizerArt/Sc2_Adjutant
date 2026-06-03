import type { HandleDetectedGame } from "../../application/use-cases/handle-detected-game.js";
import { Sc2GamePollingService } from "../../application/services/sc2-game-polling-service.js";
import type { AppRegion } from "../../domain/entities/app-settings.js";
import { findUserPlayer, type GameSession } from "../../domain/entities/game-session.js";
import type { Opponent } from "../../domain/entities/opponent.js";
import type { OpponentSearchQuery } from "../../domain/ports/opponent-data-source-port.js";
import type { Sc2ClientPort } from "../../domain/ports/sc2-client-port.js";
import type { MonitoringStatus } from "../../shared/ipc/contracts.js";
import type { VoiceOpponentSpeechData } from "../../shared/ipc/voice-contracts.js";
import { broadcastVoiceEvent } from "./voice-broadcaster.js";

export type MonitoringControllerOptions = {
  readonly sc2Client: Sc2ClientPort;
  readonly handleDetectedGame: HandleDetectedGame;
  readonly userName?: string;
  readonly region?: AppRegion;
  readonly intervalMs?: number;
};

const VOICE_OPPONENT_ANNOUNCE_DELAY_MS = 1500;
const VOICE_OPPONENT_START_WINDOW_MS = 120_000;

type PendingVoiceOpponentAnnouncement = {
  readonly sessionId: string;
  readonly matchKey: string;
  readonly data: VoiceOpponentSpeechData;
  readonly timer: NodeJS.Timeout;
};

export class MonitoringController {
  private readonly pollingService: Sc2GamePollingService;
  private userName?: string;
  private region: AppRegion;
  private status: MonitoringStatus = {
    running: false
  };
  // Polling may emit early and later-enriched snapshots for the same match.
  // Voice uses a short debounce so the spoken card uses the best available data.
  private pendingVoiceOpponentAnnouncement: PendingVoiceOpponentAnnouncement | null = null;
  private lastAnnouncedVoiceOpponent: {
    readonly sessionId: string;
    readonly matchKey: string;
    readonly data: VoiceOpponentSpeechData;
  } | null = null;
  private announcedVoiceMatchKey: string | null = null;
  private voiceMatchEnded = false;

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

      this.updateVoiceMatchLifecycle(session);
    });

    this.pollingService.on("newGameDetected", ({ session }) => {
      const sessionIdSnapshot = session.id;

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

          this.scheduleVoiceOpponentAnnouncement(session, sessionIdSnapshot, toVoiceOpponentData(result.enrichedOpponent, result.match.opponentRace));
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
    this.clearPendingVoiceOpponentAnnouncement();
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
    this.clearPendingVoiceOpponentAnnouncement();
    this.lastAnnouncedVoiceOpponent = null;
    this.announcedVoiceMatchKey = null;
    this.voiceMatchEnded = false;

    return this.getStatus();
  }

  setRegion(region: AppRegion): MonitoringStatus {
    this.region = region;
    return this.getStatus();
  }

  private scheduleVoiceOpponentAnnouncement(
    session: GameSession,
    sessionId: string,
    data: VoiceOpponentSpeechData
  ): void {
    if (!shouldAnnounceOpponentVoice(session)) {
      return;
    }

    const matchKey = buildVoiceMatchKey(session);
    if (!matchKey) {
      return;
    }

    if (this.announcedVoiceMatchKey === matchKey) {
      return;
    }

    if (this.lastAnnouncedVoiceOpponent?.sessionId === sessionId) {
      return;
    }

    const pending = this.pendingVoiceOpponentAnnouncement;
    if (pending) {
      if (pending.matchKey === matchKey && voiceDataQuality(pending.data) > voiceDataQuality(data)) {
        return;
      }
      clearTimeout(pending.timer);
    }

    const timer = setTimeout(() => {
      const current = this.pendingVoiceOpponentAnnouncement;
      if (!current || current.sessionId !== sessionId) {
        return;
      }

      this.pendingVoiceOpponentAnnouncement = null;
      this.lastAnnouncedVoiceOpponent = {
        sessionId: current.sessionId,
        matchKey: current.matchKey,
        data: current.data
      };
      this.announcedVoiceMatchKey = current.matchKey;
      broadcastVoiceEvent({
        kind: "opponent",
        data: current.data
      });
    }, VOICE_OPPONENT_ANNOUNCE_DELAY_MS);

    this.pendingVoiceOpponentAnnouncement = {
      sessionId,
      matchKey,
      data,
      timer
    };
  }

  private updateVoiceMatchLifecycle(session: GameSession): void {
    const matchKey = buildVoiceMatchKey(session);
    if (!matchKey) {
      if (this.voiceMatchEnded) {
        this.announcedVoiceMatchKey = null;
        this.lastAnnouncedVoiceOpponent = null;
        this.voiceMatchEnded = false;
      }
      return;
    }

    const hasFinal = hasFinalResult(session);
    if (hasFinal) {
      this.voiceMatchEnded = true;
      return;
    }

    if (this.voiceMatchEnded) {
      this.announcedVoiceMatchKey = null;
      this.lastAnnouncedVoiceOpponent = null;
      this.voiceMatchEnded = false;
    }
  }

  private clearPendingVoiceOpponentAnnouncement(): void {
    if (!this.pendingVoiceOpponentAnnouncement) {
      return;
    }
    clearTimeout(this.pendingVoiceOpponentAnnouncement.timer);
    this.pendingVoiceOpponentAnnouncement = null;
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

function toVoiceOpponentData(opponent: Opponent, matchRace: Opponent["race"]): VoiceOpponentSpeechData {
  return {
    nickname: opponent.revealedNickname ?? opponent.nickname,
    race: matchRace === "Unknown" ? opponent.race : matchRace,
    mmr: opponent.mmrAtLastMatch,
    encounters: opponent.encounters,
    wins: opponent.wins,
    losses: opponent.losses,
    strategyTags: opponent.strategyTags,
    notes: opponent.notes
  };
}

function shouldAnnounceOpponentVoice(session: GameSession): boolean {
  if (!session.isActive || session.mode !== "ranked-1v1" || hasFinalResult(session)) {
    return false;
  }

  if (!session.startedAt) {
    return true;
  }

  const startedAtMs = Date.parse(session.startedAt);
  const detectedAtMs = Date.parse(session.detectedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(detectedAtMs)) {
    return true;
  }

  return detectedAtMs - startedAtMs <= VOICE_OPPONENT_START_WINDOW_MS;
}

function hasFinalResult(session: GameSession): boolean {
  return session.players.some((player) => player.result === "Victory" || player.result === "Defeat");
}

function buildVoiceMatchKey(session: GameSession): string | null {
  if (!session.isActive || session.mode !== "ranked-1v1" || session.players.length !== 2) {
    return null;
  }

  const playerKey = session.players
    .map((player) => (player.profileLink ?? player.battleTag ?? player.name).trim().toLowerCase())
    .filter((value) => value.length > 0)
    .sort()
    .join("|");

  return playerKey ? `${session.mode}:${playerKey}` : null;
}

function voiceDataQuality(data: VoiceOpponentSpeechData): number {
  return (
    (data.mmr === undefined ? 0 : 4) +
    (data.race === "Unknown" ? 0 : 2) +
    Math.min(data.encounters, 1) +
    Math.min(data.strategyTags.length, 3) * 0.1 +
    Math.min(data.notes.length, 2) * 0.1
  );
}
