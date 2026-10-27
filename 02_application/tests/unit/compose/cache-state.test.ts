import { describe, expect, it, vi } from "vitest";
import { CachedOpponentDataSource } from "../../../src/infrastructure/opponent-sources/cached-opponent-data-source.js";
import type { OpponentDataCandidate, OpponentDataSourcePort } from "../../../src/domain/ports/opponent-data-source-port.js";
import { executeCompatibility, type CompatibilityPayload } from "../../../src/compose-compat/engine.js";

const candidate: OpponentDataCandidate = { source: "FakeSource", nickname: "Opponent", race: "Zerg", aliases: ["Alias"], confidenceScore: 0.9 };
function source() {
  return { sourceName: "FakeSource", searchOpponent: vi.fn(async () => [candidate]) };
}

describe("persisted opponent source cache", () => {
  it("hydrates fulfilled responses without fetching again and detaches exported data", async () => {
    const first = new CachedOpponentDataSource(source(), { clock: () => 100, successTtlMs: 1000 });
    await first.searchOpponent({ nickname: "Opponent", race: "Zerg" });
    const serialized = JSON.parse(JSON.stringify(first.exportState()));
    const nextSource = source();
    const next = new CachedOpponentDataSource(nextSource, { clock: () => 200, successTtlMs: 1000 });
    next.restoreState(serialized);
    serialized.entries[0].entry.candidates[0].nickname = "tampered";
    await expect(next.searchOpponent({ nickname: " opponent ", race: "Zerg" })).resolves.toEqual([candidate]);
    expect(nextSource.searchOpponent).not.toHaveBeenCalled();
    const exported = JSON.parse(JSON.stringify(next.exportState()));
    exported.entries[0].entry.candidates[0].aliases.push("tampered");
    expect(next.exportState().entries[0].entry).toMatchObject({ candidates: [candidate] });
  });

  it("persists failures and cooldown across separate cache instances", async () => {
    const failing: OpponentDataSourcePort = { sourceName: "FakeSource", searchOpponent: vi.fn(async () => { throw new Error("offline"); }) };
    const options = { clock: () => 100, failureTtlMs: 50, failureThreshold: 2, cooldownMs: 1000 };
    const first = new CachedOpponentDataSource(failing, options);
    await expect(first.searchOpponent({ nickname: "First" })).rejects.toThrow("offline");
    const second = new CachedOpponentDataSource(failing, options);
    second.restoreState(first.exportState());
    await expect(second.searchOpponent({ nickname: "First" })).rejects.toMatchObject({ code: "OPPONENT_SOURCE_CACHED_FAILURE" });
    await expect(second.searchOpponent({ nickname: "Second" })).rejects.toThrow("offline");
    const recoveredSource = source();
    const third = new CachedOpponentDataSource(recoveredSource, { ...options, clock: () => 200 });
    third.restoreState(second.exportState());
    await expect(third.searchOpponent({ nickname: "Third" })).rejects.toMatchObject({ code: "OPPONENT_SOURCE_COOLDOWN" });
    expect(recoveredSource.searchOpponent).not.toHaveBeenCalled();
    expect(third.getSnapshot()).toMatchObject({ state: "cooling-down", consecutiveFailures: 2, cacheEntries: 0 });
  });

  it("prunes expired entries and enforces the destination size limit", async () => {
    const first = new CachedOpponentDataSource(source(), { clock: () => 100, successTtlMs: 1000 });
    for (const nickname of ["First", "Second", "Third"]) await first.searchOpponent({ nickname });
    const limited = new CachedOpponentDataSource(source(), { clock: () => 200, successTtlMs: 1000, maxEntries: 1 });
    limited.restoreState(first.exportState());
    expect(limited.exportState().entries).toHaveLength(1);
    expect(limited.exportState().entries[0].key).toContain("third");
    const nextSource = source();
    const expired = new CachedOpponentDataSource(nextSource, { clock: () => 1101, successTtlMs: 1000 });
    expired.restoreState(first.exportState());
    expect(expired.exportState().entries).toHaveLength(0);
    await expired.searchOpponent({ nickname: "First" });
    expect(nextSource.searchOpponent).toHaveBeenCalledOnce();
  });

  it("rejects malformed state without replacing an existing live cache", async () => {
    const liveSource = source();
    const live = new CachedOpponentDataSource(liveSource, { clock: () => 100, successTtlMs: 1000 });
    await live.searchOpponent({ nickname: "Opponent" });
    const original = live.exportState();
    const invalid = [false, [], {}, { ...original, schema: 2 }, { ...original, sourceName: "AnotherSource" },
      { ...original, cooldownUntil: Infinity }, { ...original, consecutiveFailures: -1 },
      { ...original, entries: [{ key: "bad", entry: { status: "invented", expiresAt: 1000 } }] },
      { ...original, entries: [{ key: "bad", entry: { status: "fulfilled", expiresAt: 1000, candidates: [{}] } }] }];
    for (const value of invalid) expect(() => live.restoreState(value)).toThrow("Invalid persisted");
    expect(live.exportState()).toEqual(original);
    await live.searchOpponent({ nickname: "Opponent" });
    expect(liveSource.searchOpponent).toHaveBeenCalledOnce();
    expect(() => live.restoreState(undefined)).not.toThrow();
    expect(() => live.restoreState(null)).not.toThrow();
  });

  it("bounds restored expiry/cooldown durations to the configured policies", () => {
    const cache = new CachedOpponentDataSource(source(), { clock: () => 100, successTtlMs: 1000, cooldownMs: 500 });
    cache.restoreState({ schema: 1, sourceName: "FakeSource", consecutiveFailures: 3, cooldownUntil: 1e12,
      entries: [{ key: "fixture", entry: { status: "fulfilled", expiresAt: 1e12, candidates: [candidate] } }] });
    expect(cache.exportState().cooldownUntil).toBe(600);
    expect(cache.exportState().entries[0].entry.expiresAt).toBe(1100);
  });

  it("preserves source cache while external enrichment is disabled", async () => {
    const state = new CachedOpponentDataSource(source()).exportState();
    const payload: CompatibilityPayload = { records: { opponents: [], matches: [], candidates: [], sourceCache: state },
      settings: { externalSourcesEnabled: false }, session: { id: "unsupported", isActive: false, mode: "unsupported", players: [], detectedAt: "2026-10-25T00:00:00Z" } };
    const result = await executeCompatibility("registerDetectedGame", payload) as { records: { sourceCache: unknown } };
    expect(result.records.sourceCache).toEqual(state);
  });
});
