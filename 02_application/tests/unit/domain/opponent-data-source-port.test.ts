import { describe, expect, it } from "vitest";
import type { OpponentDataSourcePort } from "../../../src/domain/ports/opponent-data-source-port.js";

describe("OpponentDataSourcePort", () => {
  it("describes normalized opponent candidates from external sources", async () => {
    const source: OpponentDataSourcePort = {
      sourceName: "FakeSource",
      async searchOpponent() {
        return [
          {
            source: "FakeSource",
            nickname: "RobbyG",
            race: "Terran",
            aliases: [],
            mmr: 4100,
            league: "Master",
            confidenceScore: 0.75
          }
        ];
      }
    };

    const candidates = await source.searchOpponent({
      nickname: "RobbyG",
      race: "Terran",
      region: "EU"
    });

    expect(candidates[0]).toMatchObject({
      source: "FakeSource",
      nickname: "RobbyG",
      race: "Terran",
      mmr: 4100,
      confidenceScore: 0.75
    });
  });
});

