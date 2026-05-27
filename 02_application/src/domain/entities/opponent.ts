import type { EntityId } from "../value-objects/entity-id.js";
import { normalizeRace, type Race } from "../value-objects/race.js";
import type { OpponentDataCandidate } from "../ports/opponent-data-source-port.js";
import { isBarcodeNickname } from "../value-objects/barcode.js";
import type { MatchResult } from "./match.js";

export const MAX_OPPONENT_NOTES = 5;
export const MAX_OPPONENT_NOTE_LENGTH = 96;
export const MAX_OPPONENT_STRATEGY_TAGS = 12;
export const MAX_OPPONENT_STRATEGY_TAG_LENGTH = 11;
export const OPPONENT_MARKERS = ["skull", "heart", "blocked"] as const;

export type OpponentMarker = (typeof OPPONENT_MARKERS)[number];

export type Opponent = {
  readonly id: EntityId;
  readonly nickname: string;
  readonly revealedNickname?: string;
  readonly race: Race;
  readonly raceProfiles?: Partial<Record<Race, OpponentRaceProfileData>>;
  readonly battleTag?: string;
  readonly aliases: readonly string[];
  readonly mmrAtLastMatch?: number;
  readonly league?: string;
  readonly encounters: number;
  readonly wins: number;
  readonly losses: number;
  readonly lastMatchDate?: string;
  readonly notes: readonly string[];
  readonly strategyTags: readonly string[];
  readonly markers?: readonly OpponentMarker[];
  readonly confidenceScore?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type OpponentRaceProfileData = {
  readonly mmrAtLastMatch?: number;
  readonly league?: string;
  readonly totalGamesAtLastMatch?: number;
  readonly strategyTags?: readonly string[];
  readonly notes?: readonly string[];
  readonly confidenceScore?: number;
  readonly updatedAt: string;
};

export type CreateOpponentInput = {
  readonly id: EntityId;
  readonly nickname: string;
  readonly race: Race;
  readonly battleTag?: string;
  readonly aliases?: readonly string[];
  readonly mmrAtLastMatch?: number;
  readonly league?: string;
  readonly notes?: readonly string[];
  readonly strategyTags?: readonly string[];
  readonly markers?: readonly OpponentMarker[];
  readonly confidenceScore?: number;
  readonly now?: string;
};

export type UpdateOpponentProfileInput = {
  readonly nickname?: string;
  readonly race?: Race;
  readonly battleTag?: string;
  readonly aliases?: readonly string[];
  readonly mmrAtLastMatch?: number;
  readonly league?: string;
  readonly strategyTags?: readonly string[];
  readonly markers?: readonly OpponentMarker[];
  readonly confidenceScore?: number;
};

export function createOpponent(input: CreateOpponentInput): Opponent {
  const now = input.now ?? new Date().toISOString();

  return {
    id: input.id,
    nickname: input.nickname.trim(),
    race: input.race,
    raceProfiles: createRaceProfiles(input, now),
    battleTag: normalizeOptionalString(input.battleTag),
    aliases: input.aliases ?? [],
    mmrAtLastMatch: input.mmrAtLastMatch,
    league: normalizeOptionalString(input.league),
    encounters: 0,
    wins: 0,
    losses: 0,
    notes: input.notes ?? [],
    strategyTags: normalizeStrategyTags(input.strategyTags ?? []),
    markers: normalizeMarkers(input.markers),
    confidenceScore: input.confidenceScore,
    createdAt: now,
    updatedAt: now
  };
}

export function recordOpponentMatch(opponent: Opponent, result: MatchResult, playedAt: string, mmr?: number): Opponent {
  return {
    ...opponent,
    encounters: opponent.encounters + 1,
    wins: result === "win" ? opponent.wins + 1 : opponent.wins,
    losses: result === "loss" ? opponent.losses + 1 : opponent.losses,
    mmrAtLastMatch: mmr ?? opponent.mmrAtLastMatch,
    lastMatchDate: playedAt,
    updatedAt: new Date().toISOString()
  };
}

export function updateOpponentMatchResult(opponent: Opponent, previous: MatchResult, next: MatchResult): Opponent {
  if (previous === next || next === "unknown") {
    return opponent;
  }

  return {
    ...opponent,
    wins: opponent.wins + resultDelta(previous, next, "win"),
    losses: opponent.losses + resultDelta(previous, next, "loss"),
    updatedAt: new Date().toISOString()
  };
}

export function addOpponentNote(opponent: Opponent, note: string, race?: Race): Opponent {
  const normalizedNote = note.trim().slice(0, MAX_OPPONENT_NOTE_LENGTH);
  if (!normalizedNote) {
    return opponent;
  }

  const targetRace = race ? normalizeRace(race) : "Unknown";
  const now = new Date().toISOString();

  if (targetRace !== "Unknown") {
    const currentNotes = opponent.raceProfiles?.[targetRace]?.notes ?? [];

    return {
      ...opponent,
      raceProfiles: upsertRaceProfile(opponent.raceProfiles, targetRace, {
        notes: [...currentNotes, normalizedNote].slice(-MAX_OPPONENT_NOTES),
        updatedAt: now
      }),
      updatedAt: now
    };
  }

  return {
    ...opponent,
    notes: [...opponent.notes, normalizedNote].slice(-MAX_OPPONENT_NOTES),
    updatedAt: now
  };
}

export function removeOpponentNote(opponent: Opponent, noteIndex: number, race?: Race): Opponent {
  const targetRace = race ? normalizeRace(race) : "Unknown";

  if (targetRace !== "Unknown") {
    const currentNotes = opponent.raceProfiles?.[targetRace]?.notes ?? [];
    if (!Number.isInteger(noteIndex) || noteIndex < 0 || noteIndex >= currentNotes.length) {
      return opponent;
    }

    const now = new Date().toISOString();
    return {
      ...opponent,
      raceProfiles: upsertRaceProfile(opponent.raceProfiles, targetRace, {
        notes: currentNotes.filter((_note, index) => index !== noteIndex),
        updatedAt: now
      }),
      updatedAt: now
    };
  }

  if (!Number.isInteger(noteIndex) || noteIndex < 0 || noteIndex >= opponent.notes.length) {
    return opponent;
  }

  return {
    ...opponent,
    notes: opponent.notes.filter((_note, index) => index !== noteIndex),
    updatedAt: new Date().toISOString()
  };
}

export function updateOpponentProfile(
  opponent: Opponent,
  input: UpdateOpponentProfileInput,
  now = new Date().toISOString()
): Opponent {
  const targetRace = hasOwn(input, "race") && input.race ? normalizeRace(input.race) : opponent.race;
  const nextMmr = hasOwn(input, "mmrAtLastMatch")
    ? normalizeOptionalNumber(input.mmrAtLastMatch)
    : opponent.mmrAtLastMatch;
  const nextLeague = hasOwn(input, "league") ? normalizeOptionalString(input.league) : opponent.league;
  const nextTags = hasOwn(input, "strategyTags") && input.strategyTags
    ? normalizeStrategyTags(input.strategyTags)
    : opponent.strategyTags;
  const nextConfidence = hasOwn(input, "confidenceScore") ? normalizeConfidence(input.confidenceScore) : opponent.confidenceScore;
  const nextMarkers = hasOwn(input, "markers") ? normalizeMarkers(input.markers) : opponent.markers;
  const shouldUpdateRaceProfile =
    hasOwn(input, "race") ||
    hasOwn(input, "mmrAtLastMatch") ||
    hasOwn(input, "league") ||
    hasOwn(input, "strategyTags") ||
    hasOwn(input, "confidenceScore");

  return {
    ...opponent,
    nickname: hasOwn(input, "nickname") ? normalizeOptionalString(input.nickname) ?? opponent.nickname : opponent.nickname,
    race: targetRace,
    raceProfiles: shouldUpdateRaceProfile
      ? upsertRaceProfile(opponent.raceProfiles, targetRace, {
          mmrAtLastMatch: nextMmr,
          league: nextLeague,
          strategyTags: nextTags,
          confidenceScore: nextConfidence,
          updatedAt: now
        })
      : opponent.raceProfiles,
    battleTag: hasOwn(input, "battleTag") ? normalizeOptionalString(input.battleTag) : opponent.battleTag,
    aliases: hasOwn(input, "aliases") && input.aliases ? normalizeStringArray(input.aliases) : opponent.aliases,
    mmrAtLastMatch: nextMmr,
    league: nextLeague,
    strategyTags: nextTags,
    markers: nextMarkers,
    confidenceScore: nextConfidence,
    updatedAt: now
  };
}

export function enrichOpponentFromCandidate(
  opponent: Opponent,
  candidate: OpponentDataCandidate,
  now = new Date().toISOString(),
  targetRace?: Race
): Opponent {
  // Attribute the candidate's MMR / league / confidence to the race we
  // actually observed in the match (when supplied) rather than the
  // candidate's dominant race. SC2Pulse's distinct-character endpoint only
  // returns one entry per character with `dominantRace`, so without this
  // hint every match against a multi-race opponent writes the MMR into the
  // same dominant-race slot — leaving every other race tab on "Unknown"
  // even after several matches.
  const fallbackRace = normalizeRace(candidate.race);
  const requestedRace = targetRace ? normalizeRace(targetRace) : "Unknown";
  const race = requestedRace === "Unknown" ? fallbackRace : requestedRace;
  const localRaceProfile = opponent.raceProfiles?.[race];
  const observedRaceProfile = opponent.raceProfiles?.[requestedRace];
  const unknownRaceProfile = opponent.raceProfiles?.Unknown;
  const localMmr =
    localRaceProfile?.mmrAtLastMatch ??
    observedRaceProfile?.mmrAtLastMatch ??
    unknownRaceProfile?.mmrAtLastMatch ??
    opponent.mmrAtLastMatch;
  const localLeague =
    localRaceProfile?.league ??
    observedRaceProfile?.league ??
    unknownRaceProfile?.league ??
    opponent.league;

  // When the stored nickname is a barcode and SC2Pulse resolves it to a real
  // player name (e.g. via the profile-link lookup that surfaces `proNickname`),
  // keep the barcode as the primary nickname so the UI still shows it as the
  // in-game label. Park the resolved name on `revealedNickname` so callers can
  // render it in parentheses next to the barcode.
  const opponentIsBarcode = isBarcodeNickname(opponent.nickname);
  const candidateRevealsRealName =
    candidate.nickname &&
    candidate.nickname !== opponent.nickname &&
    !isBarcodeNickname(candidate.nickname);
  const keepBarcodeAsNickname = opponentIsBarcode && Boolean(candidateRevealsRealName);

  const nextNickname = keepBarcodeAsNickname
    ? opponent.nickname
    : candidate.nickname || opponent.nickname;
  const nextRevealedNickname = keepBarcodeAsNickname
    ? candidate.nickname
    : opponent.revealedNickname;
  const aliasBase =
    !keepBarcodeAsNickname && candidate.nickname && candidate.nickname !== opponent.nickname
      ? [...opponent.aliases, opponent.nickname]
      : opponent.aliases;
  const hasObservedRace = Boolean(targetRace) && race !== "Unknown" && race !== "Random";

  return {
    ...opponent,
    nickname: nextNickname,
    revealedNickname: nextRevealedNickname,
    race: hasObservedRace || opponent.race === "Unknown" || race === "Random" ? race : opponent.race,
    raceProfiles: upsertRaceProfile(opponent.raceProfiles, race, {
      mmrAtLastMatch: candidate.mmr ?? localMmr,
      league: candidate.league ?? localLeague,
      totalGamesAtLastMatch: sourceTotalGames(candidate) ?? localRaceProfile?.totalGamesAtLastMatch,
      strategyTags: localRaceProfile?.strategyTags ?? [],
      notes: localRaceProfile?.notes ?? [],
      confidenceScore: candidate.confidenceScore,
      updatedAt: now
    }),
    battleTag: opponent.battleTag ?? candidate.battleTag,
    aliases: mergeUniqueStrings(aliasBase, candidate.aliases),
    mmrAtLastMatch: candidate.mmr ?? localMmr,
    league: candidate.league ?? localLeague,
    confidenceScore: candidate.confidenceScore,
    updatedAt: now
  };
}

function sourceTotalGames(candidate: OpponentDataCandidate): number | undefined {
  return normalizeOptionalNumber(candidate.totalGames);
}

function createRaceProfiles(input: CreateOpponentInput, now: string): Opponent["raceProfiles"] {
  return upsertRaceProfile(undefined, input.race, {
    mmrAtLastMatch: input.mmrAtLastMatch,
    league: normalizeOptionalString(input.league),
    strategyTags: normalizeStrategyTags(input.strategyTags ?? []),
    notes: input.notes ?? [],
    confidenceScore: input.confidenceScore,
    updatedAt: now
  });
}

function upsertRaceProfile(
  profiles: Opponent["raceProfiles"],
  race: Race,
  profile: OpponentRaceProfileData
): Opponent["raceProfiles"] {
  return {
    ...profiles,
    [race]: {
      ...profiles?.[race],
      ...profile
    }
  };
}

function resultDelta(previous: MatchResult, next: MatchResult, target: MatchResult): number {
  const previousValue = previous === target ? 1 : 0;
  const nextValue = next === target ? 1 : 0;
  return nextValue - previousValue;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function mergeUniqueStrings(first: readonly string[], second: readonly string[]): readonly string[] {
  const result = new Set<string>();

  for (const value of [...first, ...second]) {
    const normalized = value.trim();
    if (normalized) {
      result.add(normalized);
    }
  }

  return [...result];
}

function normalizeStringArray(values: readonly string[]): readonly string[] {
  return mergeUniqueStrings([], values);
}

function normalizeStrategyTags(values: readonly string[]): readonly string[] {
  return mergeUniqueStrings([], values.map((value) => value.slice(0, MAX_OPPONENT_STRATEGY_TAG_LENGTH))).slice(
    0,
    MAX_OPPONENT_STRATEGY_TAGS
  );
}

function normalizeMarkers(values: readonly OpponentMarker[] | undefined): readonly OpponentMarker[] {
  const markers = new Set<OpponentMarker>();

  for (const value of values ?? []) {
    if (OPPONENT_MARKERS.includes(value)) {
      markers.add(value);
    }
  }

  return [...markers];
}

function normalizeOptionalNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeConfidence(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.min(Math.max(value, 0), 1);
}

function hasOwn<T extends object, K extends PropertyKey>(value: T, key: K): value is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}
