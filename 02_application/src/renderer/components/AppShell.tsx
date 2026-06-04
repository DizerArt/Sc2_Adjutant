import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MatchDetails } from "../../application/use-cases/get-match-details.js";
import type { MatchHistoryItem } from "../../application/use-cases/list-match-history.js";
import type {
  DiagnosticsReport,
  DiagnosticStatus,
} from "../../application/use-cases/run-diagnostics.js";
import type {
  AppSettings,
  OverlayPosition,
} from "../../domain/entities/app-settings.js";
import type { EnrichmentCandidateSnapshot } from "../../domain/entities/enrichment-candidate-snapshot.js";
import {
  MAX_OPPONENT_NOTES,
  MAX_OPPONENT_NOTE_LENGTH,
  MAX_OPPONENT_STRATEGY_TAG_LENGTH,
  MAX_OPPONENT_STRATEGY_TAGS,
  OPPONENT_MARKERS,
  type Opponent,
  type OpponentMarker,
} from "../../domain/entities/opponent.js";
import type { Race } from "../../domain/value-objects/race.js";
import type {
  MonitoringSessionPlayer,
  MonitoringStatus,
  ReplayWatcherStatus,
  SyncReplaysResponse,
} from "../../shared/ipc/contracts.js";
import adjutantAvatarUrl from "../assets/adjutant-avatar.png";
import {
  formatOpponentDisplayName,
  OpponentRaceProfile,
} from "./OpponentRaceProfile.js";
import {
  createTranslator,
  normalizeUiLanguage,
  type Translator,
} from "../i18n.js";
import { useVoiceNarrator } from "../voice/use-voice-narrator.js";
import type { OpponentSpeechData } from "../voice/voice-narrator-service.js";
import { VoiceSettingsPanel } from "./VoiceSettingsPanel.js";
import type { VoiceSettings } from "../../domain/entities/voice-settings.js";

type LoadState = "idle" | "loading" | "ready" | "error";
type ActiveView = "match" | "opponents" | "diagnostics" | "settings" | "voice" | "info";
type OpponentsTab = "known" | "history";
type OpponentSortKey = "lastSeen" | "mmr" | "race" | "confidence";
type MatchHistorySortKey = "lastSeen" | "race" | "result";
type MatchFavoriteFilter = "All" | "Favorites";
type RaceFilter = Race | "All";

type DashboardState = {
  readonly diagnostics: DiagnosticsReport | null;
  readonly opponents: readonly Opponent[];
  readonly candidates: readonly EnrichmentCandidateSnapshot[];
  readonly matches: readonly MatchHistoryItem[];
  readonly monitoring: MonitoringStatus | null;
  readonly replayWatcher: ReplayWatcherStatus | null;
  readonly settings: AppSettings | null;
  readonly loadState: LoadState;
  readonly errorMessage?: string;
};

type MatchDetailsState = {
  readonly matchId: string | null;
  readonly loadState: LoadState;
  readonly details: MatchDetails | null;
  readonly errorMessage?: string;
};

type SettingsDraft = {
  readonly playerName: string;
  readonly language: AppSettings["language"];
  readonly region: AppSettings["region"];
  readonly defaultRace: Race;
  readonly replayDirectory: string;
  readonly pollingIntervalMs: string;
  readonly externalSourcesEnabled: boolean;
  readonly externalSources: {
    readonly sc2Pulse: boolean;
    readonly localFixture: boolean;
  };
  readonly overlayEnabled: boolean;
  readonly overlayPosition: OverlayPosition;
  readonly overlayPlacementMode: boolean;
};

type ReplaySyncDraft = {
  readonly mode: "full" | "partial";
  readonly limit: string;
};

const DEFAULT_REPLAY_SYNC_LIMIT = "25";

const OPPONENT_MARKER_SYMBOLS: Record<OpponentMarker, string> = {
  skull: "☠",
  heart: "♥",
  blocked: "⊘",
};

type OpponentListFilters = {
  readonly query: string;
  readonly race: RaceFilter;
  readonly markers: readonly OpponentMarker[];
  readonly sortBy: OpponentSortKey;
};

type MatchHistoryFilters = {
  readonly query: string;
  readonly race: RaceFilter;
  readonly favorite: MatchFavoriteFilter;
  readonly sortBy: MatchHistorySortKey;
};

type OpponentProfileDraft = {
  readonly nickname: string;
  readonly race: Race;
  readonly battleTag: string;
  readonly aliases: string;
  readonly mmrAtLastMatch: string;
  readonly league: string;
  readonly strategyTags: string;
  readonly confidenceScore: string;
};

export function AppShell() {
  const [activeView, setActiveView] = useState<ActiveView>("match");
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [compactMode, setCompactMode] = useState(false);
  const [dashboardState, setDashboardState] = useState<DashboardState>({
    diagnostics: null,
    opponents: [],
    candidates: [],
    matches: [],
    monitoring: null,
    replayWatcher: null,
    settings: null,
    loadState: "idle",
  });
  const [noteDraft, setNoteDraft] = useState("");
  const [noteState, setNoteState] = useState<LoadState>("idle");
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft>(
    defaultSettingsDraft(),
  );
  const [settingsState, setSettingsState] = useState<LoadState>("idle");
  const [storageOpenState, setStorageOpenState] = useState<LoadState>("idle");
  const [replaySyncDraft, setReplaySyncDraft] = useState<ReplaySyncDraft>({
    mode: "partial",
    limit: DEFAULT_REPLAY_SYNC_LIMIT,
  });
  const [replaySyncState, setReplaySyncState] = useState<LoadState>("idle");
  const [replaySyncResult, setReplaySyncResult] =
    useState<SyncReplaysResponse | null>(null);
  const [replaySyncStartedAt, setReplaySyncStartedAt] = useState<number | null>(
    null,
  );
  const [replaySyncElapsedSeconds, setReplaySyncElapsedSeconds] = useState(0);
  const [profileDraft, setProfileDraft] = useState<OpponentProfileDraft>(
    defaultOpponentProfileDraft(),
  );
  const [profileState, setProfileState] = useState<LoadState>("idle");
  const [infoEditorOpen, setInfoEditorOpen] = useState(false);
  const [notesModalRace, setNotesModalRace] = useState<Race | null>(null);
  const [opponentsTab, setOpponentsTab] = useState<OpponentsTab>("known");
  const [opponentFilters, setOpponentFilters] = useState<OpponentListFilters>({
    query: "",
    race: "All",
    markers: [],
    sortBy: "lastSeen",
  });
  const [matchFilters, setMatchFilters] = useState<MatchHistoryFilters>({
    query: "",
    race: "All",
    favorite: "All",
    sortBy: "lastSeen",
  });
  const [selectedOpponentId, setSelectedOpponentId] = useState<string | null>(
    null,
  );
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [matchDetailsState, setMatchDetailsState] = useState<MatchDetailsState>(
    {
      matchId: null,
      loadState: "idle",
      details: null,
    },
  );
  const runtimeSnapshotRef = useRef("");
  const language = normalizeUiLanguage(settingsDraft.language);
  const t = useMemo(() => createTranslator(language), [language]);

  const voiceController = useVoiceNarrator(dashboardState.settings);

  const saveVoiceSettings = useCallback(
    async (next: VoiceSettings) => {
      if (!window.sc2Assistant) {
        throw new Error("Electron bridge is not available.");
      }
      const response = await window.sc2Assistant.saveSettings({ voice: next });
      setDashboardState((current) => ({
        ...current,
        settings: response.settings,
        loadState: "ready",
      }));
    },
    [],
  );

  const loadDashboard = useCallback(
    async (mode: "full" | "silent" = "full") => {
      if (!window.sc2Assistant) {
        setDashboardState({
          diagnostics: null,
          opponents: [],
          candidates: [],
          matches: [],
          monitoring: null,
          replayWatcher: null,
          settings: null,
          loadState: "error",
          errorMessage: "Electron bridge is not available.",
        });
        return;
      }

      if (mode === "full") {
        setDashboardState((current) => ({ ...current, loadState: "loading" }));
      }

      try {
        const [
          diagnostics,
          opponentsResponse,
          matchesResponse,
          monitoring,
          replayWatcher,
          settingsResponse,
        ] = await Promise.all([
          window.sc2Assistant.getDiagnostics(),
          window.sc2Assistant.listOpponents(),
          window.sc2Assistant.listMatches(),
          window.sc2Assistant.getMonitoringStatus(),
          window.sc2Assistant.getReplayWatcherStatus(),
          window.sc2Assistant.getSettings(),
        ]);
        const selectedOpponent = selectedOpponentId
          ? opponentsResponse.opponents.find(
              (opponent) => opponent.id === selectedOpponentId,
            )
          : undefined;
        const primaryOpponent =
          selectedOpponent ?? opponentsResponse.opponents[0];
        const candidatesResponse = primaryOpponent
          ? await window.sc2Assistant.listOpponentCandidates({
              opponentId: primaryOpponent.id,
            })
          : { candidates: [] };
        runtimeSnapshotRef.current = runtimeSnapshot(monitoring, replayWatcher);

        setDashboardState({
          diagnostics,
          opponents: opponentsResponse.opponents,
          candidates: candidatesResponse.candidates,
          matches: matchesResponse.items,
          monitoring,
          replayWatcher,
          settings: settingsResponse.settings,
          loadState: "ready",
        });
        if (mode === "full") {
          setSettingsDraft(
            settingsDraftFromSettings(settingsResponse.settings),
          );
        }
        if (!selectedOpponentId && primaryOpponent) {
          setSelectedOpponentId(primaryOpponent.id);
        }
      } catch (error) {
        setDashboardState({
          diagnostics: null,
          opponents: [],
          candidates: [],
          matches: [],
          monitoring: null,
          replayWatcher: null,
          settings: null,
          loadState: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [selectedOpponentId],
  );

  const refreshRuntimeState = useCallback(async () => {
    if (!window.sc2Assistant) {
      return;
    }

    try {
      const [monitoring, replayWatcher] = await Promise.all([
        window.sc2Assistant.getMonitoringStatus(),
        window.sc2Assistant.getReplayWatcherStatus(),
      ]);
      const nextSnapshot = runtimeSnapshot(monitoring, replayWatcher);
      const recordsMayHaveChanged = runtimeSnapshotRef.current !== nextSnapshot;
      runtimeSnapshotRef.current = nextSnapshot;

      if (!recordsMayHaveChanged) {
        setDashboardState((current) => ({
          ...current,
          monitoring,
          replayWatcher,
        }));
        return;
      }

      const [opponentsResponse, matchesResponse] = await Promise.all([
        window.sc2Assistant.listOpponents(),
        window.sc2Assistant.listMatches(),
      ]);

      setDashboardState((current) => ({
        ...current,
        opponents: opponentsResponse.opponents,
        matches: matchesResponse.items,
        monitoring,
        replayWatcher,
        loadState: "ready",
      }));
    } catch (error) {
      setDashboardState((current) => ({
        ...current,
        loadState: current.loadState === "idle" ? "error" : current.loadState,
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
    }
  }, []);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    let isMounted = true;

    void window.sc2Assistant
      ?.getAppVersion()
      .then((response) => {
        if (isMounted) {
          setAppVersion(response.version);
        }
      })
      .catch(() => {
        if (isMounted) {
          setAppVersion(null);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedMatchId || !window.sc2Assistant) {
      setMatchDetailsState({
        matchId: selectedMatchId,
        loadState: "idle",
        details: null,
      });
      return;
    }

    let cancelled = false;
    setMatchDetailsState({
      matchId: selectedMatchId,
      loadState: "loading",
      details: null,
    });

    window.sc2Assistant
      .getMatchDetails({ matchId: selectedMatchId })
      .then((response) => {
        if (!cancelled) {
          setMatchDetailsState({
            matchId: selectedMatchId,
            loadState: "ready",
            details: response.details,
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMatchDetailsState({
            matchId: selectedMatchId,
            loadState: "error",
            details: null,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedMatchId]);

  useEffect(() => {
    const interval = window.setInterval(
      () => {
        void refreshRuntimeState();
      },
      dashboardState.monitoring?.running ? 2000 : 5000,
    );

    return () => {
      window.clearInterval(interval);
    };
  }, [dashboardState.monitoring?.running, refreshRuntimeState]);

  useEffect(() => {
    const unsubscribe = window.sc2Assistant?.onReplaySyncProgress(
      (progress) => {
        setReplaySyncResult(progress);
      },
    );

    return () => {
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (replaySyncState !== "loading" || replaySyncStartedAt === null) {
      return;
    }

    const updateElapsed = () => {
      setReplaySyncElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - replaySyncStartedAt) / 1000)),
      );
    };
    updateElapsed();
    const interval = window.setInterval(updateElapsed, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [replaySyncStartedAt, replaySyncState]);

  const primaryOpponent = useMemo(
    () =>
      selectedOpponentId
        ? (dashboardState.opponents.find(
            (opponent) => opponent.id === selectedOpponentId,
          ) ?? dashboardState.opponents[0])
        : dashboardState.opponents[0],
    [dashboardState.opponents, selectedOpponentId],
  );
  const currentMatchOpponent = useMemo(
    () =>
      findCurrentMatchOpponent(
        dashboardState.opponents,
        dashboardState.matches,
        dashboardState.monitoring,
        dashboardState.settings?.playerName ?? settingsDraft.playerName,
      ),
    [
      dashboardState.opponents,
      dashboardState.matches,
      dashboardState.monitoring,
      dashboardState.settings?.playerName,
      settingsDraft.playerName,
    ],
  );

  const selectedMatch = useMemo(
    () =>
      dashboardState.matches.find((item) => item.match.id === selectedMatchId),
    [dashboardState.matches, selectedMatchId],
  );

  // Remember the last opponent detected as the live one. The Current match
  // card keeps rendering this opponent after the game ends, until a new
  // ranked-1v1 game is detected and the live opponent changes. We cache the
  // id (not the full record) so wins/losses written when the game concludes
  // still flow through to the rendered card.
  const [stickyMatchOpponentId, setStickyMatchOpponentId] = useState<
    string | undefined
  >(undefined);

  useEffect(() => {
    if (currentMatchOpponent) {
      setStickyMatchOpponentId(currentMatchOpponent.id);
      setActiveView("match");
      setInfoEditorOpen(false);
      setNotesModalRace(null);
    }
  }, [currentMatchOpponent?.id]);

  const stickyMatchOpponent = useMemo(() => {
    if (currentMatchOpponent) {
      return currentMatchOpponent;
    }
    if (!stickyMatchOpponentId) {
      return undefined;
    }
    const opponent = dashboardState.opponents.find(
      (item) => item.id === stickyMatchOpponentId,
    );
    const userName =
      dashboardState.settings?.playerName ?? settingsDraft.playerName;
    return opponent && !isLocalOpponentRecord(opponent, userName)
      ? opponent
      : undefined;
  }, [
    currentMatchOpponent,
    stickyMatchOpponentId,
    dashboardState.opponents,
    dashboardState.settings?.playerName,
    settingsDraft.playerName,
  ]);

  const activeOpponent =
    activeView === "match" ? stickyMatchOpponent : primaryOpponent;

  useEffect(() => {
    setProfileDraft(opponentProfileDraftFromOpponent(activeOpponent));
    setProfileState("idle");
    setNotesModalRace(null);
  }, [activeOpponent?.id]);

  useEffect(() => {
    if (!window.sc2Assistant || !activeOpponent) {
      return;
    }

    void window.sc2Assistant
      .listOpponentCandidates({ opponentId: activeOpponent.id })
      .then((candidatesResponse) => {
        setDashboardState((current) => ({
          ...current,
          candidates: candidatesResponse.candidates,
        }));
      });
  }, [activeOpponent?.id]);

  async function selectOpponent(opponentId: string) {
    setSelectedOpponentId(opponentId);

    if (!window.sc2Assistant) {
      return;
    }

    const candidatesResponse = await window.sc2Assistant.listOpponentCandidates(
      { opponentId },
    );
    setDashboardState((current) => ({
      ...current,
      candidates: candidatesResponse.candidates,
    }));
  }

  async function selectMatch(item: MatchHistoryItem) {
    setSelectedMatchId(item.match.id);
    await selectOpponent(item.match.opponentId);
  }

  async function openProfileHistoryMatch(item: MatchHistoryItem) {
    setActiveView("opponents");
    setOpponentsTab("history");
    await selectMatch(item);
  }

  async function openOpponentFromMatch(opponentId: string) {
    setSelectedMatchId(null);
    setOpponentsTab("known");
    await selectOpponent(opponentId);
  }

  async function revealReplay(replayPath: string) {
    await window.sc2Assistant?.revealReplay({ replayPath });
  }

  async function toggleMatchFavorite(matchId: string) {
    if (!window.sc2Assistant) {
      return;
    }

    await window.sc2Assistant.toggleMatchFavorite({ matchId });
    const matchesResponse = await window.sc2Assistant.listMatches();
    setDashboardState((current) => ({
      ...current,
      matches: matchesResponse.items,
    }));
  }

  async function toggleMonitoring() {
    if (!window.sc2Assistant) {
      return;
    }

    const monitoring = dashboardState.monitoring?.running
      ? await window.sc2Assistant.stopMonitoring()
      : await window.sc2Assistant.startMonitoring();

    const opponentsResponse = await window.sc2Assistant.listOpponents();
    const matchesResponse = await window.sc2Assistant.listMatches();
    const selectedOpponent = selectedOpponentId
      ? opponentsResponse.opponents.find(
          (opponent) => opponent.id === selectedOpponentId,
        )
      : undefined;
    const primaryOpponent = selectedOpponent ?? opponentsResponse.opponents[0];
    const candidatesResponse = primaryOpponent
      ? await window.sc2Assistant.listOpponentCandidates({
          opponentId: primaryOpponent.id,
        })
      : { candidates: [] };

    setDashboardState((current) => ({
      ...current,
      monitoring,
      opponents: opponentsResponse.opponents,
      candidates: candidatesResponse.candidates,
      matches: matchesResponse.items,
      loadState: "ready",
    }));
  }

  async function toggleReplayWatcher() {
    if (!window.sc2Assistant) {
      return;
    }

    const replayWatcher = dashboardState.replayWatcher?.running
      ? await window.sc2Assistant.stopReplayWatcher()
      : await window.sc2Assistant.startReplayWatcher();
    const matchesResponse = await window.sc2Assistant.listMatches();

    setDashboardState((current) => ({
      ...current,
      replayWatcher,
      matches: matchesResponse.items,
      loadState: "ready",
    }));
  }

  async function refreshDashboard() {
    await loadDashboard();
  }

  function openInfoEditor(race?: Race) {
    setNotesModalRace(null);
    setProfileDraft(
      opponentProfileDraftFromOpponent(
        activeOpponent,
        dashboardState.candidates,
        race,
      ),
    );
    setProfileState("idle");
    setInfoEditorOpen(true);
  }

  function openRaceNotes(race: Race) {
    setNoteDraft("");
    setNoteState("idle");
    setNotesModalRace(race);
  }

  function closeRaceNotes() {
    setNoteDraft("");
    setNoteState("idle");
    setNotesModalRace(null);
  }

  async function submitOpponentNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const noteRace = notesModalRace ?? undefined;
    const currentNotes = activeOpponent && noteRace
      ? notesForOpponentRace(activeOpponent, noteRace)
      : activeOpponent?.notes ?? [];

    if (
      !window.sc2Assistant ||
      !activeOpponent ||
      !noteDraft.trim() ||
      currentNotes.length >= MAX_OPPONENT_NOTES
    ) {
      return;
    }

    setNoteState("loading");

    try {
      await window.sc2Assistant.addOpponentNote({
        opponentId: activeOpponent.id,
        note: noteDraft.slice(0, MAX_OPPONENT_NOTE_LENGTH),
        race: noteRace,
      });

      setNoteDraft("");
      setNoteState("ready");
      await loadDashboard("silent");
    } catch {
      setNoteState("error");
    }
  }

  async function deleteOpponentNote(noteIndex: number) {
    if (!window.sc2Assistant || !activeOpponent) {
      return;
    }

    setNoteState("loading");

    try {
      const response = await window.sc2Assistant.removeOpponentNote({
        opponentId: activeOpponent.id,
        noteIndex,
        race: notesModalRace ?? undefined,
      });

      setDashboardState((current) => ({
        ...current,
        opponents: current.opponents.map((opponent) =>
          opponent.id === response.opponent.id ? response.opponent : opponent,
        ),
        loadState: "ready",
      }));
      setNoteState("ready");
    } catch {
      setNoteState("error");
    }
  }

  async function submitOpponentProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!window.sc2Assistant || !activeOpponent) {
      return;
    }

    setProfileState("loading");

    try {
      const response = await window.sc2Assistant.updateOpponentProfile({
        opponentId: activeOpponent.id,
        nickname: profileDraft.nickname,
        race: profileDraft.race,
        battleTag: profileDraft.battleTag,
        aliases: splitDraftList(profileDraft.aliases),
        mmrAtLastMatch: parseDraftNumber(profileDraft.mmrAtLastMatch),
        league: profileDraft.league,
        strategyTags: splitDraftList(
          profileDraft.strategyTags,
          MAX_OPPONENT_STRATEGY_TAGS,
          MAX_OPPONENT_STRATEGY_TAG_LENGTH,
        ),
        confidenceScore: parseDraftConfidence(profileDraft.confidenceScore),
      });

      setDashboardState((current) => ({
        ...current,
        opponents: current.opponents.map((opponent) =>
          opponent.id === response.opponent.id ? response.opponent : opponent,
        ),
        loadState: "ready",
      }));
      setProfileDraft(
        opponentProfileDraftFromOpponent(
          response.opponent,
          [],
          profileDraft.race,
        ),
      );
      setProfileState("ready");
      setInfoEditorOpen(false);
    } catch {
      setProfileState("error");
    }
  }

  async function toggleOpponentMarker(marker: OpponentMarker) {
    if (!window.sc2Assistant || !activeOpponent) {
      return;
    }

    const currentMarkers = new Set(activeOpponent.markers ?? []);
    if (currentMarkers.has(marker)) {
      currentMarkers.delete(marker);
    } else {
      currentMarkers.add(marker);
    }

    const response = await window.sc2Assistant.updateOpponentProfile({
      opponentId: activeOpponent.id,
      markers: OPPONENT_MARKERS.filter((item) => currentMarkers.has(item)),
    });

    setDashboardState((current) => ({
      ...current,
      opponents: current.opponents.map((opponent) =>
        opponent.id === response.opponent.id ? response.opponent : opponent,
      ),
      loadState: "ready",
    }));
  }

  async function addOpponentStrategyTag(
    race: Race,
    currentTags: readonly string[],
    tag: string,
  ) {
    if (!window.sc2Assistant || !activeOpponent) {
      return;
    }

    const normalizedTag = tag
      .trim()
      .slice(0, MAX_OPPONENT_STRATEGY_TAG_LENGTH);
    if (!normalizedTag || currentTags.length >= MAX_OPPONENT_STRATEGY_TAGS) {
      return;
    }

    const response = await window.sc2Assistant.updateOpponentProfile({
      opponentId: activeOpponent.id,
      race,
      strategyTags: [...currentTags, normalizedTag].slice(
        0,
        MAX_OPPONENT_STRATEGY_TAGS,
      ),
    });

    setDashboardState((current) => ({
      ...current,
      opponents: current.opponents.map((opponent) =>
        opponent.id === response.opponent.id ? response.opponent : opponent,
      ),
      loadState: "ready",
    }));
  }

  async function removeOpponentStrategyTag(
    race: Race,
    currentTags: readonly string[],
    tagIndex: number,
  ) {
    if (!window.sc2Assistant || !activeOpponent) {
      return;
    }

    if (tagIndex < 0 || tagIndex >= currentTags.length) {
      return;
    }

    const response = await window.sc2Assistant.updateOpponentProfile({
      opponentId: activeOpponent.id,
      race,
      strategyTags: currentTags.filter((_, index) => index !== tagIndex),
    });

    setDashboardState((current) => ({
      ...current,
      opponents: current.opponents.map((opponent) =>
        opponent.id === response.opponent.id ? response.opponent : opponent,
      ),
      loadState: "ready",
    }));
  }

  const [clearStatsState, setClearStatsState] = useState<LoadState>("idle");
  const [rebuildStatsState, setRebuildStatsState] = useState<LoadState>("idle");
  const [rebuildStatsSummary, setRebuildStatsSummary] = useState<string | null>(
    null,
  );

  async function rebuildStats() {
    if (!window.sc2Assistant) {
      return;
    }

    setRebuildStatsState("loading");
    try {
      const response = await window.sc2Assistant.rebuildStats();
      setRebuildStatsSummary(
        `Inspected ${response.inspectedCount}, rebuilt ${response.rebuiltCount}.`,
      );
      setRebuildStatsState("ready");
      await loadDashboard("silent");
    } catch {
      setRebuildStatsState("error");
    }
  }

  async function clearAllStats() {
    if (!window.sc2Assistant) {
      return;
    }

    const confirmed = window.confirm(t("settings.clearConfirm"));
    if (!confirmed) {
      return;
    }

    setClearStatsState("loading");
    try {
      await window.sc2Assistant.clearStats();
      await loadDashboard();
      setClearStatsState("ready");
    } catch {
      setClearStatsState("error");
    }
  }

  async function submitSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!window.sc2Assistant) {
      return;
    }

    setSettingsState("loading");

    try {
      const response = await window.sc2Assistant.saveSettings({
        playerName: settingsDraft.playerName,
        language: settingsDraft.language,
        region: settingsDraft.region,
        defaultRace: settingsDraft.defaultRace,
        replayDirectory: settingsDraft.replayDirectory,
        pollingIntervalMs: Number.parseInt(settingsDraft.pollingIntervalMs, 10),
        externalSourcesEnabled: settingsDraft.externalSourcesEnabled,
        externalSources: settingsDraft.externalSources,
        overlayEnabled: settingsDraft.overlayEnabled,
        overlayPosition: settingsDraft.overlayPosition,
        overlayPlacementMode: settingsDraft.overlayPlacementMode,
      });

      if (settingsDraft.overlayEnabled) {
        void window.sc2Assistant.showOverlay();
      } else {
        void window.sc2Assistant.hideOverlay();
      }

      setDashboardState((current) => ({
        ...current,
        settings: response.settings,
        loadState: "ready",
      }));
      setSettingsDraft(settingsDraftFromSettings(response.settings));
      setSettingsState("ready");
    } catch {
      setSettingsState("error");
    }
  }

  async function openLocalStorage() {
    if (!window.sc2Assistant) {
      return;
    }

    setStorageOpenState("loading");
    try {
      await window.sc2Assistant.openLocalStorage();
      setStorageOpenState("ready");
    } catch {
      setStorageOpenState("error");
    }
  }

  async function syncReplayArchive() {
    if (!window.sc2Assistant) {
      return;
    }

    const limit = parseReplaySyncLimit(replaySyncDraft.limit);
    if (replaySyncDraft.mode === "partial" && limit === null) {
      setReplaySyncState("error");
      return;
    }

    setReplaySyncState("loading");
    setReplaySyncResult(null);
    setReplaySyncStartedAt(Date.now());
    setReplaySyncElapsedSeconds(0);

    try {
      const response = await window.sc2Assistant.syncReplays({
        mode: replaySyncDraft.mode,
        limit:
          replaySyncDraft.mode === "partial" ? (limit ?? undefined) : undefined,
      });
      setReplaySyncResult(response);
      setReplaySyncState("ready");
      await loadDashboard("silent");
    } catch {
      setReplaySyncState("error");
    } finally {
      setReplaySyncStartedAt(null);
    }
  }

  const workspaceVisible =
    !infoEditorOpen && (activeView === "match" || activeView === "opponents");

  const enterCompactMode = useCallback(() => {
    // Measure the information block, then ask the main process to shrink the
    // window to those exact bounds — the block stays put, the chrome vanishes.
    const block = document.querySelector(".workspace");
    if (!block) {
      return;
    }
    const rect = block.getBoundingClientRect();
    setCompactMode(true);
    void window.sc2Assistant?.setCompactWindow({
      compact: true,
      offsetX: rect.left,
      offsetY: rect.top,
      width: rect.width,
      height: rect.height,
    });
  }, []);

  const exitCompactMode = useCallback(() => {
    setCompactMode(false);
    void window.sc2Assistant?.setCompactWindow({ compact: false });
  }, []);

  return (
    <div className={`app-frame${compactMode ? " app-frame-compact" : ""}`}>
      <WindowTitleBar
        compactDisabled={!workspaceVisible}
        compactMode={compactMode}
        onToggleCompact={compactMode ? exitCompactMode : enterCompactMode}
        t={t}
      />
      <main className="app-shell">
        <aside className="sidebar" aria-label="Primary navigation">
          <div className="brand-block">
            <span className="brand-kicker">SC2</span>
            <h1>Adjutant</h1>
          </div>

          <div className="adjutant-avatar" aria-hidden="true">
            <span className="adjutant-avatar-corner adjutant-avatar-corner-tl" />
            <span className="adjutant-avatar-corner adjutant-avatar-corner-tr" />
            <span className="adjutant-avatar-corner adjutant-avatar-corner-bl" />
            <span className="adjutant-avatar-corner adjutant-avatar-corner-br" />
            <img src={adjutantAvatarUrl} alt="" />
            <span className="adjutant-avatar-status">
              <span className="adjutant-avatar-status-dot" />
              {t("app.online")}
            </span>
          </div>

          <nav className="nav-list">
            {[
              ["match", t("nav.currentMatch")],
              ["opponents", t("nav.opponents")],
              ["diagnostics", t("nav.diagnostics")],
              ["settings", t("nav.settings")],
              ["voice", t("nav.voice")],
              ["info", t("nav.info")],
            ].map(([view, label]) => (
              <button
                className={`nav-item ${activeView === view ? "active" : ""}`}
                key={view}
                onClick={() => {
                  setActiveView(view as ActiveView);
                  setInfoEditorOpen(false);
                }}
                type="button"
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="sidebar-version-row" aria-label={t("info.version")}>
            <span className="sidebar-version-label">
              {t("info.version")}{" "}
              <strong>{appVersion ?? t("profile.unknown")}</strong>
            </span>
            <a
              className="sidebar-update-link"
              href={LATEST_RELEASE_URL}
              rel="noreferrer"
              target="_blank"
            >
              {t("info.update")}
            </a>
          </div>

          {dashboardState.monitoring?.lastError ? (
            <div className="sidebar-monitoring-error" role="status">
              <span className="sidebar-monitoring-error-label">Monitoring</span>
              <span className="sidebar-monitoring-error-message">
                {dashboardState.monitoring.lastError}
              </span>
            </div>
          ) : null}

          <div className="sidebar-author" aria-label="Application author">
            <span className="sidebar-author-label">{t("app.createdBy")}</span>
            <span className="sidebar-author-name">ReTorieS</span>
          </div>
        </aside>

        <section className="content-area">
          <header className="top-bar">
            <div>
              <p className="eyebrow">
                {infoEditorOpen
                  ? t("header.opponentData")
                  : headerEyebrow(activeView, t)}
              </p>
              <div className="title-line">
                {activeView === "opponents" && !infoEditorOpen ? null : (
                  <h2>
                    {infoEditorOpen
                      ? t("header.infoEditor")
                      : headerTitle(activeView, t)}
                  </h2>
                )}
                {!infoEditorOpen && activeView === "match" ? (
                  <RuntimeIndicator
                    monitoring={dashboardState.monitoring}
                    replayWatcher={dashboardState.replayWatcher}
                    t={t}
                  />
                ) : null}
              </div>
            </div>
          </header>

          {activeView === "settings" ? (
            <SettingsView
              clearStatsState={clearStatsState}
              onOpenLocalStorage={openLocalStorage}
              onChange={setSettingsDraft}
              onClearStats={clearAllStats}
              onReplaySyncChange={setReplaySyncDraft}
              onReplaySyncRun={syncReplayArchive}
              onSubmit={submitSettings}
              replaySyncDraft={replaySyncDraft}
              replaySyncElapsedSeconds={replaySyncElapsedSeconds}
              replaySyncResult={replaySyncResult}
              replaySyncState={replaySyncState}
              settingsDraft={settingsDraft}
              settingsState={settingsState}
              storageOpenState={storageOpenState}
              t={t}
            />
          ) : activeView === "voice" ? (
            <VoiceSettingsPanel
              settings={dashboardState.settings}
              onSave={saveVoiceSettings}
              narrator={voiceController.narrator}
              runtimeStatus={voiceController.status}
              t={t}
            />
          ) : infoEditorOpen ? (
            <OpponentInfoEditor
              candidates={dashboardState.candidates}
              noteDraft={noteDraft}
              noteState={noteState}
              onBack={() => setInfoEditorOpen(false)}
              onNoteChange={setNoteDraft}
              onNoteDelete={deleteOpponentNote}
              onNoteSubmit={submitOpponentNote}
              onProfileDraftChange={setProfileDraft}
              onProfileSubmit={submitOpponentProfile}
              opponent={activeOpponent}
              profileDraft={profileDraft}
              profileState={profileState}
              t={t}
            />
          ) : activeView === "diagnostics" ? (
            <DiagnosticsView
              dashboardState={dashboardState}
              onRebuildStats={rebuildStats}
              onToggleMonitoring={toggleMonitoring}
              onToggleReplayWatcher={toggleReplayWatcher}
              rebuildStatsState={rebuildStatsState}
              rebuildStatsSummary={rebuildStatsSummary}
              t={t}
            />
          ) : activeView === "info" ? (
            <InfoView t={t} />
          ) : (
            <OpponentWorkspace
              activeView={activeView}
              dashboardState={dashboardState}
              matchFilters={matchFilters}
              matchDetailsState={matchDetailsState}
              opponentFilters={opponentFilters}
              opponentsTab={opponentsTab}
              onAddInfo={openInfoEditor}
              onOpenNotes={openRaceNotes}
              onMatchFiltersChange={setMatchFilters}
              onMatchSelect={selectMatch}
              onMatchFavoriteToggle={toggleMatchFavorite}
              onOpenOpponentFromMatch={openOpponentFromMatch}
              onOpponentFiltersChange={setOpponentFilters}
              onOpponentSelect={selectOpponent}
              onOpponentMarkerToggle={toggleOpponentMarker}
              onOpponentVoicePreview={(data) =>
                void voiceController.narrator?.previewOpponentCard(data)
              }
              onOpponentsTabChange={setOpponentsTab}
              onProfileHistoryMatchSelect={openProfileHistoryMatch}
              onRevealReplay={revealReplay}
              onStrategyTagAdd={addOpponentStrategyTag}
              onStrategyTagRemove={removeOpponentStrategyTag}
              primaryOpponent={activeOpponent}
              selectedMatch={selectedMatch}
              selectedMatchId={selectedMatchId ?? undefined}
              selectedOpponentId={activeOpponent?.id}
              t={t}
            />
          )}
          {notesModalRace && activeOpponent ? (
            <RaceNotesDialog
              noteDraft={noteDraft}
              noteState={noteState}
              notes={notesForOpponentRace(activeOpponent, notesModalRace)}
              onClose={closeRaceNotes}
              onNoteChange={setNoteDraft}
              onNoteDelete={deleteOpponentNote}
              onNoteSubmit={submitOpponentNote}
              opponent={activeOpponent}
              race={notesModalRace}
              t={t}
            />
          ) : null}
        </section>
      </main>
      {/* Rendered last so its no-drag region is resolved after the panel
          headings' drag regions — otherwise the overlapping part of the tab
          gets re-claimed as draggable and stops responding to clicks. */}
      {compactMode ? (
        <button
          aria-label={t("app.window.expand")}
          className="compact-exit-tab"
          onClick={exitCompactMode}
          title={t("app.window.expand")}
          type="button"
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M1.5 4.5 L1.5 1.5 L4.5 1.5 M10.5 7.5 L10.5 10.5 L7.5 10.5"
              stroke="currentColor"
              strokeWidth="1.3"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

function notesForOpponentRace(opponent: Opponent, race: Race): readonly string[] {
  return opponent.raceProfiles?.[race]?.notes ?? (race === opponent.race ? opponent.notes : []);
}

type RaceNotesDialogProps = {
  readonly noteDraft: string;
  readonly noteState: LoadState;
  readonly notes: readonly string[];
  readonly opponent: Opponent;
  readonly race: Race;
  readonly onClose: () => void;
  readonly onNoteChange: (value: string) => void;
  readonly onNoteDelete: (noteIndex: number) => void | Promise<void>;
  readonly onNoteSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly t: Translator;
};

function RaceNotesDialog(props: RaceNotesDialogProps) {
  const notesLimitReached = props.notes.length >= MAX_OPPONENT_NOTES;

  return (
    <div
      className="race-notes-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          props.onClose();
        }
      }}
      role="presentation"
    >
      <section
        aria-label={props.t("profile.raceNotes")}
        aria-modal="true"
        className="race-notes-dialog"
        role="dialog"
      >
        <header className="race-notes-header">
          <div>
            <p className="eyebrow">{props.t("profile.raceNotes")}</p>
            <h3>{formatOpponentDisplayName(props.opponent)}</h3>
            <span>{props.race}</span>
          </div>
          <button className="ghost-button" onClick={props.onClose} type="button">
            {props.t("profile.closeNotes")}
          </button>
        </header>

        <form className="note-form" onSubmit={props.onNoteSubmit}>
          <label htmlFor="race-opponent-note">{props.t("profile.notes")}</label>
          <div className="note-input-row">
            <input
              disabled={props.noteState === "loading" || notesLimitReached}
              id="race-opponent-note"
              maxLength={MAX_OPPONENT_NOTE_LENGTH}
              onChange={(event) =>
                props.onNoteChange(
                  event.currentTarget.value.slice(0, MAX_OPPONENT_NOTE_LENGTH),
                )
              }
              placeholder={props.t("profile.notePlaceholder")}
              value={props.noteDraft}
            />
            <button
              className="action-button"
              disabled={
                !props.noteDraft.trim() ||
                props.noteState === "loading" ||
                notesLimitReached
              }
              type="submit"
            >
              {props.noteState === "loading"
                ? props.t("settings.saving")
                : props.t("editor.addNote")}
            </button>
          </div>
          <small className="field-limit">
            {props.notes.length}/{MAX_OPPONENT_NOTES} {props.t("editor.notes").toLowerCase()},{" "}
            {props.noteDraft.length}/{MAX_OPPONENT_NOTE_LENGTH} {props.t("editor.charsEach")}
          </small>
          {props.noteState === "error" ? (
            <p className="inline-error">{props.t("editor.couldNotSaveNote")}</p>
          ) : null}
        </form>

        <div className="notes-list race-notes-list">
          {props.notes.length === 0 ? (
            <p>{props.t("profile.noRaceNotes")}</p>
          ) : (
            props.notes.map((note, index) => (
              <div className="note-item" key={`${props.opponent.id}-${props.race}-note-${index}`}>
                <p title={note}>{note}</p>
                <button
                  aria-label={`${props.t("editor.deleteNote")} ${index + 1}`}
                  className="icon-button delete-note-button"
                  disabled={props.noteState === "loading"}
                  onClick={() => void props.onNoteDelete(index)}
                  type="button"
                >
                  x
                </button>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
function WindowTitleBar({
  compactDisabled,
  compactMode,
  onToggleCompact,
  t,
}: {
  readonly compactDisabled: boolean;
  readonly compactMode: boolean;
  readonly onToggleCompact: () => void;
  readonly t: Translator;
}) {
  function minimize(): void {
    void window.sc2Assistant?.minimizeWindow();
  }
  function close(): void {
    void window.sc2Assistant?.closeWindow();
  }

  return (
    <div className="window-titlebar" role="banner">
      <div className="window-titlebar-drag">
        <span className="window-titlebar-mark" aria-hidden="true" />
        <span className="window-titlebar-title">SC2 Adjutant</span>
      </div>
      <div className="window-titlebar-controls" aria-label="Window controls">
        <button
          aria-label={t("app.window.compact")}
          aria-pressed={compactMode}
          className="window-titlebar-button"
          disabled={compactDisabled}
          onClick={onToggleCompact}
          title={t("app.window.compact")}
          type="button"
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M4.5 1.5 L4.5 4.5 L1.5 4.5 M7.5 10.5 L7.5 7.5 L10.5 7.5"
              stroke="currentColor"
              strokeWidth="1.3"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          aria-label={t("app.window.minimize")}
          className="window-titlebar-button"
          onClick={minimize}
          type="button"
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <rect x="2" y="5.5" width="8" height="1" />
          </svg>
        </button>
        <button
          aria-label={t("app.window.close")}
          className="window-titlebar-button window-titlebar-button-close"
          onClick={close}
          type="button"
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M2 2 L10 10 M10 2 L2 10"
              stroke="currentColor"
              strokeWidth="1.4"
              fill="none"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

type OpponentWorkspaceProps = {
  readonly activeView: ActiveView;
  readonly dashboardState: DashboardState;
  readonly matchFilters: MatchHistoryFilters;
  readonly matchDetailsState: MatchDetailsState;
  readonly opponentFilters: OpponentListFilters;
  readonly opponentsTab: OpponentsTab;
  readonly onAddInfo: (race: Race) => void;
  readonly onOpenNotes: (race: Race) => void;
  readonly onMatchFiltersChange: (filters: MatchHistoryFilters) => void;
  readonly onMatchSelect: (item: MatchHistoryItem) => void | Promise<void>;
  readonly onMatchFavoriteToggle: (matchId: string) => void | Promise<void>;
  readonly onOpenOpponentFromMatch: (
    opponentId: string,
  ) => void | Promise<void>;
  readonly onOpponentFiltersChange: (filters: OpponentListFilters) => void;
  readonly onOpponentSelect: (opponentId: string) => void | Promise<void>;
  readonly onOpponentMarkerToggle: (marker: OpponentMarker) => void | Promise<void>;
  readonly onOpponentVoicePreview: (data: OpponentSpeechData) => void | Promise<void>;
  readonly onOpponentsTabChange: (tab: OpponentsTab) => void;
  readonly onProfileHistoryMatchSelect: (
    item: MatchHistoryItem,
  ) => void | Promise<void>;
  readonly onRevealReplay: (replayPath: string) => void | Promise<void>;
  readonly onStrategyTagAdd: (
    race: Race,
    currentTags: readonly string[],
    tag: string,
  ) => void | Promise<void>;
  readonly onStrategyTagRemove: (
    race: Race,
    currentTags: readonly string[],
    tagIndex: number,
  ) => void | Promise<void>;
  readonly primaryOpponent: Opponent | undefined;
  readonly selectedMatch: MatchHistoryItem | undefined;
  readonly selectedMatchId: string | undefined;
  readonly selectedOpponentId: string | undefined;
  readonly t: Translator;
};

function OpponentWorkspace(props: OpponentWorkspaceProps) {
  const visibleOpponents = useMemo(
    () =>
      filterAndSortOpponents(
        props.dashboardState.opponents,
        props.opponentFilters,
      ),
    [props.dashboardState.opponents, props.opponentFilters],
  );
  const visibleMatches = useMemo(
    () =>
      filterAndSortMatches(props.dashboardState.matches, props.matchFilters),
    [props.dashboardState.matches, props.matchFilters],
  );

  const latestMatch = useMemo(
    () =>
      findLatestMatchForOpponent(
        props.dashboardState.matches,
        props.primaryOpponent?.id,
      ),
    [props.dashboardState.matches, props.primaryOpponent?.id],
  );
  const showMatchDetails =
    props.activeView === "opponents" &&
    props.opponentsTab === "history" &&
    Boolean(props.selectedMatch);

  return (
    <section
      className={`workspace ${props.activeView === "match" ? "workspace-current-match" : ""}`}
    >
      <div
        className={`panel primary-panel ${showMatchDetails ? "primary-panel-match-details" : ""}`}
      >
        {!showMatchDetails ? (
          <div className="panel-heading primary-panel-heading">
            <p className="eyebrow">{props.t("profile.opponentProfile")}</p>
            {!props.primaryOpponent ? (
              <h3>{props.t("profile.noActive")}</h3>
            ) : null}
          </div>
        ) : null}

        {showMatchDetails ? (
          <MatchDetailsPanel
            detailsState={props.matchDetailsState}
            item={props.selectedMatch}
            onOpenOpponent={props.onOpenOpponentFromMatch}
            onRevealReplay={props.onRevealReplay}
            onToggleFavorite={props.onMatchFavoriteToggle}
            t={props.t}
          />
        ) : props.primaryOpponent ? (
          <OpponentRaceProfile
            latestMatch={latestMatch}
            matches={props.dashboardState.matches}
            onAddInfoClick={props.onAddInfo}
            onMarkerToggle={props.onOpponentMarkerToggle}
            onPreviewVoiceClick={props.onOpponentVoicePreview}
            onOpenNotesClick={props.onOpenNotes}
            onHistoryMatchSelect={props.onProfileHistoryMatchSelect}
            onStrategyTagAdd={props.onStrategyTagAdd}
            onStrategyTagRemove={props.onStrategyTagRemove}
            opponent={props.primaryOpponent}
            t={props.t}
          />
        ) : (
          <div className="profile-placeholder">
            <span className="race-mark">?</span>
            <div>
              <strong>{props.t("profile.newGame")}</strong>
              <p>{profileSummary(undefined, props.dashboardState)}</p>
            </div>
          </div>
        )}
      </div>

      {props.activeView === "opponents" ? (
        <div className="panel secondary-panel">
          <div
            className="tab-switcher"
            role="tablist"
            aria-label="Opponents view"
          >
            <button
              aria-selected={props.opponentsTab === "known"}
              data-active={props.opponentsTab === "known" ? "true" : "false"}
              onClick={() => props.onOpponentsTabChange("known")}
              role="tab"
              type="button"
            >
              {props.t("header.knownOpponents")}
            </button>
            <button
              aria-selected={props.opponentsTab === "history"}
              data-active={props.opponentsTab === "history" ? "true" : "false"}
              onClick={() => props.onOpponentsTabChange("history")}
              role="tab"
              type="button"
            >
              {props.t("header.matchHistory")}
            </button>
          </div>

          {props.opponentsTab === "known" ? (
            <OpponentListView
              filters={props.opponentFilters}
              onFiltersChange={props.onOpponentFiltersChange}
              onSelectOpponent={props.onOpponentSelect}
              opponents={visibleOpponents}
              selectedOpponentId={props.selectedOpponentId}
              totalOpponents={props.dashboardState.opponents.length}
              t={props.t}
            />
          ) : (
            <MatchHistoryList
              filters={props.matchFilters}
              items={visibleMatches}
              onFiltersChange={props.onMatchFiltersChange}
              onToggleFavorite={props.onMatchFavoriteToggle}
              onSelectMatch={props.onMatchSelect}
              selectedMatchId={props.selectedMatchId}
              totalMatches={props.dashboardState.matches.length}
              t={props.t}
            />
          )}
        </div>
      ) : null}
    </section>
  );
}

function MatchDetailsPanel({
  detailsState,
  item,
  onOpenOpponent,
  onRevealReplay,
  onToggleFavorite,
  t,
}: {
  readonly detailsState: MatchDetailsState;
  readonly item: MatchHistoryItem | undefined;
  readonly onOpenOpponent: (opponentId: string) => void | Promise<void>;
  readonly onRevealReplay: (replayPath: string) => void | Promise<void>;
  readonly onToggleFavorite: (matchId: string) => void | Promise<void>;
  readonly t: Translator;
}) {
  const [activeGraphId, setActiveGraphId] = useState("armyValue");
  const details = detailsState.details;
  const graphs = details?.graphs ?? [];
  const activeGraph =
    graphs.find((graph) => graph.id === activeGraphId) ?? graphs[0];

  useEffect(() => {
    if (
      graphs.length > 0 &&
      !graphs.some((graph) => graph.id === activeGraphId)
    ) {
      setActiveGraphId(graphs[0]?.id ?? "armyValue");
    }
  }, [activeGraphId, graphs]);

  if (!item) {
    return (
      <div className="match-details-empty">
        <strong>{t("match.emptyDetails")}</strong>
        <span>{t("match.emptyDetailsHelp")}</span>
      </div>
    );
  }

  const match = details?.match ?? item.match;
  const matchFavorite = item.match.favorite;
  const opponent = details?.opponent ?? item.opponent;
  const mapName = details?.mapName ?? match.map ?? t("match.unknownMap");
  const buildOrders = details?.buildOrders ?? [];

  return (
    <div className="match-details">
      <div className="match-details-hero">
        <div>
          <p className="eyebrow">{t("match.selectedVs")}</p>
          <button
            className="match-details-opponent-link"
            onClick={() => void onOpenOpponent(match.opponentId)}
            type="button"
          >
            {opponent ? formatOpponentDisplayName(opponent) : match.opponentId}
          </button>
          <span>
            {match.opponentRace} / {match.result.toUpperCase()}
          </span>
        </div>
        <div className="match-details-actions">
          <button
            aria-label={
              matchFavorite
                ? t("list.removeFavorite")
                : t("list.addFavorite")
            }
            className="match-favorite-button match-details-favorite-button"
            data-active={matchFavorite ? "true" : "false"}
            onClick={() => void onToggleFavorite(match.id)}
            title={
              matchFavorite
                ? t("list.removeFavorite")
                : t("list.addFavorite")
            }
            type="button"
          >
            {"\u2605"}
          </button>
          <button
            className="ghost-button"
            disabled={!match.replayPath}
            onClick={() =>
              match.replayPath ? void onRevealReplay(match.replayPath) : undefined
            }
            type="button"
          >
            {t("match.replayFile")}
          </button>
        </div>
      </div>

      <div className="match-details-stats">
        <MetricCard label={t("match.map")} value={mapName} />
        <MetricCard
          label={t("match.matchTime")}
          value={formatShortDateTime(match.playedAt)}
        />
        <MetricCard
          label={t("match.duration")}
          value={
            match.durationSeconds
              ? formatDuration(match.durationSeconds)
              : t("match.unknownDuration")
          }
        />
      </div>

      {detailsState.loadState === "loading" ? (
        <div className="match-details-empty">
          <strong>{t("match.reading")}</strong>
          <span>{t("match.readingHelp")}</span>
        </div>
      ) : null}

      {detailsState.loadState === "error" ? (
        <p className="inline-error">
          {detailsState.errorMessage ?? "Failed to load match details."}
        </p>
      ) : null}

      {details?.parseError ? (
        <p className="inline-warning">
          {t("match.parser")}: {details.parseError}
        </p>
      ) : null}

      <div className="match-details-players">
        {(details?.players ?? []).map((player) => (
          <span
            className="match-player-pill"
            key={`${player.name}-${player.race}`}
          >
            {player.name} / {player.race}
            {player.apm ? ` / ${player.apm} APM` : ""}
          </span>
        ))}
      </div>

      <section className="match-details-section">
        <div className="match-details-section-head">
          <h4>{t("match.graphs")}</h4>
          <div className="graph-switcher">
            {graphs.map((graph) => (
              <button
                className={graph.id === activeGraph?.id ? "active" : ""}
                key={graph.id}
                onClick={() => setActiveGraphId(graph.id)}
                type="button"
              >
                {graph.label}
              </button>
            ))}
          </div>
        </div>
        {activeGraph ? (
          <MatchGraph graph={activeGraph} />
        ) : (
          <div className="empty-state">{t("match.emptyGraph")}</div>
        )}
      </section>

      <section className="match-details-section">
        <div className="match-details-section-head">
          <h4>{t("match.buildOrder")}</h4>
        </div>
        {buildOrders.length > 0 ? (
          <div className="build-order-grid">
            {buildOrders.slice(0, 2).map((player) => (
              <div
                className="build-order-column"
                key={`${player.playerName}-${player.race}`}
              >
                <div className="build-order-title">{player.playerName}</div>
                <div className="build-order-table">
                  {player.entries.map((entry, index) => (
                    <div
                      className="build-order-row"
                      key={`${entry.seconds}-${entry.action}-${index}`}
                    >
                      <span>{formatDuration(entry.seconds)}</span>
                      <strong>{entry.action}</strong>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">{t("match.emptyBuildOrder")}</div>
        )}
      </section>

      {details?.suspicion ? (
        <SuspicionPanel suspicion={details.suspicion} t={t} />
      ) : null}
    </div>
  );
}

function SuspicionPanel({
  suspicion,
  t,
}: {
  readonly suspicion: NonNullable<MatchDetails["suspicion"]>;
  readonly t: Translator;
}) {
  return (
    <section className="match-details-section suspicion-panel">
      <div className="match-details-section-head">
        <h4>{t("match.suspicion")}</h4>
        <span className="suspicion-note">{t("match.suspicionHint")}</span>
      </div>
      {suspicion.players.length > 0 ? (
        <div className="suspicion-grid">
          {suspicion.players.map((player) => (
            <div
              className="suspicion-card"
              data-level={player.level}
              key={`${player.playerName}-${player.race}`}
            >
              <div className="suspicion-card-head">
                <div>
                  <strong>{player.playerName}</strong>
                  <span>
                    {player.race} / {suspicionLevelText(player.level, t)}
                  </span>
                </div>
                <b>{player.score}%</b>
              </div>
              <div className="suspicion-meter" aria-hidden="true">
                <i style={{ width: `${player.score}%` }} />
              </div>
              <div className="suspicion-meta">
                <span>
                  {t("match.confidence")}: {player.confidence}%
                </span>
                <span>
                  {t("match.evidence")}: {player.evidence.length}
                </span>
              </div>
              {player.evidence.length > 0 ? (
                <div className="suspicion-evidence-list">
                  {player.evidence.slice(0, 5).map((item, index) => (
                    <div
                      className="suspicion-evidence"
                      key={`${item.seconds}-${item.type}-${index}`}
                    >
                      <span>{formatDuration(item.seconds)}</span>
                      <div>
                        <strong>{item.label}</strong>
                        <p>{item.details}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-state">{t("match.emptySuspicion")}</div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state">{t("match.emptySuspicion")}</div>
      )}
      {suspicion.parseError ? (
        <p className="inline-warning">
          {t("match.parser")}: {suspicion.parseError}
        </p>
      ) : null}
    </section>
  );
}

function suspicionLevelText(
  level: NonNullable<MatchDetails["suspicion"]>["players"][number]["level"],
  t: Translator
): string {
  if (level === "high") {
    return t("match.suspicionHigh");
  }

  if (level === "medium") {
    return t("match.suspicionMedium");
  }

  return t("match.suspicionLow");
}

function MetricCard({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="match-detail-metric">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function MatchGraph({
  graph,
}: {
  readonly graph: MatchDetails["graphs"][number];
}) {
  const width = 720;
  const height = 320;
  const padding = { left: 64, right: 18, top: 18, bottom: 52 };
  const allSamples = graph.series.flatMap((series) => series.samples);
  const maxSeconds = Math.max(1, ...allSamples.map((sample) => sample.seconds));
  const maxValue = Math.max(1, ...allSamples.map((sample) => sample.value));
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const valueTicks = [1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1];
  const timeTicks = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];

  const x = (seconds: number) =>
    padding.left + (seconds / maxSeconds) * plotWidth;
  const y = (value: number) =>
    padding.top + plotHeight - (value / maxValue) * plotHeight;

  return (
    <div className="match-graph-card">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${graph.label} graph`}
      >
        <line
          className="graph-axis"
          x1={padding.left}
          y1={padding.top}
          x2={padding.left}
          y2={padding.top + plotHeight}
        />
        <line
          className="graph-axis"
          x1={padding.left}
          y1={padding.top + plotHeight}
          x2={padding.left + plotWidth}
          y2={padding.top + plotHeight}
        />
        {valueTicks.map((tick) => (
          <g key={tick}>
            <line
              className="graph-grid-line"
              x1={padding.left}
              y1={padding.top + plotHeight - plotHeight * tick}
              x2={padding.left + plotWidth}
              y2={padding.top + plotHeight - plotHeight * tick}
            />
            <text
              className="graph-label"
              textAnchor="end"
              x={padding.left - 18}
              y={padding.top + plotHeight - plotHeight * tick + 4}
            >
              {Math.round(maxValue * tick).toLocaleString()}
            </text>
          </g>
        ))}
        {timeTicks.map((tick) => (
          <g key={`time-${tick}`}>
            <line
              className="graph-tick-line"
              x1={padding.left + plotWidth * tick}
              y1={padding.top + plotHeight}
              x2={padding.left + plotWidth * tick}
              y2={padding.top + plotHeight + 6}
            />
            <text
              className="graph-label"
              textAnchor="middle"
              x={padding.left + plotWidth * tick}
              y={padding.top + plotHeight + 22}
            >
              {formatDuration(maxSeconds * tick)}
            </text>
          </g>
        ))}
        {graph.series.map((series, index) => (
          <polyline
            className={`graph-line graph-line-${index % 2}`}
            fill="none"
            key={`${series.playerName}-${series.race}`}
            points={series.samples
              .map((sample) => `${x(sample.seconds)},${y(sample.value)}`)
              .join(" ")}
          />
        ))}
        <text className="graph-title" x={padding.left} y={padding.top - 7}>
          {graph.yLabel}
        </text>
        <text
          className="graph-title"
          x={width - padding.right}
          y={height - 8}
          textAnchor="end"
        >
          {graph.xLabel}
        </text>
      </svg>
      <div className="graph-legend">
        {graph.series.map((series, index) => (
          <span key={`${series.playerName}-legend`}>
            <i className={`graph-legend-dot graph-line-${index % 2}`} />
            {series.playerName}
          </span>
        ))}
      </div>
    </div>
  );
}

type OpponentInfoEditorProps = {
  readonly candidates: readonly EnrichmentCandidateSnapshot[];
  readonly noteDraft: string;
  readonly noteState: LoadState;
  readonly opponent: Opponent | undefined;
  readonly profileDraft: OpponentProfileDraft;
  readonly profileState: LoadState;
  readonly onBack: () => void;
  readonly onNoteChange: (value: string) => void;
  readonly onNoteDelete: (noteIndex: number) => void | Promise<void>;
  readonly onNoteSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onProfileDraftChange: (draft: OpponentProfileDraft) => void;
  readonly onProfileSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly t: Translator;
};

function OpponentInfoEditor(props: OpponentInfoEditorProps) {
  if (!props.opponent) {
    return (
      <section className="settings-layout">
        <div className="panel">
          <div className="panel-heading">
            <p className="eyebrow">{props.t("header.opponentData")}</p>
            <h3>{props.t("editor.noOpponent")}</h3>
          </div>
          <button className="ghost-button" onClick={props.onBack} type="button">
            {props.t("editor.cancelBack")}
          </button>
        </div>
      </section>
    );
  }

  const opponent = props.opponent;
  const notesLimitReached = opponent.notes.length >= MAX_OPPONENT_NOTES;

  return (
    <section className="info-editor-layout">
      <div className="panel editor-main-panel">
        <div className="panel-heading editor-heading">
          <div>
            <p className="eyebrow">{props.t("header.opponentData")}</p>
            <h3>{formatOpponentDisplayName(opponent)}</h3>
          </div>
        </div>

        <div className="editor-context-grid">
          <CandidateList candidates={props.candidates} t={props.t} />
        </div>

        <OpponentProfileForm
          draft={props.profileDraft}
          onBack={props.onBack}
          onChange={props.onProfileDraftChange}
          onSubmit={props.onProfileSubmit}
          state={props.profileState}
          t={props.t}
        />

        <div className="editor-notes-grid">
          <form className="note-form" onSubmit={props.onNoteSubmit}>
            <label htmlFor="opponent-note">{props.t("editor.quickNote")}</label>
            <div className="note-input-row">
              <input
                disabled={props.noteState === "loading" || notesLimitReached}
                id="opponent-note"
                maxLength={MAX_OPPONENT_NOTE_LENGTH}
                onChange={(event) =>
                  props.onNoteChange(
                    event.currentTarget.value.slice(
                      0,
                      MAX_OPPONENT_NOTE_LENGTH,
                    ),
                  )
                }
                placeholder="Proxy, timing, weakness..."
                value={props.noteDraft}
              />
              <button
                className="action-button"
                disabled={
                  !props.noteDraft.trim() ||
                  props.noteState === "loading" ||
                  notesLimitReached
                }
                type="submit"
              >
                {props.noteState === "loading"
                  ? props.t("settings.saving")
                  : props.t("editor.addNote")}
              </button>
            </div>
            <small className="field-limit">
              {opponent.notes.length}/{MAX_OPPONENT_NOTES}{" "}
              {props.t("editor.notes").toLowerCase()}, {props.noteDraft.length}/
              {MAX_OPPONENT_NOTE_LENGTH} {props.t("editor.charsEach")}
            </small>
            {props.noteState === "error" ? (
              <p className="inline-error">
                {props.t("editor.couldNotSaveNote")}
              </p>
            ) : null}
          </form>

          <div className="notes-list">
            <span className="section-label">{props.t("editor.notes")}</span>
            {opponent.notes.length === 0 ? (
              <p>{props.t("editor.noNotes")}</p>
            ) : (
              opponent.notes.map((note, index) => (
                <div className="note-item" key={`${opponent.id}-note-${index}`}>
                  <p title={note}>{note}</p>
                  <button
                    aria-label={`${props.t("editor.deleteNote")} ${index + 1}`}
                    className="icon-button delete-note-button"
                    disabled={props.noteState === "loading"}
                    onClick={() => void props.onNoteDelete(index)}
                    type="button"
                  >
                    x
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

const LATEST_RELEASE_URL =
  "https://github.com/DizerArt/Sc2_Adjutant/releases/latest";

function InfoView({ t }: { readonly t: Translator }) {
  return (
    <section className="info-layout">
      <div className="panel info-panel info-panel-hero">
        <div className="panel-heading">
          <p className="eyebrow">{t("info.about")}</p>
          <h3>SC2 Adjutant</h3>
        </div>
        <p className="info-paragraph">{t("info.aboutBody1")}</p>
        <p className="info-paragraph">{t("info.aboutBody2")}</p>
      </div>

      <div className="info-grid">
        <div className="panel info-panel">
          <div className="panel-heading">
            <p className="eyebrow">{t("info.author")}</p>
            <h3>{t("info.authorTitle")}</h3>
          </div>
          <p className="info-paragraph">{t("info.authorBody")}</p>
        </div>

        <div className="panel info-panel">
          <div className="panel-heading">
            <p className="eyebrow">{t("info.license")}</p>
            <h3>{t("info.licenseTitle")}</h3>
          </div>
          <p className="info-paragraph">{t("info.licenseBody")}</p>
          <div className="info-support">
            <span className="info-support-label">
              {t("info.supportAuthor")}
            </span>
            <div className="info-support-links">
              <a
                className="info-support-link"
                href="https://paypal.me/ArturioDiz"
                rel="noreferrer"
                target="_blank"
              >
                PayPal
              </a>
              <a
                className="info-support-link"
                href="https://www.donationalerts.com/r/retories"
                rel="noreferrer"
                target="_blank"
              >
                DonationAlerts
              </a>
            </div>
          </div>
        </div>
      </div>

      <div className="panel info-panel">
        <div className="panel-heading">
          <p className="eyebrow">{t("info.builtWith")}</p>
          <h3>{t("info.toolsTitle")}</h3>
        </div>
        <ul className="info-stack-list">
          <li>
            <strong>Electron</strong>
            <span>{t("info.electronDescription")}</span>
          </li>
          <li>
            <strong>React + TypeScript</strong>
            <span>{t("info.reactDescription")}</span>
          </li>
          <li>
            <strong>Vite</strong>
            <span>{t("info.viteDescription")}</span>
          </li>
          <li>
            <strong>SC2 Client API</strong>
            <span>{t("info.sc2ApiDescription")}</span>
          </li>
          <li>
            <strong>sc2readerjs</strong>
            <span>{t("info.sc2ReaderDescription")}</span>
          </li>
          <li>
            <strong>Node.js file system</strong>
            <span>{t("info.fsDescription")}</span>
          </li>
        </ul>
      </div>

      <div className="panel info-panel">
        <div className="panel-heading">
          <p className="eyebrow">{t("info.quickStart")}</p>
          <h3>{t("info.quickStartTitle")}</h3>
        </div>
        <ol className="info-guide-list">
          <li>
            <strong>{t("info.stepLaunchTitle")}</strong>
            <span>{t("info.stepLaunchBody")}</span>
          </li>
          <li>
            <strong>{t("info.stepSettingsTitle")}</strong>
            <span>{t("info.stepSettingsBody")}</span>
          </li>
          <li>
            <strong>{t("info.stepReplayTitle")}</strong>
            <span>
              {t("info.stepReplayBody")}{" "}
              <code>Documents\StarCraft II\Accounts</code>
            </span>
          </li>
          <li>
            <strong>{t("info.stepPlayTitle")}</strong>
            <span>{t("info.stepPlayBody")}</span>
          </li>
        </ol>
      </div>

      <div className="panel info-panel">
        <div className="panel-heading">
          <p className="eyebrow">{t("info.voiceSetup")}</p>
          <h3>{t("info.voiceSetupTitle")}</h3>
        </div>
        <p className="info-paragraph">{t("info.voiceSetupBody")}</p>
        <ol className="info-guide-list">
          <li>
            <strong>{t("info.voiceSetupPythonTitle")}</strong>
            <span>
              {t("info.voiceSetupPythonBody")}{" "}
              <a href="https://www.python.org/downloads/windows/" rel="noreferrer" target="_blank">
                python.org
              </a>
            </span>
          </li>
          <li>
            <strong>{t("info.voiceSetupTorchTitle")}</strong>
            <span>
              {t("info.voiceSetupTorchBody")}{" "}
              <a href="https://pytorch.org/get-started/locally/" rel="noreferrer" target="_blank">
                pytorch.org
              </a>
            </span>
            <code>python -m pip install torch --index-url https://download.pytorch.org/whl/cpu</code>
          </li>
          <li>
            <strong>{t("info.voiceSetupVerifyTitle")}</strong>
            <span>{t("info.voiceSetupVerifyBody")}</span>
            <code>python -c "import torch; print(torch.__version__)"</code>
          </li>
        </ol>
      </div>

      <div className="panel info-panel">
        <div className="panel-heading">
          <p className="eyebrow">{t("info.goodToKnow")}</p>
          <h3>{t("info.tipsTitle")}</h3>
        </div>
        <ul className="info-tips-list">
          <li>{t("info.tipDiagnostics")}</li>
          <li>{t("info.tipStorage")}</li>
          <li>{t("info.tipNotes")}</li>
          <li>{t("info.tipVoice")}</li>
          <li>{t("info.tipReadonly")}</li>
        </ul>
      </div>

    </section>
  );
}

type DiagnosticsViewProps = {
  readonly dashboardState: DashboardState;
  readonly rebuildStatsState: LoadState;
  readonly rebuildStatsSummary: string | null;
  readonly onRebuildStats: () => void | Promise<void>;
  readonly onToggleMonitoring: () => void | Promise<void>;
  readonly onToggleReplayWatcher: () => void | Promise<void>;
  readonly t: Translator;
};

function DiagnosticsView(props: DiagnosticsViewProps) {
  const statusItems = buildStatusItems(props.dashboardState, props.t);

  return (
    <section className="diagnostics-layout">
      <section className="status-grid" aria-label="System status">
        {statusItems.map((item) => (
          <article
            className="status-card"
            data-tone={item.tone}
            key={item.label}
          >
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </article>
        ))}
      </section>

      <div className="panel diagnostics-panel">
        <div className="diagnostic-actions">
          <button
            className="action-button"
            onClick={() => void props.onToggleMonitoring()}
            type="button"
          >
            {props.dashboardState.monitoring?.running
              ? props.t("diagnostics.stopMonitoring")
              : props.t("diagnostics.startMonitoring")}
          </button>
          <button
            className="ghost-button"
            onClick={() => void props.onToggleReplayWatcher()}
            type="button"
          >
            {props.dashboardState.replayWatcher?.running
              ? props.t("diagnostics.stopReplayWatcher")
              : props.t("diagnostics.startReplayWatcher")}
          </button>
          <button
            className="ghost-button"
            disabled={props.rebuildStatsState === "loading"}
            onClick={() => void props.onRebuildStats()}
            type="button"
          >
            {props.rebuildStatsState === "loading"
              ? props.t("diagnostics.rebuilding")
              : props.t("diagnostics.rebuild")}
          </button>
          {props.rebuildStatsSummary ? (
            <small>{props.rebuildStatsSummary}</small>
          ) : null}
          {props.rebuildStatsState === "error" ? (
            <small className="inline-error">
              {props.t("diagnostics.failed")}
            </small>
          ) : null}
        </div>

        <div className="diagnostic-list">
          {props.dashboardState.diagnostics?.items.map((item) => (
            <div
              className="diagnostic-row"
              data-tone={item.status}
              key={item.name}
            >
              <strong>{item.name}</strong>
              <small>{item.message}</small>
              <DiagnosticDetails item={item} t={props.t} />
            </div>
          )) ?? (
            <div className="empty-state">
              {props.t("diagnostics.notLoaded")}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function RuntimeIndicator({
  monitoring,
  replayWatcher,
  t,
}: {
  readonly monitoring: MonitoringStatus | null;
  readonly replayWatcher: ReplayWatcherStatus | null;
  readonly t: Translator;
}) {
  const state = runtimeIndicatorState(monitoring, replayWatcher);

  return (
    <span className="runtime-indicator" data-state={state}>
      {state === "active"
        ? t("runtime.active")
        : state === "partial"
          ? t("runtime.monitoring")
          : t("runtime.off")}
    </span>
  );
}

function runtimeIndicatorState(
  monitoring: MonitoringStatus | null,
  replayWatcher: ReplayWatcherStatus | null,
): "active" | "partial" | "off" {
  if (!monitoring?.running) {
    return "off";
  }

  return replayWatcher?.running ? "active" : "partial";
}

function DiagnosticDetails({
  item,
  t,
}: {
  readonly item: DiagnosticsReport["items"][number];
  readonly t: Translator;
}) {
  const sourceDiagnostics = sourceDiagnosticsFromDetails(item.details).filter(
    (source) =>
      source.state !== "ready" ||
      Boolean(source.lastFailureMessage) ||
      (source.consecutiveFailures ?? 0) > 0,
  );

  if (sourceDiagnostics.length === 0) {
    return null;
  }

  return (
    <div className="diagnostic-source-list">
      {sourceDiagnostics.map((source) => (
        <div
          className="diagnostic-source-row"
          data-state={source.state}
          key={source.name}
        >
          <span>{source.name}</span>
          <strong>{source.state}</strong>
          {source.cooldownUntil ? (
            <small>
              {t("diagnostics.cooldownUntil")}{" "}
              {source.cooldownUntil.slice(11, 19)}
            </small>
          ) : null}
          {source.lastFailureMessage ? (
            <small>{source.lastFailureMessage}</small>
          ) : null}
        </div>
      ))}
    </div>
  );
}

type SourceDiagnosticDetail = {
  readonly name: string;
  readonly state: string;
  readonly cacheEntries?: number;
  readonly consecutiveFailures?: number;
  readonly cooldownUntil?: string;
  readonly lastFailureMessage?: string;
};

function sourceDiagnosticsFromDetails(
  details: Record<string, unknown> | undefined,
): readonly SourceDiagnosticDetail[] {
  const value = details?.sourceDiagnostics;
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isSourceDiagnosticDetail);
}

function isSourceDiagnosticDetail(
  value: unknown,
): value is SourceDiagnosticDetail {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.name === "string" && typeof record.state === "string";
}

function CandidateList({
  candidates,
  t,
}: {
  readonly candidates: readonly EnrichmentCandidateSnapshot[];
  readonly t: Translator;
}) {
  const selectedCandidate =
    candidates.find((candidate) => candidate.selected) ?? candidates[0];

  if (!selectedCandidate) {
    return (
      <div className="candidate-list">
        <span className="section-label">{t("editor.sourceMatch")}</span>
        <p>{t("editor.noCandidates")}</p>
      </div>
    );
  }

  return (
    <div className="candidate-list">
      <span className="section-label">{t("editor.sourceMatch")}</span>
      <div
        className="candidate-row"
        data-selected={selectedCandidate.selected ? "true" : "false"}
      >
        <span>{selectedCandidate.source}</span>
        <strong>{selectedCandidate.nickname}</strong>
        <small>
          {selectedCandidate.race} /{" "}
          {selectedCandidate.region ? `${selectedCandidate.region} / ` : ""}
          {selectedCandidate.mmr
            ? `${selectedCandidate.mmr} MMR`
            : t("editor.mmrUnknown")}{" "}
          / {formatConfidence(selectedCandidate.confidenceScore)}
          {selectedCandidate.battleTag
            ? ` / ${selectedCandidate.battleTag}`
            : ""}
        </small>
      </div>
    </div>
  );
}

type OpponentProfileFormProps = {
  readonly draft: OpponentProfileDraft;
  readonly state: LoadState;
  readonly onChange: (draft: OpponentProfileDraft) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onBack: () => void;
  readonly t: Translator;
};

function OpponentProfileForm(props: OpponentProfileFormProps) {
  return (
    <form className="profile-edit-form" onSubmit={props.onSubmit}>
      <span className="section-label">{props.t("editor.manualProfile")}</span>
      <div className="profile-edit-grid">
        <label>
          {props.t("editor.name")}
          <input
            onChange={(event) =>
              props.onChange({
                ...props.draft,
                nickname: event.currentTarget.value,
              })
            }
            value={props.draft.nickname}
          />
        </label>
        <label>
          {props.t("profile.race")}
          <select
            onChange={(event) =>
              props.onChange({
                ...props.draft,
                race: event.currentTarget.value as Race,
              })
            }
            value={props.draft.race}
          >
            <option value="Unknown">Unknown</option>
            <option value="Terran">Terran</option>
            <option value="Protoss">Protoss</option>
            <option value="Zerg">Zerg</option>
            <option value="Random">Random</option>
          </select>
        </label>
        <label>
          BattleTag
          <input
            onChange={(event) =>
              props.onChange({
                ...props.draft,
                battleTag: event.currentTarget.value,
              })
            }
            value={props.draft.battleTag}
          />
        </label>
        <label>
          MMR
          <input
            inputMode="numeric"
            onChange={(event) =>
              props.onChange({
                ...props.draft,
                mmrAtLastMatch: event.currentTarget.value,
              })
            }
            value={props.draft.mmrAtLastMatch}
          />
        </label>
        <label>
          {props.t("profile.league")}
          <input
            onChange={(event) =>
              props.onChange({
                ...props.draft,
                league: event.currentTarget.value,
              })
            }
            value={props.draft.league}
          />
        </label>
        <label>
          {props.t("profile.confidence")} %
          <input
            inputMode="decimal"
            onChange={(event) =>
              props.onChange({
                ...props.draft,
                confidenceScore: event.currentTarget.value,
              })
            }
            value={props.draft.confidenceScore}
          />
        </label>
      </div>
      <label>
        {props.t("editor.aliases")}
        <input
          onChange={(event) =>
            props.onChange({
              ...props.draft,
              aliases: event.currentTarget.value,
            })
          }
          placeholder="comma separated"
          value={props.draft.aliases}
        />
      </label>
      <div className="form-actions">
        <button
          className="action-button"
          disabled={props.state === "loading" || !props.draft.nickname.trim()}
          type="submit"
        >
          {props.state === "loading"
            ? props.t("settings.saving")
            : props.t("editor.saveProfile")}
        </button>
        <button className="ghost-button" onClick={props.onBack} type="button">
          {props.t("editor.cancelBack")}
        </button>
        {props.state === "ready" ? (
          <span className="form-status">{props.t("settings.saved")}</span>
        ) : null}
        {props.state === "error" ? (
          <span className="form-status error">
            {props.t("settings.saveFailed")}
          </span>
        ) : null}
      </div>
    </form>
  );
}

type OpponentListViewProps = {
  readonly filters: OpponentListFilters;
  readonly onFiltersChange: (filters: OpponentListFilters) => void;
  readonly onSelectOpponent: (opponentId: string) => void | Promise<void>;
  readonly opponents: readonly Opponent[];
  readonly selectedOpponentId: string | undefined;
  readonly totalOpponents: number;
  readonly t: Translator;
};

function OpponentListView(props: OpponentListViewProps) {
  const pageSize = 11;
  const [page, setPage] = useState(0);

  useEffect(() => {
    setPage(0);
  }, [
    props.filters.query,
    props.filters.race,
    props.filters.markers,
    props.filters.sortBy,
  ]);

  function toggleFilterMarker(marker: OpponentMarker) {
    const active = props.filters.markers.includes(marker);
    props.onFiltersChange({
      ...props.filters,
      markers: active
        ? props.filters.markers.filter((item) => item !== marker)
        : [...props.filters.markers, marker],
    });
  }

  const totalPages = Math.max(1, Math.ceil(props.opponents.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const startIndex = safePage * pageSize;
  const visiblePage = props.opponents.slice(startIndex, startIndex + pageSize);

  return (
    <div className="list-section">
      <div className="list-controls">
        <input
          aria-label="Search opponents"
          onChange={(event) =>
            props.onFiltersChange({
              ...props.filters,
              query: event.currentTarget.value,
            })
          }
          placeholder={props.t("list.opponentSearch")}
          value={props.filters.query}
        />
        <select
          aria-label={props.t("list.filterRace")}
          onChange={(event) =>
            props.onFiltersChange({
              ...props.filters,
              race: event.currentTarget.value as RaceFilter,
            })
          }
          value={props.filters.race}
        >
          <option value="All">{props.t("list.allRaces")}</option>
          <option value="Terran">Terran</option>
          <option value="Protoss">Protoss</option>
          <option value="Zerg">Zerg</option>
          <option value="Random">Random</option>
          <option value="Unknown">Unknown</option>
        </select>
        <select
          aria-label={props.t("list.sort")}
          onChange={(event) =>
            props.onFiltersChange({
              ...props.filters,
              sortBy: event.currentTarget.value as OpponentSortKey,
            })
          }
          value={props.filters.sortBy}
        >
          <option value="lastSeen">{props.t("list.lastSeen")}</option>
          <option value="mmr">MMR</option>
          <option value="race">{props.t("list.race")}</option>
          <option value="confidence">{props.t("list.confidence")}</option>
        </select>
        <div
          className="opponent-marker-filter"
          aria-label={props.t("list.markerFilter")}
        >
          {OPPONENT_MARKERS.map((marker) => (
            <button
              aria-label={opponentMarkerLabel(marker, props.t)}
              data-active={
                props.filters.markers.includes(marker) ? "true" : "false"
              }
              data-marker={marker}
              key={marker}
              onClick={() => toggleFilterMarker(marker)}
              title={opponentMarkerLabel(marker, props.t)}
              type="button"
            >
              {OPPONENT_MARKER_SYMBOLS[marker]}
            </button>
          ))}
        </div>
      </div>

      <div className="list-count">
        {props.opponents.length} / {props.totalOpponents}
      </div>

      {props.opponents.length > pageSize ? (
        <div className="list-pagination">
          <button
            className="ghost-button"
            disabled={safePage <= 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
            type="button"
          >
            {props.t("list.prev")}
          </button>
          <span className="pagination-label">
            {props.t("list.page")} {safePage + 1} / {totalPages}
          </span>
          <button
            className="ghost-button"
            disabled={safePage >= totalPages - 1}
            onClick={() =>
              setPage((current) => Math.min(totalPages - 1, current + 1))
            }
            type="button"
          >
            {props.t("list.next")}
          </button>
        </div>
      ) : null}

      <div className="opponent-list">
        {props.totalOpponents === 0 ? (
          <div className="empty-state">{props.t("list.emptyOpponents")}</div>
        ) : props.opponents.length === 0 ? (
          <div className="empty-state">
            {props.t("list.opponentsNoResults")}
          </div>
        ) : (
          visiblePage.map((opponent) => (
            <button
              className="opponent-row"
              data-race={opponent.race}
              data-selected={
                opponent.id === props.selectedOpponentId ? "true" : "false"
              }
              key={opponent.id}
              onClick={() => void props.onSelectOpponent(opponent.id)}
              type="button"
            >
              <span className="race-chip" data-race={opponent.race}>
                {opponent.race.slice(0, 1)}
              </span>
              <strong>{formatOpponentDisplayName(opponent)}</strong>
              <small>{formatOpponentRowMeta(opponent)}</small>
              <OpponentMarkerStrip markers={opponent.markers ?? []} t={props.t} />
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function MatchHistoryList({
  filters,
  items,
  onFiltersChange,
  onSelectMatch,
  onToggleFavorite,
  selectedMatchId,
  t,
  totalMatches,
}: {
  readonly filters: MatchHistoryFilters;
  readonly items: readonly MatchHistoryItem[];
  readonly onFiltersChange: (filters: MatchHistoryFilters) => void;
  readonly onSelectMatch: (item: MatchHistoryItem) => void | Promise<void>;
  readonly onToggleFavorite: (matchId: string) => void | Promise<void>;
  readonly selectedMatchId: string | undefined;
  readonly totalMatches: number;
  readonly t: Translator;
}) {
  const pageSize = 9;
  const [page, setPage] = useState(0);

  useEffect(() => {
    setPage(0);
  }, [
    filters.query,
    filters.race,
    filters.favorite,
    filters.sortBy,
    items.length,
  ]);

  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const startIndex = safePage * pageSize;
  const visibleItems = items.slice(startIndex, startIndex + pageSize);

  return (
    <div className="list-section">
      <div className="list-controls">
        <input
          aria-label="Search match history"
          onChange={(event) =>
            onFiltersChange({ ...filters, query: event.currentTarget.value })
          }
          placeholder={t("list.matchSearch")}
          value={filters.query}
        />
        <select
          aria-label={t("list.filterRace")}
          onChange={(event) =>
            onFiltersChange({
              ...filters,
              race: event.currentTarget.value as RaceFilter,
            })
          }
          value={filters.race}
        >
          <option value="All">{t("list.allRaces")}</option>
          <option value="Terran">Terran</option>
          <option value="Protoss">Protoss</option>
          <option value="Zerg">Zerg</option>
          <option value="Random">Random</option>
          <option value="Unknown">Unknown</option>
        </select>
        <select
          aria-label={t("list.sort")}
          onChange={(event) =>
            onFiltersChange({
              ...filters,
              sortBy: event.currentTarget.value as MatchHistorySortKey,
            })
          }
          value={filters.sortBy}
        >
          <option value="lastSeen">{t("list.lastSeen")}</option>
          <option value="race">{t("list.race")}</option>
          <option value="result">{t("list.result")}</option>
        </select>
        <select
          aria-label={t("list.favorites")}
          onChange={(event) =>
            onFiltersChange({
              ...filters,
              favorite: event.currentTarget.value as MatchFavoriteFilter,
            })
          }
          value={filters.favorite}
        >
          <option value="All">{t("list.allGames")}</option>
          <option value="Favorites">{t("list.favorites")}</option>
        </select>
      </div>

      <div className="list-count">
        {items.length} / {totalMatches}
      </div>

      {items.length > pageSize ? (
        <div className="list-pagination">
          <button
            className="ghost-button"
            disabled={safePage <= 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
            type="button"
          >
            {t("list.prev")}
          </button>
          <span className="pagination-label">
            {t("list.page")} {safePage + 1} / {totalPages}
          </span>
          <button
            className="ghost-button"
            disabled={safePage >= totalPages - 1}
            onClick={() =>
              setPage((current) => Math.min(totalPages - 1, current + 1))
            }
            type="button"
          >
            {t("list.next")}
          </button>
        </div>
      ) : null}

      <div className="match-list">
        {totalMatches === 0 ? (
          <div className="empty-state">{t("list.emptyMatches")}</div>
        ) : items.length === 0 ? (
          <div className="empty-state">{t("list.matchesNoResults")}</div>
        ) : (
          visibleItems.map((item) => {
            const { match, opponent } = item;
            const raceKey = match.opponentRace.toLowerCase();
            return (
              <div
                className="match-row"
                data-result={match.result}
                data-selected={match.id === selectedMatchId ? "true" : "false"}
                key={match.id}
              >
                <span className="result-chip" aria-hidden="true">
                  {match.result.slice(0, 1).toUpperCase()}
                </span>
                <button
                  className="match-row-body"
                  onClick={() => void onSelectMatch(item)}
                  type="button"
                >
                  <div className="match-row-head">
                    <strong>
                      {opponent
                        ? formatOpponentDisplayName(opponent)
                        : match.opponentId}
                    </strong>
                  </div>
                  <div className="match-row-meta">
                    <span className={`match-row-race race-${raceKey}`}>
                      {match.opponentRace}
                    </span>
                    <span
                      className="match-row-duration"
                      aria-label="Match duration"
                    >
                      {match.durationSeconds
                        ? formatDuration(match.durationSeconds)
                        : "\u2014"}
                    </span>
                    <span className="match-row-time">
                      {formatShortDateTime(match.playedAt)}
                    </span>
                    {match.map ? (
                      <span className="match-row-map" title={match.map}>
                        {match.map}
                      </span>
                    ) : null}
                  </div>
                </button>
                <button
                  aria-label={
                    match.favorite
                      ? t("list.removeFavorite")
                      : t("list.addFavorite")
                  }
                  className="match-favorite-button"
                  data-active={match.favorite ? "true" : "false"}
                  onClick={() => void onToggleFavorite(match.id)}
                  title={
                    match.favorite
                      ? t("list.removeFavorite")
                      : t("list.addFavorite")
                  }
                  type="button"
                >
                  {"\u2605"}
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function formatShortDateTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return iso;
  }
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}

function formatDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatOpponentRowMeta(opponent: Opponent): string {
  const parts: string[] = [`${opponent.encounters}g`];
  if (typeof opponent.mmrAtLastMatch === "number") {
    parts.push(`${opponent.mmrAtLastMatch} MMR`);
  }
  if (opponent.wins + opponent.losses > 0) {
    parts.push(`${opponent.wins}W/${opponent.losses}L`);
  }
  return parts.join(" / ");
}

type SettingsViewProps = {
  readonly settingsDraft: SettingsDraft;
  readonly settingsState: LoadState;
  readonly storageOpenState: LoadState;
  readonly replaySyncDraft: ReplaySyncDraft;
  readonly replaySyncElapsedSeconds: number;
  readonly replaySyncState: LoadState;
  readonly replaySyncResult: SyncReplaysResponse | null;
  readonly clearStatsState: LoadState;
  readonly onChange: (settings: SettingsDraft) => void;
  readonly onOpenLocalStorage: () => void | Promise<void>;
  readonly onReplaySyncChange: (settings: ReplaySyncDraft) => void;
  readonly onReplaySyncRun: () => void | Promise<void>;
  readonly onClearStats: () => void | Promise<void>;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly t: Translator;
};

function SettingsView(props: SettingsViewProps) {
  const replaySyncLimitValid =
    props.replaySyncDraft.mode === "full" ||
    parseReplaySyncLimit(props.replaySyncDraft.limit) !== null;

  return (
    <section className="settings-layout">
      <form className="panel settings-form" onSubmit={props.onSubmit}>
        <div className="panel-heading">
          <p className="eyebrow">{props.t("settings.playerProfile")}</p>
          <h3>{props.t("settings.detection")}</h3>
        </div>

        <label>
          {props.t("settings.sc2Name")}
          <input
            onChange={(event) =>
              props.onChange({
                ...props.settingsDraft,
                playerName: event.currentTarget.value,
              })
            }
            placeholder="RetorieS"
            value={props.settingsDraft.playerName}
          />
        </label>

        <div className="settings-row">
          <label>
            {props.t("settings.language")}
            <select
              onChange={(event) =>
                props.onChange({
                  ...props.settingsDraft,
                  language: normalizeUiLanguage(event.currentTarget.value),
                })
              }
              value={props.settingsDraft.language}
            >
              <option value="en">{props.t("language.english")}</option>
              <option value="ru">{props.t("language.russian")}</option>
            </select>
          </label>

          <label>
            {props.t("settings.region")}
            <select
              onChange={(event) =>
                props.onChange({
                  ...props.settingsDraft,
                  region: event.currentTarget.value as AppSettings["region"],
                })
              }
              value={props.settingsDraft.region}
            >
              <option value="unknown">Unknown</option>
              <option value="eu">EU</option>
              <option value="us">US</option>
              <option value="kr">KR</option>
              <option value="cn">CN</option>
            </select>
          </label>

          <label>
            {props.t("settings.defaultRace")}
            <select
              onChange={(event) =>
                props.onChange({
                  ...props.settingsDraft,
                  defaultRace: event.currentTarget.value as Race,
                })
              }
              value={props.settingsDraft.defaultRace}
            >
              <option value="Unknown">Unknown</option>
              <option value="Terran">Terran</option>
              <option value="Protoss">Protoss</option>
              <option value="Zerg">Zerg</option>
              <option value="Random">Random</option>
            </select>
          </label>
        </div>

        <label>
          {props.t("settings.replayDirectory")}
          <input
            onChange={(event) =>
              props.onChange({
                ...props.settingsDraft,
                replayDirectory: event.currentTarget.value,
              })
            }
            placeholder="C:\\Users\\you\\Documents\\StarCraft II\\Accounts"
            value={props.settingsDraft.replayDirectory}
          />
        </label>

        <label>
          {props.t("settings.pollingInterval")}
          <input
            min="500"
            max="10000"
            onChange={(event) =>
              props.onChange({
                ...props.settingsDraft,
                pollingIntervalMs: event.currentTarget.value,
              })
            }
            type="number"
            value={props.settingsDraft.pollingIntervalMs}
          />
        </label>

        <label className="toggle-row">
          <input
            checked={props.settingsDraft.externalSourcesEnabled}
            onChange={(event) =>
              props.onChange({
                ...props.settingsDraft,
                externalSourcesEnabled: event.currentTarget.checked,
              })
            }
            type="checkbox"
          />
          {props.t("settings.externalSources")}
        </label>

        <label className="toggle-row">
          <input
            checked={props.settingsDraft.overlayEnabled}
            onChange={(event) => {
              const enabled = event.currentTarget.checked;
              props.onChange({
                ...props.settingsDraft,
                overlayEnabled: enabled,
                overlayPlacementMode: enabled ? props.settingsDraft.overlayPlacementMode : false,
              });
              if (enabled) {
                void window.sc2Assistant?.showOverlay();
              } else {
                void window.sc2Assistant?.setOverlayPlacementMode(false);
                void window.sc2Assistant?.hideOverlay();
              }
            }}
            type="checkbox"
          />
          {props.t("settings.enableOverlay")}
        </label>

        <label className="toggle-row">
          <input
            checked={props.settingsDraft.overlayPlacementMode}
            disabled={!props.settingsDraft.overlayEnabled}
            onChange={(event) => {
              const enabled = event.currentTarget.checked;
              props.onChange({
                ...props.settingsDraft,
                overlayPlacementMode: enabled,
              });
              void window.sc2Assistant?.setOverlayPlacementMode(enabled);
            }}
            type="checkbox"
          />
          {props.t("settings.overlayPlacementMode")}
        </label>

        <fieldset
          className="source-settings"
          disabled={!props.settingsDraft.externalSourcesEnabled}
        >
          <legend>{props.t("settings.sourceAdapters")}</legend>
          <label className="toggle-row">
            <input
              checked={props.settingsDraft.externalSources.sc2Pulse}
              onChange={(event) =>
                props.onChange({
                  ...props.settingsDraft,
                  externalSources: {
                    ...props.settingsDraft.externalSources,
                    sc2Pulse: event.currentTarget.checked,
                  },
                })
              }
              type="checkbox"
            />
            SC2Pulse
          </label>
          <label className="toggle-row">
            <input
              checked={props.settingsDraft.externalSources.localFixture}
              onChange={(event) =>
                props.onChange({
                  ...props.settingsDraft,
                  externalSources: {
                    ...props.settingsDraft.externalSources,
                    localFixture: event.currentTarget.checked,
                  },
                })
              }
              type="checkbox"
            />
            {props.t("settings.localFixture")}
          </label>
        </fieldset>

        <div className="form-actions">
          <button
            className="action-button"
            disabled={props.settingsState === "loading"}
            type="submit"
          >
            {props.settingsState === "loading"
              ? props.t("settings.saving")
              : props.t("settings.save")}
          </button>
          {props.settingsState === "ready" ? (
            <span className="form-status">{props.t("settings.saved")}</span>
          ) : null}
          {props.settingsState === "error" ? (
            <span className="form-status error">
              {props.t("settings.saveFailed")}
            </span>
          ) : null}
          <button
            className="ghost-button"
            disabled={props.storageOpenState === "loading"}
            onClick={() => void props.onOpenLocalStorage()}
            type="button"
          >
            {props.storageOpenState === "loading"
              ? props.t("settings.opening")
              : props.t("settings.openLocalStorage")}
          </button>
          {props.storageOpenState === "error" ? (
            <span className="form-status error">
              {props.t("settings.openFailed")}
            </span>
          ) : null}
        </div>
      </form>

      <section className="panel replay-sync-panel">
        <div className="panel-heading">
          <p className="eyebrow">{props.t("settings.replaySync")}</p>
          <h3>{props.t("settings.importHistory")}</h3>
        </div>

        <p className="settings-helper">{props.t("settings.syncHelp")}</p>

        <label>
          {props.t("settings.syncMode")}
          <select
            onChange={(event) =>
              props.onReplaySyncChange({
                ...props.replaySyncDraft,
                mode: event.currentTarget.value as ReplaySyncDraft["mode"],
              })
            }
            value={props.replaySyncDraft.mode}
          >
            <option value="partial">{props.t("settings.partialSync")}</option>
            <option value="full">{props.t("settings.fullSync")}</option>
          </select>
        </label>

        {props.replaySyncDraft.mode === "partial" ? (
          <label>
            {props.t("settings.latestReplays")}
            <input
              aria-invalid={!replaySyncLimitValid}
              autoComplete="off"
              inputMode="numeric"
              onChange={(event) =>
                props.onReplaySyncChange({
                  ...props.replaySyncDraft,
                  limit: sanitizeReplaySyncLimitInput(
                    event.currentTarget.value,
                  ),
                })
              }
              onBlur={() => {
                if (
                  parseReplaySyncLimit(props.replaySyncDraft.limit) === null
                ) {
                  props.onReplaySyncChange({
                    ...props.replaySyncDraft,
                    limit: DEFAULT_REPLAY_SYNC_LIMIT,
                  });
                }
              }}
              onFocus={(event) => event.currentTarget.select()}
              pattern="[0-9]*"
              placeholder={DEFAULT_REPLAY_SYNC_LIMIT}
              type="text"
              value={props.replaySyncDraft.limit}
            />
          </label>
        ) : null}

        <div className="form-actions">
          <button
            className="action-button"
            disabled={
              props.replaySyncState === "loading" || !replaySyncLimitValid
            }
            onClick={() => void props.onReplaySyncRun()}
            type="button"
          >
            {props.replaySyncState === "loading"
              ? replaySyncProgressLabel(
                  props.replaySyncResult,
                  props.replaySyncElapsedSeconds,
                  props.t,
                )
              : props.t("settings.sync")}
          </button>
          {props.replaySyncState === "error" ? (
            <span className="form-status error">
              {props.t("settings.syncFailed")}
            </span>
          ) : null}
        </div>

        {props.replaySyncResult ? (
          <div className="sync-result" role="status">
            <span>
              {props.t("sync.scanned")} {props.replaySyncResult.scannedCount}
            </span>
            <span>
              {props.t("sync.inspected")}{" "}
              {props.replaySyncResult.inspectedCount}
            </span>
            <span>
              {props.t("sync.processed")}{" "}
              {props.replaySyncResult.processedCount}/
              {props.replaySyncResult.inspectedCount}
            </span>
            <span>
              {props.t("sync.imported")} {props.replaySyncResult.importedCount}
            </span>
            <span>
              {props.t("sync.linked")} {props.replaySyncResult.linkedCount}
            </span>
            <span>
              {props.t("sync.skipped")}{" "}
              {props.replaySyncResult.skippedExistingCount}
            </span>
            <span>
              {props.t("sync.unsupported")}{" "}
              {props.replaySyncResult.skippedUnsupportedCount}
            </span>
            <span>
              {props.t("sync.failed")} {props.replaySyncResult.failedCount}
            </span>
          </div>
        ) : null}
      </section>

      <section className="panel danger-zone">
        <div className="panel-heading">
          <p className="eyebrow">{props.t("settings.danger")}</p>
          <h3>{props.t("settings.clear")}</h3>
        </div>
        <p className="danger-zone-description">
          {props.t("settings.clearDescription")}
        </p>
        <div className="form-actions">
          <button
            className="danger-button"
            disabled={props.clearStatsState === "loading"}
            onClick={() => void props.onClearStats()}
            type="button"
          >
            {props.clearStatsState === "loading"
              ? props.t("settings.clearing")
              : props.t("settings.clear")}
          </button>
          {props.clearStatsState === "ready" ? (
            <span className="form-status">{props.t("settings.cleared")}</span>
          ) : null}
          {props.clearStatsState === "error" ? (
            <span className="form-status error">
              {props.t("settings.clearFailed")}
            </span>
          ) : null}
        </div>
      </section>
    </section>
  );
}

function buildStatusItems(state: DashboardState, t: Translator) {
  if (state.loadState === "loading" || state.loadState === "idle") {
    return [
      {
        label: t("diagnostics.sc2ClientApi"),
        value: t("diagnostics.checking"),
        tone: "idle",
      },
      {
        label: t("diagnostics.localStorage"),
        value: t("diagnostics.checking"),
        tone: "idle",
      },
      {
        label: t("diagnostics.liveMonitoring"),
        value: t("diagnostics.checking"),
        tone: "idle",
      },
      {
        label: t("diagnostics.replayWatcher"),
        value: t("diagnostics.checking"),
        tone: "idle",
      },
      {
        label: "External Sources",
        value: t("diagnostics.adaptersPending"),
        tone: "idle",
      },
    ];
  }

  if (state.loadState === "error" || !state.diagnostics) {
    return [
      {
        label: t("diagnostics.sc2ClientApi"),
        value: state.errorMessage ?? t("diagnostics.unavailable"),
        tone: "error",
      },
      {
        label: t("diagnostics.localStorage"),
        value: t("diagnostics.unknown"),
        tone: "warning",
      },
      {
        label: t("diagnostics.liveMonitoring"),
        value: t("diagnostics.unknown"),
        tone: "warning",
      },
      {
        label: t("diagnostics.replayWatcher"),
        value: t("diagnostics.unknown"),
        tone: "warning",
      },
      {
        label: "External Sources",
        value: t("diagnostics.adaptersPending"),
        tone: "idle",
      },
    ];
  }

  const diagnosticsByName = new Map(
    state.diagnostics.items.map((item) => [item.name, item]),
  );

  return [
    statusItemFromDiagnostic(
      t("diagnostics.sc2ClientApi"),
      diagnosticsByName.get("SC2 Client API"),
    ),
    statusItemFromDiagnostic(
      t("diagnostics.localStorage"),
      diagnosticsByName.get("Local Storage"),
    ),
    {
      label: t("diagnostics.liveMonitoring"),
      value: state.monitoring?.running
        ? t("diagnostics.running")
        : t("diagnostics.stopped"),
      tone: state.monitoring?.running ? "ok" : "idle",
    },
    {
      label: t("diagnostics.replayWatcher"),
      value: replayWatcherStatusLabel(state.replayWatcher, t),
      tone: state.replayWatcher?.lastError
        ? "error"
        : state.replayWatcher?.running
          ? "ok"
          : "idle",
    },
    statusItemFromDiagnostic(
      "External Sources",
      diagnosticsByName.get("External Sources"),
    ),
  ];
}

function statusItemFromDiagnostic(
  label: string,
  diagnostic?: DiagnosticsReport["items"][number],
) {
  return {
    label,
    value: diagnostic?.message ?? "Not checked",
    tone: diagnosticTone(diagnostic?.status),
  };
}

function diagnosticTone(
  status: DiagnosticStatus | undefined,
): "ok" | "warning" | "error" | "idle" {
  if (status === "ok" || status === "warning" || status === "error") {
    return status;
  }

  return "idle";
}

function headerEyebrow(view: ActiveView, t: Translator): string {
  const labels: Record<ActiveView, string> = {
    match: t("header.currentMatch"),
    opponents: t("header.localDatabase"),
    diagnostics: t("header.diagnostics"),
    settings: t("header.settings"),
    voice: t("header.voice"),
    info: t("header.about"),
  };

  return labels[view];
}

function headerTitle(
  view: ActiveView,
  t: Translator,
): string {
  const labels: Record<ActiveView, string> = {
    match: t("header.currentMatchTitle"),
    opponents: t("header.localDatabase"),
    diagnostics: t("diagnostics.title"),
    settings: t("header.settingsTitle"),
    voice: t("header.voiceTitle"),
    info: t("header.aboutTitle"),
  };

  return labels[view];
}

function formatConfidence(confidenceScore: number | undefined): string {
  if (typeof confidenceScore !== "number") {
    return "Unknown";
  }

  return `${Math.round(confidenceScore * 100)}%`;
}

function replayWatcherStatusLabel(
  status: ReplayWatcherStatus | null,
  t?: Translator,
): string {
  if (!status) {
    return t ? t("diagnostics.unknown") : "Unknown";
  }

  if (status.lastError) {
    return status.lastError;
  }

  return status.running
    ? t
      ? t("diagnostics.running")
      : "Running"
    : t
      ? t("diagnostics.stopped")
      : "Stopped";
}

function filterAndSortOpponents(
  opponents: readonly Opponent[],
  filters: OpponentListFilters,
): readonly Opponent[] {
  const query = filters.query.trim().toLowerCase();

  return [...opponents]
    .filter(
      (opponent) => filters.race === "All" || opponent.race === filters.race,
    )
    .filter((opponent) =>
      filters.markers.every((marker) => (opponent.markers ?? []).includes(marker)),
    )
    .filter((opponent) => {
      if (!query) {
        return true;
      }

      return [
        opponent.nickname,
        opponent.revealedNickname ?? "",
        opponent.battleTag ?? "",
        ...opponent.aliases,
      ].some((value) => value.toLowerCase().includes(query));
    })
    .sort((first, second) => compareOpponents(first, second, filters.sortBy));
}

function OpponentMarkerStrip({
  markers,
  t,
}: {
  readonly markers: readonly OpponentMarker[];
  readonly t: Translator;
}) {
  return (
    <span className="opponent-marker-strip" aria-label={t("list.markers")}>
      {OPPONENT_MARKERS.map((marker) => (
        <span
          aria-label={opponentMarkerLabel(marker, t)}
          data-active={markers.includes(marker) ? "true" : "false"}
          data-marker={marker}
          key={marker}
          title={opponentMarkerLabel(marker, t)}
        >
          {OPPONENT_MARKER_SYMBOLS[marker]}
        </span>
      ))}
    </span>
  );
}

function opponentMarkerLabel(marker: OpponentMarker, t: Translator): string {
  if (marker === "skull") {
    return t("opponentMarker.skull");
  }
  if (marker === "heart") {
    return t("opponentMarker.heart");
  }
  return t("opponentMarker.blocked");
}

function compareOpponents(
  first: Opponent,
  second: Opponent,
  sortBy: OpponentSortKey,
): number {
  if (sortBy === "mmr") {
    return (second.mmrAtLastMatch ?? -1) - (first.mmrAtLastMatch ?? -1);
  }

  if (sortBy === "race") {
    return (
      first.race.localeCompare(second.race) ||
      first.nickname.localeCompare(second.nickname)
    );
  }

  if (sortBy === "confidence") {
    return (second.confidenceScore ?? -1) - (first.confidenceScore ?? -1);
  }

  const firstDate = first.lastMatchDate ?? first.updatedAt;
  const secondDate = second.lastMatchDate ?? second.updatedAt;
  return secondDate.localeCompare(firstDate);
}

function filterAndSortMatches(
  matches: readonly MatchHistoryItem[],
  filters: MatchHistoryFilters,
): readonly MatchHistoryItem[] {
  const query = filters.query.trim().toLowerCase();

  return [...matches]
    .filter(
      (item) =>
        filters.race === "All" || item.match.opponentRace === filters.race,
    )
    .filter((item) => filters.favorite === "All" || item.match.favorite)
    .filter((item) => {
      if (!query) {
        return true;
      }

      const opponent = item.opponent;
      return [
        opponent?.nickname ?? "",
        opponent?.revealedNickname ?? "",
        opponent?.battleTag ?? "",
        ...(opponent?.aliases ?? []),
        item.match.map ?? "",
        item.match.opponentId,
      ].some((value) => value.toLowerCase().includes(query));
    })
    .sort((first, second) => compareMatches(first, second, filters.sortBy));
}

function compareMatches(
  first: MatchHistoryItem,
  second: MatchHistoryItem,
  sortBy: MatchHistorySortKey,
): number {
  if (sortBy === "race") {
    return (
      first.match.opponentRace.localeCompare(second.match.opponentRace) ||
      second.match.playedAt.localeCompare(first.match.playedAt)
    );
  }

  if (sortBy === "result") {
    return (
      first.match.result.localeCompare(second.match.result) ||
      second.match.playedAt.localeCompare(first.match.playedAt)
    );
  }

  return second.match.playedAt.localeCompare(first.match.playedAt);
}

function findLatestMatchForOpponent(
  matches: readonly MatchHistoryItem[],
  opponentId: string | undefined,
): MatchHistoryItem | undefined {
  if (!opponentId) {
    return undefined;
  }

  return matches.find((item) => item.match.opponentId === opponentId);
}

function findCurrentMatchOpponent(
  opponents: readonly Opponent[],
  matches: readonly MatchHistoryItem[],
  monitoring: MonitoringStatus | null,
  userName?: string,
): Opponent | undefined {
  const session = monitoring?.currentSession;
  if (!session?.active || session.mode !== "ranked-1v1") {
    return undefined;
  }

  // Once SC2 has reported a final result for either player the match is
  // concluded. Treat the post-game score screen as "no active match" so the
  // current-match card reverts to the empty state instead of lingering.
  const resultUserPlayer = session.players.find((player) => player.isUser);
  const userResult = resultUserPlayer?.result;
  if (userResult === "Victory" || userResult === "Defeat") {
    return undefined;
  }
  const anyConcludedResult = session.players.some(
    (player) => player.result === "Victory" || player.result === "Defeat",
  );
  if (anyConcludedResult) {
    return undefined;
  }

  const opponentPlayer = findCurrentMatchOpponentPlayer(
    session.players,
    userName,
  );
  const opponentName = normalizePlayerIdentityName(opponentPlayer?.name);
  if (opponentName) {
    const sessionOpponent = opponents.find(
      (opponent) =>
        !isLocalOpponentRecord(opponent, userName) &&
        [opponent.nickname, opponent.battleTag ?? "", ...opponent.aliases].some(
          (name) => normalizePlayerIdentityName(name) === opponentName,
        ),
    );
    if (sessionOpponent) {
      return sessionOpponent;
    }
  }

  if (monitoring?.lastSavedMatchId) {
    const currentMatch = matches.find(
      (item) => item.match.id === monitoring.lastSavedMatchId,
    );
    const matchOpponent = currentMatch
      ? opponents.find(
          (opponent) => opponent.id === currentMatch.match.opponentId,
        )
      : undefined;

    if (matchOpponent && !isLocalOpponentRecord(matchOpponent, userName)) {
      return matchOpponent;
    }
  }

  return undefined;
}

function findCurrentMatchOpponentPlayer(
  players: readonly MonitoringSessionPlayer[],
  userName: string | undefined,
): MonitoringSessionPlayer | undefined {
  const normalizedUserName = normalizePlayerIdentityName(userName);
  if (!normalizedUserName) {
    return undefined;
  }

  const userPlayer = normalizedUserName
    ? (players.find(
        (player) =>
          normalizePlayerIdentityName(player.name) === normalizedUserName,
      ) ?? players.find((player) => player.isUser))
    : players.find((player) => player.isUser);

  if (userPlayer) {
    return players.find((player) => player !== userPlayer);
  }

  return undefined;
}

function isLocalOpponentRecord(
  opponent: Opponent,
  userName: string | undefined,
): boolean {
  const normalizedUserName = normalizePlayerIdentityName(userName);
  if (!normalizedUserName) {
    return false;
  }

  return [
    opponent.nickname,
    opponent.battleTag ?? "",
    ...opponent.aliases,
  ].some((name) => normalizePlayerIdentityName(name) === normalizedUserName);
}

function normalizePlayerIdentityName(value: string | undefined): string {
  return (value ?? "")
    .replace(/^(?:<[^>]+>\s*)+/, "")
    .replace(/#\d+$/, "")
    .trim()
    .toLowerCase();
}

function profileSummary(
  opponent: Opponent | undefined,
  state: DashboardState,
): string {
  if (opponent) {
    const mmr = opponent.mmrAtLastMatch
      ? `MMR ${opponent.mmrAtLastMatch}`
      : "MMR unknown";
    const league = opponent.league ?? "league unknown";
    return `${mmr}, ${league}. Local record is loaded from persistent storage.`;
  }

  if (state.loadState === "error") {
    return state.errorMessage ?? "Unable to load application state.";
  }

  return "Monitoring is ready for ranked 1v1 detection.";
}

function settingsDraftFromSettings(settings: AppSettings): SettingsDraft {
  return {
    playerName: settings.playerName ?? "",
    language: settings.language,
    region: settings.region,
    defaultRace: settings.defaultRace,
    replayDirectory: settings.replayDirectory ?? "",
    pollingIntervalMs: String(settings.pollingIntervalMs),
    externalSourcesEnabled: settings.externalSourcesEnabled,
    externalSources: settings.externalSources,
    overlayEnabled: settings.overlayEnabled,
    overlayPosition: settings.overlayPosition,
    overlayPlacementMode: settings.overlayPlacementMode,
  };
}

function sanitizeReplaySyncLimitInput(value: string): string {
  return value.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
}

function parseReplaySyncLimit(value: string): number | null {
  const sanitized = sanitizeReplaySyncLimitInput(value);
  if (!sanitized) {
    return null;
  }

  const parsed = Number.parseInt(sanitized, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function replaySyncProgressLabel(
  progress: SyncReplaysResponse | null,
  elapsedSeconds: number,
  t: Translator,
): string {
  const elapsed = formatDuration(elapsedSeconds);
  if (!progress) {
    return `${t("settings.syncing")} ${elapsed}`;
  }

  return `${t("settings.syncing")} ${elapsed} ${progress.processedCount}/${progress.inspectedCount}`;
}

function opponentProfileDraftFromOpponent(
  opponent: Opponent | undefined,
  candidates: readonly EnrichmentCandidateSnapshot[] = [],
  selectedRace?: Race,
): OpponentProfileDraft {
  if (!opponent) {
    return defaultOpponentProfileDraft();
  }

  const targetRace = selectedRace ?? opponent.race;
  const raceProfile = opponent.raceProfiles?.[targetRace];
  const sourceCandidate = candidateForDraft(opponent, candidates, targetRace);
  const aliases = mergeDraftValues(
    opponent.aliases,
    sourceCandidate?.aliases ?? [],
  );

  return {
    nickname: opponent.nickname,
    race:
      targetRace === "Unknown" && sourceCandidate
        ? sourceCandidate.race
        : targetRace,
    battleTag: opponent.battleTag ?? sourceCandidate?.battleTag ?? "",
    aliases: aliases.join(", "),
    mmrAtLastMatch:
      typeof sourceCandidate?.mmr === "number"
        ? String(sourceCandidate.mmr)
        : typeof raceProfile?.mmrAtLastMatch === "number"
          ? String(raceProfile.mmrAtLastMatch)
          : typeof opponent.mmrAtLastMatch === "number"
            ? String(opponent.mmrAtLastMatch)
            : "",
    league:
      sourceCandidate?.league ?? raceProfile?.league ?? opponent.league ?? "",
    strategyTags:
      raceProfile?.strategyTags && raceProfile.strategyTags.length > 0
        ? raceProfile.strategyTags.join(", ")
        : targetRace === opponent.race
          ? opponent.strategyTags.join(", ")
          : "",
    confidenceScore:
      typeof sourceCandidate?.confidenceScore === "number"
        ? String(Math.round(sourceCandidate.confidenceScore * 100))
        : typeof raceProfile?.confidenceScore === "number"
          ? String(Math.round(raceProfile.confidenceScore * 100))
          : typeof opponent.confidenceScore === "number"
            ? String(Math.round(opponent.confidenceScore * 100))
            : "",
  };
}

function candidateForDraft(
  opponent: Opponent,
  candidates: readonly EnrichmentCandidateSnapshot[],
  selectedRace?: Race,
): EnrichmentCandidateSnapshot | undefined {
  const ownCandidates = candidates.filter(
    (candidate) => candidate.opponentId === opponent.id,
  );
  const raceCandidates = selectedRace
    ? ownCandidates.filter((candidate) => candidate.race === selectedRace)
    : ownCandidates;
  const candidatesToUse =
    raceCandidates.length > 0 ? raceCandidates : ownCandidates;

  return (
    candidatesToUse.find((candidate) => candidate.selected) ??
    candidatesToUse.find((candidate) =>
      isExactNickname(candidate.nickname, opponent.nickname),
    ) ??
    candidatesToUse[0]
  );
}

function isExactNickname(first: string, second: string): boolean {
  return first.trim().toLowerCase() === second.trim().toLowerCase();
}

function mergeDraftValues(
  first: readonly string[],
  second: readonly string[],
): readonly string[] {
  const seen = new Set<string>();
  const values: string[] = [];

  for (const value of [...first, ...second]) {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }

    seen.add(key);
    values.push(normalized);
  }

  return values;
}

function defaultOpponentProfileDraft(): OpponentProfileDraft {
  return {
    nickname: "",
    race: "Unknown",
    battleTag: "",
    aliases: "",
    mmrAtLastMatch: "",
    league: "",
    strategyTags: "",
    confidenceScore: "",
  };
}

function defaultSettingsDraft(): SettingsDraft {
  return {
    playerName: "",
    language: "en",
    region: "unknown",
    defaultRace: "Unknown",
    replayDirectory: "",
    pollingIntervalMs: "1000",
    externalSourcesEnabled: true,
    externalSources: {
      sc2Pulse: true,
      localFixture: true,
    },
    overlayEnabled: false,
    overlayPosition: "top-right",
    overlayPlacementMode: false,
  };
}

function runtimeSnapshot(
  monitoring: MonitoringStatus | null,
  replayWatcher: ReplayWatcherStatus | null,
): string {
  return JSON.stringify({
    monitoring: monitoring
      ? {
          running: monitoring.running,
          lastSavedMatchId: monitoring.lastSavedMatchId,
          lastDetectedOpponent: monitoring.lastDetectedOpponent,
          lastError: monitoring.lastError,
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
        }
      : null,
    replayWatcher: replayWatcher
      ? {
          running: replayWatcher.running,
          directory: replayWatcher.directory,
          lastReplayPath: replayWatcher.lastReplayPath,
          lastLinkedMatchId: replayWatcher.lastLinkedMatchId,
          lastError: replayWatcher.lastError,
        }
      : null,
  });
}

function splitDraftList(
  value: string,
  maxItems = Number.POSITIVE_INFINITY,
  maxItemLength = Number.POSITIVE_INFINITY,
): readonly string[] {
  return value
    .split(",")
    .map((item) => item.trim().slice(0, maxItemLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function parseDraftNumber(value: string): number | undefined {
  const normalized = value.trim();

  if (!normalized) {
    return undefined;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDraftConfidence(value: string): number | undefined {
  const parsed = parseDraftNumber(value);
  return typeof parsed === "number" ? parsed / 100 : undefined;
}
