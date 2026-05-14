export type StorageHealthResult = {
  readonly directory: string;
  readonly writable: boolean;
};

export interface StorageHealthPort {
  verifyWritable(): Promise<StorageHealthResult>;
}

