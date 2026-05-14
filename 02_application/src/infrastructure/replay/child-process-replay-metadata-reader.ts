import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReplayMetadata } from "../../domain/entities/match.js";
import type { ReplayFile, ReplayMetadataReaderPort } from "../../domain/ports/replay-metadata-reader-port.js";

export type ChildProcessReplayMetadataReaderOptions = {
  readonly fallback?: ReplayMetadataReaderPort;
  readonly resolveUserName?: () => Promise<string | undefined>;
  readonly workerPath?: string;
  readonly maxReadsPerWorker?: number;
  readonly requestTimeoutMs?: number;
  readonly workerOldSpaceMb?: number;
};

type PendingRequest = {
  readonly resolve: (metadata: ReplayMetadata) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
};

type WorkerMessage =
  | {
      readonly id: number;
      readonly ok: true;
      readonly metadata: ReplayMetadata;
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly message: string;
    };

const currentDir = fileURLToPath(new URL(".", import.meta.url));

export class ChildProcessReplayMetadataReader implements ReplayMetadataReaderPort {
  private readonly fallback?: ReplayMetadataReaderPort;
  private readonly resolveUserName?: () => Promise<string | undefined>;
  private readonly workerPath: string;
  private readonly maxReadsPerWorker: number;
  private readonly requestTimeoutMs: number;
  private readonly workerOldSpaceMb: number;
  private worker: ChildProcess | null = null;
  private workerReads = 0;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(options: ChildProcessReplayMetadataReaderOptions = {}) {
    this.fallback = options.fallback;
    this.resolveUserName = options.resolveUserName;
    this.workerPath = options.workerPath ?? defaultReplayMetadataWorkerPath();
    this.maxReadsPerWorker = Math.max(1, Math.floor(options.maxReadsPerWorker ?? 1));
    this.requestTimeoutMs = Math.max(1000, Math.floor(options.requestTimeoutMs ?? 30000));
    this.workerOldSpaceMb = Math.max(128, Math.floor(options.workerOldSpaceMb ?? 768));

    process.once("exit", () => {
      this.stopWorker();
    });
  }

  async readMetadata(file: ReplayFile): Promise<ReplayMetadata> {
    try {
      const userName = (await this.resolveUserName?.())?.trim();
      return await this.readInWorker(file, userName);
    } catch (error) {
      if (this.fallback) {
        return this.fallback.readMetadata(file);
      }

      throw error;
    }
  }

  dispose(): void {
    this.stopWorker();
  }

  private readInWorker(file: ReplayFile, userName: string | undefined): Promise<ReplayMetadata> {
    const worker = this.ensureWorker();
    const requestId = this.nextRequestId++;

    return new Promise<ReplayMetadata>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.restartWorker(new Error(`Replay metadata worker timed out after ${this.requestTimeoutMs}ms.`));
        reject(new Error("Replay metadata worker timed out."));
      }, this.requestTimeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });
      worker.send({ id: requestId, file, userName }, (error) => {
        if (!error) {
          return;
        }

        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  private ensureWorker(): ChildProcess {
    if (this.worker && this.worker.connected && this.workerReads < this.maxReadsPerWorker) {
      return this.worker;
    }

    this.stopWorker();

    const isTypeScriptWorker = this.workerPath.endsWith(".ts");
    const execPath = resolveWorkerExecPath();
    const isElectronExec = basename(execPath).toLowerCase().includes("electron");
    const execArgv = [
      `--max-old-space-size=${this.workerOldSpaceMb}`,
      ...(isTypeScriptWorker ? ["--import", "tsx"] : [])
    ];
    const worker = fork(this.workerPath, [], {
      execPath,
      env: {
        ...process.env,
        ...(isElectronExec ? { ELECTRON_RUN_AS_NODE: "1" } : {})
      },
      execArgv,
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });

    worker.on("message", (message) => {
      this.handleWorkerMessage(message);
    });
    worker.on("exit", (_code, signal) => {
      if (this.worker === worker) {
        this.worker = null;
        this.workerReads = 0;
      }
      this.rejectPending(new Error(`Replay metadata worker exited${signal ? ` with ${signal}` : ""}.`));
    });
    worker.on("error", (error) => {
      this.restartWorker(error);
    });

    this.worker = worker;
    this.workerReads = 0;
    return worker;
  }

  private handleWorkerMessage(message: unknown): void {
    if (!isWorkerMessage(message)) {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    this.workerReads += 1;

    if (message.ok) {
      pending.resolve(message.metadata);
    } else {
      pending.reject(new Error(message.message));
    }

    if (this.workerReads >= this.maxReadsPerWorker) {
      this.stopWorker();
    }
  }

  private restartWorker(error: Error): void {
    this.stopWorker();
    this.rejectPending(error);
  }

  private stopWorker(): void {
    if (!this.worker) {
      return;
    }

    const worker = this.worker;
    this.worker = null;
    this.workerReads = 0;
    worker.removeAllListeners("message");
    worker.removeAllListeners("exit");
    worker.removeAllListeners("error");

    if (worker.connected) {
      worker.disconnect();
    }

    if (!worker.killed) {
      worker.kill();
    }
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

export function defaultReplayMetadataWorkerPath(): string {
  if (currentDir.endsWith("dist-electron\\infrastructure\\replay\\") ||
    currentDir.endsWith("dist-electron/infrastructure/replay/")) {
    return fileURLToPath(new URL("./replay-metadata-worker.js", import.meta.url));
  }

  return fileURLToPath(new URL("./replay-metadata-worker.ts", import.meta.url));
}

function resolveWorkerExecPath(): string {
  const explicitNodePath = process.env.npm_node_execpath ?? process.env.NODE;
  if (explicitNodePath && existsSync(explicitNodePath)) {
    return explicitNodePath;
  }

  return process.execPath;
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (!isRecord(value) || typeof value.id !== "number" || typeof value.ok !== "boolean") {
    return false;
  }

  if (value.ok === true) {
    return isRecord(value.metadata);
  }

  return typeof value.message === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
