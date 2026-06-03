import { describe, expect, it } from "vitest";
import { SyncReplayArchive } from "../../../src/application/use-cases/sync-replay-archive.js";
import { OpponentEnrichmentService } from "../../../src/application/services/opponent-enrichment-service.js";
import { createMatch, type Match, type ReplayMetadata } from "../../../src/domain/entities/match.js";
import { createOpponent, type Opponent } from "../../../src/domain/entities/opponent.js";
import type {
  OpponentDataCandidate,
  OpponentDataSourcePort,
  OpponentSearchQuery
} from "../../../src/domain/ports/opponent-data-source-port.js";
import type { ReplayFileScannerPort } from "../../../src/domain/ports/replay-file-scanner-port.js";
import type { ReplayFile, ReplayMetadataReaderPort } from "../../../src/domain/ports/replay-metadata-reader-port.js";
import type { MatchRepository } from "../../../src/domain/repositories/match-repository.js";
import type { OpponentRepository } from "../../../src/domain/repositories/opponent-repository.js";
import type { EntityId } from "../../../src/domain/value-objects/entity-id.js";

describe("SyncReplayArchive", () => {
  it("imports newest 1v1 replays that include the configured user", async () => {
    const scanner = new FakeReplayScanner([
      replayFile("A:\\replays\\old.SC2Replay", "2026-05-01T10:00:00.000Z"),
      replayFile("A:\\replays\\new.SC2Replay", "2026-05-02T10:00:00.000Z"),
      replayFile("A:\\replays\\team.SC2Replay", "2026-05-03T10:00:00.000Z"),
      replayFile("A:\\replays\\foreign.SC2Replay", "2026-05-04T10:00:00.000Z")
    ]);
    const reader = new FakeReplayMetadataReader({
      "A:\\replays\\new.SC2Replay": metadata("A:\\replays\\new.SC2Replay", "ZergKnight", "2026-05-02T10:00:00.000Z"),
      "A:\\replays\\old.SC2Replay": metadata("A:\\replays\\old.SC2Replay", "Marine", "2026-05-01T10:00:00.000Z"),
      "A:\\replays\\team.SC2Replay": {
        ...metadata("A:\\replays\\team.SC2Replay", "TeamOpponent", "2026-05-03T10:00:00.000Z"),
        players: [
          { name: "RetorieS", race: "Terran", result: "win" },
          { name: "TeamOpponent", race: "Protoss", result: "loss" },
          { name: "Ally", race: "Zerg" }
        ]
      },
      "A:\\replays\\foreign.SC2Replay": {
        ...metadata("A:\\replays\\foreign.SC2Replay", "Other", "2026-05-04T10:00:00.000Z"),
        players: [
          { name: "OtherUser", race: "Terran", result: "win" },
          { name: "Other", race: "Protoss", result: "loss" }
        ]
      }
    });
    const matchRepository = new InMemoryMatchRepository([]);
    const opponentRepository = new InMemoryOpponentRepository([]);

    const result = await new SyncReplayArchive({
      replayFileScanner: scanner,
      replayMetadataReader: reader,
      matchRepository,
      opponentRepository,
      clock: () => "2026-05-05T00:00:00.000Z"
    }).execute({
      directory: "A:\\replays",
      userName: "RetorieS",
      mode: "full"
    });

    expect(result).toMatchObject({
      scannedCount: 4,
      inspectedCount: 4,
      importedCount: 2,
      skippedUnsupportedCount: 2
    });
    await expect(matchRepository.findAll()).resolves.toHaveLength(2);
    await expect(opponentRepository.findAll()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nickname: "ZergKnight", encounters: 1 }),
        expect.objectContaining({ nickname: "Marine", encounters: 1 })
      ])
    );
  });

  it("partial sync inspects only the latest requested replay files", async () => {
    const scanner = new FakeReplayScanner([
      replayFile("A:\\replays\\first.SC2Replay", "2026-05-01T10:00:00.000Z"),
      replayFile("A:\\replays\\second.SC2Replay", "2026-05-02T10:00:00.000Z"),
      replayFile("A:\\replays\\third.SC2Replay", "2026-05-03T10:00:00.000Z")
    ]);
    const reader = new FakeReplayMetadataReader({
      "A:\\replays\\second.SC2Replay": metadata("A:\\replays\\second.SC2Replay", "Second", "2026-05-02T10:00:00.000Z"),
      "A:\\replays\\third.SC2Replay": metadata("A:\\replays\\third.SC2Replay", "Third", "2026-05-03T10:00:00.000Z")
    });
    const matchRepository = new InMemoryMatchRepository([]);

    const result = await new SyncReplayArchive({
      replayFileScanner: scanner,
      replayMetadataReader: reader,
      matchRepository,
      opponentRepository: new InMemoryOpponentRepository([])
    }).execute({
      directory: "A:\\replays",
      userName: "RetorieS",
      mode: "partial",
      limit: 2
    });

    expect(result.inspectedCount).toBe(2);
    expect(reader.readPaths).toEqual([
      "A:\\replays\\third.SC2Replay",
      "A:\\replays\\second.SC2Replay"
    ]);
    await expect(matchRepository.findAll()).resolves.toHaveLength(2);
  });

  it("skips matches that already have the same replay path", async () => {
    const existing = createMatch({
      id: "match_existing",
      opponentId: "opponent_existing",
      playedAt: "2026-05-01T10:00:00.000Z",
      playerRace: "Terran",
      opponentRace: "Zerg",
      result: "win",
      replayPath: "A:\\replays\\known.SC2Replay",
      now: "2026-05-01T10:00:00.000Z"
    });
    const matchRepository = new InMemoryMatchRepository([existing]);

    const result = await new SyncReplayArchive({
      replayFileScanner: new FakeReplayScanner([
        replayFile("A:\\replays\\known.SC2Replay", "2026-05-01T10:00:00.000Z")
      ]),
      replayMetadataReader: new FakeReplayMetadataReader({
        "A:\\replays\\known.SC2Replay": metadata("A:\\replays\\known.SC2Replay", "Known", "2026-05-01T10:00:00.000Z")
      }),
      matchRepository,
      opponentRepository: new InMemoryOpponentRepository([])
    }).execute({
      directory: "A:\\replays",
      userName: "RetorieS",
      mode: "full"
    });

    expect(result.skippedExistingCount).toBe(1);
    await expect(matchRepository.findAll()).resolves.toHaveLength(1);
  });

  it("reconciles an already imported barcode replay through its Battle.net profile link", async () => {
    const opponent = {
      ...createOpponent({
        id: "opponent_existing_barcode",
        nickname: "llllllllllll",
        race: "Zerg",
        battleTag: "Wrong#1111",
        mmrAtLastMatch: 4179,
        league: "Master",
        now: "2026-05-11T00:12:00.000Z"
      }),
      revealedNickname: "Wrong",
      raceProfiles: {
        Zerg: {
          mmrAtLastMatch: 4179,
          league: "Master",
          updatedAt: "2026-05-11T00:12:00.000Z"
        }
      }
    };
    const existing = createMatch({
      id: "match_existing_barcode",
      opponentId: opponent.id,
      playedAt: "2026-05-11T00:12:00.000Z",
      playerRace: "Terran",
      opponentRace: "Zerg",
      result: "win",
      replayPath: "A:\\replays\\barcode.SC2Replay",
      now: "2026-05-11T00:12:00.000Z"
    });
    const matchRepository = new InMemoryMatchRepository([existing]);
    const opponentRepository = new InMemoryOpponentRepository([opponent]);
    const source = new FakeSource("SC2Pulse", [
      {
        source: "SC2Pulse",
        nickname: "SuperMage",
        race: "Zerg",
        region: "EU",
        battleTag: "SuperMage#22387",
        aliases: ["llllllllllll", "llllllllllll#7576"],
        mmr: 3872,
        league: "Master",
        totalGames: 20515,
        confidenceScore: 1
      }
    ]);

    const result = await new SyncReplayArchive({
      replayFileScanner: new FakeReplayScanner([
        replayFile("A:\\replays\\barcode.SC2Replay", "2026-05-11T00:12:00.000Z")
      ]),
      replayMetadataReader: new FakeReplayMetadataReader({
        "A:\\replays\\barcode.SC2Replay": {
          replayPath: "A:\\replays\\barcode.SC2Replay",
          playedAt: "2026-05-11T00:12:00.000Z",
          map: "Ruby Rock LE",
          result: "win",
          durationSeconds: 298,
          players: [
            { name: "RetorieS", race: "Terran", result: "win", toon: "2-S2-1-100" },
            { name: "llllllllllll", race: "Zerg", result: "loss", toon: "2-S2-1-5501280" }
          ]
        }
      }),
      matchRepository,
      opponentRepository,
      enrichmentService: new OpponentEnrichmentService([source]),
      clock: () => "2026-05-11T00:20:00.000Z"
    }).execute({
      directory: "A:\\replays",
      userName: "RetorieS",
      mode: "full",
      region: "EU"
    });

    const opponents = await opponentRepository.findAll();

    expect(result).toMatchObject({
      importedCount: 0,
      linkedCount: 0,
      skippedExistingCount: 1
    });
    expect(source.queries).toMatchObject([
      {
        nickname: "llllllllllll",
        profileLink: "https://starcraft2.blizzard.com/profile/2/1/5501280",
        race: "Zerg",
        region: "EU"
      }
    ]);
    expect(opponents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "opponent_https-starcraft2-blizzard-com-profile-2-1-5501280",
          nickname: "llllllllllll",
          revealedNickname: "SuperMage",
          battleTag: "SuperMage#22387",
          mmrAtLastMatch: 3872,
          league: "Master"
        })
      ])
    );
  });

  it("reconciles an already imported normal replay through its Battle.net profile link", async () => {
    const wrongOpponent = createOpponent({
      id: "opponent_showtime",
      nickname: "Showtime",
      race: "Protoss",
      battleTag: "ShoWTimE#2619",
      mmrAtLastMatch: 5824,
      now: "2026-05-27T20:12:00.000Z"
    });
    const existing = createMatch({
      id: "match_existing_showtime",
      opponentId: wrongOpponent.id,
      playedAt: "2026-05-27T20:12:00.000Z",
      playerRace: "Terran",
      opponentRace: "Zerg",
      result: "loss",
      replayPath: "A:\\replays\\showtime.SC2Replay",
      now: "2026-05-27T20:12:00.000Z"
    });
    const matchRepository = new InMemoryMatchRepository([existing]);
    const opponentRepository = new InMemoryOpponentRepository([wrongOpponent]);
    const source = new FakeSource("SC2Pulse", [
      {
        source: "SC2Pulse",
        nickname: "Showtime",
        race: "Zerg",
        region: "EU",
        battleTag: "Showtime#9999",
        aliases: [],
        profileUrl: "https://starcraft2.blizzard.com/profile/2/1/7777777",
        mmr: 3929,
        league: "Diamond",
        totalGames: 873,
        confidenceScore: 1
      }
    ]);

    await new SyncReplayArchive({
      replayFileScanner: new FakeReplayScanner([
        replayFile("A:\\replays\\showtime.SC2Replay", "2026-05-27T20:12:00.000Z")
      ]),
      replayMetadataReader: new FakeReplayMetadataReader({
        "A:\\replays\\showtime.SC2Replay": {
          replayPath: "A:\\replays\\showtime.SC2Replay",
          playedAt: "2026-05-27T20:12:00.000Z",
          map: "Celestial Enclave LE",
          result: "loss",
          durationSeconds: 711,
          players: [
            { name: "RetorieS", race: "Terran", result: "loss", toon: "2-S2-1-100" },
            { name: "Showtime", race: "Zerg", result: "win", toon: "2-S2-1-7777777" }
          ]
        }
      }),
      matchRepository,
      opponentRepository,
      enrichmentService: new OpponentEnrichmentService([source]),
      clock: () => "2026-05-27T20:20:00.000Z"
    }).execute({
      directory: "A:\\replays",
      userName: "RetorieS",
      mode: "full",
      region: "EU"
    });

    const matches = await matchRepository.findAll();
    const opponents = await opponentRepository.findAll();

    expect(source.queries).toMatchObject([
      {
        nickname: "Showtime",
        profileLink: "https://starcraft2.blizzard.com/profile/2/1/7777777",
        race: "Zerg",
        region: "EU"
      }
    ]);
    expect(matches[0]).toMatchObject({
      opponentId: "opponent_https-starcraft2-blizzard-com-profile-2-1-7777777",
      opponentRace: "Zerg"
    });
    expect(opponents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "opponent_https-starcraft2-blizzard-com-profile-2-1-7777777",
          nickname: "Showtime",
          battleTag: "Showtime#9999",
          mmrAtLastMatch: 3929
        })
      ])
    );
    expect(opponents.some((opponent) => opponent.id === "opponent_showtime")).toBe(false);
  });

  it("moves an already linked barcode replay back to the opponent id derived from its own profile link", async () => {
    const wrongOpponent = {
      ...createOpponent({
        id: "opponent_https-starcraft2-blizzard-com-profile-2-1-5501280",
        nickname: "llllllllllll",
        race: "Zerg",
        battleTag: "SuperMage#22387",
        now: "2026-05-11T00:12:00.000Z"
      }),
      revealedNickname: "SuperMage",
      encounters: 1,
      wins: 1,
      lastMatchDate: "2026-05-11T00:12:00.000Z"
    };
    const existing = createMatch({
      id: "match_existing_barcode_wrong_opponent",
      opponentId: wrongOpponent.id,
      playedAt: "2026-05-11T00:30:00.000Z",
      playerRace: "Terran",
      opponentRace: "Zerg",
      result: "win",
      replayPath: "A:\\replays\\cringeracoon.SC2Replay",
      now: "2026-05-11T00:30:00.000Z"
    });
    const matchRepository = new InMemoryMatchRepository([existing]);
    const opponentRepository = new InMemoryOpponentRepository([wrongOpponent]);
    const source = new FakeSource("SC2Pulse", [
      {
        source: "SC2Pulse",
        nickname: "cringeracoon",
        race: "Zerg",
        region: "EU",
        battleTag: "cringeracoon#2270",
        aliases: ["llllllllllll"],
        mmr: 4669,
        league: "Master",
        totalGames: 1234,
        confidenceScore: 1
      }
    ]);

    await new SyncReplayArchive({
      replayFileScanner: new FakeReplayScanner([
        replayFile("A:\\replays\\cringeracoon.SC2Replay", "2026-05-11T00:30:00.000Z")
      ]),
      replayMetadataReader: new FakeReplayMetadataReader({
        "A:\\replays\\cringeracoon.SC2Replay": {
          replayPath: "A:\\replays\\cringeracoon.SC2Replay",
          playedAt: "2026-05-11T00:30:00.000Z",
          map: "Ruby Rock LE",
          result: "win",
          durationSeconds: 298,
          players: [
            { name: "RetorieS", race: "Terran", result: "win", toon: "2-S2-1-100" },
            { name: "llllllllllll", race: "Zerg", result: "loss", toon: "2-S2-1-11197848" }
          ]
        }
      }),
      matchRepository,
      opponentRepository,
      enrichmentService: new OpponentEnrichmentService([source]),
      clock: () => "2026-05-11T00:40:00.000Z"
    }).execute({
      directory: "A:\\replays",
      userName: "RetorieS",
      mode: "full",
      region: "EU"
    });

    const matches = await matchRepository.findAll();
    const opponents = await opponentRepository.findAll();

    expect(matches[0]).toMatchObject({
      opponentId: "opponent_https-starcraft2-blizzard-com-profile-2-1-11197848"
    });
    expect(opponents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "opponent_https-starcraft2-blizzard-com-profile-2-1-11197848",
          nickname: "llllllllllll",
          revealedNickname: "cringeracoon",
          battleTag: "cringeracoon#2270",
          mmrAtLastMatch: 4669,
          encounters: 1,
          wins: 1
        }),
        expect.objectContaining({
          id: "opponent_https-starcraft2-blizzard-com-profile-2-1-5501280",
          battleTag: "SuperMage#22387",
          encounters: 0,
          wins: 0
        })
      ])
    );
  });

  it("links a replay to an existing replayless live match instead of creating a duplicate", async () => {
    const opponent = createOpponent({
      id: "opponent_zergknight",
      nickname: "ZergKnight",
      race: "Zerg",
      now: "2026-05-01T10:00:00.000Z"
    });
    const match = createMatch({
      id: "match_live",
      opponentId: opponent.id,
      playedAt: "2026-05-01T10:03:00.000Z",
      playerRace: "Terran",
      opponentRace: "Zerg",
      result: "unknown",
      now: "2026-05-01T10:03:00.000Z"
    });
    const matchRepository = new InMemoryMatchRepository([match]);
    const opponentRepository = new InMemoryOpponentRepository([{ ...opponent, encounters: 1 }]);

    const result = await new SyncReplayArchive({
      replayFileScanner: new FakeReplayScanner([
        replayFile("A:\\replays\\linked.SC2Replay", "2026-05-01T10:04:00.000Z")
      ]),
      replayMetadataReader: new FakeReplayMetadataReader({
        "A:\\replays\\linked.SC2Replay": metadata("A:\\replays\\linked.SC2Replay", "ZergKnight", "2026-05-01T10:04:00.000Z")
      }),
      matchRepository,
      opponentRepository,
      clock: () => "2026-05-01T10:05:00.000Z"
    }).execute({
      directory: "A:\\replays",
      userName: "RetorieS",
      mode: "full"
    });

    expect(result).toMatchObject({
      importedCount: 0,
      linkedCount: 1
    });
    await expect(matchRepository.findAll()).resolves.toEqual([
      expect.objectContaining({
        id: "match_live",
        replayPath: "A:\\replays\\linked.SC2Replay",
        result: "win",
        playerRace: "Terran",
        opponentRace: "Zerg"
      })
    ]);
  });

  it("repairs unknown races when replay sync links an existing live match", async () => {
    const opponent = createOpponent({
      id: "opponent_numberone",
      nickname: "NumberOne",
      race: "Unknown",
      now: "2026-05-17T03:35:00.000Z"
    });
    const match = createMatch({
      id: "match_live_unknown_race",
      opponentId: opponent.id,
      playedAt: "2026-05-17T03:34:00.000Z",
      playerRace: "Unknown",
      opponentRace: "Unknown",
      result: "unknown",
      now: "2026-05-17T03:34:00.000Z"
    });
    const matchRepository = new InMemoryMatchRepository([match]);
    const opponentRepository = new InMemoryOpponentRepository([{ ...opponent, encounters: 1 }]);

    await new SyncReplayArchive({
      replayFileScanner: new FakeReplayScanner([
        replayFile("A:\\replays\\numberone.SC2Replay", "2026-05-17T03:35:00.000Z")
      ]),
      replayMetadataReader: new FakeReplayMetadataReader({
        "A:\\replays\\numberone.SC2Replay": {
          replayPath: "A:\\replays\\numberone.SC2Replay",
          playedAt: "2026-05-17T03:35:00.000Z",
          map: "Winter Madness LE",
          result: "loss",
          durationSeconds: 215,
          players: [
            { name: "RetorieS", race: "Terran", result: "loss" },
            { name: "NumberOne", race: "Protoss", result: "win" }
          ]
        }
      }),
      matchRepository,
      opponentRepository,
      clock: () => "2026-05-17T03:40:00.000Z"
    }).execute({
      directory: "A:\\replays",
      userName: "RetorieS",
      mode: "full"
    });

    await expect(matchRepository.findById("match_live_unknown_race")).resolves.toMatchObject({
      replayPath: "A:\\replays\\numberone.SC2Replay",
      playerRace: "Terran",
      opponentRace: "Protoss",
      result: "loss"
    });
    await expect(opponentRepository.findById("opponent_numberone")).resolves.toMatchObject({
      race: "Protoss",
      encounters: 1,
      losses: 1,
      raceProfiles: {
        Protoss: expect.objectContaining({})
      }
    });
  });

  it("resolves replay-sync barcode opponents through their Battle.net profile link", async () => {
    const scanner = new FakeReplayScanner([
      replayFile("A:\\replays\\barcode.SC2Replay", "2026-05-11T00:12:00.000Z")
    ]);
    const reader = new FakeReplayMetadataReader({
      "A:\\replays\\barcode.SC2Replay": {
        replayPath: "A:\\replays\\barcode.SC2Replay",
        playedAt: "2026-05-11T00:12:00.000Z",
        map: "Ruby Rock LE",
        result: "win",
        durationSeconds: 298,
        players: [
          { name: "RetorieS", race: "Terran", result: "win", toon: "2-S2-1-100" },
          { name: "LLLLLLLLLLL", race: "Zerg", result: "loss", toon: "2-S2-1-5501280" }
        ]
      }
    });
    const matchRepository = new InMemoryMatchRepository([]);
    const opponentRepository = new InMemoryOpponentRepository([]);
    const source = new FakeSource("SC2Pulse", [
      {
        source: "SC2Pulse",
        nickname: "SuperMage",
        race: "Zerg",
        region: "EU",
        battleTag: "SuperMage#22387",
        aliases: ["LLLLLLLLLLL"],
        mmr: 3872,
        league: "Master",
        totalGames: 20515,
        confidenceScore: 0.95
      }
    ]);

    const result = await new SyncReplayArchive({
      replayFileScanner: scanner,
      replayMetadataReader: reader,
      matchRepository,
      opponentRepository,
      enrichmentService: new OpponentEnrichmentService([source]),
      clock: () => "2026-05-11T00:20:00.000Z"
    }).execute({
      directory: "A:\\replays",
      userName: "RetorieS",
      mode: "full",
      region: "EU"
    });

    const opponents = await opponentRepository.findAll();

    expect(result.importedCount).toBe(1);
    expect(source.queries).toMatchObject([
      {
        nickname: "LLLLLLLLLLL",
        profileLink: "https://starcraft2.blizzard.com/profile/2/1/5501280",
        race: "Zerg",
        region: "EU"
      }
    ]);
    expect(opponents).toHaveLength(1);
    expect(opponents[0]).toMatchObject({
      nickname: "LLLLLLLLLLL",
      revealedNickname: "SuperMage",
      battleTag: "SuperMage#22387",
      mmrAtLastMatch: 3872,
      league: "Master",
      encounters: 1,
      wins: 1
    });
    expect(opponents[0]?.raceProfiles?.Zerg?.mmrAtLastMatch).toBe(3872);
    expect(opponents[0]?.raceProfiles?.Zerg?.totalGamesAtLastMatch).toBe(20515);
  });

  it("resolves normal replay-sync opponents through their replay profile id instead of nickname only", async () => {
    const scanner = new FakeReplayScanner([
      replayFile("A:\\replays\\asyl.SC2Replay", "2026-05-27T20:12:00.000Z")
    ]);
    const reader = new FakeReplayMetadataReader({
      "A:\\replays\\asyl.SC2Replay": {
        replayPath: "A:\\replays\\asyl.SC2Replay",
        playedAt: "2026-05-27T20:12:00.000Z",
        map: "Ghost River LE",
        result: "loss",
        durationSeconds: 422,
        players: [
          { name: "RetorieS", race: "Terran", result: "loss", toon: "2-S2-1-100" },
          { name: "Asyl", race: "Protoss", result: "win", toon: "2-S2-1-16215737210316521472" }
        ]
      }
    });
    const opponentRepository = new InMemoryOpponentRepository([]);
    const source = new FakeSource("SC2Pulse", [
      {
        source: "SC2Pulse",
        nickname: "Asyl",
        race: "Protoss",
        region: "EU",
        battleTag: "Asyl#878",
        aliases: [],
        profileUrl: "https://starcraft2.blizzard.com/profile/2/1/16215737210316521472",
        mmr: 4081,
        league: "Diamond",
        totalGames: 2971,
        confidenceScore: 1
      }
    ]);

    await new SyncReplayArchive({
      replayFileScanner: scanner,
      replayMetadataReader: reader,
      matchRepository: new InMemoryMatchRepository([]),
      opponentRepository,
      enrichmentService: new OpponentEnrichmentService([source]),
      clock: () => "2026-05-27T20:20:00.000Z"
    }).execute({
      directory: "A:\\replays",
      userName: "RetorieS",
      mode: "full",
      region: "EU"
    });

    const opponents = await opponentRepository.findAll();

    expect(source.queries).toMatchObject([
      {
        nickname: "Asyl",
        profileLink: "https://starcraft2.blizzard.com/profile/2/1/16215737210316521472",
        race: "Protoss",
        region: "EU"
      }
    ]);
    expect(opponents).toHaveLength(1);
    expect(opponents[0]).toMatchObject({
      id: "opponent_https-starcraft2-blizzard-com-profile-2-1-16215737210316521472",
      nickname: "Asyl",
      battleTag: "Asyl#878",
      mmrAtLastMatch: 4081,
      league: "Diamond"
    });
  });

  it("does not merge same-name replay-sync opponents when a replay profile id is available", async () => {
    const existing = createOpponent({
      id: "opponent_asyl",
      nickname: "Asyl",
      race: "Protoss",
      now: "2026-05-26T20:00:00.000Z"
    });
    const existingMatch = createMatch({
      id: "match_existing_asyl",
      opponentId: existing.id,
      playedAt: "2026-05-26T20:00:00.000Z",
      playerRace: "Terran",
      opponentRace: "Protoss",
      result: "win",
      replayPath: "A:\\replays\\old-asyl.SC2Replay",
      now: "2026-05-26T20:00:00.000Z"
    });
    const opponentRepository = new InMemoryOpponentRepository([existing]);

    await new SyncReplayArchive({
      replayFileScanner: new FakeReplayScanner([
        replayFile("A:\\replays\\asyl.SC2Replay", "2026-05-27T20:12:00.000Z")
      ]),
      replayMetadataReader: new FakeReplayMetadataReader({
        "A:\\replays\\asyl.SC2Replay": {
          replayPath: "A:\\replays\\asyl.SC2Replay",
          playedAt: "2026-05-27T20:12:00.000Z",
          map: "Ghost River LE",
          result: "loss",
          durationSeconds: 422,
          players: [
            { name: "RetorieS", race: "Terran", result: "loss", toon: "2-S2-1-100" },
            { name: "Asyl", race: "Protoss", result: "win", toon: "2-S2-1-16215737210316521472" }
          ]
        }
      }),
      matchRepository: new InMemoryMatchRepository([existingMatch]),
      opponentRepository,
      clock: () => "2026-05-27T20:20:00.000Z"
    }).execute({
      directory: "A:\\replays",
      userName: "RetorieS",
      mode: "full",
      region: "EU"
    });

    const opponents = await opponentRepository.findAll();

    expect(opponents.map((opponent) => opponent.id).sort()).toEqual([
      "opponent_asyl",
      "opponent_https-starcraft2-blizzard-com-profile-2-1-16215737210316521472"
    ]);
  });

  it("does not attach nickname-only replay imports to a BattleTag-resolved opponent", async () => {
    const resolvedBlume = createOpponent({
      id: "opponent_blume-1434",
      nickname: "Blume",
      race: "Zerg",
      battleTag: "Blume#1434",
      mmrAtLastMatch: 3997,
      now: "2026-06-03T10:09:00.000Z"
    });
    const currentMatch = createMatch({
      id: "match_current_blume",
      opponentId: resolvedBlume.id,
      playedAt: "2026-06-03T10:09:00.000Z",
      playerRace: "Terran",
      opponentRace: "Zerg",
      result: "win",
      replayPath: "A:\\replays\\current-blume.SC2Replay",
      now: "2026-06-03T10:09:00.000Z"
    });
    const matchRepository = new InMemoryMatchRepository([currentMatch]);
    const opponentRepository = new InMemoryOpponentRepository([
      { ...resolvedBlume, encounters: 1, wins: 1 }
    ]);

    await new SyncReplayArchive({
      replayFileScanner: new FakeReplayScanner([
        replayFile("A:\\replays\\old-blume.SC2Replay", "2026-03-20T00:03:00.000Z")
      ]),
      replayMetadataReader: new FakeReplayMetadataReader({
        "A:\\replays\\old-blume.SC2Replay": {
          replayPath: "A:\\replays\\old-blume.SC2Replay",
          playedAt: "2026-03-20T00:03:00.000Z",
          map: "Taito Citadel LE",
          result: "win",
          durationSeconds: 3,
          players: [
            { name: "RetorieS", race: "Terran", result: "win" },
            { name: "Blume", race: "Zerg", result: "loss" }
          ]
        }
      }),
      matchRepository,
      opponentRepository,
      clock: () => "2026-06-03T10:20:00.000Z"
    }).execute({
      directory: "A:\\replays",
      userName: "RetorieS",
      mode: "full",
      region: "EU"
    });

    const matches = await matchRepository.findAll();
    const opponents = await opponentRepository.findAll();

    expect(matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "match_current_blume",
          opponentId: "opponent_blume-1434"
        }),
        expect.objectContaining({
          id: "match_a-replays-old-blume-sc2replay",
          opponentId: "opponent_blume"
        })
      ])
    );
    expect(opponents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "opponent_blume-1434",
          battleTag: "Blume#1434",
          encounters: 1
        }),
        expect.objectContaining({
          id: "opponent_blume",
          battleTag: undefined,
          encounters: 1
        })
      ])
    );
  });

  it("detaches already linked nickname-only replays that predate a BattleTag-resolved opponent", async () => {
    const resolvedBlume = createOpponent({
      id: "opponent_blume-1434",
      nickname: "Blume",
      race: "Zerg",
      battleTag: "Blume#1434",
      mmrAtLastMatch: 3997,
      now: "2026-06-03T10:09:00.000Z"
    });
    const wronglyLinkedOldMatch = createMatch({
      id: "match_old_blume",
      opponentId: resolvedBlume.id,
      playedAt: "2026-03-20T00:03:00.000Z",
      playerRace: "Terran",
      opponentRace: "Zerg",
      result: "win",
      replayPath: "A:\\replays\\old-blume-linked.SC2Replay",
      now: "2026-03-20T00:03:00.000Z"
    });
    const matchRepository = new InMemoryMatchRepository([wronglyLinkedOldMatch]);
    const opponentRepository = new InMemoryOpponentRepository([
      { ...resolvedBlume, encounters: 3, wins: 3 }
    ]);

    await new SyncReplayArchive({
      replayFileScanner: new FakeReplayScanner([
        replayFile("A:\\replays\\old-blume-linked.SC2Replay", "2026-03-20T00:03:00.000Z")
      ]),
      replayMetadataReader: new FakeReplayMetadataReader({
        "A:\\replays\\old-blume-linked.SC2Replay": {
          replayPath: "A:\\replays\\old-blume-linked.SC2Replay",
          playedAt: "2026-03-20T00:03:00.000Z",
          map: "Taito Citadel LE",
          result: "win",
          durationSeconds: 3,
          players: [
            { name: "RetorieS", race: "Terran", result: "win" },
            { name: "Blume", race: "Zerg", result: "loss" }
          ]
        }
      }),
      matchRepository,
      opponentRepository,
      clock: () => "2026-06-03T10:20:00.000Z"
    }).execute({
      directory: "A:\\replays",
      userName: "RetorieS",
      mode: "full",
      region: "EU"
    });

    await expect(matchRepository.findById("match_old_blume")).resolves.toMatchObject({
      opponentId: "opponent_blume"
    });
    await expect(opponentRepository.findById("opponent_blume-1434")).resolves.toMatchObject({
      encounters: 0,
      wins: 0
    });
    await expect(opponentRepository.findById("opponent_blume")).resolves.toMatchObject({
      nickname: "Blume",
      encounters: 1,
      wins: 1
    });
  });

  it("computes the SC2Pulse Battle.net profile query from a replay toon for sparse barcode profiles", async () => {
    const scanner = new FakeReplayScanner([
      replayFile("A:\\replays\\hellhound.SC2Replay", "2026-05-11T00:30:00.000Z")
    ]);
    const reader = new FakeReplayMetadataReader({
      "A:\\replays\\hellhound.SC2Replay": {
        replayPath: "A:\\replays\\hellhound.SC2Replay",
        playedAt: "2026-05-11T00:30:00.000Z",
        map: "Goldenaura LE",
        result: "loss",
        durationSeconds: 360,
        players: [
          { name: "RetorieS", race: "Terran", result: "loss", toon: "2-S2-1-100" },
          { name: "llllllll", race: "Unknown", result: "win", toon: "2-S2-1-11197848" }
        ]
      }
    });
    const opponentRepository = new InMemoryOpponentRepository([]);
    const source = new FakeSource("SC2Pulse", [
      {
        source: "SC2Pulse",
        nickname: "Höllenhund",
        race: "Unknown",
        region: "EU",
        battleTag: "Höllenhund#21562",
        aliases: ["llllllll"],
        confidenceScore: 0.65
      }
    ]);

    await new SyncReplayArchive({
      replayFileScanner: scanner,
      replayMetadataReader: reader,
      matchRepository: new InMemoryMatchRepository([]),
      opponentRepository,
      enrichmentService: new OpponentEnrichmentService([source]),
      clock: () => "2026-05-11T00:35:00.000Z"
    }).execute({
      directory: "A:\\replays",
      userName: "RetorieS",
      mode: "full",
      region: "EU"
    });

    const opponents = await opponentRepository.findAll();

    expect(source.queries).toMatchObject([
      {
        nickname: "llllllll",
        profileLink: "https://starcraft2.blizzard.com/profile/2/1/11197848",
        race: "Unknown",
        region: "EU"
      }
    ]);
    expect(opponents).toHaveLength(1);
    expect(opponents[0]).toMatchObject({
      nickname: "llllllll",
      revealedNickname: "Höllenhund",
      battleTag: "Höllenhund#21562",
      encounters: 1,
      losses: 1
    });
  });
});

function replayFile(path: string, modifiedAt: string): ReplayFile {
  return { path, modifiedAt };
}

function metadata(replayPath: string, opponentName: string, playedAt: string): ReplayMetadata {
  return {
    replayPath,
    playedAt,
    map: "Ruby Rock LE",
    result: "win",
    durationSeconds: 600,
    players: [
      { name: "RetorieS", race: "Terran", result: "win" },
      { name: opponentName, race: "Zerg", result: "loss" }
    ]
  };
}

class FakeReplayScanner implements ReplayFileScannerPort {
  constructor(private readonly files: readonly ReplayFile[]) {}

  async scan(): Promise<readonly ReplayFile[]> {
    return this.files;
  }
}

class FakeReplayMetadataReader implements ReplayMetadataReaderPort {
  readonly readPaths: string[] = [];

  constructor(private readonly metadataByPath: Record<string, ReplayMetadata>) {}

  async readMetadata(file: ReplayFile): Promise<ReplayMetadata> {
    this.readPaths.push(file.path);
    const metadata = this.metadataByPath[file.path];
    if (!metadata) {
      throw new Error(`No metadata for ${file.path}`);
    }

    return metadata;
  }
}

class FakeSource implements OpponentDataSourcePort {
  readonly queries: OpponentSearchQuery[] = [];

  constructor(
    readonly sourceName: string,
    private readonly candidates: readonly OpponentDataCandidate[]
  ) {}

  async searchOpponent(query: OpponentSearchQuery): Promise<readonly OpponentDataCandidate[]> {
    this.queries.push(query);
    return this.candidates;
  }
}

class InMemoryOpponentRepository implements OpponentRepository {
  private opponents: Opponent[];

  constructor(opponents: readonly Opponent[]) {
    this.opponents = [...opponents];
  }

  async findAll(): Promise<readonly Opponent[]> {
    return this.opponents;
  }

  async findById(id: EntityId): Promise<Opponent | null> {
    return this.opponents.find((opponent) => opponent.id === id) ?? null;
  }

  async save(opponent: Opponent): Promise<void> {
    const index = this.opponents.findIndex((candidate) => candidate.id === opponent.id);
    if (index === -1) {
      this.opponents = [...this.opponents, opponent];
      return;
    }

    this.opponents = this.opponents.map((candidate) => candidate.id === opponent.id ? opponent : candidate);
  }

  async clear(): Promise<void> {
    this.opponents = [];
  }
}

class InMemoryMatchRepository implements MatchRepository {
  private matches: Match[];

  constructor(matches: readonly Match[]) {
    this.matches = [...matches];
  }

  async findAll(): Promise<readonly Match[]> {
    return this.matches;
  }

  async findById(id: EntityId): Promise<Match | null> {
    return this.matches.find((match) => match.id === id) ?? null;
  }

  async findByOpponentId(opponentId: EntityId): Promise<readonly Match[]> {
    return this.matches.filter((match) => match.opponentId === opponentId);
  }

  async save(match: Match): Promise<void> {
    const index = this.matches.findIndex((candidate) => candidate.id === match.id);
    if (index === -1) {
      this.matches = [...this.matches, match];
      return;
    }

    this.matches = this.matches.map((candidate) => candidate.id === match.id ? match : candidate);
  }

  async clear(): Promise<void> {
    this.matches = [];
  }
}
