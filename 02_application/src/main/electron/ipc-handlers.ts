import { app, ipcMain, shell } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AddOpponentNote } from "../../application/use-cases/add-opponent-note.js";
import { BackfillOpponentProfilesFromCandidates } from "../../application/use-cases/backfill-opponent-profiles-from-candidates.js";
import { BackfillReplayMetadata } from "../../application/use-cases/backfill-replay-metadata.js";
import { ClearAllStats } from "../../application/use-cases/clear-all-stats.js";
import { GetAppSettings } from "../../application/use-cases/get-app-settings.js";
import { GetMatchDetails } from "../../application/use-cases/get-match-details.js";
import { HandleDetectedGame } from "../../application/use-cases/handle-detected-game.js";
import { ListEnrichmentCandidates } from "../../application/use-cases/list-enrichment-candidates.js";
import { ListMatchHistory } from "../../application/use-cases/list-match-history.js";
import { ListKnownOpponents } from "../../application/use-cases/list-known-opponents.js";
import { MergeDuplicateOpponents } from "../../application/use-cases/merge-duplicate-opponents.js";
import { ProcessNewReplay } from "../../application/use-cases/process-new-replay.js";
import { RemoveOpponentNote } from "../../application/use-cases/remove-opponent-note.js";
import { RebuildOpponentStats } from "../../application/use-cases/rebuild-opponent-stats.js";
import { RunDiagnostics } from "../../application/use-cases/run-diagnostics.js";
import { SaveAppSettings } from "../../application/use-cases/save-app-settings.js";
import { SyncReplayArchive } from "../../application/use-cases/sync-replay-archive.js";
import { ToggleMatchFavorite } from "../../application/use-cases/toggle-match-favorite.js";
import { UpdateOpponentProfile } from "../../application/use-cases/update-opponent-profile.js";
import { OpponentEnrichmentService } from "../../application/services/opponent-enrichment-service.js";
import type { AppRegion } from "../../domain/entities/app-settings.js";
import type { OpponentSearchQuery } from "../../domain/ports/opponent-data-source-port.js";
import { CachedOpponentDataSource } from "../../infrastructure/opponent-sources/cached-opponent-data-source.js";
import { FileOpponentDataSource } from "../../infrastructure/opponent-sources/file-opponent-data-source.js";
import { Sc2PulseAdapter } from "../../infrastructure/opponent-sources/sc2-pulse-adapter.js";
import { SettingsAwareOpponentDataSource } from "../../infrastructure/opponent-sources/settings-aware-opponent-data-source.js";
import { ChildProcessReplayMetadataReader } from "../../infrastructure/replay/child-process-replay-metadata-reader.js";
import { FileReplayScanner } from "../../infrastructure/replay/file-replay-scanner.js";
import { Sc2ReplayAnalysisReader } from "../../infrastructure/replay/sc2-replay-analysis-reader.js";
import { SidecarReplayMetadataReader } from "../../infrastructure/replay/sidecar-replay-metadata-reader.js";
import { Sc2ClientApiAdapter } from "../../infrastructure/sc2-client/sc2-client-api-adapter.js";
import { resolveAppDataDirectory } from "../../infrastructure/storage/app-data-directory.js";
import {
  BufferedEnrichmentCandidateRepository,
  BufferedMatchRepository,
  BufferedOpponentRepository
} from "../../infrastructure/storage/buffered-repositories.js";
import { FileAppSettingsRepository } from "../../infrastructure/storage/file-app-settings-repository.js";
import { FileEnrichmentCandidateRepository } from "../../infrastructure/storage/file-enrichment-candidate-repository.js";
import { FileMatchRepository } from "../../infrastructure/storage/file-match-repository.js";
import { FileOpponentRepository } from "../../infrastructure/storage/file-opponent-repository.js";
import { FileStorageHealthCheck } from "../../infrastructure/storage/file-storage-health-check.js";
import { compactMatchStorage } from "../../infrastructure/storage/match-storage-maintenance.js";
import { ensureStorageManifest } from "../../infrastructure/storage/storage-manifest.js";
import { IPC_CHANNELS } from "../../shared/ipc/channels.js";
import type {
  AddOpponentNoteRequest,
  AddOpponentNoteResponse,
  AppVersionResponse,
  RemoveOpponentNoteRequest,
  RemoveOpponentNoteResponse,
  ClearStatsResponse,
  ListOpponentCandidatesRequest,
  ListOpponentCandidatesResponse,
  MatchFavoriteRequest,
  MatchFavoriteResponse,
  MatchDetailsRequest,
  MatchDetailsResponse,
  MonitoringStatus,
  RebuildStatsResponse,
  RevealReplayRequest,
  ReplayWatcherStatus,
  RendererDiagnosticsResponse,
  RendererMatchesResponse,
  RendererOpponentsResponse,
  RendererSettingsResponse,
  SaveSettingsRequest,
  SyncReplaysRequest,
  SyncReplaysResponse,
  UpdateOpponentProfileRequest,
  UpdateOpponentProfileResponse
} from "../../shared/ipc/contracts.js";
import { MonitoringController } from "./monitoring-controller.js";
import { ReplayWatcherController, resolveReplayDirectory } from "./replay-watcher-controller.js";

const APPLICATION_PACKAGE_NAME = "sc2-assistant-application";

type PackageMetadata = {
  readonly name?: unknown;
  readonly version?: unknown;
};

function resolveApplicationVersion(): string {
  for (const packageJsonPath of applicationPackageJsonCandidates()) {
    const version = readApplicationVersion(packageJsonPath);
    if (version) {
      return version;
    }
  }

  return app.getVersion();
}

function applicationPackageJsonCandidates(): string[] {
  const candidates = new Set<string>();

  addPackageJsonAncestors(candidates, process.cwd());
  addPackageJsonAncestors(candidates, app.getAppPath());
  addPackageJsonAncestors(candidates, dirname(fileURLToPath(import.meta.url)));

  return [...candidates];
}

function addPackageJsonAncestors(candidates: Set<string>, startDirectory: string): void {
  let currentDirectory = startDirectory;

  while (true) {
    candidates.add(join(currentDirectory, "package.json"));

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return;
    }
    currentDirectory = parentDirectory;
  }
}

function readApplicationVersion(packageJsonPath: string): string | null {
  if (!existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const metadata = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageMetadata;
    if (
      metadata.name === APPLICATION_PACKAGE_NAME &&
      typeof metadata.version === "string" &&
      metadata.version.trim().length > 0
    ) {
      return metadata.version;
    }
  } catch {
    return null;
  }

  return null;
}

export async function registerIpcHandlers(): Promise<void> {
  const dataDir = resolveAppDataDirectory();
  const manifest = await ensureStorageManifest({
    directory: dataDir,
    storageFormat: "csv"
  });
  await compactMatchStorage({
    filePath: join(dataDir, manifest.files.matches),
    format: manifest.storageFormat
  });

  const opponentRepository = new FileOpponentRepository(join(dataDir, manifest.files.opponents), "csv");
  const matchRepository = new FileMatchRepository(join(dataDir, manifest.files.matches), "csv");
  const settingsRepository = new FileAppSettingsRepository(join(dataDir, manifest.files.settings));
  const enrichmentCandidateRepository = new FileEnrichmentCandidateRepository(
    join(dataDir, manifest.files.enrichmentCandidates)
  );
  const settings = await settingsRepository.read();
  const sc2PulseSource = new CachedOpponentDataSource(new Sc2PulseAdapter());
  const opponentSources = [
    new SettingsAwareOpponentDataSource(
      settingsRepository,
      sc2PulseSource,
      (settings) => settings.externalSources.sc2Pulse
    ),
    new SettingsAwareOpponentDataSource(
      settingsRepository,
      new FileOpponentDataSource(join(dataDir, manifest.files.opponentSourceFixtures)),
      (settings) => settings.externalSources.localFixture
    )
  ];
  const enrichmentService = new OpponentEnrichmentService(opponentSources);

  // Self-heal local opponent records from older builds that split the same
  // nickname into separate per-race profiles, then rebuild stats from matches.
  await new MergeDuplicateOpponents({ opponentRepository, matchRepository }).execute();
  await new BackfillReplayMetadata({
    matchRepository,
    replayMetadataReader: new ChildProcessReplayMetadataReader({
      fallback: new SidecarReplayMetadataReader(),
      resolveUserName: async () => (await settingsRepository.read()).playerName,
      maxReadsPerWorker: 1,
      workerOldSpaceMb: 256
    }),
    processNewReplay: new ProcessNewReplay(
      matchRepository,
      opponentRepository,
      undefined,
      {
        enrichmentService,
        enrichmentCandidateRepository,
        resolveLocalPlayerNames: async () => {
          const currentSettings = await settingsRepository.read();
          return currentSettings.playerName ? [currentSettings.playerName] : [];
        }
      }
    ),
    maxItems: 100
  }).execute();
  // Self-heal local opponent stats from the (now compacted) match log so any
  // wins/encounters drift from the bug-1 era resolves on next launch.
  await new RebuildOpponentStats({ opponentRepository, matchRepository }).execute();
  // Self-heal source enrichment fields captured before confidence scoring was
  // tightened, so exact SC2Pulse profile matches can fill missing BattleTag/MMR.
  await new BackfillOpponentProfilesFromCandidates({
    opponentRepository,
    enrichmentCandidateRepository
  }).execute();

  const sc2Client = new Sc2ClientApiAdapter({ timeoutMs: 1000 });
  const monitoringController = new MonitoringController({
    sc2Client,
    handleDetectedGame: new HandleDetectedGame({
      opponentRepository,
      matchRepository,
      enrichmentCandidateRepository,
      enrichmentService
    }),
    userName: process.env.SC2_ASSISTANT_PLAYER_NAME ?? settings.playerName,
    region: settings.region,
    intervalMs: Number.parseInt(
      process.env.SC2_ASSISTANT_POLL_INTERVAL_MS ?? String(settings.pollingIntervalMs),
      10
    )
  });
  const replayWatcherController = new ReplayWatcherController({
    settingsRepository,
    matchRepository,
    opponentRepository,
    enrichmentService,
    enrichmentCandidateRepository
  });
  startRuntimeWhenSc2IsReachable(sc2Client, monitoringController, replayWatcherController);

  ipcMain.handle(IPC_CHANNELS.appVersion, async (): Promise<AppVersionResponse> => {
    return { version: resolveApplicationVersion() };
  });

  ipcMain.handle(IPC_CHANNELS.diagnosticsGet, async (): Promise<RendererDiagnosticsResponse> => {
    const currentSettings = await settingsRepository.read();

    return new RunDiagnostics({
      sc2Client,
      storageHealth: new FileStorageHealthCheck(dataDir),
      opponentRepository,
      matchRepository,
      externalSourcesEnabled: currentSettings.externalSourcesEnabled,
      externalSourceNames: currentSettings.externalSourcesEnabled ? enabledExternalSourceNames(currentSettings) : [],
      externalSourceDiagnostics: currentSettings.externalSourcesEnabled
        ? enabledExternalSourceDiagnostics(currentSettings, sc2PulseSource)
        : []
    }).execute();
  });

  ipcMain.handle(IPC_CHANNELS.settingsGet, async (): Promise<RendererSettingsResponse> => {
    return new GetAppSettings(settingsRepository).execute();
  });

  ipcMain.handle(
    IPC_CHANNELS.settingsSave,
    async (_event, request: SaveSettingsRequest): Promise<RendererSettingsResponse> => {
      const result = await new SaveAppSettings(settingsRepository).execute(request);
      monitoringController.setUserName(process.env.SC2_ASSISTANT_PLAYER_NAME ?? result.settings.playerName);
      monitoringController.setRegion(result.settings.region);
      await replayWatcherController.reloadSettings();
      return result;
    }
  );

  ipcMain.handle(IPC_CHANNELS.opponentsList, async (): Promise<RendererOpponentsResponse> => {
    return new ListKnownOpponents(opponentRepository).execute();
  });

  ipcMain.handle(IPC_CHANNELS.matchesList, async (): Promise<RendererMatchesResponse> => {
    return new ListMatchHistory(matchRepository, opponentRepository).execute();
  });

  ipcMain.handle(
    IPC_CHANNELS.matchesDetails,
    async (_event, request: MatchDetailsRequest): Promise<MatchDetailsResponse> => {
      return new GetMatchDetails(
        matchRepository,
        opponentRepository,
        new Sc2ReplayAnalysisReader()
      ).execute(request);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.matchesToggleFavorite,
    async (_event, request: MatchFavoriteRequest): Promise<MatchFavoriteResponse> => {
      return new ToggleMatchFavorite(matchRepository).execute(request);
    }
  );

  ipcMain.handle(IPC_CHANNELS.replayReveal, async (_event, request: RevealReplayRequest): Promise<void> => {
    shell.showItemInFolder(request.replayPath);
  });

  ipcMain.handle(
    IPC_CHANNELS.replaysSync,
    async (event, request: SyncReplaysRequest): Promise<SyncReplaysResponse> => {
      const currentSettings = await settingsRepository.read();
      const directory = await resolveReplayDirectory(currentSettings.replayDirectory);
      if (!directory) {
        throw new Error("Replay directory is not configured.");
      }

      const userName = (process.env.SC2_ASSISTANT_PLAYER_NAME ?? currentSettings.playerName)?.trim();
      if (!userName) {
        throw new Error("SC2 name is not configured.");
      }

      const bufferedMatchRepository = await BufferedMatchRepository.create(matchRepository);
      const bufferedOpponentRepository = await BufferedOpponentRepository.create(opponentRepository);
      const bufferedEnrichmentCandidateRepository =
        await BufferedEnrichmentCandidateRepository.create(enrichmentCandidateRepository);

      const result = await new SyncReplayArchive({
        replayFileScanner: new FileReplayScanner(),
        replayMetadataReader: new ChildProcessReplayMetadataReader({
          fallback: new SidecarReplayMetadataReader(),
          resolveUserName: async () => userName,
          maxReadsPerWorker: 1,
          requestTimeoutMs: 45000,
          workerOldSpaceMb: 256
        }),
        matchRepository: bufferedMatchRepository,
        opponentRepository: bufferedOpponentRepository,
        enrichmentService,
        enrichmentCandidateRepository: bufferedEnrichmentCandidateRepository,
        batchSize: 100,
        onBatchProcessed: async (progress) => {
          await bufferedOpponentRepository.flush();
          await bufferedMatchRepository.flush();
          await bufferedEnrichmentCandidateRepository.flush();
          event.sender.send(IPC_CHANNELS.replaysSyncProgress, progress);
        }
      }).execute({
        directory,
        userName,
        mode: request.mode,
        limit: request.limit,
        region: opponentSearchRegionFromAppRegion(currentSettings.region)
      });

      await bufferedOpponentRepository.flush();
      await bufferedMatchRepository.flush();
      await bufferedEnrichmentCandidateRepository.flush();

      return result;
    }
  );

  ipcMain.handle(IPC_CHANNELS.storageOpen, async (): Promise<void> => {
    const error = await shell.openPath(dataDir);
    if (error) {
      throw new Error(error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.statsClear, async (): Promise<ClearStatsResponse> => {
    const result = await new ClearAllStats({
      opponentRepository,
      matchRepository,
      enrichmentCandidateRepository
    }).execute();
    return { clearedAt: result.clearedAt };
  });

  ipcMain.handle(IPC_CHANNELS.statsRebuild, async (): Promise<RebuildStatsResponse> => {
    const result = await new RebuildOpponentStats({ opponentRepository, matchRepository }).execute();
    return { inspectedCount: result.inspectedCount, rebuiltCount: result.rebuiltCount };
  });

  ipcMain.handle(
    IPC_CHANNELS.opponentsAddNote,
    async (_event, request: AddOpponentNoteRequest): Promise<AddOpponentNoteResponse> => {
      return new AddOpponentNote(opponentRepository).execute(request);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.opponentsRemoveNote,
    async (_event, request: RemoveOpponentNoteRequest): Promise<RemoveOpponentNoteResponse> => {
      return new RemoveOpponentNote(opponentRepository).execute(request);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.opponentsUpdateProfile,
    async (_event, request: UpdateOpponentProfileRequest): Promise<UpdateOpponentProfileResponse> => {
      return new UpdateOpponentProfile(opponentRepository).execute(request);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.opponentsCandidates,
    async (_event, request: ListOpponentCandidatesRequest): Promise<ListOpponentCandidatesResponse> => {
      return new ListEnrichmentCandidates(enrichmentCandidateRepository).execute(request);
    }
  );

  ipcMain.handle(IPC_CHANNELS.monitoringStart, async (): Promise<MonitoringStatus> => {
    return monitoringController.start();
  });

  ipcMain.handle(IPC_CHANNELS.monitoringStop, async (): Promise<MonitoringStatus> => {
    return monitoringController.stop();
  });

  ipcMain.handle(IPC_CHANNELS.monitoringStatus, async (): Promise<MonitoringStatus> => {
    return monitoringController.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.replayWatcherStart, async (): Promise<ReplayWatcherStatus> => {
    return replayWatcherController.start();
  });

  ipcMain.handle(IPC_CHANNELS.replayWatcherStop, async (): Promise<ReplayWatcherStatus> => {
    return replayWatcherController.stop();
  });

  ipcMain.handle(IPC_CHANNELS.replayWatcherStatus, async (): Promise<ReplayWatcherStatus> => {
    return replayWatcherController.getStatus();
  });
}

function startRuntimeWhenSc2IsReachable(
  sc2Client: Sc2ClientApiAdapter,
  monitoringController: MonitoringController,
  replayWatcherController: ReplayWatcherController
): void {
  const intervalMs = Number.parseInt(process.env.SC2_ASSISTANT_AUTOSTART_CHECK_MS ?? "5000", 10);
  const safeIntervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 5000;
  let checkInFlight = false;
  let timer: NodeJS.Timeout | undefined;

  const stopChecking = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const checkAndStart = async () => {
    if (checkInFlight) {
      return;
    }

    if (monitoringController.getStatus().running && replayWatcherController.getStatus().running) {
      stopChecking();
      return;
    }

    checkInFlight = true;
    try {
      await sc2Client.getCurrentGame();

      if (!monitoringController.getStatus().running) {
        monitoringController.start();
      }

      if (!replayWatcherController.getStatus().running) {
        await replayWatcherController.start();
      }

      stopChecking();
    } catch {
      // SC2 Client API is unreachable until StarCraft II is running.
    } finally {
      checkInFlight = false;
    }
  };

  void checkAndStart();
  timer = setInterval(() => {
    void checkAndStart();
  }, safeIntervalMs);
}

function enabledExternalSourceNames(settings: Awaited<ReturnType<FileAppSettingsRepository["read"]>>): readonly string[] {
  const names: string[] = [];

  if (settings.externalSources.sc2Pulse) {
    names.push("SC2Pulse");
  }

  if (settings.externalSources.localFixture) {
    names.push("Local Fixture Source");
  }

  return names;
}

function enabledExternalSourceDiagnostics(
  settings: Awaited<ReturnType<FileAppSettingsRepository["read"]>>,
  sc2PulseSource: CachedOpponentDataSource
): readonly ReturnType<CachedOpponentDataSource["getSnapshot"]>[] {
  const diagnostics: ReturnType<CachedOpponentDataSource["getSnapshot"]>[] = [];

  if (settings.externalSources.sc2Pulse) {
    diagnostics.push(sc2PulseSource.getSnapshot());
  }

  return diagnostics;
}

function opponentSearchRegionFromAppRegion(region: AppRegion): OpponentSearchQuery["region"] | undefined {
  if (region === "us" || region === "eu" || region === "kr" || region === "cn") {
    return region.toUpperCase() as OpponentSearchQuery["region"];
  }

  return undefined;
}
