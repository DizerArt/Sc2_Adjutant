import { describe, expect, it, vi } from "vitest";
import { ReplayWatcherService } from "../../../src/application/services/replay-watcher-service.js";
import type { ProcessNewReplay } from "../../../src/application/use-cases/process-new-replay.js";
import type { ReplayFileScannerPort } from "../../../src/domain/ports/replay-file-scanner-port.js";
import type { ReplayFile, ReplayMetadataReaderPort } from "../../../src/domain/ports/replay-metadata-reader-port.js";

describe("ReplayWatcherService", () => {
  it("waits until a new replay file is old enough before processing it", async () => {
    const file: ReplayFile = {
      path: "A:\\Replays\\new.SC2Replay",
      modifiedAt: "2026-05-05T00:00:00.000Z"
    };
    const scanner = new FakeScanner([file]);
    const reader: ReplayMetadataReaderPort = {
      readMetadata: vi.fn(async () => ({
        replayPath: file.path,
        playedAt: file.modifiedAt,
        result: "loss" as const
      }))
    };
    const processNewReplay = {
      execute: vi.fn(async () => null)
    } as unknown as ProcessNewReplay;
    let now = Date.parse("2026-05-05T00:00:05.000Z");
    const watcher = new ReplayWatcherService(scanner, reader, processNewReplay, {
      directory: "A:\\Replays",
      minFileAgeMs: 10000,
      clock: () => now
    });

    await watcher.scanOnce();
    expect(reader.readMetadata).not.toHaveBeenCalled();
    expect(processNewReplay.execute).not.toHaveBeenCalled();

    now = Date.parse("2026-05-05T00:00:11.000Z");
    await watcher.scanOnce();

    expect(reader.readMetadata).toHaveBeenCalledTimes(1);
    expect(processNewReplay.execute).toHaveBeenCalledTimes(1);
  });

  it("does not overlap regular scans with the startup snapshot", async () => {
    const file: ReplayFile = {
      path: "A:\\Replays\\old.SC2Replay",
      modifiedAt: "2026-05-05T00:00:00.000Z"
    };
    let resolveScan!: (files: readonly ReplayFile[]) => void;
    const scanPromise = new Promise<readonly ReplayFile[]>((resolve) => {
      resolveScan = resolve;
    });
    const scanner: ReplayFileScannerPort = {
      scan: vi.fn(() => scanPromise)
    };
    const reader: ReplayMetadataReaderPort = {
      readMetadata: vi.fn(async () => ({
        replayPath: file.path,
        playedAt: file.modifiedAt,
        result: "loss" as const
      }))
    };
    const processNewReplay = {
      execute: vi.fn(async () => null)
    } as unknown as ProcessNewReplay;
    const watcher = new ReplayWatcherService(scanner, reader, processNewReplay, {
      directory: "A:\\Replays",
      minFileAgeMs: 0
    });

    const snapshot = watcher.scanOnce({ snapshotOnly: true });
    await watcher.scanOnce();
    resolveScan([file]);
    await snapshot;

    expect(scanner.scan).toHaveBeenCalledTimes(1);
    expect(reader.readMetadata).not.toHaveBeenCalled();

    await watcher.scanOnce();
    expect(reader.readMetadata).not.toHaveBeenCalled();
  });
});

class FakeScanner implements ReplayFileScannerPort {
  constructor(private readonly files: readonly ReplayFile[]) {}

  async scan(): Promise<readonly ReplayFile[]> {
    return this.files;
  }
}
