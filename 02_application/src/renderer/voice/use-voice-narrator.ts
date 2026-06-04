import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "../../domain/entities/app-settings.js";
import { createTranslator } from "../i18n.js";
import type { VoiceSpeakEvent } from "../../shared/ipc/voice-contracts.js";
import type {
  VoiceRuntimeStatus,
  VoiceSynthesisPort
} from "../../domain/ports/voice-synthesis-port.js";
import { voiceIdLanguage, type VoiceId } from "../../domain/entities/voice-settings.js";
import { VoiceAudioPlayer } from "./audio-player.js";
import { PiperRuntime } from "./piper-runtime.js";
import { SileroRuntime } from "./silero-runtime.js";
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
  readonly silero: SileroRuntime;
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
  const silero = new SileroRuntime(audioContext);
  const player = new VoiceAudioPlayer(audioContext);

  const runtime: Runtime = {
    audioContext,
    piper,
    silero,
    player,
    narrator: undefined as unknown as VoiceNarratorService,
    activeTts: undefined as unknown as VoiceSynthesisPort
  };
  runtime.activeTts = createRoutingTts(runtime);
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
    getUiLanguage: () => getSettings()?.language ?? "en",
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
    const warmupVoiceId = resolveWarmupVoiceId(settings);
    const selectedRuntime = voiceIdLanguage(warmupVoiceId) === "ru" ? runtime.silero : runtime.piper;

    const unsubscribeStatus = selectedRuntime.onStatusChange(setStatus);

    // Keep TTS failures visible in the Voice Assistant panel. Silent fallback
    // would bypass the controlled priority/preemption queue.
    void selectedRuntime
      .warmup(warmupVoiceId)
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
        console.error("[useVoiceNarrator] voice warmup failed:", error);
      });

    return () => {
      unsubscribeStatus();
    };
  }, [settings, voiceActive, settings?.language, settings?.voice.voiceEn, settings?.voice.voiceRu]);

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

function createRoutingTts(runtime: Runtime): VoiceSynthesisPort {
  return {
    getStatus: () => runtime.piper.getStatus(),
    warmup: (voiceId: VoiceId) => routedRuntime(runtime, voiceId).warmup(voiceId),
    synthesize: (request) => routedRuntime(runtime, request.voiceId).synthesize(request)
  };
}

function routedRuntime(runtime: Runtime, voiceId: VoiceId): VoiceSynthesisPort {
  return voiceIdLanguage(voiceId) === "ru" ? runtime.silero : runtime.piper;
}

function resolveWarmupVoiceId(settings: AppSettings): VoiceId {
  return settings.language === "ru" ? settings.voice.voiceRu : settings.voice.voiceEn;
}
