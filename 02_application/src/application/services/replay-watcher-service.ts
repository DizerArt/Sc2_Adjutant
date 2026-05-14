import { EventEmitter } from "node:events";
import type { ProcessNewReplayResult, ProcessNewReplay } from "../use-cases/process-new-replay.js";
import type { ReplayFileScannerPort } from "../../domain/ports/replay-file-scanner-port.js";
import type { ReplayFile, ReplayMetadataReaderPort } from "../../domain/ports/replay-metadata-reader-port.js";

export type ReplayDetectedEvent = {
  readonly file: ReplayFile;
  readonly result: ProcessNewReplayResult | null;
};

export type ReplayWatcherEvents = {
  replayDetected: [ReplayDetectedEvent];
  error: [unknown];
};

export type ReplayWatcherServiceOptions = {
  readonly directory?: string;
  readonly intervalMs?: number;
  readonly minFileAgeMs?: number;
  readonly clock?: () => number;
};

export class ReplayWatcherService {
  private readonly events = new EventEmitter();
  private readonly knownReplayPaths = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private directory?: string;
  private readonly intervalMs: number;
  private readonly minFileAgeMs: number;
  private readonly clock: () => number;
  private scanInFlight = false;

  constructor(
    private readonly scanner: ReplayFileScannerPort,
    private readonly metadataReader: ReplayMetadataReaderPort,
    private readonly processNewReplay: ProcessNewReplay,
    options: ReplayWatcherServiceOptions = {}
  ) {
    this.directory = normalizeOptionalString(options.directory);
    this.intervalMs = options.intervalMs ?? 5000;
    this.minFileAgeMs = options.minFileAgeMs ?? 10000;
    this.clock = options.clock ?? (() => Date.now());
  }

  on<EventName extends keyof ReplayWatcherEvents>(
    eventName: EventName,
    listener: (...args: ReplayWatcherEvents[EventName]) => void
  ): this {
    this.events.on(eventName, listener as (...args: unknown[]) => void);
    return this;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    void this.scanOnce({ snapshotOnly: true });
    this.timer = setInterval(() => {
      void this.scanOnce();
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  setDirectory(directory: string | undefined): void {
    this.directory = normalizeOptionalString(directory);
    this.knownReplayPaths.clear();
  }

  async scanOnce(options: { readonly snapshotOnly?: boolean } = {}): Promise<void> {
    if (this.scanInFlight) {
      return;
    }

    if (!this.directory) {
      this.events.emit("error", new Error("Replay directory is not configured."));
      return;
    }

    this.scanInFlight = true;
    try {
      const files = await this.scanner.scan(this.directory);

      for (const file of files) {
        if (!isOldEnough(file.modifiedAt, this.clock(), this.minFileAgeMs)) {
          continue;
        }

        if (this.knownReplayPaths.has(file.path)) {
          continue;
        }

        this.knownReplayPaths.add(file.path);

        if (options.snapshotOnly) {
          continue;
        }

        const metadata = await this.metadataReader.readMetadata(file);
        const result = await this.processNewReplay.execute(metadata);
        this.events.emit("replayDetected", { file, result });
      }
    } catch (error) {
      this.events.emit("error", error);
    } finally {
      this.scanInFlight = false;
    }
  }
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function isOldEnough(modifiedAt: string, now: number, minFileAgeMs: number): boolean {
  if (minFileAgeMs <= 0) {
    return true;
  }

  const modifiedTime = Date.parse(modifiedAt);
  if (!Number.isFinite(modifiedTime)) {
    return true;
  }

  return now - modifiedTime >= minFileAgeMs;
}
