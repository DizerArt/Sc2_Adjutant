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

/** JSON state for an owned one-shot worker; the same cache policy applies after hydration. */
export type CachedOpponentDataSourceState = {
  readonly schema: 1;
  readonly sourceName: string;
  readonly entries: readonly { readonly key: string; readonly entry: CacheEntry }[];
  readonly consecutiveFailures: number;
  readonly cooldownUntil: number;
  readonly lastFailureMessage?: string;
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

  exportState(): CachedOpponentDataSourceState {
    this.pruneCache(this.clock());
    // Detach snapshots so a caller cannot mutate the live cache through a returned candidate.
    return JSON.parse(JSON.stringify({
      schema: 1,
      sourceName: this.sourceName,
      entries: [...this.cache].map(([key, entry]) => ({ key, entry })),
      consecutiveFailures: this.consecutiveFailures,
      cooldownUntil: this.cooldownUntil,
      lastFailureMessage: this.lastFailureMessage
    })) as CachedOpponentDataSourceState;
  }

  restoreState(value: unknown): void {
    if (value === undefined || value === null) return;
    const state = objectRecord(value);
    if (state.schema !== 1 || state.sourceName !== this.sourceName || !Array.isArray(state.entries)
      || state.entries.length > 10_000 || !safeCount(state.consecutiveFailures)
      || !safeTimestamp(state.cooldownUntil)
      || (state.lastFailureMessage !== undefined && typeof state.lastFailureMessage !== "string")) {
      throw new Error("Invalid persisted opponent-source cache state.");
    }
    const now = this.clock();
    const restored = new Map<string, CacheEntry>();
    const keys = new Set<string>();
    for (const item of state.entries) {
      const record = objectRecord(item);
      const entry = objectRecord(record.entry);
      if (typeof record.key !== "string" || !record.key || record.key.length > 8192
        || keys.has(record.key) || !safeTimestamp(entry.expiresAt)) {
        throw new Error("Invalid persisted opponent-source cache entry.");
      }
      keys.add(record.key);
      let next: CacheEntry;
      if (entry.status === "fulfilled") {
        if (!Array.isArray(entry.candidates) || entry.candidates.length > 10_000
          || !entry.candidates.every(isCandidate)) throw new Error("Invalid persisted opponent-source candidates.");
        const ttl = entry.candidates.length > 0 ? this.successTtlMs : this.emptyTtlMs;
        next = {
          status: "fulfilled", expiresAt: Math.min(entry.expiresAt as number, now + ttl),
          candidates: JSON.parse(JSON.stringify(entry.candidates)) as OpponentDataCandidate[]
        };
      } else if (entry.status === "rejected" && typeof entry.message === "string") {
        next = { status: "rejected", expiresAt: Math.min(entry.expiresAt as number, now + this.failureTtlMs), message: entry.message.slice(0, 2048) };
      } else {
        throw new Error("Invalid persisted opponent-source cache status.");
      }
      if (next.expiresAt > now) restored.set(record.key, next);
    }
    // Validate the complete snapshot before mutating a live instance.
    this.cache.clear();
    for (const [key, entry] of restored) this.cache.set(key, entry);
    this.consecutiveFailures = state.consecutiveFailures as number;
    this.cooldownUntil = Math.min(state.cooldownUntil as number, now + this.cooldownMs);
    this.lastFailureMessage = (state.lastFailureMessage as string | undefined)?.slice(0, 2048);
    this.pruneCache(now);
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

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid persisted opponent-source cache object.");
  return value as Record<string, unknown>;
}

function safeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

function isCandidate(value: unknown): value is OpponentDataCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.source !== "string" || typeof candidate.nickname !== "string"
    || !["Terran", "Zerg", "Protoss", "Random", "Unknown"].includes(candidate.race as string)
    || !Array.isArray(candidate.aliases) || !candidate.aliases.every((alias) => typeof alias === "string")
    || typeof candidate.confidenceScore !== "number" || !Number.isFinite(candidate.confidenceScore)
    || candidate.confidenceScore < 0 || candidate.confidenceScore > 1) return false;
  for (const key of ["mmr", "totalGames", "wins", "losses"]) {
    if (candidate[key] !== undefined && (typeof candidate[key] !== "number" || !Number.isFinite(candidate[key]))) return false;
  }
  for (const key of ["battleTag", "league", "lastPlayedAt", "profileUrl"]) {
    if (candidate[key] !== undefined && typeof candidate[key] !== "string") return false;
  }
  return candidate.region === undefined || ["US", "EU", "KR", "CN", "Unknown"].includes(candidate.region as string);
}

function cacheKeyFor(query: OpponentSearchQuery): string {
  return JSON.stringify({
    nickname: query.nickname.trim().toLowerCase(),
    battleTag: query.battleTag?.trim().toLowerCase() ?? "",
    profileLink: query.profileLink?.trim().toLowerCase() ?? "",
    race: query.race ?? "",
    region: query.region ?? "",
    season: query.season ?? "",
    observedMmr: query.observedMmr ?? ""
  });
}
