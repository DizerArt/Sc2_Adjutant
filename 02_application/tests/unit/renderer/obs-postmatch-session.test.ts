import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePostmatchPayload, parsePostmatchStatus, startPostmatchPolling } from "../../../src/renderer/postmatch/postmatch-session.js";
const syntheticFacts = { id: "synthetic-show", duration: 20, timeline_seconds: 17, flight_seconds: 2.4, game_seconds: 600, elapsed_gameloops: 13440, map: "Synthetic map", teams: [{ label: "Fixture A" }, { label: "Fixture B" }], events: [{ id: "loss-1", tick: 20, at: 1, team: 0, unit: "SyntheticUnit", owner_name: null, x: null, y: null }], resource_timeline: [{ tick: 20, at: 1, team: 0, minerals: null, gas: null }], story: { schema_version: 1, bounds: null, events: [], movement: { schema_version: 1, status: "unavailable", samples: [] } } };
const ready = { status: "ready", id: "synthetic-show", startedAt: 1700000000, available: true, visible: true };
afterEach(() => vi.useRealTimers());
describe("read-only shared post-match session", () => {
  it("accepts four actual FFA teams while rejecting a team index outside the roster", () => {
    const facts={...syntheticFacts,teams:Array.from({length:4},(_,i)=>({label:`Player ${i+1}`})),events:[{...syntheticFacts.events[0],team:3}],resource_timeline:[{...syntheticFacts.resource_timeline[0],team:2}]};
    for(const kind of ["fountain","battle_map","armies","heroes"] as const)expect(parsePostmatchPayload(facts,"synthetic-show",kind)?.events).toEqual(facts.events.map(event=>({...event,icon:null})));
    expect(parsePostmatchPayload({...facts,events:[{...facts.events[0],team:4}]},"synthetic-show","heroes")).toBeNull();
    expect(parsePostmatchPayload({...facts,story:{...facts.story,events:[{tick:1,at:1,team:4}]}},"synthetic-show","heroes")).toBeNull();
    expect(parsePostmatchPayload({...facts,teams:facts.teams.map(team=>({...team,label:"x".repeat(512)}))},"synthetic-show","heroes")).not.toBeNull();
    expect(parsePostmatchPayload({...facts,teams:facts.teams.map(team=>({...team,label:"x".repeat(513)}))},"synthetic-show","heroes")).toBeNull();
  });
  it("selects each animation locally and preserves unknown coordinates/resources without fabricating map bounds", () => {
    for (const kind of ["fountain", "battle_map", "armies", "heroes"] as const) {
      const parsed = parsePostmatchPayload(syntheticFacts, "synthetic-show", kind);
      expect(parsed?.animation).toBe(kind);
      expect(parsed?.resource_timeline).toEqual(syntheticFacts.resource_timeline);
      expect(parsed?.map_background).toEqual({ status: "unavailable", reason: "No local map image; schematic based on replay positions" });
      expect((parsed?.story as Record<string, unknown>).bounds).toBeNull();
    }
    expect(syntheticFacts).not.toHaveProperty("animation");
  });
  it("rejects mismatched, malformed and unbounded facts rather than starting an animation", () => {
    expect(parsePostmatchPayload(syntheticFacts, "another-show", "fountain")).toBeNull();
    for (const invalid of [{ duration: Infinity }, { teams: [] }, { story: null }, { events: [{ ...syntheticFacts.events[0], team: 3 }] }, { events: [{ ...syntheticFacts.events[0], at: -1 }] }, { events: Array(10001).fill(syntheticFacts.events[0]) }]) expect(parsePostmatchPayload({ ...syntheticFacts, ...invalid }, "synthetic-show", "heroes")).toBeNull();
    expect(parsePostmatchStatus({ ...ready, startedAt: "yesterday" })).toBeNull();
    expect(parsePostmatchStatus({ ...ready, id: undefined })).toBeNull();
  });
  it("polls small status snapshots and refetches map enrichment once on a shared-clock restart", async () => {
    vi.useFakeTimers();
    let status = { ...ready };
    const fetcher = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes("/status") ? status : syntheticFacts), { status: 200 }));
    const onPayload = vi.fn(), onEmpty = vi.fn();
    const stop = startPostmatchPolling({ kind: "armies", preview: false, fetch: fetcher as typeof fetch, onPayload, onEmpty });
    await vi.advanceTimersByTimeAsync(2250);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("/data"))).toHaveLength(1);
    expect(onPayload).toHaveBeenCalledTimes(1);
    expect(onPayload.mock.calls[0][1]).toBe(ready.startedAt);
    status = { ...status, startedAt: ready.startedAt + 30 };
    await vi.advanceTimersByTimeAsync(750);
    expect(onPayload).toHaveBeenCalledTimes(2);
    expect(onPayload.mock.calls[1][1]).toBe(ready.startedAt + 30);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("/data"))).toHaveLength(2);
    status = { ...status, visible: false };
    await vi.advanceTimersByTimeAsync(750);
    expect(onEmpty).toHaveBeenCalledWith("hidden");
    stop(); const count = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).toHaveBeenCalledTimes(count);
  });
  it("requests draft preview explicitly and starts its own clock without changing the broadcast", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1800000000000);
    const fetcher = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes("/status") ? { ...ready, visible: false } : syntheticFacts), { status: 200 }));
    const onPayload = vi.fn();
    const stop = startPostmatchPolling({ kind: "fountain", preview: true, fetch: fetcher as typeof fetch, onPayload, onEmpty: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(["/api/overlay/postmatch/status?preview=1", "/api/overlay/postmatch/data?id=synthetic-show&preview=1"]);
    expect(onPayload.mock.calls[0][1]).toBe(1800000000);
    stop();
  });
  it("aborts owned requests and ignores late responses after the frame is removed", async () => {
    vi.useFakeTimers();
    let complete!: (response: Response) => void;
    const fetcher = vi.fn((_url: unknown, options?: RequestInit) => { expect(options?.signal).toBeDefined(); return new Promise<Response>((resolve) => { complete = resolve; }); });
    const onPayload = vi.fn(), onEmpty = vi.fn();
    const stop = startPostmatchPolling({ kind: "heroes", preview: false, fetch: fetcher as typeof fetch, onPayload, onEmpty });
    const signal = fetcher.mock.calls[0][1]?.signal;
    stop(); expect(signal?.aborted).toBe(true);
    complete(new Response(JSON.stringify(ready)));
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(onPayload).not.toHaveBeenCalled(); expect(onEmpty).not.toHaveBeenCalled();
  });
});
