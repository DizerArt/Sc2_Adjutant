import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileReplayScanner } from "../../../../src/infrastructure/replay/file-replay-scanner.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("FileReplayScanner", () => {
  it("recursively returns StarCraft II replay files only", async () => {
    const dir = await createTempDir();
    const nestedDir = join(dir, "Account", "Replay");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(dir, "notes.txt"), "ignore", "utf8");
    await writeFile(join(nestedDir, "ladder.SC2Replay"), "binary", "utf8");

    const scanner = new FileReplayScanner();

    const files = await scanner.scan(dir);

    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe(join(nestedDir, "ladder.SC2Replay"));
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sc2-assistant-replays-"));
  tempDirs.push(dir);
  return dir;
}
