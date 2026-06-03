import type { Race } from "../../domain/value-objects/race.js";

export type VoiceOpponentSpeechData = {
  readonly nickname: string;
  readonly race: Race;
  readonly mmr?: number;
  readonly encounters: number;
  readonly wins: number;
  readonly losses: number;
  readonly strategyTags: readonly string[];
  readonly notes: readonly string[];
};

export type VoiceMatchSpeechData = {
  readonly result: "win" | "loss" | "unknown";
  readonly durationSeconds?: number;
  readonly opponentRace: Race;
};

export type VoiceSpeakEvent =
  | { readonly kind: "launch" }
  | { readonly kind: "opponent"; readonly data: VoiceOpponentSpeechData }
  | { readonly kind: "match"; readonly data: VoiceMatchSpeechData };
