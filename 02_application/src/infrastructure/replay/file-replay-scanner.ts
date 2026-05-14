import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ReplayFileScannerPort } from "../../domain/ports/replay-file-scanner-port.js";
import type { ReplayFile } from "../../domain/ports/replay-metadata-reader-port.js";

export class FileReplayScanner implements ReplayFileScannerPort {
  async scan(directory: string): Promise<readonly ReplayFile[]> {
    const files = await scanDirectory(directory);
    return files.sort((first, second) => first.modifiedAt.localeCompare(second.modifiedAt));
  }
}

async function scanDirectory(directory: string): Promise<ReplayFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: ReplayFile[] = [];

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await scanDirectory(entryPath)));
      continue;
    }

    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".sc2replay")) {
      continue;
    }

    const fileStats = await stat(entryPath);
    files.push({
      path: entryPath,
      modifiedAt: fileStats.mtime.toISOString()
    });
  }

  return files;
}
