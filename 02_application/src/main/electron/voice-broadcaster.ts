import type { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc/channels.js";
import type { VoiceSpeakEvent } from "../../shared/ipc/voice-contracts.js";

let target: BrowserWindow | null = null;

export function setVoiceBroadcastTarget(window: BrowserWindow | null): void {
  target = window;
}

export function broadcastVoiceEvent(event: VoiceSpeakEvent): void {
  if (!target || target.isDestroyed()) {
    return;
  }
  target.webContents.send(IPC_CHANNELS.voiceSpeak, event);
}
