import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StorageHealthPort, StorageHealthResult } from "../../domain/ports/storage-health-port.js";

export class FileStorageHealthCheck implements StorageHealthPort {
  constructor(private readonly directory: string) {}

  async verifyWritable(): Promise<StorageHealthResult> {
    await mkdir(this.directory, { recursive: true });

    const probePath = join(this.directory, `.write-test-${process.pid}-${Date.now()}.tmp`);
    const probeContent = "sc2-assistant-storage-health-check";

    try {
      await writeFile(probePath, probeContent, "utf8");
      const storedContent = await readFile(probePath, "utf8");

      return {
        directory: this.directory,
        writable: storedContent === probeContent
      };
    } finally {
      await rm(probePath, { force: true });
    }
  }
}

