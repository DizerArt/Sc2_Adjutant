declare module "@mintplex-labs/piper-tts-web" {
  export type PiperProgress = {
    readonly url: string;
    readonly total: number;
    readonly loaded: number;
  };

  export type PiperWasmPaths = {
    onnxWasm: string;
    piperData: string;
    piperWasm: string;
  };

  export type TtsSessionOptions = {
    voiceId: string;
    progress?: (progress: PiperProgress) => void;
    logger?: (text: string) => void;
    wasmPaths?: PiperWasmPaths;
  };

  export class TtsSession {
    static _instance: TtsSession | null;
    static WASM_LOCATIONS: PiperWasmPaths;
    ready: boolean;
    voiceId: string;
    waitReady: Promise<void> | boolean;
    constructor(options: TtsSessionOptions);
    static create(options: TtsSessionOptions): Promise<TtsSession>;
    init(): Promise<void>;
    predict(text: string): Promise<Blob>;
  }

  export function predict(
    config: { text: string; voiceId: string },
    callback?: (progress: PiperProgress) => void
  ): Promise<Blob>;

  export function download(
    voiceId: string,
    callback?: (progress: PiperProgress) => void
  ): Promise<void>;

  export function remove(voiceId: string): Promise<void>;
  export function stored(): Promise<string[]>;
  export function flush(): Promise<void>;
  export function voices(): Promise<unknown[]>;

  export const HF_BASE: string;
  export const ONNX_BASE: string;
  export const WASM_BASE: string;
  export const PATH_MAP: Record<string, string>;
}
