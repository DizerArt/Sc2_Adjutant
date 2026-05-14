import { describe, expect, it } from "vitest";
import { OpponentEnrichmentService } from "../../../src/application/services/opponent-enrichment-service.js";
import { createOpponent } from "../../../src/domain/entities/opponent.js";
import type {
  OpponentDataCandidate,
  OpponentDataSourcePort,
  OpponentSearchQuery
} from "../../../src/domain/ports/opponent-data-source-port.js";

describe("OpponentEnrichmentService", () => {
  it("enriches opponent with the best candidate by confidence score", async () => {
    const opponent = createOpponent({
      id: "opponent_robbyg-terran",
      nickname: "RobbyG",
      race: "Terran",
      now: "2026-05-03T03:00:00.000Z"
    });

    const service = new OpponentEnrichmentService(
      [
        new FakeSource("LowConfidence", [
          candidate({ source: "LowConfidence", nickname: "RobbyG", confidenceScore: 0.55, mmr: 3700 })
        ]),
        new FakeSource("HighConfidence", [
          candidate({
            source: "HighConfidence",
            nickname: "RobbyG",
            confidenceScore: 0.92,
            mmr: 4200,
            league: "Master",
            totalGames: 5039,
            aliases: ["Robby"],
            profileUrl: "https://example.test/robbyg"
          })
        ])
      ],
      {
        clock: () => "2026-05-03T03:10:00.000Z"
      }
    );

    const result = await service.enrich(opponent);

    expect(result.bestCandidate?.source).toBe("HighConfidence");
    expect(result.opponent).toMatchObject({
      nickname: "RobbyG",
      race: "Terran",
      mmrAtLastMatch: 4200,
      league: "Master",
      aliases: ["Robby"],
      confidenceScore: 0.92,
      updatedAt: "2026-05-03T03:10:00.000Z"
    });
    expect(result.opponent.raceProfiles?.Terran?.totalGamesAtLastMatch).toBe(5039);
  });

  it("keeps the original opponent when candidates are below threshold", async () => {
    const opponent = createOpponent({
      id: "opponent_unknown",
      nickname: "Unknown",
      race: "Protoss",
      now: "2026-05-03T03:00:00.000Z"
    });

    const service = new OpponentEnrichmentService(
      [new FakeSource("WeakSource", [candidate({ source: "WeakSource", confidenceScore: 0.2 })])],
      { minConfidenceScore: 0.5 }
    );

    const result = await service.enrich(opponent);

    expect(result.bestCandidate).toBeNull();
    expect(result.opponent).toEqual(opponent);
  });

  it("returns warnings for failed sources while using successful candidates", async () => {
    const opponent = createOpponent({
      id: "opponent_robbyg-terran",
      nickname: "RobbyG",
      race: "Terran",
      now: "2026-05-03T03:00:00.000Z"
    });

    const service = new OpponentEnrichmentService([
      new ThrowingSource("BrokenSource"),
      new FakeSource("GoodSource", [candidate({ source: "GoodSource", confidenceScore: 0.8, mmr: 4100 })])
    ]);

    const result = await service.enrich(opponent);

    expect(result.warnings).toEqual([
      {
        source: "BrokenSource",
        message: "source unavailable"
      }
    ]);
    expect(result.opponent.mmrAtLastMatch).toBe(4100);
  });

  it("does not overwrite locally observed race or match record from external sources", async () => {
    const opponent = {
      ...createOpponent({
        id: "opponent_wanabemaxpax-zerg",
        nickname: "WanaBeMaxPax",
        race: "Zerg",
        now: "2026-05-03T16:50:00.000Z"
      }),
      encounters: 1,
      wins: 1,
      losses: 0,
      lastMatchDate: "2026-05-03T16:54:14.335Z"
    };

    const service = new OpponentEnrichmentService(
      [
        new FakeSource("ExternalProfile", [
          candidate({
            source: "ExternalProfile",
            nickname: "WanaBeMaxPax",
            race: "Protoss",
            confidenceScore: 0.95,
            mmr: 4873,
            league: "Grandmaster",
            wins: 110,
            losses: 74,
            lastPlayedAt: "2026-05-01T10:00:00.000Z"
          })
        ])
      ],
      {
        clock: () => "2026-05-03T17:00:00.000Z"
      }
    );

    const result = await service.enrich(opponent);

    expect(result.opponent).toMatchObject({
      race: "Zerg",
      wins: 1,
      losses: 0,
      lastMatchDate: "2026-05-03T16:54:14.335Z",
      mmrAtLastMatch: 4873,
      league: "Grandmaster"
    });
  });

  it("keeps the locally observed SC2 name as an alias when enrichment renames the profile", async () => {
    const opponent = createOpponent({
      id: "opponent_caitultedjfk",
      nickname: "CaitUltedJFK",
      race: "Terran",
      now: "2026-05-03T18:00:00.000Z"
    });

    const service = new OpponentEnrichmentService(
      [
        new FakeSource("ExternalProfile", [
          candidate({
            source: "ExternalProfile",
            nickname: "RenamedProfile",
            race: "Terran",
            confidenceScore: 0.95,
            aliases: ["KnownAlias"]
          })
        ])
      ],
      {
        clock: () => "2026-05-03T18:05:00.000Z"
      }
    );

    const result = await service.enrich(opponent);

    expect(result.opponent.nickname).toBe("RenamedProfile");
    expect(result.opponent.aliases).toEqual(["CaitUltedJFK", "KnownAlias"]);
  });

  it("attributes the candidate's MMR to the match race rather than the candidate's dominant race", async () => {
    // Regression: SC2Pulse's distinct-character endpoint returns one entry per
    // character with a `dominantRace`. If the user plays a multi-race
    // opponent, every match wrote the MMR into the dominant-race slot, so the
    // race tab the user actually played on stayed on "Unknown" forever.
    const opponent = createOpponent({
      id: "opponent_multirace",
      nickname: "MultiRacer",
      race: "Terran",
      now: "2026-05-03T03:00:00.000Z"
    });

    const service = new OpponentEnrichmentService(
      [
        new FakeSource("SC2Pulse", [
          candidate({
            source: "SC2Pulse",
            nickname: "MultiRacer",
            race: "Zerg",
            confidenceScore: 0.92,
            mmr: 4400,
            league: "Master"
          })
        ])
      ],
      { clock: () => "2026-05-03T03:10:00.000Z" }
    );

    const result = await service.enrich(opponent, { race: "Terran" });

    expect(result.opponent.raceProfiles?.Terran?.mmrAtLastMatch).toBe(4400);
    expect(result.opponent.raceProfiles?.Terran?.league).toBe("Master");
    expect(result.opponent.raceProfiles?.Zerg?.mmrAtLastMatch).toBeUndefined();
  });

  it("attributes a random-profile candidate to the observed match race", async () => {
    const opponent = createOpponent({
      id: "opponent_random",
      nickname: "RandomMain",
      race: "Zerg",
      now: "2026-05-03T00:00:00.000Z"
    });
    const service = new OpponentEnrichmentService(
      [
        new FakeSource("SC2Pulse", [
          candidate({
            source: "SC2Pulse",
            nickname: "RandomMain",
            race: "Random",
            mmr: 4400,
            league: "Master",
            confidenceScore: 0.9
          })
        ])
      ],
      {
        clock: () => "2026-05-03T00:05:00.000Z"
      }
    );

    const result = await service.enrich(opponent, { race: "Zerg" });

    expect(result.opponent.race).toBe("Zerg");
    expect(result.opponent.raceProfiles?.Zerg?.mmrAtLastMatch).toBe(4400);
    expect(result.opponent.raceProfiles?.Random?.mmrAtLastMatch).toBeUndefined();
  });

  it("rejects candidates that match the configured local player identity", async () => {
    const opponent = createOpponent({
      id: "opponent_neo",
      nickname: "Neo",
      race: "Protoss",
      now: "2026-05-03T18:00:00.000Z"
    });

    const service = new OpponentEnrichmentService([
      new FakeSource("ExternalProfile", [
        candidate({
          source: "ExternalProfile",
          nickname: "RetorieS",
          battleTag: "RetorieS#2321",
          confidenceScore: 0.99,
          mmr: 4577
        }),
        candidate({
          source: "ExternalProfile",
          nickname: "Neo",
          confidenceScore: 0.72,
          mmr: 4200
        })
      ])
    ]);

    const result = await service.enrich(opponent, {
      excludedNicknames: ["RetorieS"]
    });

    expect(result.bestCandidate?.nickname).toBe("Neo");
    expect(result.opponent.nickname).toBe("Neo");
    expect(result.opponent.mmrAtLastMatch).toBe(4200);
    expect(result.candidates.map((candidate) => candidate.nickname)).toEqual(["Neo"]);
  });

  it("can limit enrichment to explicitly allowed sources", async () => {
    const opponent = createOpponent({
      id: "opponent_barcode",
      nickname: "||||||||",
      race: "Terran",
      now: "2026-05-03T18:00:00.000Z"
    });
    const sourceCalls: string[] = [];
    const service = new OpponentEnrichmentService([
      new FakeSource("SC2Pulse", [candidate({ source: "SC2Pulse", nickname: "Wrong", confidenceScore: 0.99 })], sourceCalls),
      new FakeSource(
        "TrustedBarcodeSource",
        [candidate({ source: "TrustedBarcodeSource", nickname: "ResolvedBarcode", confidenceScore: 0.92 })],
        sourceCalls
      )
    ]);

    const result = await service.enrich(opponent, {
      allowedSourceNames: ["TrustedBarcodeSource"]
    });

    expect(sourceCalls).toEqual(["TrustedBarcodeSource"]);
    expect(result.bestCandidate?.source).toBe("TrustedBarcodeSource");
    expect(result.opponent.nickname).toBe("||||||||");
    expect(result.opponent.revealedNickname).toBe("ResolvedBarcode");
  });
});

function candidate(overrides: Partial<OpponentDataCandidate>): OpponentDataCandidate {
  return {
    source: "FakeSource",
    nickname: "RobbyG",
    race: "Terran",
    aliases: [],
    confidenceScore: 0.75,
    ...overrides
  };
}

class FakeSource implements OpponentDataSourcePort {
  constructor(
    readonly sourceName: string,
    private readonly candidates: readonly OpponentDataCandidate[],
    private readonly callLog?: string[]
  ) {}

  async searchOpponent(_query: OpponentSearchQuery): Promise<readonly OpponentDataCandidate[]> {
    this.callLog?.push(this.sourceName);
    return this.candidates;
  }
}

class ThrowingSource implements OpponentDataSourcePort {
  constructor(readonly sourceName: string) {}

  async searchOpponent(): Promise<readonly OpponentDataCandidate[]> {
    throw new Error("source unavailable");
  }
}
