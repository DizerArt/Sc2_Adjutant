import type {
  OpponentDataCandidate,
  OpponentDataSourcePort,
  OpponentSearchQuery
} from "../../domain/ports/opponent-data-source-port.js";
import { isBarcodeNickname, isExactBarcodeCandidate } from "../../domain/value-objects/barcode.js";
import { normalizeRace, type Race } from "../../domain/value-objects/race.js";
import { ExternalSourceError } from "../../shared/errors/external-source-error.js";
import { HttpJsonClient } from "../http/http-json-client.js";

export const DEFAULT_SC2_PULSE_BASE_URL = "https://sc2pulse.nephest.com/sc2/api";

const SC2_PULSE_PROFILE_BASE_URL = "https://sc2pulse.nephest.com/sc2";

const LEAGUE_NAMES = ["Bronze", "Silver", "Gold", "Platinum", "Diamond", "Master", "Grandmaster"] as const;

export type Sc2PulseAdapterOptions = {
  readonly baseUrl?: string;
  readonly httpClient?: HttpJsonClient;
  readonly maxResults?: number;
};

type Sc2PulseStats = {
  readonly rating?: number | null;
  readonly gamesPlayed?: number | null;
  readonly rank?: number | null;
};

type Sc2PulseCharacter = {
  readonly id?: number | null;
  readonly name?: string | null;
  readonly tag?: string | null;
  readonly region?: string | null;
  readonly realm?: number | null;
};

type Sc2PulseAccount = {
  readonly battleTag?: string | null;
  readonly tag?: string | null;
};

type Sc2PulseClan = {
  readonly tag?: string | null;
  readonly name?: string | null;
};

type Sc2PulseRaceGames = Partial<Record<"TERRAN" | "PROTOSS" | "ZERG" | "RANDOM", number>>;

type Sc2PulseMembers = {
  readonly character?: Sc2PulseCharacter | null;
  readonly account?: Sc2PulseAccount | null;
  readonly clan?: Sc2PulseClan | null;
  readonly proId?: number | null;
  readonly proNickname?: string | null;
  readonly raceGames?: Sc2PulseRaceGames | null;
  readonly terranGamesPlayed?: number | null;
  readonly protossGamesPlayed?: number | null;
  readonly zergGamesPlayed?: number | null;
  readonly randomGamesPlayed?: number | null;
};

type Sc2PulseLadderDistinctCharacter = {
  readonly leagueMax?: number | null;
  readonly ratingMax?: number | null;
  readonly totalGamesPlayed?: number | null;
  readonly previousStats?: Sc2PulseStats | null;
  readonly currentStats?: Sc2PulseStats | null;
  readonly members?: Sc2PulseMembers | null;
};

type Sc2PulseTeamLeague = {
  readonly type?: number | null;
  readonly queueType?: number | null;
  readonly teamType?: number | null;
};

type Sc2PulseTeam = {
  readonly rating?: number | null;
  readonly wins?: number | null;
  readonly losses?: number | null;
  readonly ties?: number | null;
  readonly lastPlayed?: string | null;
  readonly league?: Sc2PulseTeamLeague | null;
  readonly members?: readonly Sc2PulseMembers[] | null;
};

type CharacterCommonSummary = {
  readonly rating: number;
  readonly leagueType?: number;
  readonly totalGames?: number;
  readonly race?: Race;
};

type CandidateEntry = {
  readonly entry: Sc2PulseLadderDistinctCharacter;
  readonly candidate: OpponentDataCandidate;
};

const ONE_VS_ONE_QUEUE_TYPE = 201;
const ARRANGED_TEAM_TYPE = 0;

export class Sc2PulseAdapter implements OpponentDataSourcePort {
  readonly sourceName = "SC2Pulse";

  private readonly baseUrl: string;
  private readonly httpClient: HttpJsonClient;
  private readonly maxResults: number;

  constructor(options: Sc2PulseAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_SC2_PULSE_BASE_URL).replace(/\/+$/, "");
    this.httpClient =
      options.httpClient ??
      new HttpJsonClient({
        timeoutMs: 5000,
        retryCount: 1,
        retryDelayMs: 500,
        minIntervalMs: 250
      });
    this.maxResults = options.maxResults ?? 5;
  }

  async searchOpponent(query: OpponentSearchQuery): Promise<readonly OpponentDataCandidate[]> {
    const trimmedNickname = query.nickname.trim();
    const trimmedProfileLink = query.profileLink?.trim();
    const lookupText = trimmedProfileLink || trimmedNickname;
    if (!lookupText) {
      return [];
    }
    const lookupQuery = trimmedProfileLink
      ? {
        ...query,
        nickname: trimmedProfileLink
      }
      : query;

    const url = `${this.baseUrl}/characters?query=${encodeURIComponent(lookupText)}`;
    const response = await this.httpClient.getJson<unknown>(url);

    const responseEntries = normalizeCharacterSearchResponse(response);
    if (!responseEntries) {
      throw new ExternalSourceError(
        "SC2_PULSE_INVALID_RESPONSE",
        "SC2Pulse character search response was not a character entry or array."
      );
    }

    const isBarcodeQuery = !trimmedProfileLink && isBarcodeNickname(trimmedNickname);
    const entries: CandidateEntry[] = [];

    for (const entry of responseEntries) {
      const candidate = mapEntryToCandidate(entry, lookupQuery);
      if (!candidate) {
        continue;
      }
      if (isBarcodeQuery && !isSafeBarcodeCandidate(trimmedNickname, candidate)) {
        continue;
      }
      entries.push({ entry, candidate });
    }

    const sorted = [...preferRequestedRegion(entries, query.region)]
      .sort((first, second) => compareCandidates(first.candidate, second.candidate))
      .slice(0, this.maxResults);

    await this.backfillRaceAwareMmr(sorted, lookupQuery);

    return sorted.map((item) => item.candidate);
  }

  private async backfillRaceAwareMmr(entries: CandidateEntry[], query: OpponentSearchQuery): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const top = entries[0];
    const needsRaceSpecificLookup =
      isProfileLookup(query.nickname) &&
      query.race !== undefined &&
      query.race !== "Unknown" &&
      query.race !== "Random";

    if (typeof top.candidate.mmr === "number" && !needsRaceSpecificLookup) {
      return;
    }

    const characterId = numberValue(top.entry.members?.character?.id);
    if (typeof characterId !== "number") {
      return;
    }

    // SC2Pulse's `/characters` search returns a single aggregate for the
    // character. Barcode profile lookups can be against an off-race replay, so
    // use `/character/{id}/common` to pick the 1v1 team for the observed race.
    const summary = await this.fetchCharacterCommonSummary(characterId, query.race);
    if (!summary) {
      return;
    }

    const enriched = mapEntryToCandidate(top.entry, query, summary);
    if (!enriched) {
      return;
    }

    entries[0] = { entry: top.entry, candidate: enriched };
  }

  private async fetchCharacterCommonSummary(
    characterId: number,
    requestedRace?: Race
  ): Promise<CharacterCommonSummary | null> {
    try {
      const url = `${this.baseUrl}/character/${characterId}/common`;
      const payload = await this.httpClient.getJson<unknown>(url);
      return summarizeCharacterCommon(payload, requestedRace);
    } catch {
      return null;
    }
  }
}

function normalizeCharacterSearchResponse(
  response: unknown
): readonly Sc2PulseLadderDistinctCharacter[] | null {
  if (Array.isArray(response)) {
    return response as readonly Sc2PulseLadderDistinctCharacter[];
  }

  if (isSc2PulseCharacterEntry(response)) {
    return [response];
  }

  return null;
}

function isSc2PulseCharacterEntry(value: unknown): value is Sc2PulseLadderDistinctCharacter {
  if (!isRecord(value)) {
    return false;
  }

  return isRecord(value.members) && isRecord(value.members.character);
}

function mapEntryToCandidate(
  entry: Sc2PulseLadderDistinctCharacter,
  query: OpponentSearchQuery,
  commonSummary?: CharacterCommonSummary
): OpponentDataCandidate | null {
  const members = entry.members;
  if (!members || !members.character) {
    return null;
  }

  const character = members.character;
  const account = members.account ?? null;

  const characterTag = pickCharacterTag(character);
  if (!characterTag) {
    return null;
  }

  const baseRace = pickDominantRace(members);
  const dominantRace = commonSummary?.race ?? (baseRace !== "Unknown" ? baseRace : commonSummary?.race ?? baseRace);
  const candidateRegion = normalizeCandidateRegion(character.region);
  const battleTag = nonEmptyString(account?.battleTag);
  const accountTag = nonEmptyString(account?.tag);
  const proNickname = nonEmptyString(members.proNickname);
  const preferredNickname =
    isProfileLookup(query.nickname) && isBarcodeNickname(characterTag) && (proNickname || accountTag)
      ? (proNickname ?? accountTag ?? characterTag)
      : characterTag;
  const aliases = uniqueAliases(preferredNickname, [characterTag, character.name, accountTag, proNickname]);

  const currentRating = numberValue(entry.currentStats?.rating);
  const previousRating = numberValue(entry.previousStats?.rating);
  const ratingMax = numberValue(entry.ratingMax);
  const shouldPreferCommonStats =
    commonSummary !== undefined &&
    isProfileLookup(query.nickname) &&
    query.race !== undefined &&
    query.race !== "Unknown" &&
    query.race !== "Random";
  const mmr = shouldPreferCommonStats
    ? commonSummary.rating ?? currentRating ?? previousRating ?? ratingMax
    : currentRating ?? previousRating ?? ratingMax ?? commonSummary?.rating;
  const league = shouldPreferCommonStats
    ? leagueLabel(commonSummary.leagueType) ?? leagueLabel(numberValue(entry.leagueMax))
    : leagueLabel(numberValue(entry.leagueMax)) ?? leagueLabel(commonSummary?.leagueType);
  const totalGames = shouldPreferCommonStats
    ? commonSummary.totalGames ?? totalGamesPlayed(entry, members)
    : totalGamesPlayed(entry, members) ?? commonSummary?.totalGames;
  const profileUrl = profileUrlFromCharacter(character);

  const baseHasRecentStats =
    typeof entry.currentStats?.rating === "number" ||
    typeof entry.previousStats?.rating === "number" ||
    (typeof entry.currentStats?.gamesPlayed === "number" && entry.currentStats.gamesPlayed > 0) ||
    (typeof entry.previousStats?.gamesPlayed === "number" && entry.previousStats.gamesPlayed > 0);

  const confidenceScore = computeConfidence({
    queryNickname: query.nickname.trim().toLowerCase(),
    isProfileLookup: isProfileLookup(query.nickname),
    characterTag: characterTag.toLowerCase(),
    accountTag: accountTag?.toLowerCase(),
    queryRace: query.race,
    candidateRace: dominantRace,
    queryRegion: query.region,
    candidateRegion,
    hasRevealed: Boolean(proNickname),
    hasStableIdentifier: Boolean(battleTag || profileUrl),
    hasMmr: typeof mmr === "number",
    hasRecentStats: baseHasRecentStats || commonSummary !== undefined
  });

  return {
    source: "SC2Pulse",
    nickname: preferredNickname,
    race: dominantRace,
    region: candidateRegion,
    battleTag,
    aliases,
    mmr,
    league,
    totalGames,
    profileUrl,
    confidenceScore
  };
}

function summarizeCharacterCommon(payload: unknown, requestedRace?: Race): CharacterCommonSummary | null {
  if (!isRecord(payload)) {
    return null;
  }

  const teams = Array.isArray(payload.teams) ? payload.teams : [];
  const usableTeams: { readonly team: Sc2PulseTeam; readonly race: Race; readonly lastPlayed: number }[] = [];

  for (const raw of teams) {
    if (!isRecord(raw)) {
      continue;
    }

    const team = raw as Sc2PulseTeam;
    if (!isOneVsOneLadderTeam(team)) {
      continue;
    }

    if (typeof numberValue(team.rating) !== "number") {
      continue;
    }

    const parsedLastPlayed = team.lastPlayed ? Date.parse(team.lastPlayed) : Number.NaN;
    const lastPlayed = Number.isFinite(parsedLastPlayed) ? parsedLastPlayed : 0;
    const member = team.members?.[0];
    const memberRace = member ? pickDominantRace(member) : "Unknown";

    usableTeams.push({ team, race: memberRace, lastPlayed });
  }

  if (usableTeams.length === 0) {
    return null;
  }

  const raceSpecificTeams = requestedRace && requestedRace !== "Unknown" && requestedRace !== "Random"
    ? usableTeams.filter((entry) => entry.race === requestedRace)
    : [];
  const best = [...(raceSpecificTeams.length > 0 ? raceSpecificTeams : usableTeams)]
    .sort((first, second) => second.lastPlayed - first.lastPlayed)[0];
  const bestTeam = best?.team;
  if (!best || !bestTeam) {
    return null;
  }
  const rating = numberValue(bestTeam.rating);
  if (typeof rating !== "number") {
    return null;
  }

  const wins = numberValue(bestTeam.wins) ?? 0;
  const losses = numberValue(bestTeam.losses) ?? 0;
  const ties = numberValue(bestTeam.ties) ?? 0;
  const playedTotal = wins + losses + ties;

  return {
    rating,
    leagueType: numberValue(bestTeam.league?.type),
    totalGames: playedTotal > 0 ? playedTotal : undefined,
    race: best.race !== "Unknown" ? best.race : undefined
  };
}

function isOneVsOneLadderTeam(team: Sc2PulseTeam): boolean {
  const league = team.league;
  if (!league) {
    return false;
  }

  return numberValue(league.queueType) === ONE_VS_ONE_QUEUE_TYPE && numberValue(league.teamType) === ARRANGED_TEAM_TYPE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSafeBarcodeCandidate(queryNickname: string, candidate: OpponentDataCandidate): boolean {
  const hasStableIdentifier = Boolean(candidate.battleTag || candidate.profileUrl);

  return hasStableIdentifier && isExactBarcodeCandidate(queryNickname, candidate.nickname);
}

function preferRequestedRegion(
  entries: readonly CandidateEntry[],
  requestedRegion: OpponentSearchQuery["region"] | undefined
): readonly CandidateEntry[] {
  if (!requestedRegion || requestedRegion === "Unknown") {
    return entries;
  }

  const exactRegionMatches = entries.filter((entry) => entry.candidate.region === requestedRegion);
  return exactRegionMatches.length > 0 ? exactRegionMatches : entries;
}

function compareCandidates(first: OpponentDataCandidate, second: OpponentDataCandidate): number {
  return second.confidenceScore - first.confidenceScore;
}

function isProfileLookup(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("battlenet:://starcraft/profile/") || normalized.includes("starcraft2.blizzard.com/profile/");
}

function pickCharacterTag(character: Sc2PulseCharacter): string {
  const tag = nonEmptyString(character.tag);
  if (tag) {
    return tag;
  }

  const name = nonEmptyString(character.name);
  if (!name) {
    return "";
  }

  const hashIndex = name.indexOf("#");
  return hashIndex > 0 ? name.slice(0, hashIndex) : name;
}

function pickDominantRace(members: Sc2PulseMembers): Race {
  const fromRaceGames = members.raceGames ?? null;
  const counts: Record<"TERRAN" | "PROTOSS" | "ZERG" | "RANDOM", number> = {
    TERRAN: numberValue(fromRaceGames?.TERRAN) ?? numberValue(members.terranGamesPlayed) ?? 0,
    PROTOSS: numberValue(fromRaceGames?.PROTOSS) ?? numberValue(members.protossGamesPlayed) ?? 0,
    ZERG: numberValue(fromRaceGames?.ZERG) ?? numberValue(members.zergGamesPlayed) ?? 0,
    RANDOM: numberValue(fromRaceGames?.RANDOM) ?? numberValue(members.randomGamesPlayed) ?? 0
  };

  let bestKey: keyof typeof counts | null = null;
  let bestCount = 0;

  for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
    const count = counts[key];
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }

  if (bestKey === null) {
    return "Unknown";
  }

  return normalizeRace(bestKey);
}

function totalGamesPlayed(entry: Sc2PulseLadderDistinctCharacter, members: Sc2PulseMembers): number | undefined {
  const explicitTotal = numberValue(entry.totalGamesPlayed);
  if (typeof explicitTotal === "number") {
    return explicitTotal;
  }

  const fromRaceGames = members.raceGames ?? null;
  if (fromRaceGames) {
    const raceGameTotal =
      (numberValue(fromRaceGames.TERRAN) ?? 0) +
      (numberValue(fromRaceGames.PROTOSS) ?? 0) +
      (numberValue(fromRaceGames.ZERG) ?? 0) +
      (numberValue(fromRaceGames.RANDOM) ?? 0);

    if (raceGameTotal > 0) {
      return raceGameTotal;
    }
  }

  const memberTotal =
    (numberValue(members.terranGamesPlayed) ?? 0) +
    (numberValue(members.protossGamesPlayed) ?? 0) +
    (numberValue(members.zergGamesPlayed) ?? 0) +
    (numberValue(members.randomGamesPlayed) ?? 0);

  return memberTotal > 0 ? memberTotal : undefined;
}

function profileUrlFromCharacter(character: Sc2PulseCharacter): string | undefined {
  if (typeof character.id !== "number" || !Number.isFinite(character.id)) {
    return undefined;
  }

  return `${SC2_PULSE_PROFILE_BASE_URL}/?type=character&id=${character.id}&m=1`;
}

function normalizeCandidateRegion(value: string | null | undefined): NonNullable<OpponentDataCandidate["region"]> {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "US" || normalized === "EU" || normalized === "KR" || normalized === "CN") {
    return normalized;
  }

  return "Unknown";
}

function leagueLabel(value: number | undefined): string | undefined {
  if (typeof value !== "number" || value < 0 || value >= LEAGUE_NAMES.length) {
    return undefined;
  }

  return LEAGUE_NAMES[value];
}

type ConfidenceInputs = {
  readonly queryNickname: string;
  readonly isProfileLookup: boolean;
  readonly characterTag: string;
  readonly accountTag?: string;
  readonly queryRace?: Race;
  readonly candidateRace: Race;
  readonly queryRegion?: OpponentSearchQuery["region"];
  readonly candidateRegion: string;
  readonly hasRevealed: boolean;
  readonly hasStableIdentifier: boolean;
  readonly hasMmr: boolean;
  readonly hasRecentStats: boolean;
};

function computeConfidence(inputs: ConfidenceInputs): number {
  let score = 0;

  if (inputs.isProfileLookup) {
    score += 0.5;
  }

  if (inputs.queryNickname.length > 0) {
    if (
      inputs.characterTag === inputs.queryNickname ||
      (inputs.accountTag !== undefined && inputs.accountTag === inputs.queryNickname)
    ) {
      score += 0.4;
    } else if (
      inputs.characterTag.includes(inputs.queryNickname) ||
      (inputs.accountTag !== undefined && inputs.accountTag.includes(inputs.queryNickname))
    ) {
      score += 0.2;
    }
  }

  if (inputs.queryRace && inputs.queryRace !== "Unknown" && inputs.candidateRace === inputs.queryRace) {
    score += 0.15;
  }

  if (
    inputs.queryRegion &&
    inputs.queryRegion !== "Unknown" &&
    inputs.candidateRegion.length > 0 &&
    inputs.queryRegion === inputs.candidateRegion
  ) {
    score += 0.15;
  }

  if (inputs.hasRevealed) {
    score += 0.1;
  }

  if (inputs.hasStableIdentifier && inputs.queryNickname.length > 0 && inputs.characterTag === inputs.queryNickname) {
    score += 0.1;
  }

  if (inputs.hasMmr && inputs.queryNickname.length > 0 && inputs.characterTag === inputs.queryNickname) {
    score += 0.1;
  }

  if (inputs.hasRecentStats) {
    score += 0.2;
  }

  if (score > 1) {
    score = 1;
  }

  return Number(score.toFixed(4));
}

function uniqueAliases(primary: string, candidates: readonly (string | null | undefined)[]): readonly string[] {
  const seen = new Set<string>([primary.toLowerCase()]);
  const result: string[] = [];

  for (const candidate of candidates) {
    const value = nonEmptyString(candidate);
    if (!value) {
      continue;
    }

    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(value);
  }

  return result;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return value;
}
