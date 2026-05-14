import type {
  OpponentDataCandidate,
  OpponentDataSourcePort,
  OpponentSearchQuery
} from "../../domain/ports/opponent-data-source-port.js";
import { ExternalSourceError } from "../../shared/errors/external-source-error.js";

export type CachedOpponentDataSourceOptions = {
  readonly successTtlMs?: number;
  readonly emptyTtlMs?: number;
  readonly failureTtlMs?: number;
  readonly failureThreshold?: number;
  readonly cooldownMs?: number;
  readonly maxEntries?: number;
  readonly clock?: () => number;
};

export type CachedOpponentDataSourceSnapshot = {
  readonly name: string;
  readonly state: "ready" | "cached" | "cooling-down";
  readonly cacheEntries: number;
  readonly consecutiveFailures: number;
  readonly cooldownUntil?: string;
  readonly lastFailureMessage?: string;
};

type CacheEntry =
  | {
      readonly status: "fulfilled";
      readonly expiresAt: number;
      readonly candidates: readonly OpponentDataCandidate[];
    }
  | {
      readonly status: "rejected";
      readonly expiresAt: number;
      readonly message: string;
    };

export class CachedOpponentDataSource implements OpponentDataSourcePort {
  readonly sourceName: string;

  private readonly successTtlMs: number;
  private readonly emptyTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly maxEntries: number;
  private readonly clock: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private consecutiveFailures = 0;
  private cooldownUntil = 0;
  private lastFailureMessage?: string;

  constructor(
    private readonly source: OpponentDataSourcePort,
    options: CachedOpponentDataSourceOptions = {}
  ) {
    this.sourceName = source.sourceName;
    this.successTtlMs = options.successTtlMs ?? 12 * 60 * 60 * 1000;
    this.emptyTtlMs = options.emptyTtlMs ?? 60 * 60 * 1000;
    this.failureTtlMs = options.failureTtlMs ?? 15 * 60 * 1000;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 30 * 60 * 1000;
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 500));
    this.clock = options.clock ?? (() => Date.now());
  }

  async searchOpponent(query: OpponentSearchQuery): Promise<readonly OpponentDataCandidate[]> {
    const now = this.clock();
    this.pruneCache(now);
    const key = cacheKeyFor(query);
    const cached = this.cache.get(key);

    if (cached && cached.expiresAt > now) {
      if (cached.status === "fulfilled") {
        return cached.candidates;
      }

      throw new ExternalSourceError(
        "OPPONENT_SOURCE_CACHED_FAILURE",
        `${this.sourceName} is temporarily unavailable: ${cached.message}`
      );
    }

    if (this.cooldownUntil > now) {
      throw new ExternalSourceError(
        "OPPONENT_SOURCE_COOLDOWN",
        `${this.sourceName} is cooling down after repeated failures.`
      );
    }

    try {
      const candidates = await this.source.searchOpponent(query);
      this.consecutiveFailures = 0;
      this.lastFailureMessage = undefined;
      this.cache.set(key, {
        status: "fulfilled",
        expiresAt: now + (candidates.length > 0 ? this.successTtlMs : this.emptyTtlMs),
        candidates
      });
      this.pruneCache(now);
      return candidates;
    } catch (error) {
      this.consecutiveFailures += 1;

      if (this.consecutiveFailures >= this.failureThreshold) {
        this.cooldownUntil = now + this.cooldownMs;
      }

      this.lastFailureMessage = error instanceof Error ? error.message : String(error);
      this.cache.set(key, {
        status: "rejected",
        expiresAt: now + this.failureTtlMs,
        message: this.lastFailureMessage
      });
      this.pruneCache(now);

      throw error;
    }
  }

  getSnapshot(): CachedOpponentDataSourceSnapshot {
    const now = this.clock();
    this.pruneCache(now);
    const activeCacheEntries = [...this.cache.values()].filter((entry) => entry.expiresAt > now).length;
    const coolingDown = this.cooldownUntil > now;

    return {
      name: this.sourceName,
      state: coolingDown ? "cooling-down" : activeCacheEntries > 0 ? "cached" : "ready",
      cacheEntries: activeCacheEntries,
      consecutiveFailures: this.consecutiveFailures,
      cooldownUntil: coolingDown ? new Date(this.cooldownUntil).toISOString() : undefined,
      lastFailureMessage: this.lastFailureMessage
    };
  }

  private pruneCache(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) {
        this.cache.delete(key);
      }
    }

    while (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }

      this.cache.delete(oldestKey);
    }
  }
}

function cacheKeyFor(query: OpponentSearchQuery): string {
  return JSON.stringify({
    nickname: query.nickname.trim().toLowerCase(),
    profileLink: query.profileLink?.trim().toLowerCase() ?? "",
    race: query.race ?? "",
    region: query.region ?? "",
    season: query.season ?? ""
  });
}
