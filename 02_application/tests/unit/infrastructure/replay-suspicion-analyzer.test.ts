import { describe, expect, it } from "vitest";
import { scoreSuspicion } from "../../../src/infrastructure/replay/replay-suspicion-analyzer.js";
import type { ReplayAnalysisPlayer } from "../../../src/domain/ports/replay-analysis-reader-port.js";

describe("scoreSuspicion", () => {
  const players: readonly ReplayAnalysisPlayer[] = [
    { name: "RetorieS", race: "Terran" },
    { name: "Opponent", race: "Protoss" }
  ];

  it("keeps suspicion low when no replay markers are present", () => {
    const result = scoreSuspicion(players, []);

    expect(result.players[0]).toMatchObject({
      playerName: "RetorieS",
      score: 0,
      confidence: 28,
      level: "low"
    });
  });

  it("raises suspicion when hidden camera and hidden target markers repeat", () => {
    const result = scoreSuspicion(players, [
      evidence("Opponent", 242, "hiddenCamera", 8, "Hidden proxy Stargate"),
      evidence("Opponent", 311, "hiddenCamera", 8, "Hidden Nydus"),
      evidence("Opponent", 420, "hiddenCamera", 8, "Hidden Dark Shrine"),
      evidence("Opponent", 512, "hiddenTarget", 14, "Hidden proxy Stargate"),
      evidence("Opponent", 590, "hiddenTarget", 14, "Hidden Nydus"),
      evidence("Opponent", 644, "hiddenTarget", 14, "Hidden Dark Shrine")
    ]);

    const opponentScore = result.players.find((player) => player.playerName === "Opponent");

    expect(opponentScore).toMatchObject({
      score: 58,
      confidence: 67,
      level: "medium"
    });
  });

  it("raises suspicion from repeated hidden enemy army and structure markers", () => {
    const result = scoreSuspicion(players, [
      evidence("Opponent", 164, "hiddenEnemyCamera", 5, "Camera inspected hidden enemy Reaper."),
      evidence("Opponent", 201, "hiddenEnemyCommand", 6, "Command landed near hidden enemy Factory."),
      evidence("Opponent", 273, "hiddenEnemyCamera", 5, "Camera inspected hidden enemy Hellion."),
      evidence("Opponent", 366, "hiddenEnemyCommand", 8, "Command landed near hidden enemy Reaper."),
      evidence("Opponent", 456, "hiddenEnemyCamera", 5, "Camera inspected hidden enemy Hellion."),
      evidence("Opponent", 512, "hiddenEnemyCamera", 5, "Camera inspected hidden enemy Marine."),
      evidence("Opponent", 540, "hiddenEnemyCommand", 6, "Command landed near hidden enemy Barracks.")
    ]);

    const opponentScore = result.players.find((player) => player.playerName === "Opponent");

    expect(opponentScore).toMatchObject({
      score: 45,
      confidence: 78,
      level: "medium"
    });
  });
});

function evidence(
  playerName: string,
  seconds: number,
  type: "hiddenCamera" | "hiddenTarget" | "hiddenEnemyCamera" | "hiddenEnemyCommand",
  weight: number,
  details: string
) {
  return {
    seconds,
    playerName,
    type,
    label: "Marker",
    details,
    weight
  };
}
