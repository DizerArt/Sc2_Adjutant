import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SidecarReplayMetadataReader } from "../../../../src/infrastructure/replay/sidecar-replay-metadata-reader.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SidecarReplayMetadataReader", () => {
  it("reads map and result from optional replay sidecar JSON", async () => {
    const dir = await createTempDir();
    const replayPath = join(dir, "ladder.SC2Replay");
    await writeFile(replayPath, "binary", "utf8");
    await writeFile(
      `${replayPath}.json`,
      JSON.stringify({
        playedAt: "2026-05-03T10:30:00.000Z",
        map: "Ghost River LE",
        result: "loss",
        durationSeconds: 845
      }),
      "utf8"
    );

    const reader = new SidecarReplayMetadataReader();

    await expect(
      reader.readMetadata({
        path: replayPath,
        modifiedAt: "2026-05-03T10:35:00.000Z"
      })
    ).resolves.toEqual({
      replayPath,
      playedAt: "2026-05-03T10:30:00.000Z",
      map: "Ghost River LE",
      result: "loss",
      durationSeconds: 845
    });
  });

  it("falls back to file modified time when sidecar is absent", async () => {
    const reader = new SidecarReplayMetadataReader();

    await expect(
      reader.readMetadata({
        path: "A:\\Replays\\ladder.SC2Replay",
        modifiedAt: "2026-05-03T10:35:00.000Z"
      })
    ).resolves.toEqual({
      replayPath: "A:\\Replays\\ladder.SC2Replay",
      playedAt: "2026-05-03T10:35:00.000Z",
      map: undefined,
      result: undefined,
      durationSeconds: undefined
    });
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sc2-assistant-replay-sidecar-"));
  tempDirs.push(dir);
  return dir;
}
