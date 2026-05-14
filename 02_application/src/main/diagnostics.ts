import { RunDiagnostics } from "../application/use-cases/run-diagnostics.js";
import { Sc2ClientApiAdapter } from "../infrastructure/sc2-client/sc2-client-api-adapter.js";
import { resolveAppDataDirectory } from "../infrastructure/storage/app-data-directory.js";
import { FileStorageHealthCheck } from "../infrastructure/storage/file-storage-health-check.js";
import { ensureStorageManifest } from "../infrastructure/storage/storage-manifest.js";

const dataDir = resolveAppDataDirectory();
const manifest = await ensureStorageManifest({
  directory: dataDir,
  storageFormat: "csv"
});

const diagnostics = new RunDiagnostics({
  sc2Client: new Sc2ClientApiAdapter({ timeoutMs: 1000 }),
  storageHealth: new FileStorageHealthCheck(dataDir)
});

const report = await diagnostics.execute();

console.log(`SC2 Assistant diagnostics: ${report.overallStatus.toUpperCase()}`);
console.log(`Checked at: ${report.checkedAt}`);
console.log(`Storage schema version: ${manifest.schemaVersion}`);

for (const item of report.items) {
  console.log(`- [${item.status.toUpperCase()}] ${item.name}: ${item.message}`);

  if (item.details) {
    console.log(`  ${JSON.stringify(item.details)}`);
  }
}

process.exitCode = report.overallStatus === "error" ? 1 : 0;
