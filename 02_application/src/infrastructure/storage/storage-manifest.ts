import { join } from "node:path";
import { readTextFileIfExists, writeTextFileAtomically } from "./atomic-file.js";
import type { FileStorageFormat } from "./file-opponent-repository.js";

export const CURRENT_STORAGE_SCHEMA_VERSION = 1;
export const STORAGE_MANIFEST_FILE_NAME = "storage-manifest.json";

export type StorageManifest = {
  readonly appName: "SC2 Assistant";
  readonly schemaVersion: number;
  readonly storageFormat: FileStorageFormat;
  readonly files: {
    readonly opponents: string;
    readonly matches: string;
    readonly settings: string;
    readonly enrichmentCandidates: string;
    readonly opponentSourceFixtures: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type EnsureStorageManifestOptions = {
  readonly directory: string;
  readonly storageFormat?: FileStorageFormat;
  readonly clock?: () => string;
};

export async function ensureStorageManifest(options: EnsureStorageManifestOptions): Promise<StorageManifest> {
  const storageFormat = options.storageFormat ?? "csv";
  const manifestPath = join(options.directory, STORAGE_MANIFEST_FILE_NAME);
  const existingContent = await readTextFileIfExists(manifestPath);
  const now = options.clock?.() ?? new Date().toISOString();

  if (existingContent) {
    const existingManifest = parseStorageManifest(existingContent);
    const nextManifest: StorageManifest = {
      ...existingManifest,
      schemaVersion: CURRENT_STORAGE_SCHEMA_VERSION,
      storageFormat,
      files: fileNamesForFormat(storageFormat),
      updatedAt: now
    };

    await writeTextFileAtomically(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
    return nextManifest;
  }

  const manifest: StorageManifest = {
    appName: "SC2 Assistant",
    schemaVersion: CURRENT_STORAGE_SCHEMA_VERSION,
    storageFormat,
    files: fileNamesForFormat(storageFormat),
    createdAt: now,
    updatedAt: now
  };

  await writeTextFileAtomically(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function readStorageManifest(directory: string): Promise<StorageManifest | null> {
  const content = await readTextFileIfExists(join(directory, STORAGE_MANIFEST_FILE_NAME));
  return content ? parseStorageManifest(content) : null;
}

function parseStorageManifest(content: string): StorageManifest {
  const parsed = JSON.parse(content) as Partial<StorageManifest>;

  if (parsed.appName !== "SC2 Assistant") {
    throw new Error("Invalid storage manifest app name.");
  }

  if (typeof parsed.schemaVersion !== "number") {
    throw new Error("Invalid storage manifest schema version.");
  }

  if (parsed.storageFormat !== "csv" && parsed.storageFormat !== "xml") {
    throw new Error("Invalid storage manifest format.");
  }

  if (!parsed.files?.opponents || !parsed.files.matches) {
    throw new Error("Invalid storage manifest file list.");
  }

  if (!parsed.createdAt || !parsed.updatedAt) {
    throw new Error("Invalid storage manifest timestamps.");
  }

  return parsed as StorageManifest;
}

function fileNamesForFormat(format: FileStorageFormat): StorageManifest["files"] {
  return {
    opponents: `opponents.${format}`,
    matches: `matches.${format}`,
    settings: "settings.json",
    enrichmentCandidates: "enrichment-candidates.json",
    opponentSourceFixtures: "opponent-source-fixtures.json"
  };
}
