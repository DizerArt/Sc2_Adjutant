import { describe, expect, it } from "vitest";
import { executeCompatibility, type CompatibilityPayload } from "../../../src/compose-compat/engine.js";
import { defaultAppSettings } from "../../../src/domain/entities/app-settings.js";
import { toGameSession } from "../../../src/domain/entities/game-session.js";

function input(): CompatibilityPayload {
  return {
    records: { opponents: [], matches: [], candidates: [] },
    settings: { ...defaultAppSettings(), externalSourcesEnabled: false },
    userName: "LocalPlayer", region: "EU",
    session: toGameSession({ players: [{ name: "LocalPlayer", race: "Terran", isUser: true }, { name: "Opponent", race: "Zerg" }], isReplay: false, displayTime: 30 }, "2026-10-25T00:00:30.000Z")
  };
}

describe("compose compatibility domain adapter", () => {
  it("uses incumbent identity and avoids duplicate encounters on repeated detection", async () => {
    const payload = input();
    const first = await executeCompatibility("registerDetectedGame", payload) as { result: unknown; records: NonNullable<CompatibilityPayload["records"]> };
    expect(first.records.opponents).toHaveLength(1);
    expect(first.records.matches).toHaveLength(1);
    expect(first.records.opponents[0].encounters).toBe(1);
    const again = await executeCompatibility("registerDetectedGame", { ...payload, records: first.records }) as typeof first;
    expect(again.records.matches).toHaveLength(1);
    expect(again.records.opponents[0].encounters).toBe(1);
    expect(payload.records?.opponents).toEqual([]);
  });

  it("retains unknown imported record fields after incumbent updates", async () => {
    const payload = input();
    const first = await executeCompatibility("registerDetectedGame", payload) as { records: NonNullable<CompatibilityPayload["records"]> };
    const opponent = { ...first.records.opponents[0], futureField: { preserved: true } };
    const next = await executeCompatibility("registerDetectedGame", { ...payload, records: { ...first.records, opponents: [opponent] } }) as typeof first;
    expect(next.records.opponents[0]).toHaveProperty("futureField", { preserved: true });
  });

  it("does not report replay or team sessions as ranked matches", async () => {
    const payload = input();
    const result = await executeCompatibility("registerDetectedGame", { ...payload, session: { ...payload.session!, mode: "unsupported" } }) as { result: unknown; records: unknown };
    expect(result.result).toBeNull();
    expect(result.records).toEqual({ opponents: [], matches: [], candidates: [] });
  });

  it("rejects malformed snapshots and unsupported commands", async () => {
    await expect(executeCompatibility("inventResult", input())).rejects.toThrow("Unsupported");
    await expect(executeCompatibility("processReplay", { ...input(), records: undefined })).rejects.toThrow("Missing domain snapshot");
  });

  it("imports a replay through incumbent reconciliation and retains the winner", async () => {
    const payload = input();
    const next = await executeCompatibility("syncReplay", { ...payload, file: { path: "C:/fixtures/example.SC2Replay", modifiedAt: "2026-10-25T00:10:00.000Z" }, metadata: {
      replayPath: "C:/fixtures/example.SC2Replay", map: "Fixture map", playedAt: "2026-10-25T00:00:00.000Z", durationSeconds: 600,
      players: [{ name: "LocalPlayer", race: "Terran", result: "win" }, { name: "Opponent", race: "Zerg", result: "loss" }]
    } }) as { result: { importedCount: number; failedCount: number }; records: NonNullable<CompatibilityPayload["records"]> };
    expect(next.result.importedCount).toBe(1);
    expect(next.result.failedCount).toBe(0);
    expect(next.records.matches[0].result).toBe("win");
    expect(next.records.opponents[0].wins).toBe(1);
  });
});
