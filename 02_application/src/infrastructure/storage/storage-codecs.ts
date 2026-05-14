import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import type { Match, MatchResult } from "../../domain/entities/match.js";
import type { Opponent } from "../../domain/entities/opponent.js";
import { normalizeRace, type Race } from "../../domain/value-objects/race.js";

type CsvRecord = Record<string, string>;

const csvColumns = {
  opponents: [
    "id",
    "nickname",
    "revealedNickname",
    "race",
    "raceProfiles",
    "battleTag",
    "aliases",
    "mmrAtLastMatch",
    "league",
    "encounters",
    "wins",
    "losses",
    "lastMatchDate",
    "notes",
    "strategyTags",
    "confidenceScore",
    "createdAt",
    "updatedAt"
  ],
  matches: [
    "id",
    "opponentId",
    "playedAt",
    "map",
    "playerRace",
    "opponentRace",
    "result",
    "mmrBefore",
    "mmrAfter",
    "durationSeconds",
    "replayPath",
    "favorite",
    "notes",
    "createdAt",
    "updatedAt"
  ]
} as const;

export function opponentsToCsv(opponents: readonly Opponent[]): string {
  return stringify(opponents.map(opponentToCsvRecord), {
    header: true,
    columns: csvColumns.opponents
  });
}

export function opponentsFromCsv(content: string): readonly Opponent[] {
  if (!content.trim()) {
    return [];
  }

  const records = parse(content, {
    columns: true,
    skip_empty_lines: true
  }) as CsvRecord[];

  return records.map(opponentFromCsvRecord);
}

export function matchesToCsv(matches: readonly Match[]): string {
  return stringify(matches.map(matchToCsvRecord), {
    header: true,
    columns: csvColumns.matches
  });
}

export function matchesFromCsv(content: string): readonly Match[] {
  if (!content.trim()) {
    return [];
  }

  const records = parse(content, {
    columns: true,
    skip_empty_lines: true
  }) as CsvRecord[];

  return records.map(matchFromCsvRecord);
}

export function opponentsToXml(opponents: readonly Opponent[]): string {
  return xmlBuilder().build({
    opponents: {
      opponent: opponents.map(opponentToXmlRecord)
    }
  });
}

export function opponentsFromXml(content: string): readonly Opponent[] {
  if (!content.trim()) {
    return [];
  }

  const parsed = xmlParser().parse(content) as { opponents?: { opponent?: unknown } };
  return toArray(parsed.opponents?.opponent).map(opponentFromXmlRecord);
}

export function matchesToXml(matches: readonly Match[]): string {
  return xmlBuilder().build({
    matches: {
      match: matches.map(matchToXmlRecord)
    }
  });
}

export function matchesFromXml(content: string): readonly Match[] {
  if (!content.trim()) {
    return [];
  }

  const parsed = xmlParser().parse(content) as { matches?: { match?: unknown } };
  return toArray(parsed.matches?.match).map(matchFromXmlRecord);
}

function opponentToCsvRecord(opponent: Opponent): CsvRecord {
  return {
    id: opponent.id,
    nickname: opponent.nickname,
    revealedNickname: opponent.revealedNickname ?? "",
    race: opponent.race,
    raceProfiles: JSON.stringify(opponent.raceProfiles ?? {}),
    battleTag: opponent.battleTag ?? "",
    aliases: JSON.stringify(opponent.aliases),
    mmrAtLastMatch: numberToString(opponent.mmrAtLastMatch),
    league: opponent.league ?? "",
    encounters: String(opponent.encounters),
    wins: String(opponent.wins),
    losses: String(opponent.losses),
    lastMatchDate: opponent.lastMatchDate ?? "",
    notes: JSON.stringify(opponent.notes),
    strategyTags: JSON.stringify(opponent.strategyTags),
    confidenceScore: numberToString(opponent.confidenceScore),
    createdAt: opponent.createdAt,
    updatedAt: opponent.updatedAt
  };
}

function opponentFromCsvRecord(record: CsvRecord): Opponent {
  return {
    id: record.id,
    nickname: record.nickname,
    revealedNickname: emptyToUndefined(record.revealedNickname),
    race: normalizeRace(record.race),
    raceProfiles: parseRaceProfiles(record.raceProfiles),
    battleTag: emptyToUndefined(record.battleTag),
    aliases: parseJsonStringArray(record.aliases),
    mmrAtLastMatch: parseOptionalNumber(record.mmrAtLastMatch),
    league: emptyToUndefined(record.league),
    encounters: parseRequiredNumber(record.encounters),
    wins: parseRequiredNumber(record.wins),
    losses: parseRequiredNumber(record.losses),
    lastMatchDate: emptyToUndefined(record.lastMatchDate),
    notes: parseJsonStringArray(record.notes),
    strategyTags: parseJsonStringArray(record.strategyTags),
    confidenceScore: parseOptionalNumber(record.confidenceScore),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function matchToCsvRecord(match: Match): CsvRecord {
  return {
    id: match.id,
    opponentId: match.opponentId,
    playedAt: match.playedAt,
    map: match.map ?? "",
    playerRace: match.playerRace,
    opponentRace: match.opponentRace,
    result: match.result,
    mmrBefore: numberToString(match.mmrBefore),
    mmrAfter: numberToString(match.mmrAfter),
    durationSeconds: numberToString(match.durationSeconds),
    replayPath: match.replayPath ?? "",
    favorite: match.favorite ? "true" : "false",
    notes: JSON.stringify(match.notes),
    createdAt: match.createdAt,
    updatedAt: match.updatedAt
  };
}

function matchFromCsvRecord(record: CsvRecord): Match {
  return {
    id: record.id,
    opponentId: record.opponentId,
    playedAt: record.playedAt,
    map: emptyToUndefined(record.map),
    playerRace: normalizeRace(record.playerRace),
    opponentRace: normalizeRace(record.opponentRace),
    result: normalizeMatchResult(record.result),
    mmrBefore: parseOptionalNumber(record.mmrBefore),
    mmrAfter: parseOptionalNumber(record.mmrAfter),
    durationSeconds: parseOptionalNumber(record.durationSeconds),
    replayPath: emptyToUndefined(record.replayPath),
    favorite: parseBoolean(record.favorite),
    notes: parseJsonStringArray(record.notes),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function opponentToXmlRecord(opponent: Opponent): object {
  return {
    ...opponent,
    revealedNickname: opponent.revealedNickname ?? "",
    raceProfiles: JSON.stringify(opponent.raceProfiles ?? {}),
    battleTag: opponent.battleTag ?? "",
    aliases: { item: opponent.aliases },
    mmrAtLastMatch: opponent.mmrAtLastMatch ?? "",
    league: opponent.league ?? "",
    lastMatchDate: opponent.lastMatchDate ?? "",
    notes: { item: opponent.notes },
    strategyTags: { item: opponent.strategyTags },
    confidenceScore: opponent.confidenceScore ?? ""
  };
}

function opponentFromXmlRecord(value: unknown): Opponent {
  const record = asRecord(value);

  return {
    id: stringValue(record.id),
    nickname: stringValue(record.nickname),
    revealedNickname: emptyToUndefined(stringValue(record.revealedNickname)),
    race: normalizeRace(record.race),
    raceProfiles: parseRaceProfiles(stringValue(record.raceProfiles)),
    battleTag: emptyToUndefined(stringValue(record.battleTag)),
    aliases: xmlItems(record.aliases),
    mmrAtLastMatch: parseOptionalNumber(stringValue(record.mmrAtLastMatch)),
    league: emptyToUndefined(stringValue(record.league)),
    encounters: parseRequiredNumber(stringValue(record.encounters)),
    wins: parseRequiredNumber(stringValue(record.wins)),
    losses: parseRequiredNumber(stringValue(record.losses)),
    lastMatchDate: emptyToUndefined(stringValue(record.lastMatchDate)),
    notes: xmlItems(record.notes),
    strategyTags: xmlItems(record.strategyTags),
    confidenceScore: parseOptionalNumber(stringValue(record.confidenceScore)),
    createdAt: stringValue(record.createdAt),
    updatedAt: stringValue(record.updatedAt)
  };
}

function matchToXmlRecord(match: Match): object {
  return {
    ...match,
    map: match.map ?? "",
    mmrBefore: match.mmrBefore ?? "",
    mmrAfter: match.mmrAfter ?? "",
    durationSeconds: match.durationSeconds ?? "",
    replayPath: match.replayPath ?? "",
    favorite: match.favorite ? "true" : "false",
    notes: { item: match.notes }
  };
}

function matchFromXmlRecord(value: unknown): Match {
  const record = asRecord(value);

  return {
    id: stringValue(record.id),
    opponentId: stringValue(record.opponentId),
    playedAt: stringValue(record.playedAt),
    map: emptyToUndefined(stringValue(record.map)),
    playerRace: normalizeRace(record.playerRace),
    opponentRace: normalizeRace(record.opponentRace),
    result: normalizeMatchResult(stringValue(record.result)),
    mmrBefore: parseOptionalNumber(stringValue(record.mmrBefore)),
    mmrAfter: parseOptionalNumber(stringValue(record.mmrAfter)),
    durationSeconds: parseOptionalNumber(stringValue(record.durationSeconds)),
    replayPath: emptyToUndefined(stringValue(record.replayPath)),
    favorite: parseBoolean(stringValue(record.favorite)),
    notes: xmlItems(record.notes),
    createdAt: stringValue(record.createdAt),
    updatedAt: stringValue(record.updatedAt)
  };
}

function xmlParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: true
  });
}

function xmlBuilder(): XMLBuilder {
  return new XMLBuilder({
    format: true,
    ignoreAttributes: false,
    suppressEmptyNode: false
  });
}

function numberToString(value: number | undefined): string {
  return typeof value === "number" ? String(value) : "";
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim() ? value : undefined;
}

function parseRequiredNumber(value: string): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected finite number, got "${value}".`);
  }

  return parsed;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBoolean(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "yes";
}

function parseJsonStringArray(value: string | undefined): readonly string[] {
  if (!value) {
    return [];
  }

  const parsed = JSON.parse(value) as unknown;
  return toArray(parsed).map(stringValue).filter(Boolean);
}

function parseRaceProfiles(value: string | undefined): Opponent["raceProfiles"] {
  if (!value) {
    return undefined;
  }

  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const profiles: Partial<Record<Race, NonNullable<Opponent["raceProfiles"]>[Race]>> = {};
  const record = parsed as Record<string, unknown>;

  for (const [rawRace, rawProfile] of Object.entries(record)) {
    const race = normalizeRace(rawRace);
    const profileRecord = asRecord(rawProfile);
    const updatedAt = stringValue(profileRecord.updatedAt);

    profiles[race] = {
      mmrAtLastMatch: parseOptionalNumber(stringValue(profileRecord.mmrAtLastMatch)),
      league: emptyToUndefined(stringValue(profileRecord.league)),
      totalGamesAtLastMatch: parseOptionalNumber(stringValue(profileRecord.totalGamesAtLastMatch)),
      strategyTags: parseJsonStringArray(JSON.stringify(toArray(profileRecord.strategyTags))),
      confidenceScore: parseOptionalNumber(stringValue(profileRecord.confidenceScore)),
      updatedAt: updatedAt || new Date(0).toISOString()
    };
  }

  return profiles;
}

function normalizeMatchResult(value: string): MatchResult {
  if (value === "win" || value === "loss" || value === "unknown") {
    return value;
  }

  return "unknown";
}

function xmlItems(value: unknown): readonly string[] {
  const record = asRecord(value);
  return toArray(record.item).map(stringValue).filter(Boolean);
}

function toArray(value: unknown): readonly unknown[] {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return {};
  }

  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value);
}
