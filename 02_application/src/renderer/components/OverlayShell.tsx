import { useEffect, useMemo, useState } from "react";
import type { MatchHistoryItem } from "../../application/use-cases/list-match-history.js";
import type { Opponent } from "../../domain/entities/opponent.js";
import type { Race } from "../../domain/value-objects/race.js";
import type { AppSettings } from "../../domain/entities/app-settings.js";
import type { MonitoringStatus } from "../../shared/ipc/contracts.js";
import protossModelUrl from "../assets/protoss-model.png";
import randomModelUrl from "../assets/random-model.png";
import terranModelUrl from "../assets/terran-model.png";
import zergModelUrl from "../assets/zerg-model.png";
import {
  formatOpponentDisplayName,
  raceThemeFor,
  type RaceTheme
} from "./OpponentRaceProfile.js";
import { createTranslator, normalizeUiLanguage } from "../i18n.js";

const RACE_PORTRAITS: Partial<Record<RaceTheme, string>> = {
  terran: terranModelUrl,
  zerg: zergModelUrl,
  protoss: protossModelUrl,
  random: randomModelUrl
};

const POLL_INTERVAL_ACTIVE_MS = 2500;
const POLL_INTERVAL_IDLE_MS = 6000;
const MAX_TAG_COUNT = 4;

export function OverlayShell() {
  const [opponent, setOpponent] = useState<Opponent | undefined>(undefined);
  const [matches, setMatches] = useState<readonly MatchHistoryItem[]>([]);
  const [monitoring, setMonitoring] = useState<MonitoringStatus | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settingsCache: AppSettings | null = null;
    let lastRuntimeSnapshot = "";

    async function tick(): Promise<void> {
      if (cancelled || !window.sc2Assistant) {
        return;
      }
      try {
        const monitoringResponse = await window.sc2Assistant.getMonitoringStatus();
        if (!settingsCache) {
          const settingsResponse = await window.sc2Assistant.getSettings();
          settingsCache = settingsResponse.settings;
        }

        if (cancelled) {
          return;
        }

        const nextRuntimeSnapshot = overlayRuntimeSnapshot(monitoringResponse);
        if (lastRuntimeSnapshot !== nextRuntimeSnapshot) {
          lastRuntimeSnapshot = nextRuntimeSnapshot;
          const [opponentsResponse, matchesResponse] = await Promise.all([
            window.sc2Assistant.listOpponents(),
            window.sc2Assistant.listMatches()
          ]);

          if (cancelled) {
            return;
          }

          const userName = settingsCache.playerName ?? undefined;
          const liveOpponent = findCurrentMatchOpponent(
            opponentsResponse.opponents,
            matchesResponse.items,
            monitoringResponse,
            userName
          );
          setOpponent(liveOpponent);
          setMatches(matchesResponse.items);
        }
        setMonitoring(monitoringResponse);
        setSettings(settingsCache);

        const nextDelay =
          monitoringResponse.running && monitoringResponse.currentSession?.active
            ? POLL_INTERVAL_ACTIVE_MS
            : POLL_INTERVAL_IDLE_MS;
        timer = setTimeout(tick, nextDelay);
      } catch (error) {
        if (!cancelled) {
          console.warn("Overlay polling failed:", error);
          timer = setTimeout(tick, POLL_INTERVAL_IDLE_MS);
        }
      }
    }

    void tick();

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);

  const raceStats = useMemo(
    () => (opponent ? opponentRaceStats(opponent, matches) : null),
    [opponent, matches]
  );
  const t = createTranslator(normalizeUiLanguage(settings?.language));

  if (!opponent) {
    return (
      <div className="overlay-card overlay-card--empty">
        <div className="overlay-empty-state">
          <span className="overlay-empty-title">
            {monitoring?.running ? t("overlay.watching") : t("overlay.idle")}
          </span>
          <span className="overlay-empty-sub">
            {settings?.overlayEnabled
              ? t("overlay.liveHint")
              : t("overlay.disableHint")}
          </span>
        </div>
      </div>
    );
  }

  const race = (opponent.race ?? "Unknown") as Race;
  const theme = raceThemeFor(race);
  const portrait = RACE_PORTRAITS[theme];
  const stats = raceStats ?? {
    encounters: opponent.encounters,
    wins: opponent.wins,
    losses: opponent.losses
  };
  const winRateLabel = winRateFor(stats);
  const mmrLabel = mmrForRace(opponent, race);
  const strategyTags = strategyTagsForRace(opponent, race);
  const tags = strategyTags.slice(0, MAX_TAG_COUNT);
  const overflowCount = Math.max(0, strategyTags.length - tags.length);
  const displayName = formatOpponentDisplayName(opponent);

  return (
    <div className={`overlay-card theme-${theme}`} data-race={theme}>
      <div className="overlay-portrait" aria-hidden="true">
        {portrait ? (
          <img className="overlay-portrait-image" src={portrait} alt="" />
        ) : (
          <span className="overlay-portrait-glyph">
            {race.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className={`overlay-portrait-glyph-tag race-${theme}`}>
          {race.slice(0, 1)}
        </span>
      </div>

      <div className="overlay-body-content">
        <header className="overlay-header">
          <span className="overlay-eyebrow">{t("overlay.currentMatch")}</span>
          <h1 className="overlay-nickname" title={displayName}>
            {displayName}
          </h1>
        </header>

        <div className="overlay-stats">
          <div className="overlay-stat">
            <span className="overlay-stat-label">{t("overlay.games")}</span>
            <span className="overlay-stat-value">{stats.encounters}</span>
          </div>
          <div className="overlay-stat overlay-stat-mmr">
            <span className="overlay-stat-label">MMR</span>
            <span className="overlay-stat-value">{mmrLabel}</span>
          </div>
          <div className="overlay-stat overlay-stat-wins">
            <span className="overlay-stat-label">W</span>
            <span className="overlay-stat-value">{stats.wins}</span>
          </div>
          <div className="overlay-stat overlay-stat-losses">
            <span className="overlay-stat-label">L</span>
            <span className="overlay-stat-value">{stats.losses}</span>
          </div>
          <div className="overlay-stat overlay-stat-rate">
            <span className="overlay-stat-label">WR</span>
            <span className="overlay-stat-value">{winRateLabel}</span>
          </div>
        </div>

        <ul className="overlay-tags" role="list">
          {tags.length === 0 ? (
            <li className="overlay-tag overlay-tag--empty">{t("overlay.noTags")}</li>
          ) : (
            tags.map((tag) => (
              <li className="overlay-tag" data-race={theme} key={tag} title={tag}>
                {tag.toUpperCase()}
              </li>
            ))
          )}
          {overflowCount > 0 ? (
            <li className="overlay-tag overlay-tag--overflow" data-race={theme}>
              +{overflowCount}
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}

type RaceStats = {
  readonly encounters: number;
  readonly wins: number;
  readonly losses: number;
};

function opponentRaceStats(
  opponent: Opponent,
  matches: readonly MatchHistoryItem[]
): RaceStats {
  const opponentMatches = matches.filter(
    (item) => item.match.opponentId === opponent.id
  );

  if (opponentMatches.length === 0) {
    return {
      encounters: opponent.encounters,
      wins: opponent.wins,
      losses: opponent.losses
    };
  }

  return {
    encounters: opponentMatches.length,
    wins: opponentMatches.filter((item) => item.match.result === "win").length,
    losses: opponentMatches.filter((item) => item.match.result === "loss").length
  };
}

function winRateFor(stats: RaceStats): string {
  const total = stats.wins + stats.losses;
  if (total === 0) {
    return "—";
  }
  return `${Math.round((stats.wins / total) * 100)}%`;
}

function strategyTagsForRace(opponent: Opponent, race: Race): readonly string[] {
  const raceTags = opponent.raceProfiles?.[race]?.strategyTags ?? [];
  return raceTags.length > 0 ? raceTags : opponent.strategyTags;
}

function mmrForRace(opponent: Opponent, race: Race): string {
  const mmr = opponent.raceProfiles?.[race]?.mmrAtLastMatch ?? opponent.mmrAtLastMatch;
  return typeof mmr === "number" && Number.isFinite(mmr) && mmr > 0 ? String(Math.round(mmr)) : "-";
}

function findCurrentMatchOpponent(
  opponents: readonly Opponent[],
  matches: readonly MatchHistoryItem[],
  monitoring: MonitoringStatus | null,
  userName: string | undefined
): Opponent | undefined {
  if (!monitoring) {
    return undefined;
  }
  const session = monitoring.currentSession;
  const lastSavedMatchId = monitoring.lastSavedMatchId;
  if (!session?.active || session.mode !== "ranked-1v1") {
    if (lastSavedMatchId) {
      return resolveOpponentForMatch(
        opponents,
        matches,
        lastSavedMatchId,
        userName
      );
    }
    return undefined;
  }

  const concluded = session.players.some(
    (player) => player.result === "Victory" || player.result === "Defeat"
  );
  if (concluded) {
    if (lastSavedMatchId) {
      return resolveOpponentForMatch(
        opponents,
        matches,
        lastSavedMatchId,
        userName
      );
    }
    return undefined;
  }

  if (lastSavedMatchId) {
    const liveOpponent = resolveOpponentForMatch(
      opponents,
      matches,
      lastSavedMatchId,
      userName
    );
    if (liveOpponent) {
      return liveOpponent;
    }
  }

  const normalizedUser = normalizeIdentity(userName);
  const userPlayer = normalizedUser
    ? session.players.find(
        (player) => normalizeIdentity(player.name) === normalizedUser
      ) ?? session.players.find((player) => player.isUser)
    : session.players.find((player) => player.isUser);
  const opponentPlayer = userPlayer
    ? session.players.find((player) => player !== userPlayer)
    : undefined;
  const opponentName = normalizeIdentity(opponentPlayer?.name);
  if (!opponentName) {
    return undefined;
  }

  return opponents.find(
    (opponent) =>
      !isLocalRecord(opponent, normalizedUser) &&
      [opponent.nickname, opponent.battleTag ?? "", ...opponent.aliases].some(
        (name) => normalizeIdentity(name) === opponentName
      )
  );
}

function resolveOpponentForMatch(
  opponents: readonly Opponent[],
  matches: readonly MatchHistoryItem[],
  matchId: string,
  userName: string | undefined
): Opponent | undefined {
  const match = matches.find((item) => item.match.id === matchId);
  if (!match) {
    return undefined;
  }
  const opponent = opponents.find(
    (record) => record.id === match.match.opponentId
  );
  if (!opponent) {
    return undefined;
  }
  const normalizedUser = normalizeIdentity(userName);
  return isLocalRecord(opponent, normalizedUser) ? undefined : opponent;
}

function isLocalRecord(opponent: Opponent, normalizedUser: string): boolean {
  if (!normalizedUser) {
    return false;
  }
  return [opponent.nickname, opponent.battleTag ?? "", ...opponent.aliases].some(
    (name) => normalizeIdentity(name) === normalizedUser
  );
}

function normalizeIdentity(value: string | undefined): string {
  return (value ?? "")
    .replace(/^(?:<[^>]+>\s*)+/, "")
    .replace(/#\d+$/, "")
    .trim()
    .toLowerCase();
}

function overlayRuntimeSnapshot(monitoring: MonitoringStatus): string {
  return JSON.stringify({
    running: monitoring.running,
    lastSavedMatchId: monitoring.lastSavedMatchId,
    lastDetectedOpponent: monitoring.lastDetectedOpponent,
    session: monitoring.currentSession
      ? {
          active: monitoring.currentSession.active,
          mode: monitoring.currentSession.mode,
          players: monitoring.currentSession.players.map((player) => ({
            name: player.name,
            race: player.race,
            result: player.result,
            mmr: player.mmr,
            isUser: player.isUser,
          })),
        }
      : null,
  });
}
