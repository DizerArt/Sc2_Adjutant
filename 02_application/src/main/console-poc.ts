import { join } from "node:path";
import { HandleDetectedGame } from "../application/use-cases/handle-detected-game.js";
import { Sc2GamePollingService } from "../application/services/sc2-game-polling-service.js";
import { Sc2ClientApiAdapter } from "../infrastructure/sc2-client/sc2-client-api-adapter.js";
import { resolveAppDataDirectory } from "../infrastructure/storage/app-data-directory.js";
import { FileMatchRepository } from "../infrastructure/storage/file-match-repository.js";
import { FileOpponentRepository } from "../infrastructure/storage/file-opponent-repository.js";
import { compactMatchStorage } from "../infrastructure/storage/match-storage-maintenance.js";
import { ensureStorageManifest } from "../infrastructure/storage/storage-manifest.js";

const userName = process.env.SC2_ASSISTANT_PLAYER_NAME;
const intervalMs = Number.parseInt(process.env.SC2_ASSISTANT_POLL_INTERVAL_MS ?? "1000", 10);
const runOnce = process.argv.includes("--once");
const dataDir = resolveAppDataDirectory();

const sc2Client = new Sc2ClientApiAdapter({
  timeoutMs: 1000
});

const pollingService = new Sc2GamePollingService(sc2Client, {
  intervalMs: Number.isFinite(intervalMs) ? intervalMs : 1000,
  userName
});

const storageManifest = await ensureStorageManifest({
  directory: dataDir,
  storageFormat: "csv"
});
await compactMatchStorage({
  filePath: join(dataDir, storageManifest.files.matches),
  format: storageManifest.storageFormat
});

const handleDetectedGame = new HandleDetectedGame({
  opponentRepository: new FileOpponentRepository(join(dataDir, storageManifest.files.opponents), "csv"),
  matchRepository: new FileMatchRepository(join(dataDir, storageManifest.files.matches), "csv")
});

const pendingWrites: Promise<unknown>[] = [];

pollingService.on("newGameDetected", ({ session, opponent }) => {
  console.log(`New game detected: ${opponent.name}/${opponent.race}`);

  const writePromise = handleDetectedGame
    .execute({ session, opponent, userName })
    .then((result) => {
      if (result) {
        console.log(`Saved detected game: ${result.enrichedOpponent.nickname} -> ${result.match.id}`);

        if (result.enrichmentWarnings.length > 0) {
          console.log(`Enrichment warnings: ${result.enrichmentWarnings.length}`);
        }
      }
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Unable to save detected game: ${message}`);
    });

  pendingWrites.push(writePromise);
});

pollingService.on("session", (session) => {
  if (!session.isActive) {
    console.log("Waiting for active SC2 game...");
    return;
  }

  if (session.mode !== "ranked-1v1") {
    console.log(`Unsupported SC2 session: ${session.mode}`);
  }
});

pollingService.on("error", (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`SC2 Client API unavailable: ${message}`);
});

process.on("SIGINT", () => {
  pollingService.stop();
  process.exit(0);
});

console.log("SC2 Assistant PoC polling started.");
console.log("Endpoint: http://127.0.0.1:6119/game");
console.log(`Data directory: ${dataDir}`);
console.log(`Storage schema version: ${storageManifest.schemaVersion}`);

if (runOnce) {
  await pollingService.pollOnce();
  await Promise.all(pendingWrites);
} else {
  console.log("Press Ctrl+C to stop.");
  pollingService.start();
}
