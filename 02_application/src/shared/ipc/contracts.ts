import type { DiagnosticsReport } from "../../application/use-cases/run-diagnostics.js";
import type {
  GetMatchDetailsRequest,
  GetMatchDetailsResponse
} from "../../application/use-cases/get-match-details.js";
import type { MatchHistoryItem } from "../../application/use-cases/list-match-history.js";
import type {
  ToggleMatchFavoriteRequest,
  ToggleMatchFavoriteResponse
} from "../../application/use-cases/toggle-match-favorite.js";
import type {
  ReplaySyncMode,
  SyncReplayArchiveResult
} from "../../application/use-cases/sync-replay-archive.js";
import type {
  AppSettings,
  OverlayPosition,
  UpdateAppSettingsInput
} from "../../domain/entities/app-settings.js";
import type { EnrichmentCandidateSnapshot } from "../../domain/entities/enrichment-candidate-snapshot.js";
import type { Opponent, UpdateOpponentProfileInput } from "../../domain/entities/opponent.js";
import type { Race } from "../../domain/value-objects/race.js";

export type {
  VoiceOpponentSpeechData,
  VoiceMatchSpeechData,
  VoiceSpeakEvent
} from "./voice-contracts.js";

import type { VoiceSpeakEvent } from "./voice-contracts.js";

export type RendererDiagnosticsResponse = DiagnosticsReport;

export type AppVersionResponse = {
  readonly version: string;
};

export type RendererSettingsResponse = {
  readonly settings: AppSettings;
};

export type SaveSettingsRequest = UpdateAppSettingsInput;

export type RendererOpponentsResponse = {
  readonly opponents: readonly Opponent[];
};

export type AddOpponentNoteRequest = {
  readonly opponentId: string;
  readonly note: string;
  readonly race?: Race;
};

export type AddOpponentNoteResponse = {
  readonly opponent: Opponent;
};

export type RemoveOpponentNoteRequest = {
  readonly opponentId: string;
  readonly noteIndex: number;
  readonly race?: Race;
};

export type RemoveOpponentNoteResponse = {
  readonly opponent: Opponent;
};

export type UpdateOpponentProfileRequest = UpdateOpponentProfileInput & {
  readonly opponentId: string;
};

export type UpdateOpponentProfileResponse = {
  readonly opponent: Opponent;
};

export type ListOpponentCandidatesRequest = {
  readonly opponentId: string;
};

export type ListOpponentCandidatesResponse = {
  readonly candidates: readonly EnrichmentCandidateSnapshot[];
};

export type RendererMatchesResponse = {
  readonly items: readonly MatchHistoryItem[];
};

export type MatchDetailsRequest = GetMatchDetailsRequest;

export type MatchDetailsResponse = GetMatchDetailsResponse;

export type MatchFavoriteRequest = ToggleMatchFavoriteRequest;

export type MatchFavoriteResponse = ToggleMatchFavoriteResponse;

export type RevealReplayRequest = {
  readonly replayPath: string;
};

export type SyncReplaysRequest = {
  readonly mode: ReplaySyncMode;
  readonly limit?: number;
};

export type SyncReplaysResponse = SyncReplayArchiveResult;

export type SyncReplaysProgress = SyncReplayArchiveResult;

export type ClearStatsResponse = {
  readonly clearedAt: string;
};

export type RebuildStatsResponse = {
  readonly inspectedCount: number;
  readonly rebuiltCount: number;
};

export type MonitoringStatus = {
  readonly running: boolean;
  readonly currentSession?: MonitoringSessionStatus;
  readonly lastDetectedOpponent?: string;
  readonly lastSavedMatchId?: string;
  readonly lastError?: string;
};

export type MonitoringSessionStatus = {
  readonly active: boolean;
  readonly mode: string;
  readonly detectedAt: string;
  readonly players: readonly MonitoringSessionPlayer[];
};

export type MonitoringSessionPlayer = {
  readonly name: string;
  readonly race: string;
  readonly mmr?: number;
  readonly isUser?: boolean;
  readonly result?: "Victory" | "Defeat" | "Undecided" | "Unknown";
};

export type ReplayWatcherStatus = {
  readonly running: boolean;
  readonly directory?: string;
  readonly lastReplayPath?: string;
  readonly lastLinkedMatchId?: string;
  readonly lastError?: string;
};

/**
 * Compact-mode window request. When `compact` is true the main process shrinks
 * the window to the given content size and shifts it by `offsetX`/`offsetY` so
 * the information block stays pinned exactly where it was rendered on screen.
 */
export type SetCompactWindowRequest =
  | { readonly compact: false }
  | {
      readonly compact: true;
      readonly offsetX: number;
      readonly offsetY: number;
      readonly width: number;
      readonly height: number;
    };

export type Sc2AssistantBridge = {
  readonly version: string;
  readonly getAppVersion: () => Promise<AppVersionResponse>;
  readonly getDiagnostics: () => Promise<RendererDiagnosticsResponse>;
  readonly getSettings: () => Promise<RendererSettingsResponse>;
  readonly saveSettings: (request: SaveSettingsRequest) => Promise<RendererSettingsResponse>;
  readonly listOpponents: () => Promise<RendererOpponentsResponse>;
  readonly addOpponentNote: (request: AddOpponentNoteRequest) => Promise<AddOpponentNoteResponse>;
  readonly removeOpponentNote: (request: RemoveOpponentNoteRequest) => Promise<RemoveOpponentNoteResponse>;
  readonly updateOpponentProfile: (request: UpdateOpponentProfileRequest) => Promise<UpdateOpponentProfileResponse>;
  readonly listOpponentCandidates: (request: ListOpponentCandidatesRequest) => Promise<ListOpponentCandidatesResponse>;
  readonly listMatches: () => Promise<RendererMatchesResponse>;
  readonly getMatchDetails: (request: MatchDetailsRequest) => Promise<MatchDetailsResponse>;
  readonly toggleMatchFavorite: (request: MatchFavoriteRequest) => Promise<MatchFavoriteResponse>;
  readonly revealReplay: (request: RevealReplayRequest) => Promise<void>;
  readonly syncReplays: (request: SyncReplaysRequest) => Promise<SyncReplaysResponse>;
  readonly onReplaySyncProgress: (listener: (progress: SyncReplaysProgress) => void) => () => void;
  readonly openLocalStorage: () => Promise<void>;
  readonly clearStats: () => Promise<ClearStatsResponse>;
  readonly rebuildStats: () => Promise<RebuildStatsResponse>;
  readonly startMonitoring: () => Promise<MonitoringStatus>;
  readonly stopMonitoring: () => Promise<MonitoringStatus>;
  readonly getMonitoringStatus: () => Promise<MonitoringStatus>;
  readonly startReplayWatcher: () => Promise<ReplayWatcherStatus>;
  readonly stopReplayWatcher: () => Promise<ReplayWatcherStatus>;
  readonly getReplayWatcherStatus: () => Promise<ReplayWatcherStatus>;
  readonly minimizeWindow: () => Promise<void>;
  readonly closeWindow: () => Promise<void>;
  readonly setCompactWindow: (request: SetCompactWindowRequest) => Promise<void>;
  readonly showOverlay: () => Promise<void>;
  readonly hideOverlay: () => Promise<void>;
  readonly setOverlayPosition: (position: OverlayPosition) => Promise<void>;
  readonly setOverlayPlacementMode: (enabled: boolean) => Promise<void>;
  readonly onVoiceSpeak: (listener: (event: VoiceSpeakEvent) => void) => () => void;
  readonly listAvailableVoices: () => Promise<ListAvailableVoicesResponse>;
  readonly getObsOverlayInfo?: () => Promise<ObsOverlayInfo>;
  readonly configureObsOverlay?: (request: ConfigureObsOverlayRequest) => Promise<ObsOverlayInfo>;
  readonly openObsOverlayPreview?: () => Promise<void>;
  readonly getSmartOverlaySettings?: () => Promise<SmartOverlaySettingsInfo>;
  readonly saveSmartOverlayDraft?: (request: SmartOverlayDraftRequest) => Promise<SmartOverlaySettingsInfo>;
  readonly applySmartOverlay?: (request: { readonly revision: number }) => Promise<SmartOverlaySettingsInfo>;
  readonly chooseSmartOverlayImage?: (request: { readonly revision: number; readonly mode: SmartOverlayPhase }) => Promise<SmartOverlaySettingsInfo | null>;
  readonly getPostmatchStatus?: () => Promise<PostmatchStatus>;
  readonly preparePostmatch?: (request: { readonly matchId: string }) => Promise<PostmatchStatus>;
  readonly choosePostmatchReplay?: () => Promise<PostmatchStatus | null>;
};

export type PostmatchStatus = { readonly status: "empty" | "processing" | "ready" | "error"; readonly id?: string; readonly matchId?: string | null; readonly error?: string; readonly errorCode?: string; readonly startedAt?: number; readonly available: boolean; readonly visible: boolean };
export type MenuWidgetKind = "fountain" | "battle_map" | "armies" | "heroes";
export type MenuWidgetPlacement = { readonly enabled: boolean; readonly x: number; readonly y: number; readonly w: number; readonly h: number };
export type MenuWidgetLayout = { readonly columns: 32; readonly rows: 64; readonly widgets: Readonly<Record<MenuWidgetKind, MenuWidgetPlacement>> };

export type SmartOverlayPhase = "menu" | "loading" | "game" | "pause";
export type SmartOverlayImage = {
  readonly id: string;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly animated: boolean;
  readonly url: string;
  readonly posterUrl?: string;
  readonly name?: string;
};
export type SmartOverlayMode = { readonly enabled: boolean; readonly image?: SmartOverlayImage | null };
export type SmartOverlayConfig = { readonly enabled: boolean; readonly modes: Readonly<Record<SmartOverlayPhase, SmartOverlayMode>>; readonly menuLayout?: MenuWidgetLayout };
export type SmartOverlaySettingsInfo = { readonly revision: number; readonly appliedRevision: number; readonly draft: SmartOverlayConfig; readonly applied: SmartOverlayConfig };
export type SmartOverlayDraftRequest = SmartOverlayConfig & { readonly revision: number };

export type ObsOverlayInfo = {
  readonly running: boolean;
  readonly url?: string;
  readonly error?: string;
  readonly width: number;
  readonly height: number;
  readonly enabled: boolean;
  readonly position: OverlayPosition;
};

export type ConfigureObsOverlayRequest = {
  readonly enabled: boolean;
  readonly position: OverlayPosition;
  readonly width?: number;
  readonly height?: number;
};

export type ListAvailableVoicesResponse = {
  readonly available: readonly string[];
};
