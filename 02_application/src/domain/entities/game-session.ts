import { normalizeBattleTag } from "../value-objects/battle-tag.js";
import { normalizeRace, type Race } from "../value-objects/race.js";

export type GameSessionPlayer = {
  readonly name: string;
  readonly race: Race;
  readonly mmr?: number;
  readonly battleTag?: string;
  readonly profileLink?: string;
  readonly result?: "Victory" | "Defeat" | "Undecided" | "Unknown";
  readonly isUser?: boolean;
};

export type GameSession = {
  readonly id: string;
  readonly isActive: boolean;
  readonly mode: "ranked-1v1" | "unsupported" | "unknown";
  readonly players: readonly GameSessionPlayer[];
  readonly detectedAt: string;
  readonly startedAt?: string;
};

export type Sc2ClientGamePayload = {
  readonly players?: readonly unknown[];
  readonly isReplay?: boolean;
  readonly displayTime?: number;
  readonly gameSpeed?: string;
  readonly [key: string]: unknown;
};

export function toGameSession(payload: Sc2ClientGamePayload, detectedAt = new Date().toISOString()): GameSession {
  const players = Array.isArray(payload.players)
    ? payload.players.map(toGameSessionPlayer).filter((player): player is GameSessionPlayer => player !== null)
    : [];

  const mode = payload.isReplay === true || players.length !== 2 ? "unsupported" : "ranked-1v1";

  return {
    id: buildSessionId(players, payload, detectedAt),
    isActive: players.length > 0 && payload.isReplay !== true,
    mode,
    players,
    detectedAt,
    startedAt: startedAtFromPayload(payload, detectedAt)
  };
}

export function findOpponent(session: GameSession, userName?: string): GameSessionPlayer | null {
  if (session.mode !== "ranked-1v1") {
    return null;
  }

  const userPlayer = findUserPlayer(session, userName);
  if (userPlayer) {
    return session.players.find((player) => player !== userPlayer) ?? null;
  }

  return null;
}

export function findUserPlayer(session: GameSession, userName?: string): GameSessionPlayer | null {
  const normalizedUserName = normalizePlayerIdentityName(userName);
  if (!normalizedUserName) {
    return session.players.find((player) => player.isUser === true) ?? null;
  }

  return (
    session.players.find((player) => normalizePlayerIdentityName(player.name) === normalizedUserName) ??
    session.players.find((player) => player.isUser === true) ??
    null
  );
}

function toGameSessionPlayer(player: unknown): GameSessionPlayer | null {
  if (!isRecord(player)) {
    return null;
  }

  const rawName = player.name ?? player.nickname ?? player.displayName;
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    return null;
  }

  const rawResult = typeof player.result === "string" ? player.result : undefined;

  return {
    name: rawName.trim(),
    race: extractPlayerRace(player),
    mmr: extractOptionalMmr(player),
    battleTag: extractBattleTag(player),
    profileLink: extractProfileLink(player),
    result: normalizeResult(rawResult),
    isUser: typeof player.isUser === "boolean" ? player.isUser : undefined
  };
}

function extractPlayerRace(player: Record<string, unknown>): Race {
  return firstKnownRace(
    player.race,
    player.playedRace,
    player.actualRace,
    player.raceActual,
    player.selectedRace,
    player.raceSelected,
    player.type
  );
}

function extractBattleTag(player: Record<string, unknown>): string | undefined {
  return findBattleTag(player, 3);
}

function findBattleTag(value: unknown, depth: number): string | undefined {
  if (depth < 0 || !isRecord(value)) {
    return undefined;
  }

  for (const [key, candidate] of Object.entries(value)) {
    if (!isBattleTagLikeKey(key)) {
      continue;
    }

    const battleTag = typeof candidate === "string" ? normalizeBattleTag(candidate) : undefined;
    if (battleTag) {
      return battleTag;
    }
  }

  for (const candidate of Object.values(value)) {
    if (!isRecord(candidate) && !Array.isArray(candidate)) {
      continue;
    }

    const battleTag = findBattleTag(candidate, depth - 1);
    if (battleTag) {
      return battleTag;
    }
  }

  return undefined;
}

function isBattleTagLikeKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === "battletag" || (normalized.includes("battle") && normalized.includes("tag"));
}

function firstKnownRace(...values: readonly unknown[]): Race {
  for (const value of values) {
    const race = normalizeRace(value);
    if (race !== "Unknown") {
      return race;
    }
  }

  return "Unknown";
}

function normalizeResult(value: string | undefined): GameSessionPlayer["result"] {
  if (!value) {
    return "Unknown";
  }

  if (value === "Victory" || value === "Defeat" || value === "Undecided") {
    return value;
  }

  return "Unknown";
}

function buildSessionId(players: readonly GameSessionPlayer[], payload: Sc2ClientGamePayload, detectedAt: string): string {
  const playerKey = players
    .map((player) => (player.profileLink ?? player.name).trim().toLowerCase())
    .sort()
    .join("|");
  const timeKey = startedAtFromPayload(payload, detectedAt) ?? "no-start";
  return `${playerKey}:${timeKey}`;
}

function startedAtFromPayload(payload: Sc2ClientGamePayload, detectedAt: string): string | undefined {
  if (typeof payload.displayTime !== "number" || !Number.isFinite(payload.displayTime)) {
    return undefined;
  }

  const detectedAtMs = Date.parse(detectedAt);
  if (!Number.isFinite(detectedAtMs)) {
    return undefined;
  }

  const detectedAtSecondMs = Math.floor(detectedAtMs / 1000) * 1000;
  const startedAtMs = detectedAtSecondMs - Math.max(0, Math.floor(payload.displayTime)) * 1000;
  return new Date(startedAtMs).toISOString();
}

function normalizePlayerIdentityName(value: string | undefined): string {
  return (value ?? "")
    .replace(/^(?:<[^>]+>\s*)+/, "")
    .replace(/(?:\s*<[^>]+>)+$/, "")
    .replace(/#\d+$/, "")
    .trim()
    .toLowerCase();
}

function normalizeOptionalMmr(value: unknown): number | undefined {
  const numericValue = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof numericValue !== "number" || !Number.isFinite(numericValue) || numericValue <= 0) {
    return undefined;
  }

  return Math.round(numericValue);
}

function extractOptionalMmr(player: Record<string, unknown>): number | undefined {
  const direct =
    normalizeOptionalMmr(player.mmr) ??
    normalizeOptionalMmr(player.MMR) ??
    normalizeOptionalMmr(player.rating) ??
    normalizeOptionalMmr(player.ladderMmr) ??
    normalizeOptionalMmr(player.ladderMMR) ??
    normalizeOptionalMmr(player.oneVsOneMmr) ??
    normalizeOptionalMmr(player.currentMmr);
  if (direct !== undefined) {
    return direct;
  }

  return findNestedMmr(player, 2);
}

function findNestedMmr(value: unknown, depth: number): number | undefined {
  if (depth < 0 || !isRecord(value)) {
    return undefined;
  }

  for (const [key, candidate] of Object.entries(value)) {
    if (isMmrLikeKey(key)) {
      const mmr = normalizeOptionalMmr(candidate);
      if (mmr !== undefined) {
        return mmr;
      }
    }
  }

  for (const candidate of Object.values(value)) {
    if (!isRecord(candidate) && !Array.isArray(candidate)) {
      continue;
    }

    const mmr = findNestedMmr(candidate, depth - 1);
    if (mmr !== undefined) {
      return mmr;
    }
  }

  return undefined;
}

function isMmrLikeKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === "mmr" || normalized === "rating" || normalized.endsWith("mmr");
}

function extractProfileLink(player: Record<string, unknown>): string | undefined {
  return findProfileLink(player, 3) ?? profileLinkFromToon(findToon(player, 3));
}

function findProfileLink(value: unknown, depth: number): string | undefined {
  if (depth < 0 || !isRecord(value)) {
    return undefined;
  }

  for (const candidate of Object.values(value)) {
    if (typeof candidate !== "string") {
      continue;
    }

    const normalized = normalizeProfileLink(candidate);
    if (normalized) {
      return normalized;
    }
  }

  for (const candidate of Object.values(value)) {
    if (!isRecord(candidate) && !Array.isArray(candidate)) {
      continue;
    }

    const profileLink = findProfileLink(candidate, depth - 1);
    if (profileLink) {
      return profileLink;
    }
  }

  return undefined;
}

function findToon(value: unknown, depth: number): string | undefined {
  if (depth < 0 || !isRecord(value)) {
    return undefined;
  }

  for (const candidate of Object.values(value)) {
    if (typeof candidate !== "string") {
      continue;
    }

    if (/^\d+-S2-\d+-\d+$/.test(candidate.trim())) {
      return candidate.trim();
    }
  }

  for (const candidate of Object.values(value)) {
    if (!isRecord(candidate) && !Array.isArray(candidate)) {
      continue;
    }

    const toon = findToon(candidate, depth - 1);
    if (toon) {
      return toon;
    }
  }

  return undefined;
}

function normalizeProfileLink(value: string): string | undefined {
  const trimmed = value.trim();
  const battlenetMatch = trimmed.match(/battlenet::\/\/starcraft\/profile\/\d+\/\d+/i);
  if (battlenetMatch?.[0]) {
    return battlenetMatch[0].replace(/^battlenet/i, "battlenet");
  }

  const webMatch = trimmed.match(/https?:\/\/starcraft2\.blizzard\.com\/profile\/\d+\/\d+\/\d+/i);
  return webMatch?.[0];
}

function profileLinkFromToon(toon: string | undefined): string | undefined {
  const match = toon?.match(/^(\d+)-S2-\d+-(\d+)$/);
  if (!match) {
    return undefined;
  }

  const [, region, profileId] = match;
  return region && profileId ? `battlenet:://starcraft/profile/${region}/${profileId}` : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
