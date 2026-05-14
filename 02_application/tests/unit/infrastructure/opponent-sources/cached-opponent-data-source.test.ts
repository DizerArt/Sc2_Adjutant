import { describe, expect, it, vi } from "vitest";
import type {
  OpponentDataCandidate,
  OpponentDataSourcePort,
  OpponentSearchQuery
} from "../../../../src/domain/ports/opponent-data-source-port.js";
import { CachedOpponentDataSource } from "../../../../src/infrastructure/opponent-sources/cached-opponent-data-source.js";

const candidate: OpponentDataCandidate = {
  source: "FakeSource",
  nickname: "Serral",
  race: "Zerg",
  aliases: [],
  confidenceScore: 0.9
};

describe("CachedOpponentDataSource", () => {
  it("caches successful results by normalized query", async () => {
    const source = new FakeSource([[candidate]]);
    const cached = new CachedOpponentDataSource(source, {
      successTtlMs: 1000,
      clock: () => 100
    });

    await expect(cached.searchOpponent({ nickname: " Serral ", race: "Zerg" })).resolves.toEqual([candidate]);
    await expect(cached.searchOpponent({ nickname: "serral", race: "Zerg" })).resolves.toEqual([candidate]);

    expect(source.searchOpponent).toHaveBeenCalledTimes(1);
    expect(cached.getSnapshot()).toMatchObject({
      name: "FakeSource",
      state: "cached",
      cacheEntries: 1,
      consecutiveFailures: 0
    });
  });

  it("uses a shorter TTL for empty responses", async () => {
    let now = 100;
    const source = new FakeSource([[], [candidate]]);
    const cached = new CachedOpponentDataSource(source, {
      emptyTtlMs: 50,
      clock: () => now
    });

    await expect(cached.searchOpponent({ nickname: "Unknown" })).resolves.toEqual([]);
    now = 120;
    await expect(cached.searchOpponent({ nickname: "unknown" })).resolves.toEqual([]);
    now = 151;
    await expect(cached.searchOpponent({ nickname: "unknown" })).resolves.toEqual([candidate]);

    expect(source.searchOpponent).toHaveBeenCalledTimes(2);
  });

  it("keeps same-nickname barcode profile lookups separate by profile link", async () => {
    const firstCandidate: OpponentDataCandidate = {
      ...candidate,
      nickname: "SuperMage",
      battleTag: "SuperMage#22387"
    };
    const secondCandidate: OpponentDataCandidate = {
      ...candidate,
      nickname: "cringeracoon",
      battleTag: "cringeracoon#2270"
    };
    const source = new FakeSource([[firstCandidate], [secondCandidate]]);
    const cached = new CachedOpponentDataSource(source, {
      successTtlMs: 1000,
      clock: () => 100
    });

    await expect(
      cached.searchOpponent({
        nickname: "llllllllllll",
        profileLink: "https://starcraft2.blizzard.com/profile/2/1/5501280",
        race: "Zerg"
      })
    ).resolves.toEqual([firstCandidate]);
    await expect(
      cached.searchOpponent({
        nickname: "llllllllllll",
        profileLink: "https://starcraft2.blizzard.com/profile/2/1/11197848",
        race: "Zerg"
      })
    ).resolves.toEqual([secondCandidate]);

    expect(source.searchOpponent).toHaveBeenCalledTimes(2);
  });

  it("evicts oldest entries when the cache reaches its size limit", async () => {
    const source = new FakeSource([[candidate], [candidate], [candidate], [candidate]]);
    const cached = new CachedOpponentDataSource(source, {
      maxEntries: 2,
      successTtlMs: 1000,
      clock: () => 100
    });

    await expect(cached.searchOpponent({ nickname: "First" })).resolves.toEqual([candidate]);
    await expect(cached.searchOpponent({ nickname: "Second" })).resolves.toEqual([candidate]);
    await expect(cached.searchOpponent({ nickname: "Third" })).resolves.toEqual([candidate]);
    await expect(cached.searchOpponent({ nickname: "First" })).resolves.toEqual([candidate]);

    expect(source.searchOpponent).toHaveBeenCalledTimes(4);
    expect(cached.getSnapshot()).toMatchObject({
      cacheEntries: 2
    });
  });

  it("caches failures briefly to avoid retry storms", async () => {
    const source = new ThrowingSource("source offline");
    const cached = new CachedOpponentDataSource(source, {
      failureTtlMs: 1000,
      clock: () => 100
    });

    await expect(cached.searchOpponent({ nickname: "Serral" })).rejects.toThrow("source offline");
    await expect(cached.searchOpponent({ nickname: "serral" })).rejects.toMatchObject({
      code: "OPPONENT_SOURCE_CACHED_FAILURE"
    });

    expect(source.searchOpponent).toHaveBeenCalledTimes(1);
  });

  it("opens a cooldown circuit after repeated source failures", async () => {
    let now = 100;
    const source = new ThrowingSource("rate limited");
    const cached = new CachedOpponentDataSource(source, {
      failureTtlMs: 0,
      failureThreshold: 2,
      cooldownMs: 1000,
      clock: () => now
    });

    await expect(cached.searchOpponent({ nickname: "First" })).rejects.toThrow("rate limited");
    await expect(cached.searchOpponent({ nickname: "Second" })).rejects.toThrow("rate limited");

    now = 150;
    await expect(cached.searchOpponent({ nickname: "Third" })).rejects.toMatchObject({
      code: "OPPONENT_SOURCE_COOLDOWN"
    });
    expect(source.searchOpponent).toHaveBeenCalledTimes(2);
    expect(cached.getSnapshot()).toMatchObject({
      state: "cooling-down",
      consecutiveFailures: 2,
      lastFailureMessage: "rate limited"
    });
  });
});

class FakeSource implements OpponentDataSourcePort {
  readonly sourceName = "FakeSource";
  readonly searchOpponent = vi.fn(async (_query: OpponentSearchQuery): Promise<readonly OpponentDataCandidate[]> => {
    return this.responses.shift() ?? [];
  });

  constructor(private readonly responses: (readonly OpponentDataCandidate[])[]) {}
}

class ThrowingSource implements OpponentDataSourcePort {
  readonly sourceName = "ThrowingSource";
  readonly searchOpponent = vi.fn(async (): Promise<readonly OpponentDataCandidate[]> => {
    throw new Error(this.message);
  });

  constructor(private readonly message: string) {}
}
