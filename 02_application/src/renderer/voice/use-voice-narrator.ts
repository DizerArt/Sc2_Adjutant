import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "../../domain/entities/app-settings.js";
import { createTranslator } from "../i18n.js";
import type { VoiceSpeakEvent } from "../../shared/ipc/voice-contracts.js";
import type {
  VoiceRuntimeStatus,
  VoiceSynthesisPort
} from "../../domain/ports/voice-synthesis-port.js";
import { VoiceAudioPlayer } from "./audio-player.js";
import { PiperRuntime } from "./piper-runtime.js";
import {
  VoiceNarratorService,
  type OpponentSpeechData
} from "./voice-narrator-service.js";

export type VoiceController = {
  readonly narrator: VoiceNarratorService | null;
  readonly status: VoiceRuntimeStatus;
};

type Runtime = {
  readonly audioContext: AudioContext;
  readonly piper: PiperRuntime;
  readonly player: VoiceAudioPlayer;
  narrator: VoiceNarratorService;
  activeTts: VoiceSynthesisPort;
};

let runtimeSingleton: Runtime | null = null;

function ensureRuntime(getSettings: () => AppSettings | null): Runtime {
  if (runtimeSingleton) {
    return runtimeSingleton;
  }
  const AudioCtxCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioContext = new AudioCtxCtor();
  const piper = new PiperRuntime(audioContext, {
    logger: (message) => console.log("[piper]", message)
  });
  const player = new VoiceAudioPlayer(audioContext);

  const runtime: Runtime = {
    audioContext,
    piper,
    player,
    narrator: undefined as unknown as VoiceNarratorService,
    activeTts: piper
  };
  runtime.narrator = new VoiceNarratorService({
    tts: { synthesize: (req) => runtime.activeTts.synthesize(req), getStatus: () => runtime.activeTts.getStatus(), warmup: (id) => runtime.activeTts.warmup(id) },
    player,
    getSettings: () => {
      const settings = getSettings();
      if (!settings) {
        throw new Error("Voice settings not available yet");
      }
      return settings.voice;
    },
    getUiLanguage: () => "en",
    getTranslator: (language) => createTranslator(language)
  });
  runtimeSingleton = runtime;
  return runtime;
}

/**
 * Subscribes the narrator to main-process `voice:speak` events. Returns a
 * controller with the narrator handle and current runtime status so callers
 * (e.g. the Voice Assistant settings tab) can trigger preview phrases and
 * show a Ready/Loading/Error indicator.
 */
export function useVoiceNarrator(settings: AppSettings | null): VoiceController {
  const narratorRef = useRef<VoiceNarratorService | null>(null);
  const settingsRef = useRef<AppSettings | null>(settings);
  const launchAnnouncedRef = useRef(false);
  const voiceActive = Boolean(settings && settings.voice.enabled && settings.voice.provider !== "off");
  settingsRef.current = settings;
  const [status, setStatus] = useState<VoiceRuntimeStatus>({ kind: "idle" });

  // Warm up runtime once settings become available AND the user has the voice
  // assistant turned on.
  useEffect(() => {
    if (!settings || !voiceActive) {
      return;
    }
    const runtime = ensureRuntime(() => settingsRef.current);
    narratorRef.current = runtime.narrator;

    const unsubscribeStatus = runtime.piper.onStatusChange(setStatus);

    // Keep Piper failures visible in the Voice Assistant panel. Silent fallback
    // would bypass the controlled priority/preemption queue.
    void runtime.piper
      .warmup(settings.voice.voiceEn)
      .then(() => {
        if (launchAnnouncedRef.current) {
          return;
        }
        const current = settingsRef.current;
        if (!current || !current.voice.enabled || current.voice.provider === "off") {
          return;
        }
        launchAnnouncedRef.current = true;
        void runtime.narrator.announceLaunch();
      })
      .catch((error: unknown) => {
        console.error("[useVoiceNarrator] Piper warmup failed:", error);
      });

    return () => {
      unsubscribeStatus();
    };
  }, [settings, voiceActive, settings?.voice.voiceEn]);

  useEffect(() => {
    if (!settings || !voiceActive) {
      return;
    }
    if (!window.sc2Assistant?.onVoiceSpeak) {
      return;
    }
    const runtime = ensureRuntime(() => settingsRef.current);
    narratorRef.current = runtime.narrator;

    const unsubscribe = window.sc2Assistant.onVoiceSpeak((event: VoiceSpeakEvent) => {
      const narrator = narratorRef.current;
      if (!narrator) {
        return;
      }
      switch (event.kind) {
        case "launch":
          void narrator.announceLaunch();
          break;
        case "opponent":
          void narrator.announceOpponentCard(event.data satisfies OpponentSpeechData);
          break;
      }
    });

    return () => {
      unsubscribe();
    };
  }, [settings, voiceActive]);

  useEffect(() => {
    if (voiceActive) {
      return;
    }
    narratorRef.current?.stopAll();
  }, [voiceActive]);

  return { narrator: narratorRef.current, status };
}
