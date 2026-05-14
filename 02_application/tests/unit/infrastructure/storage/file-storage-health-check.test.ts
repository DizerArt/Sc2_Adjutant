import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStorageHealthCheck } from "../../../../src/infrastructure/storage/file-storage-health-check.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("FileStorageHealthCheck", () => {
  it("creates the directory and verifies writable access", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sc2-assistant-health-"));
    tempDirs.push(dir);

    const healthCheck = new FileStorageHealthCheck(join(dir, "nested", "data"));
    const result = await healthCheck.verifyWritable();

    expect(result).toEqual({
      directory: join(dir, "nested", "data"),
      writable: true
    });
  });
});

