import {
  findOpponent,
  findUserPlayer,
  type GameSession,
  type GameSessionPlayer
} from "../../domain/entities/game-session.js";
import { createMatch, type Match, type MatchResult } from "../../domain/entities/match.js";
import {
  createOpponent,
  recordOpponentMatch,
  updateOpponentMatchResult,
  type Opponent
} from "../../domain/entities/opponent.js";
import type { MatchRepository } from "../../domain/repositories/match-repository.js";
import type { OpponentRepository } from "../../domain/repositories/opponent-repository.js";
import { isBarcodeNickname } from "../../domain/value-objects/barcode.js";
import { battleTagsMatch, normalizeBattleTagKey } from "../../domain/value-objects/battle-tag.js";
import { createStableEntityId } from "../../domain/value-objects/entity-id.js";

const SAME_RESOLVED_MATCH_WINDOW_MS = 60 * 1000;

export type RegisterDetectedGameInput = {
  readonly session: GameSession;
  readonly opponent?: GameSessionPlayer;
  readonly userName?: string;
};

export type RegisterDetectedGameResult = {
  readonly opponent: Opponent;
  readonly match: Match;
  readonly createdOpponent: boolean;
};

export type RegisterDetectedGameDependencies = {
  readonly opponentRepository: OpponentRepository;
  readonly matchRepository: MatchRepository;
  readonly clock?: () => string;
};

export class RegisterDetectedGame {
  private readonly clock: () => string;

  constructor(private readonly dependencies: RegisterDetectedGameDependencies) {
    this.clock = dependencies.clock ?? (() => new Date().toISOString());
  }

  async execute(input: RegisterDetectedGameInput): Promise<RegisterDetectedGameResult | null> {
    if (!input.session.isActive || input.session.mode !== "ranked-1v1") {
      return null;
    }

    const opponentPlayer = input.opponent ?? findOpponent(input.session, input.userName);
    const player = findPlayer(input.session, opponentPlayer, input.userName);

    if (!opponentPlayer || !player) {
      return null;
    }

    if (isLocalPlayer(opponentPlayer, player, input.userName)) {
      return null;
    }

    const opponentSample = sanitizeOpponentPlayerProfileLink(opponentPlayer, player);
    const now = this.clock();
    const opponentId = buildOpponentId(opponentSample, input.session);
    const firstExistingOpponent = await findExistingOpponent(
      this.dependencies.opponentRepository,
      opponentId,
      opponentSample
    );
    const firstEffectiveOpponentId = firstExistingOpponent?.id ?? opponentId;
    const result = resultFromPlayer(player.result);
    const detectedMatch = createMatch({
      id: buildMatchId(input.session),
      opponentId: firstEffectiveOpponentId,
      playedAt: input.session.startedAt ?? input.session.detectedAt,
      playerRace: player.race,
      opponentRace: opponentSample.race,
      result,
      now
    });
    const existingMatch =
      (await this.dependencies.matchRepository.findById(detectedMatch.id)) ??
      (await findReusableLiveMatch(
        this.dependencies.matchRepository,
        this.dependencies.opponentRepository,
        detectedMatch,
        opponentSample
      ));
    const matchOpponent =
      existingMatch && existingMatch.opponentId !== firstEffectiveOpponentId
        ? await this.dependencies.opponentRepository.findById(existingMatch.opponentId)
        : null;
    const existingOpponent = matchOpponent ?? firstExistingOpponent;
    const createdOpponent = existingOpponent === null;
    const effectiveOpponentId = existingMatch?.opponentId ?? existingOpponent?.id ?? opponentId;
    const baseOpponent = existingOpponent
      ? mergeLocalOpponentSample(existingOpponent, opponentSample, now)
      : createOpponent({
        id: effectiveOpponentId,
        nickname: opponentSample.name,
        race: opponentSample.race,
        battleTag: opponentSample.battleTag,
        mmrAtLastMatch: opponentSample.mmr,
        now
      });
    const match =
      detectedMatch.opponentId === effectiveOpponentId
        ? detectedMatch
        : {
          ...detectedMatch,
          opponentId: effectiveOpponentId,
          updatedAt: now
        };
    const nextMatch = existingMatch ? mergeDetectedMatch(existingMatch, match, now) : match;
    const updatedOpponent =
      existingMatch === null
        ? recordOpponentMatch(baseOpponent, nextMatch.result, nextMatch.playedAt, opponentSample.mmr)
        : updateOpponentMatchResult(baseOpponent, existingMatch.result, nextMatch.result);

    await this.dependencies.opponentRepository.save(updatedOpponent);
    await this.dependencies.matchRepository.save(nextMatch);

    return {
      opponent: updatedOpponent,
      match: nextMatch,
      createdOpponent
    };
  }
}

function isLocalPlayer(
  opponent: GameSessionPlayer,
  player: GameSessionPlayer,
  userName: string | undefined
): boolean {
  if (opponent.isUser === true) {
    return true;
  }

  const normalizedOpponent = normalizePlayerIdentityName(opponent.name);
  if (!normalizedOpponent) {
    return false;
  }

  const normalizedPlayer = normalizePlayerIdentityName(player.name);
  const normalizedUserName = normalizePlayerIdentityName(userName);

  return (
    Boolean(normalizedPlayer && normalizedOpponent === normalizedPlayer) ||
    Boolean(normalizedUserName && normalizedOpponent === normalizedUserName)
  );
}

function sanitizeOpponentPlayerProfileLink(
  opponent: GameSessionPlayer,
  player: GameSessionPlayer
): GameSessionPlayer {
  const opponentProfileLink = normalizeProfileLink(opponent.profileLink);
  const opponentBattleTag = safeOpponentBattleTag(opponent.battleTag, player.battleTag);
  const safeOpponent = opponentBattleTag === opponent.battleTag ? opponent : { ...opponent, battleTag: opponentBattleTag };

  if (!opponentProfileLink) {
    return safeOpponent;
  }

  return opponentProfileLink === normalizeProfileLink(player.profileLink)
    ? { ...safeOpponent, profileLink: undefined }
    : safeOpponent;
}

function safeOpponentBattleTag(
  opponentBattleTag: string | undefined,
  userBattleTag: string | undefined
): string | undefined {
  const normalizedOpponentBattleTag = normalizeBattleTagKey(opponentBattleTag);
  if (!normalizedOpponentBattleTag) {
    return undefined;
  }

  return normalizedOpponentBattleTag === normalizeBattleTagKey(userBattleTag) ? undefined : opponentBattleTag;
}

async function findReusableLiveMatch(
  matchRepository: MatchRepository,
  opponentRepository: OpponentRepository,
  detectedMatch: Match,
  opponentPlayer: GameSessionPlayer
): Promise<Match | null> {
  const matches = isBarcodeNickname(opponentPlayer.name)
    ? await findReusableBarcodeLiveMatches(matchRepository, opponentRepository, opponentPlayer)
    : await matchRepository.findByOpponentId(detectedMatch.opponentId);
  const detectedTime = Date.parse(detectedMatch.playedAt);

  if (!Number.isFinite(detectedTime)) {
    return null;
  }

  return (
    [...matches]
      .filter((match) => isLikelySameLiveMatch(match, detectedMatch, detectedTime))
      .sort((first, second) => replaylessDistance(first, detectedTime) - replaylessDistance(second, detectedTime))[0] ??
    null
  );
}

async function findReusableBarcodeLiveMatches(
  matchRepository: MatchRepository,
  opponentRepository: OpponentRepository,
  opponentPlayer: GameSessionPlayer
): Promise<readonly Match[]> {
  const [matches, opponents] = await Promise.all([
    matchRepository.findAll(),
    opponentRepository.findAll()
  ]);
  const matchingOpponentIds = new Set(
    opponents
      .filter((opponent) => opponentMatchesPlayerIdentity(opponent, opponentPlayer.name))
      .map((opponent) => opponent.id)
  );

  return matches.filter((match) => matchingOpponentIds.has(match.opponentId));
}

function isLikelySameLiveMatch(match: Match, detectedMatch: Match, detectedTime: number): boolean {
  if (match.id === detectedMatch.id || match.replayPath) {
    return false;
  }

  if (
    !racesAreCompatible(match.playerRace, detectedMatch.playerRace) ||
    !racesAreCompatible(match.opponentRace, detectedMatch.opponentRace)
  ) {
    return false;
  }

  const matchTime = Date.parse(match.playedAt);
  if (!Number.isFinite(matchTime)) {
    return false;
  }

  if (match.result !== "unknown" && detectedMatch.result !== "unknown") {
    return match.result === detectedMatch.result && Math.abs(detectedTime - matchTime) <= SAME_RESOLVED_MATCH_WINDOW_MS;
  }

  const withinSameGameWindow = Math.abs(detectedTime - matchTime) <= 45 * 60 * 1000;
  const unresolvedOrSameResult =
    match.result === "unknown" || detectedMatch.result === "unknown" || match.result === detectedMatch.result;

  return withinSameGameWindow && unresolvedOrSameResult;
}

function replaylessDistance(match: Match, detectedTime: number): number {
  const matchTime = Date.parse(match.playedAt);
  return Number.isFinite(matchTime) ? Math.abs(matchTime - detectedTime) : Number.POSITIVE_INFINITY;
}

function racesAreCompatible(first: Match["playerRace"], second: Match["playerRace"]): boolean {
  return first === second || first === "Unknown" || second === "Unknown";
}

function findPlayer(
  session: GameSession,
  opponent: GameSessionPlayer | null | undefined,
  userName?: string
): GameSessionPlayer | null {
  return findUserPlayer(session, userName);
}

function resultFromPlayer(result: GameSessionPlayer["result"]): MatchResult {
  if (result === "Victory") {
    return "win";
  }

  if (result === "Defeat") {
    return "loss";
  }

  return "unknown";
}

function buildOpponentId(opponent: GameSessionPlayer, session: GameSession): string {
  const battleTagKey = normalizeBattleTagKey(opponent.battleTag);
  if (battleTagKey) {
    return createStableEntityId("opponent", battleTagKey);
  }

  if (isBarcodeNickname(opponent.name) && opponent.profileLink) {
    return createStableEntityId("opponent", opponent.profileLink);
  }

  // Barcode nicknames (`IIIIIII`, `lllll`, ...) are visually identical for many
  // unrelated players. Anchor the id to the active game's start so the same
  // active game keeps the same id, but a future barcode game with the same
  // glyphs creates a fresh, separate record instead of colliding.
  if (isBarcodeNickname(opponent.name)) {
    const anchor = session.startedAt ?? session.detectedAt;
    return createStableEntityId("opponent", `${opponent.name}-${anchor}`);
  }
  return createStableEntityId("opponent", opponent.name);
}

function buildMatchId(session: GameSession): string {
  return createStableEntityId("match", session.id);
}

function normalizePlayerIdentityName(value: string | undefined): string {
  return (value ?? "")
    .replace(/^(?:<[^>]+>\s*)+/, "")
    .replace(/(?:\s*<[^>]+>)+$/, "")
    .replace(/#\d+$/, "")
    .trim()
    .toLowerCase();
}

function normalizeProfileLink(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function opponentMatchesPlayerIdentity(opponent: Opponent, playerName: string): boolean {
  const normalizedPlayerName = normalizePlayerIdentityName(playerName);
  if (!normalizedPlayerName) {
    return false;
  }

  return [opponent.nickname, ...opponent.aliases].some(
    (identity) => normalizePlayerIdentityName(identity) === normalizedPlayerName
  );
}

async function findExistingOpponent(
  repository: OpponentRepository,
  opponentId: string,
  opponentPlayer: GameSessionPlayer
): Promise<Opponent | null> {
  const byId = await repository.findById(opponentId);
  if (byId) {
    return byId;
  }

  const byBattleTag = await findExistingOpponentByBattleTag(repository, opponentPlayer.battleTag);
  if (byBattleTag) {
    return byBattleTag;
  }

  if (normalizeBattleTagKey(opponentPlayer.battleTag)) {
    return null;
  }

  // Barcode nicknames are not unique identifiers, so a name/alias lookup would
  // collide unrelated barcodes. Always create a fresh record for those.
  if (isBarcodeNickname(opponentPlayer.name)) {
    return null;
  }

  const normalizedName = opponentPlayer.name.trim().toLowerCase();
  const opponents = await repository.findAll();
  return (
    opponents.find(
      (opponent) =>
        opponent.nickname.trim().toLowerCase() === normalizedName ||
        opponent.aliases.some((alias) => alias.trim().toLowerCase() === normalizedName)
    ) ?? null
  );
}

async function findExistingOpponentByBattleTag(
  repository: OpponentRepository,
  battleTag: string | undefined
): Promise<Opponent | null> {
  if (!normalizeBattleTagKey(battleTag)) {
    return null;
  }

  const opponents = await repository.findAll();
  return opponents.find((opponent) => battleTagsMatch(opponent.battleTag, battleTag)) ?? null;
}

function mergeDetectedMatch(existingMatch: Match, detectedMatch: Match, now: string): Match {
  return {
    ...existingMatch,
    playerRace: existingMatch.playerRace === "Unknown" ? detectedMatch.playerRace : existingMatch.playerRace,
    opponentRace: existingMatch.opponentRace === "Unknown" ? detectedMatch.opponentRace : existingMatch.opponentRace,
    result: existingMatch.result === "unknown" ? detectedMatch.result : existingMatch.result,
    updatedAt: now
  };
}

function mergeLocalOpponentSample(opponent: Opponent, opponentPlayer: GameSessionPlayer, now: string): Opponent {
  const nextRace =
    opponent.race !== "Unknown" || opponentPlayer.race === "Unknown" ? opponent.race : opponentPlayer.race;
  const nextMmr = normalizeSessionMmr(opponentPlayer.mmr);
  const nextBattleTag = safeOpponentBattleTag(opponentPlayer.battleTag, undefined);
  const targetRace = nextRace === "Unknown" ? opponentPlayer.race : nextRace;
  const battleTagChanged = nextBattleTag !== undefined && !battleTagsMatch(opponent.battleTag, nextBattleTag);

  return {
    ...opponent,
    race: nextRace,
    raceProfiles:
      nextMmr === undefined
        ? opponent.raceProfiles
        : {
          ...opponent.raceProfiles,
          [targetRace]: {
            ...opponent.raceProfiles?.[targetRace],
            mmrAtLastMatch: nextMmr,
            updatedAt: now
          }
        },
    mmrAtLastMatch: nextMmr ?? opponent.mmrAtLastMatch,
    battleTag: nextBattleTag ?? opponent.battleTag,
    updatedAt: nextRace !== opponent.race || nextMmr !== undefined || battleTagChanged ? now : opponent.updatedAt
  };
}

function normalizeSessionMmr(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}
