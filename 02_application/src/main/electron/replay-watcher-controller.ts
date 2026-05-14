import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { ProcessNewReplay } from "../../application/use-cases/process-new-replay.js";
import { ReplayWatcherService } from "../../application/services/replay-watcher-service.js";
import type { OpponentEnrichmentService } from "../../application/services/opponent-enrichment-service.js";
import type { EnrichmentCandidateRepository } from "../../domain/repositories/enrichment-candidate-repository.js";
import type { AppSettingsRepository } from "../../domain/repositories/app-settings-repository.js";
import type { MatchRepository } from "../../domain/repositories/match-repository.js";
import type { OpponentRepository } from "../../domain/repositories/opponent-repository.js";
import { ChildProcessReplayMetadataReader } from "../../infrastructure/replay/child-process-replay-metadata-reader.js";
import { FileReplayScanner } from "../../infrastructure/replay/file-replay-scanner.js";
import { SidecarReplayMetadataReader } from "../../infrastructure/replay/sidecar-replay-metadata-reader.js";
import type { ReplayWatcherStatus } from "../../shared/ipc/contracts.js";

export type ReplayWatcherControllerOptions = {
  readonly settingsRepository: AppSettingsRepository;
  readonly matchRepository: MatchRepository;
  readonly opponentRepository: OpponentRepository;
  readonly enrichmentService?: OpponentEnrichmentService;
  readonly enrichmentCandidateRepository?: EnrichmentCandidateRepository;
  readonly intervalMs?: number;
};

export class ReplayWatcherController {
  private readonly watcher: ReplayWatcherService;
  private status: ReplayWatcherStatus = {
    running: false
  };

  constructor(private readonly options: ReplayWatcherControllerOptions) {
    const metadataReader = new ChildProcessReplayMetadataReader({
      fallback: new SidecarReplayMetadataReader(),
      resolveUserName: async () => (await options.settingsRepository.read()).playerName,
      maxReadsPerWorker: 1,
      workerOldSpaceMb: 256
    });

    this.watcher = new ReplayWatcherService(
      new FileReplayScanner(),
      metadataReader,
      new ProcessNewReplay(
        options.matchRepository,
        options.opponentRepository,
        undefined,
        {
          enrichmentService: options.enrichmentService,
          enrichmentCandidateRepository: options.enrichmentCandidateRepository
        }
      ),
      {
        intervalMs: options.intervalMs ?? 5000
      }
    );

    this.watcher.on("replayDetected", ({ file, result }) => {
      this.status = {
        ...this.status,
        lastReplayPath: file.path,
        lastLinkedMatchId: result?.match.id,
        lastError: undefined
      };
    });

    this.watcher.on("error", (error) => {
      this.status = {
        ...this.status,
        lastError: error instanceof Error ? error.message : String(error)
      };
    });
  }

  async start(): Promise<ReplayWatcherStatus> {
    const settings = await this.options.settingsRepository.read();
    const directory = await resolveReplayDirectory(settings.replayDirectory);
    this.watcher.setDirectory(directory);
    this.watcher.start();

    this.status = {
      ...this.status,
      running: true,
      directory,
      lastError: directory ? undefined : this.status.lastError
    };

    return this.getStatus();
  }

  stop(): ReplayWatcherStatus {
    this.watcher.stop();
    this.status = {
      ...this.status,
      running: false
    };

    return this.getStatus();
  }

  getStatus(): ReplayWatcherStatus {
    return {
      ...this.status,
      running: this.watcher.isRunning()
    };
  }

  async reloadSettings(): Promise<ReplayWatcherStatus> {
    const settings = await this.options.settingsRepository.read();
    const directory = await resolveReplayDirectory(settings.replayDirectory);
    this.watcher.setDirectory(directory);
    this.status = {
      ...this.status,
      directory,
      lastError: directory ? undefined : this.status.lastError
    };

    return this.getStatus();
  }
}

export async function resolveReplayDirectory(configuredDirectory: string | undefined): Promise<string | undefined> {
  if (configuredDirectory?.trim()) {
    return configuredDirectory.trim();
  }

  for (const directory of defaultReplayDirectoryCandidates()) {
    if (await directoryExists(directory)) {
      return directory;
    }
  }

  return undefined;
}

function defaultReplayDirectoryCandidates(): readonly string[] {
  const userProfile = process.env.USERPROFILE;
  const homeDrive = process.env.HOMEDRIVE;
  const homePath = process.env.HOMEPATH;
  const oneDrive = process.env.OneDrive ?? process.env.ONEDRIVE;
  const home = userProfile ?? (homeDrive && homePath ? `${homeDrive}${homePath}` : undefined);
  const documentsRoots = [
    home ? join(home, "Documents") : undefined,
    oneDrive ? join(oneDrive, "Documents") : undefined
  ].filter((value): value is string => Boolean(value));

  return documentsRoots.flatMap((documents) => [
    join(documents, "StarCraft II", "Accounts"),
    join(documents, "StarCraft II")
  ]);
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    await access(directory, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
