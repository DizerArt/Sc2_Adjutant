import { EventEmitter } from "node:events";
import { findOpponent, type GameSession, type GameSessionPlayer } from "../../domain/entities/game-session.js";
import type { Sc2ClientPort } from "../../domain/ports/sc2-client-port.js";

export type NewGameDetectedEvent = {
  readonly session: GameSession;
  readonly opponent: GameSessionPlayer;
};

export type Sc2GamePollingServiceOptions = {
  readonly intervalMs: number;
  readonly idleIntervalMs?: number;
  readonly userName?: string;
};

type PollingEvents = {
  newGameDetected: [NewGameDetectedEvent];
  session: [GameSession];
  error: [unknown];
};

type ActiveGameAnchor = {
  readonly key: string;
  readonly startedAt: string;
  readonly hadFinalResult: boolean;
};

export class Sc2GamePollingService {
  private readonly events = new EventEmitter();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastActiveGameKey: string | null = null;
  private lastActiveGameResultKey: string | null = null;
  private activeAnchor: ActiveGameAnchor | null = null;
  private isPolling = false;
  private lastSessionWasActive = false;
  private userName?: string;

  constructor(
    private readonly sc2Client: Sc2ClientPort,
    private readonly options: Sc2GamePollingServiceOptions
  ) {
    this.setUserName(options.userName);
  }

  on<EventName extends keyof PollingEvents>(
    eventName: EventName,
    listener: (...args: PollingEvents[EventName]) => void
  ): this {
    this.events.on(eventName, listener as (...args: unknown[]) => void);
    return this;
  }

  off<EventName extends keyof PollingEvents>(
    eventName: EventName,
    listener: (...args: PollingEvents[EventName]) => void
  ): this {
    this.events.off(eventName, listener as (...args: unknown[]) => void);
    return this;
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    void this.pollAndSchedule();
  }

  stop(): void {
    if (!this.running && !this.timer) {
      return;
    }

    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  setUserName(userName: string | undefined): void {
    const normalizedUserName = userName?.trim();
    this.userName = normalizedUserName ? normalizedUserName : undefined;
    this.lastActiveGameKey = null;
    this.lastActiveGameResultKey = null;
    this.activeAnchor = null;
  }

  async pollOnce(): Promise<void> {
    if (this.isPolling) {
      return;
    }

    this.isPolling = true;

    try {
      const rawSession = await this.sc2Client.getCurrentGame();
      const session = this.stabilizeSession(rawSession);
      this.lastSessionWasActive = session.isActive && session.mode === "ranked-1v1";
      this.events.emit("session", session);
      this.handleSession(session);
    } catch (error) {
      this.lastSessionWasActive = false;
      this.events.emit("error", error);
    } finally {
      this.isPolling = false;
    }
  }

  private async pollAndSchedule(): Promise<void> {
    try {
      await this.pollOnce();
    } finally {
      if (!this.running) {
        return;
      }

      this.timer = setTimeout(() => {
        void this.pollAndSchedule();
      }, this.nextDelayMs());
    }
  }

  private nextDelayMs(): number {
    return this.lastSessionWasActive
      ? this.safeIntervalMs(this.options.intervalMs, 1000)
      : this.safeIntervalMs(this.options.idleIntervalMs ?? this.options.intervalMs * 4, 4000);
  }

  private safeIntervalMs(value: number, fallback: number): number {
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  private stabilizeSession(session: GameSession): GameSession {
    if (!session.isActive || session.mode !== "ranked-1v1") {
      this.activeAnchor = null;
      return session;
    }

    const activeGameKey = buildActiveGameKey(session);
    const rawStartedAt = session.startedAt;
    const detectedFinalResult = hasFinalResult(session);
    const currentAnchor = this.activeAnchor;
    const shouldStartNewAnchor =
      currentAnchor === null ||
      currentAnchor.key !== activeGameKey ||
      (!detectedFinalResult && isFreshRawStart(currentAnchor.startedAt, rawStartedAt));

    if (shouldStartNewAnchor) {
      this.activeAnchor = {
        key: activeGameKey,
        startedAt: rawStartedAt ?? session.detectedAt,
        hadFinalResult: detectedFinalResult
      };
    } else if (detectedFinalResult && !currentAnchor.hadFinalResult) {
      this.activeAnchor = {
        ...currentAnchor,
        hadFinalResult: true
      };
    }

    const activeAnchor = this.activeAnchor;
    if (!activeAnchor) {
      return session;
    }

    return {
      ...session,
      id: buildStableSessionId(session, activeAnchor.startedAt),
      startedAt: activeAnchor.startedAt
    };
  }

  private handleSession(session: GameSession): void {
    if (!session.isActive || session.mode !== "ranked-1v1") {
      this.lastActiveGameKey = null;
      this.lastActiveGameResultKey = null;
      return;
    }

    const activeGameKey = buildActiveGameKey(session);
    const activeGameResultKey = buildActiveGameResultKey(session);
    const activeGameEventKey = `${session.id}:${activeGameResultKey}`;
    const detectedFinalResult = hasFinalResult(session);

    if (this.activeAnchor?.hadFinalResult && !detectedFinalResult) {
      return;
    }

    if (activeGameKey === this.lastActiveGameKey && activeGameEventKey === this.lastActiveGameResultKey) {
      return;
    }

    const opponent = findOpponent(session, this.userName);
    if (!opponent) {
      return;
    }

    this.lastActiveGameKey = activeGameKey;
    this.lastActiveGameResultKey = activeGameEventKey;
    this.events.emit("newGameDetected", { session, opponent });
  }
}

function hasFinalResult(session: GameSession): boolean {
  return session.players.some((player) => player.result === "Victory" || player.result === "Defeat");
}

function isFreshRawStart(anchorStartedAt: string, rawStartedAt: string | undefined): boolean {
  if (!rawStartedAt) {
    return false;
  }

  const anchorMs = Date.parse(anchorStartedAt);
  const rawMs = Date.parse(rawStartedAt);

  return Number.isFinite(anchorMs) && Number.isFinite(rawMs) && Math.abs(rawMs - anchorMs) > 5000;
}

function buildActiveGameKey(session: GameSession): string {
  const playerKey = session.players
    .map((player) => `${player.name.trim().toLowerCase()}:${player.race}`)
    .sort()
    .join("|");

  return `${session.mode}:${playerKey}`;
}

function buildActiveGameResultKey(session: GameSession): string {
  return session.players
    .map((player) => `${player.name.trim().toLowerCase()}:${player.result ?? "Unknown"}:${player.mmr ?? "no-mmr"}`)
    .sort()
    .join("|");
}

function buildStableSessionId(session: GameSession, startedAt: string): string {
  const playerKey = session.players
    .map((player) => player.name.trim().toLowerCase())
    .sort()
    .join("|");

  return `${playerKey}:${startedAt}`;
}
