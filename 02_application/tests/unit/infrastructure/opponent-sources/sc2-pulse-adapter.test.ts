import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HttpJsonClient } from "../../../../src/infrastructure/http/http-json-client.js";
import { Sc2PulseAdapter } from "../../../../src/infrastructure/opponent-sources/sc2-pulse-adapter.js";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/sc2-pulse");

async function loadFixture(name: string): Promise<unknown> {
  const content = await readFile(resolve(fixturesDir, name), "utf8");
  return JSON.parse(content);
}

function buildClient(fetchImpl: typeof fetch): HttpJsonClient {
  return new HttpJsonClient({
    fetchImpl,
    timeoutMs: 1000,
    retryCount: 0,
    sleep: async () => undefined
  });
}

describe("Sc2PulseAdapter", () => {
  it("returns no candidates for an empty nickname without hitting the network", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("[]", { status: 200 }));
    const adapter = new Sc2PulseAdapter({ httpClient: buildClient(fetchImpl) });

    await expect(adapter.searchOpponent({ nickname: "   " })).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("encodes the query and hits the configured endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      expect(String(url)).toBe("https://example.test/sc2/api/characters?query=Serral%20EU");
      return new Response("[]", { status: 200 });
    });
    const adapter = new Sc2PulseAdapter({
      baseUrl: "https://example.test/sc2/api/",
      httpClient: buildClient(fetchImpl)
    });

    await adapter.searchOpponent({ nickname: "Serral EU" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps the success fixture into normalized candidates and ranks exact match first", async () => {
    const fixture = await loadFixture("character-search.success.json");
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    const adapter = new Sc2PulseAdapter({
      baseUrl: "https://example.test/sc2/api",
      httpClient: buildClient(fetchImpl)
    });

    const candidates = await adapter.searchOpponent({ nickname: "Serral", race: "Zerg" });

    expect(candidates).toHaveLength(2);

    const [first, second] = candidates;
    expect(first?.source).toBe("SC2Pulse");
    expect(first?.nickname).toBe("Serral");
    expect(first?.race).toBe("Zerg");
    expect(first?.region).toBe("EU");
    expect(first?.battleTag).toBe("Serral#2587");
    expect(first?.aliases).toEqual(["Serral#769"]);
    expect(first?.mmr).toBe(7019);
    expect(first?.league).toBe("Grandmaster");
    expect(first?.totalGames).toBe(5039);
    expect(first?.profileUrl).toBe("https://sc2pulse.nephest.com/sc2/?type=character&id=236695&m=1");
    expect(first?.confidenceScore).toBeGreaterThan(second?.confidenceScore ?? 1);
    expect(first?.confidenceScore).toBeLessThanOrEqual(1);
  });

  it("returns an empty list when the endpoint returns an empty array", async () => {
    const fixture = await loadFixture("character-search.empty.json");
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    const adapter = new Sc2PulseAdapter({
      baseUrl: "https://example.test/sc2/api",
      httpClient: buildClient(fetchImpl)
    });

    await expect(adapter.searchOpponent({ nickname: "Nobody" })).resolves.toEqual([]);
  });

  it("throws a source error on a malformed (non-array) response", async () => {
    const fixture = await loadFixture("character-search.malformed.json");
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    const adapter = new Sc2PulseAdapter({
      baseUrl: "https://example.test/sc2/api",
      httpClient: buildClient(fetchImpl)
    });

    await expect(adapter.searchOpponent({ nickname: "Serral" })).rejects.toMatchObject({
      name: "ExternalSourceError",
      code: "SC2_PULSE_INVALID_RESPONSE"
    });
  });

  it("propagates HTTP failures as ExternalSourceError without retry storms", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("rate limited", { status: 429 }));
    const adapter = new Sc2PulseAdapter({
      baseUrl: "https://example.test/sc2/api",
      httpClient: buildClient(fetchImpl)
    });

    await expect(adapter.searchOpponent({ nickname: "Serral" })).rejects.toMatchObject({
      name: "ExternalSourceError"
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("limits results to maxResults", async () => {
    const fixture = await loadFixture("character-search.success.json");
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    const adapter = new Sc2PulseAdapter({
      baseUrl: "https://example.test/sc2/api",
      httpClient: buildClient(fetchImpl),
      maxResults: 1
    });

    const candidates = await adapter.searchOpponent({ nickname: "Serral" });
    expect(candidates).toHaveLength(1);
  });

  it("skips entries without character data instead of throwing", async () => {
    const payload = [
      { leagueMax: 4, ratingMax: 4000, members: null },
      {
        leagueMax: 4,
        ratingMax: 4000,
        members: {
          character: { id: 1, region: "EU", tag: "ValidPlayer" },
          raceGames: { TERRAN: 50 }
        }
      }
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const adapter = new Sc2PulseAdapter({
      baseUrl: "https://example.test/sc2/api",
      httpClient: buildClient(fetchImpl)
    });

    const candidates = await adapter.searchOpponent({ nickname: "ValidPlayer" });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.nickname).toBe("ValidPlayer");
    expect(candidates[0]?.race).toBe("Terran");
  });

  it("extracts BattleTag for exact barcode candidates with a stable profile identifier", async () => {
    const payload = [
      {
        leagueMax: 5,
        ratingMax: 4286,
        currentStats: { rating: 4286, gamesPlayed: 4 },
        members: {
          character: { id: 5069748, region: "EU", tag: "IIIIIIIIII" },
          account: { battleTag: "HiddenBarcode#2197", tag: "HiddenBarcode" },
          raceGames: { PROTOSS: 4 }
        }
      }
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const adapter = new Sc2PulseAdapter({
      baseUrl: "https://example.test/sc2/api",
      httpClient: buildClient(fetchImpl)
    });

    const candidates = await adapter.searchOpponent({ nickname: "IIIIIIIIII", race: "Protoss", region: "EU" });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      nickname: "IIIIIIIIII",
      battleTag: "HiddenBarcode#2197",
      mmr: 4286,
      totalGames: 4,
      profileUrl: "https://sc2pulse.nephest.com/sc2/?type=character&id=5069748&m=1"
    });
  });

  it("uses the resolved pro nickname when a barcode is searched through a profile link", async () => {
    const payload = [
      {
        leagueMax: 6,
        ratingMax: 6468,
        totalGamesPlayed: 285,
        currentStats: { rating: 6566, gamesPlayed: 345 },
        members: {
          character: { id: 341260293, region: "EU", tag: "llllllllll", name: "llllllllll#21725" },
          account: { battleTag: "forte#11934", tag: "forte" },
          proNickname: "Oliveira",
          raceGames: { TERRAN: 345 }
        }
      }
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const adapter = new Sc2PulseAdapter({
      baseUrl: "https://example.test/sc2/api",
      httpClient: buildClient(fetchImpl)
    });

    const candidates = await adapter.searchOpponent({
      nickname: "battlenet:://starcraft/profile/2/11321696610171224064",
      race: "Terran",
      region: "EU"
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      nickname: "Oliveira",
      race: "Terran",
      battleTag: "forte#11934",
      aliases: ["llllllllll", "llllllllll#21725", "forte"],
      mmr: 6566,
      league: "Grandmaster",
      totalGames: 285,
      confidenceScore: 1
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.test/sc2/api/characters?query=battlenet%3A%3A%2F%2Fstarcraft%2Fprofile%2F2%2F11321696610171224064",
      expect.any(Object)
    );
  });

  it("uses a separate profileLink query ahead of the visible barcode nickname", async () => {
    const payload = [
      {
        leagueMax: 5,
        ratingMax: 4270,
        totalGamesPlayed: 20515,
        previousStats: { rating: 3872, gamesPlayed: 5 },
        members: {
          character: { id: 200, region: "EU", tag: "llllllllllll", name: "llllllllllll#7576" },
          account: { battleTag: "SuperMage#22387", tag: "SuperMage" },
          raceGames: { ZERG: 20515 }
        }
      }
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const adapter = new Sc2PulseAdapter({
      baseUrl: "https://example.test/sc2/api",
      httpClient: buildClient(fetchImpl)
    });

    const candidates = await adapter.searchOpponent({
      nickname: "llllllllllll",
      profileLink: "battlenet:://starcraft/profile/2/10220887502839873536",
      race: "Zerg",
      region: "EU"
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.test/sc2/api/characters?query=battlenet%3A%3A%2F%2Fstarcraft%2Fprofile%2F2%2F10220887502839873536",
      expect.any(Object)
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      nickname: "SuperMage",
      race: "Zerg",
      region: "EU",
      battleTag: "SuperMage#22387",
      aliases: ["llllllllllll", "llllllllllll#7576"],
      mmr: 3872,
      totalGames: 20515
    });
  });

  it("accepts SC2Pulse singleton profile-link responses for barcode lookups", async () => {
    const payload = {
      leagueMax: 5,
      ratingMax: 4270,
      totalGamesPlayed: 20515,
      previousStats: { rating: 4013, gamesPlayed: 469 },
      currentStats: { rating: 3872, gamesPlayed: 5 },
      members: {
        character: {
          id: 176014,
          realm: 1,
          region: "EU",
          tag: "llllllllllll",
          name: "llllllllllll#7576"
        },
        account: { battleTag: "SuperMage#22387", tag: "SuperMage" },
        raceGames: { ZERG: 20515 }
      }
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const adapter = new Sc2PulseAdapter({
      baseUrl: "https://example.test/sc2/api",
      httpClient: buildClient(fetchImpl)
    });

    const candidates = await adapter.searchOpponent({
      nickname: "llllllllllll",
      profileLink: "battlenet:://starcraft/profile/2/10220887502839873536",
      race: "Zerg",
      region: "EU"
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      nickname: "SuperMage",
      race: "Zerg",
      region: "EU",
      battleTag: "SuperMage#22387",
      aliases: ["llllllllllll", "llllllllllll#7576"],
      mmr: 3872,
      league: "Master",
      totalGames: 20515,
      confidenceScore: 1
    });
  });

  it("accepts Blizzard short profile links derived from replay toons", async () => {
    const payload = {
      leagueMax: 5,
      ratingMax: 4270,
      totalGamesPlayed: 20515,
      previousStats: { rating: 4013, gamesPlayed: 469 },
      currentStats: { rating: 3872, gamesPlayed: 5 },
      members: {
        character: {
          id: 176014,
          realm: 1,
          region: "EU",
          battlenetId: 5501280,
          tag: "llllllllllll",
          name: "llllllllllll#7576"
        },
        account: { battleTag: "SuperMage#22387", tag: "SuperMage" },
        raceGames: { ZERG: 20515 }
      }
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const adapter = new Sc2PulseAdapter({
      baseUrl: "https://example.test/sc2/api",
      httpClient: buildClient(fetchImpl)
    });

    const candidates = await adapter.searchOpponent({
      nickname: "llllllllllll",
      profileLink: "https://starcraft2.blizzard.com/profile/2/1/5501280",
      race: "Zerg",
      region: "EU"
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.test/sc2/api/characters?query=https%3A%2F%2Fstarcraft2.blizzard.com%2Fprofile%2F2%2F1%2F5501280",
      expect.any(Object)
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      nickname: "SuperMage",
      race: "Zerg",
      battleTag: "SuperMage#22387",
      mmr: 3872,
      totalGames: 20515
    });
  });

  it("reveals a unicode account tag from a Battle.net barcode profile link without ladder stats", async () => {
    const payload = [
      {
        leagueMax: null,
        ratingMax: null,
        totalGamesPlayed: null,
        currentStats: null,
        previousStats: null,
        members: {
          character: { id: 201, region: "EU", tag: "llllllll", name: "llllllll#912" },
          account: { battleTag: "Höllenhund#21562", tag: "Höllenhund" },
          raceGames: null
        }
      }
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const adapter = new Sc2PulseAdapter({
      baseUrl: "https://example.test/sc2/api",
      httpClient: buildClient(fetchImpl)
    });

    const candidates = await adapter.searchOpponent({
      nickname: "llllllll",
      profileLink: "battlenet:://starcraft/profile/2/17368182634978476032",
      region: "EU"
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.test/sc2/api/characters?query=battlenet%3A%3A%2F%2Fstarcraft%2Fprofile%2F2%2F17368182634978476032",
      expect.any(Object)
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      nickname: "Höllenhund",
      race: "Unknown",
      region: "EU",
      battleTag: "Höllenhund#21562",
      aliases: ["llllllll", "llllllll#912"]
    });
    expect(candidates[0]?.mmr).toBeUndefined();
    expect(candidates[0]?.confidenceScore).toBeGreaterThanOrEqual(0.6);
  });

  it("raises exact profile matches above the enrichment threshold when ratingMax or BattleTag is available", async () => {
    const payload = [
      {
        leagueMax: 5,
        ratingMax: 4629,
        currentStats: null,
        members: {
          character: { id: 42, region: "EU", tag: "aLivePS" },
          account: { battleTag: "WoongBear#31876", tag: "WoongBear" }
        }
      }
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const adapter = new Sc2PulseAdapter({
      baseUrl: "https://example.test/sc2/api",
      httpClient: buildClient(fetchImpl)
    });

    const candidates = await adapter.searchOpponent({ nickname: "aLivePS" });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      nickname: "aLivePS",
      battleTag: "WoongBear#31876",
      mmr: 4629,
      confidenceScore: 0.6
    });
  });

  it("uses previous SC2Pulse rating when current rating is missing", async () => {
    const payload = [
      {
        leagueMax: 4,
        ratingMax: null,
        currentStats: null,
        previousStats: { rating: 3875, gamesPlayed: 8 },
        members: {
          character: { id: 43, region: "EU", tag: "RecentOpponent" },
          raceGames: { TERRAN: 8 }
        }
      }
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const adapter = new Sc2PulseAdapter({
      baseUrl: "https://example.test/sc2/api",
      httpClient: buildClient(fetchImpl)
    });

    const candidates = await adapter.searchOpponent({ nickname: "RecentOpponent", race: "Terran" });

    expect(candidates[0]).toMatchObject({
      nickname: "RecentOpponent",
      mmr: 3875,
      confidenceScore: 0.95
    });
  });

  it("filters unsafe fuzzy barcode candidates to avoid false identity matches", async () => {
    const payload = [
      {
        leagueMax: 5,
        ratingMax: 4300,
        currentStats: { rating: 4300, gamesPlayed: 4 },
        members: {
          character: { id: 10, region: "EU", tag: "IIIIIIIIII" },
          account: { battleTag: "Exact#1111" },
          raceGames: { ZERG: 4 }
        }
      },
      {
        leagueMax: 5,
        ratingMax: 4400,
        currentStats: { rating: 4400, gamesPlayed: 4 },
        members: {
          character: { id: 11, region: "EU", tag: "IIIIIIIIIl" },
          account: { battleTag: "Almost#2222" },
          raceGames: { ZERG: 4 }
        }
      }
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const adapter = new Sc2PulseAdapter({
      baseUrl: "https://example.test/sc2/api",
      httpClient: buildClient(fetchImpl)
    });

    const candidates = await adapter.searchOpponent({ nickname: "IIIIIIIIII", race: "Zerg", region: "EU" });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.battleTag).toBe("Exact#1111");
  });

  it("prefers the requested server region when linked characters share the same account", async () => {
    const payload = [
      {
        leagueMax: 6,
        ratingMax: 4715,
        totalGamesPlayed: 5579,
        currentStats: { rating: 4570, gamesPlayed: 74 },
        members: {
          character: { id: 100, region: "US", tag: "Dyncommon" },
          account: { battleTag: "Dyncommon#1684", tag: "Dyncommon" },
          raceGames: { ZERG: 5579 }
        }
      },
      {
        leagueMax: 6,
        ratingMax: 4696,
        totalGamesPlayed: 600,
        currentStats: { rating: 4112, gamesPlayed: 12 },
        members: {
          character: { id: 101, region: "EU", tag: "Dyncommon" },
          account: { battleTag: "Dyncommon#1684", tag: "Dyncommon" },
          raceGames: { ZERG: 600 }
        }
      }
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const adapter = new Sc2PulseAdapter({
      baseUrl: "https://example.test/sc2/api",
      httpClient: buildClient(fetchImpl)
    });

    const candidates = await adapter.searchOpponent({ nickname: "Dyncommon", race: "Zerg", region: "EU" });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      nickname: "Dyncommon",
      region: "EU",
      mmr: 4112,
      totalGames: 600
    });
  });

  describe("character/common fallback", () => {
    function buildRoutedFetchImpl(
      handlers: Record<"search" | "common", (url: string) => Promise<Response> | Response>
    ): ReturnType<typeof vi.fn<typeof fetch>> {
      return vi.fn<typeof fetch>(async (url) => {
        const stringUrl = String(url);
        if (stringUrl.includes("/character/") && stringUrl.endsWith("/common")) {
          return handlers.common(stringUrl);
        }
        return handlers.search(stringUrl);
      });
    }

    function makeSearchPayloadWithoutMmr() {
      return [
        {
          leagueMax: null,
          ratingMax: null,
          totalGamesPlayed: null,
          currentStats: null,
          previousStats: null,
          members: {
            character: { id: 341400834, region: "EU", tag: "StayPositive" },
            account: { battleTag: "StayPositive#21505", tag: "StayPositive" }
          }
        }
      ];
    }

    function makeCommonPayload(overrides: Record<string, unknown> = {}) {
      return {
        teams: [
          {
            rating: 3878,
            wins: 16,
            losses: 36,
            ties: 0,
            lastPlayed: "2026-05-10T23:54:56Z",
            league: { type: 5, queueType: 201, teamType: 0 },
            members: [
              {
                zergGamesPlayed: 52,
                character: { id: 341400834, region: "EU", tag: "StayPositive" }
              }
            ]
          }
        ],
        ...overrides
      };
    }

    it("backfills MMR from /character/{id}/common when search returns no rating", async () => {
      const fetchImpl = buildRoutedFetchImpl({
        search: () => new Response(JSON.stringify(makeSearchPayloadWithoutMmr()), { status: 200 }),
        common: (url) => {
          expect(url).toBe("https://example.test/sc2/api/character/341400834/common");
          return new Response(JSON.stringify(makeCommonPayload()), { status: 200 });
        }
      });
      const adapter = new Sc2PulseAdapter({
        baseUrl: "https://example.test/sc2/api",
        httpClient: buildClient(fetchImpl)
      });

      const candidates = await adapter.searchOpponent({ nickname: "StayPositive", race: "Zerg", region: "EU" });

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        nickname: "StayPositive",
        battleTag: "StayPositive#21505",
        race: "Zerg",
        region: "EU",
        mmr: 3878,
        league: "Master",
        totalGames: 52
      });
      expect(candidates[0]?.confidenceScore).toBeGreaterThanOrEqual(0.9);
    });

    it("does not call /common when the search response already includes a rating", async () => {
      const search = [
        {
          leagueMax: 5,
          ratingMax: 4286,
          currentStats: { rating: 4286, gamesPlayed: 4 },
          members: {
            character: { id: 5069748, region: "EU", tag: "Active" },
            account: { battleTag: "Active#1111" },
            raceGames: { TERRAN: 4 }
          }
        }
      ];
      const fetchImpl = buildRoutedFetchImpl({
        search: () => new Response(JSON.stringify(search), { status: 200 }),
        common: () => {
          throw new Error("should not be called");
        }
      });
      const adapter = new Sc2PulseAdapter({
        baseUrl: "https://example.test/sc2/api",
        httpClient: buildClient(fetchImpl)
      });

      const candidates = await adapter.searchOpponent({ nickname: "Active" });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(candidates[0]?.mmr).toBe(4286);
    });

    it("uses the requested replay race MMR for profile-link barcode lookups with multiple 1v1 teams", async () => {
      const search = [
        {
          leagueMax: 5,
          ratingMax: 4559,
          totalGamesPlayed: 89,
          currentStats: { rating: 4669, gamesPlayed: 391 },
          members: {
            character: {
              id: 341377320,
              region: "EU",
              battlenetId: 11197848,
              tag: "llllllllllll",
              name: "llllllllllll#23179"
            },
            account: { battleTag: "cringeracoon#2270", tag: "cringeracoon" },
            raceGames: { TERRAN: 89 }
          }
        }
      ];
      const commonPayload = {
        teams: [
          {
            rating: 4669,
            wins: 131,
            losses: 139,
            league: { type: 5, queueType: 201, teamType: 0 },
            lastPlayed: "2026-05-13T05:50:04Z",
            members: [{ terranGamesPlayed: 270, raceGames: { TERRAN: 270 } }]
          },
          {
            rating: 4014,
            wins: 57,
            losses: 64,
            league: { type: 4, queueType: 201, teamType: 0 },
            lastPlayed: "2026-05-12T00:28:31Z",
            members: [{ zergGamesPlayed: 121, raceGames: { ZERG: 121 } }]
          }
        ]
      };
      const fetchImpl = buildRoutedFetchImpl({
        search: () => new Response(JSON.stringify(search), { status: 200 }),
        common: (url) => {
          expect(url).toBe("https://example.test/sc2/api/character/341377320/common");
          return new Response(JSON.stringify(commonPayload), { status: 200 });
        }
      });
      const adapter = new Sc2PulseAdapter({
        baseUrl: "https://example.test/sc2/api",
        httpClient: buildClient(fetchImpl)
      });

      const candidates = await adapter.searchOpponent({
        nickname: "llllllllllll",
        profileLink: "https://starcraft2.blizzard.com/profile/2/1/11197848",
        race: "Zerg",
        region: "EU"
      });

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(candidates[0]).toMatchObject({
        nickname: "cringeracoon",
        battleTag: "cringeracoon#2270",
        race: "Zerg",
        mmr: 4014,
        league: "Diamond",
        totalGames: 121
      });
    });

    it("skips the fallback when the top candidate has no character id", async () => {
      const payload = [
        {
          leagueMax: null,
          ratingMax: null,
          currentStats: null,
          previousStats: null,
          members: {
            character: { id: null, region: "EU", tag: "Anon" },
            account: { battleTag: "Anon#1234" }
          }
        }
      ];
      const fetchImpl = buildRoutedFetchImpl({
        search: () => new Response(JSON.stringify(payload), { status: 200 }),
        common: () => {
          throw new Error("should not be called");
        }
      });
      const adapter = new Sc2PulseAdapter({
        baseUrl: "https://example.test/sc2/api",
        httpClient: buildClient(fetchImpl)
      });

      const candidates = await adapter.searchOpponent({ nickname: "Anon" });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(candidates[0]?.mmr).toBeUndefined();
    });

    it("returns the original candidate when /common fetch fails", async () => {
      const fetchImpl = buildRoutedFetchImpl({
        search: () => new Response(JSON.stringify(makeSearchPayloadWithoutMmr()), { status: 200 }),
        common: () => new Response("boom", { status: 500 })
      });
      const adapter = new Sc2PulseAdapter({
        baseUrl: "https://example.test/sc2/api",
        httpClient: buildClient(fetchImpl)
      });

      const candidates = await adapter.searchOpponent({ nickname: "StayPositive", race: "Zerg", region: "EU" });

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        nickname: "StayPositive",
        battleTag: "StayPositive#21505"
      });
      expect(candidates[0]?.mmr).toBeUndefined();
    });

    it("returns the original candidate when /common returns no usable 1v1 team", async () => {
      const commonPayload = {
        teams: [
          {
            rating: 4500,
            wins: 10,
            losses: 5,
            league: { type: 5, queueType: 202, teamType: 0 },
            lastPlayed: "2026-05-10T23:54:56Z",
            members: [{ zergGamesPlayed: 15, character: { id: 341400834, region: "EU", tag: "StayPositive" } }]
          }
        ]
      };
      const fetchImpl = buildRoutedFetchImpl({
        search: () => new Response(JSON.stringify(makeSearchPayloadWithoutMmr()), { status: 200 }),
        common: () => new Response(JSON.stringify(commonPayload), { status: 200 })
      });
      const adapter = new Sc2PulseAdapter({
        baseUrl: "https://example.test/sc2/api",
        httpClient: buildClient(fetchImpl)
      });

      const candidates = await adapter.searchOpponent({ nickname: "StayPositive", race: "Zerg", region: "EU" });

      expect(candidates[0]?.mmr).toBeUndefined();
    });

    it("picks the most recent 1v1 team when /common returns several", async () => {
      const commonPayload = {
        teams: [
          {
            rating: 3000,
            wins: 5,
            losses: 5,
            league: { type: 4, queueType: 201, teamType: 0 },
            lastPlayed: "2025-09-10T10:00:00Z",
            members: [{ zergGamesPlayed: 10, character: { id: 341400834, region: "EU", tag: "StayPositive" } }]
          },
          {
            rating: 4100,
            wins: 20,
            losses: 30,
            league: { type: 5, queueType: 201, teamType: 0 },
            lastPlayed: "2026-05-10T23:54:56Z",
            members: [{ zergGamesPlayed: 50, character: { id: 341400834, region: "EU", tag: "StayPositive" } }]
          },
          {
            rating: 6000,
            wins: 100,
            losses: 50,
            league: { type: 6, queueType: 202, teamType: 0 },
            lastPlayed: "2026-05-09T20:00:00Z",
            members: [{ terranGamesPlayed: 150, character: { id: 341400834, region: "EU", tag: "StayPositive" } }]
          }
        ]
      };
      const fetchImpl = buildRoutedFetchImpl({
        search: () => new Response(JSON.stringify(makeSearchPayloadWithoutMmr()), { status: 200 }),
        common: () => new Response(JSON.stringify(commonPayload), { status: 200 })
      });
      const adapter = new Sc2PulseAdapter({
        baseUrl: "https://example.test/sc2/api",
        httpClient: buildClient(fetchImpl)
      });

      const candidates = await adapter.searchOpponent({ nickname: "StayPositive", race: "Zerg", region: "EU" });

      expect(candidates[0]).toMatchObject({
        mmr: 4100,
        league: "Master",
        totalGames: 50,
        race: "Zerg"
      });
    });

    it("infers race from the team member when search has no per-race counts", async () => {
      const fetchImpl = buildRoutedFetchImpl({
        search: () => new Response(JSON.stringify(makeSearchPayloadWithoutMmr()), { status: 200 }),
        common: () => new Response(JSON.stringify(makeCommonPayload()), { status: 200 })
      });
      const adapter = new Sc2PulseAdapter({
        baseUrl: "https://example.test/sc2/api",
        httpClient: buildClient(fetchImpl)
      });

      const candidates = await adapter.searchOpponent({ nickname: "StayPositive", region: "EU" });

      expect(candidates[0]?.race).toBe("Zerg");
    });
  });
});
