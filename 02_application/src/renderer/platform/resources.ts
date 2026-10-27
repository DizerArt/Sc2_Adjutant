import { convertFileSrc } from "@tauri-apps/api/core";
import { isTauriDesktop } from "./tauri-bridge.js";

export type VoiceResourceKind = "local" | "wasm";

/** Tauri maps custom protocols to localhost origins on Windows; Electron uses scheme hosts. */
export function voiceResourceBase(kind: VoiceResourceKind): string {
  return isTauriDesktop()
    ? convertFileSrc(kind, "voice-model")
    : `voice-model://${kind}`;
}
