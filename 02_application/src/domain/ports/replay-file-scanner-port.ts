import type { ReplayFile } from "./replay-metadata-reader-port.js";

export interface ReplayFileScannerPort {
  scan(directory: string): Promise<readonly ReplayFile[]>;
}
