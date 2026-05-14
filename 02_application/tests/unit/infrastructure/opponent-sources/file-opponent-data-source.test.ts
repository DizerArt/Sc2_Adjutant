import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileOpponentDataSource } from "../../../../src/infrastructure/opponent-sources/file-opponent-data-source.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("FileOpponentDataSource", () => {
  it("returns matching candidates from a local JSON fixture", async () => {
    const dir = await createTempDir();
    const filePath = join(dir, "opponent-source-fixtures.json");
    await writeFile(
      filePath,
      JSON.stringify([
        {
          source: "Fixture",
          nickname: "RobbyG",
          race: "Terran",
          aliases: ["Robby"],
          mmr: 4300,
          league: "Master",
          confidenceScore: 0.88
        },
        {
          source: "Fixture",
          nickname: "Other",
          race: "Zerg",
          aliases: [],
          confidenceScore: 0.5
        }
      ]),
      "utf8"
    );

    const source = new FileOpponentDataSource(filePath);

    await expect(source.searchOpponent({ nickname: "Robby", race: "Terran" })).resolves.toMatchObject([
      {
        source: "Fixture",
        nickname: "RobbyG",
        race: "Terran",
        mmr: 4300,
        league: "Master",
        confidenceScore: 0.88
      }
    ]);
  });

  it("returns no candidates when the fixture file does not exist", async () => {
    const dir = await createTempDir();
    const source = new FileOpponentDataSource(join(dir, "missing.json"));

    await expect(source.searchOpponent({ nickname: "RobbyG" })).resolves.toEqual([]);
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sc2-assistant-source-"));
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}
