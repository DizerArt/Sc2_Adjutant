import type { ReplayMetadata } from "../entities/match.js";

export type ReplayFile = {
  readonly path: string;
  readonly modifiedAt: string;
};

export interface ReplayMetadataReaderPort {
  readMetadata(file: ReplayFile): Promise<ReplayMetadata>;
}
