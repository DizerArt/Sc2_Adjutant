const { contextBridge, ipcRenderer } = require("electron");

const IPC_CHANNELS = {
  appVersion: "app:version",
  diagnosticsGet: "diagnostics:get",
  settingsGet: "settings:get",
  settingsSave: "settings:save",
  opponentsList: "opponents:list",
  opponentsAddNote: "opponents:add-note",
  opponentsRemoveNote: "opponents:remove-note",
  opponentsUpdateProfile: "opponents:update-profile",
  opponentsCandidates: "opponents:candidates",
  matchesList: "matches:list",
  matchesDetails: "matches:details",
  matchesToggleFavorite: "matches:toggle-favorite",
  replayReveal: "replay:reveal",
  replaysSync: "replays:sync",
  replaysSyncProgress: "replays:sync-progress",
  storageOpen: "storage:open",
  statsClear: "stats:clear",
  statsRebuild: "stats:rebuild",
  monitoringStart: "monitoring:start",
  monitoringStop: "monitoring:stop",
  monitoringStatus: "monitoring:status",
  replayWatcherStart: "replay-watcher:start",
  replayWatcherStop: "replay-watcher:stop",
  replayWatcherStatus: "replay-watcher:status",
  windowMinimize: "window:minimize",
  windowClose: "window:close",
  windowSetCompact: "window:set-compact",
  overlayShow: "overlay:show",
  overlayHide: "overlay:hide",
  overlaySetPosition: "overlay:set-position",
  overlaySetPlacementMode: "overlay:set-placement-mode",
  voiceSpeak: "voice:speak",
  voiceListAvailable: "voice:list-available",
  voiceSileroSynthesize: "voice:silero-synthesize"
};

contextBridge.exposeInMainWorld("sc2Assistant", {
  version: "0.1.0",
  getAppVersion: () => ipcRenderer.invoke(IPC_CHANNELS.appVersion),
  getDiagnostics: () => ipcRenderer.invoke(IPC_CHANNELS.diagnosticsGet),
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
  saveSettings: (request) => ipcRenderer.invoke(IPC_CHANNELS.settingsSave, request),
  listOpponents: () => ipcRenderer.invoke(IPC_CHANNELS.opponentsList),
  addOpponentNote: (request) => ipcRenderer.invoke(IPC_CHANNELS.opponentsAddNote, request),
  removeOpponentNote: (request) => ipcRenderer.invoke(IPC_CHANNELS.opponentsRemoveNote, request),
  updateOpponentProfile: (request) => ipcRenderer.invoke(IPC_CHANNELS.opponentsUpdateProfile, request),
  listOpponentCandidates: (request) => ipcRenderer.invoke(IPC_CHANNELS.opponentsCandidates, request),
  listMatches: () => ipcRenderer.invoke(IPC_CHANNELS.matchesList),
  getMatchDetails: (request) => ipcRenderer.invoke(IPC_CHANNELS.matchesDetails, request),
  toggleMatchFavorite: (request) => ipcRenderer.invoke(IPC_CHANNELS.matchesToggleFavorite, request),
  revealReplay: (request) => ipcRenderer.invoke(IPC_CHANNELS.replayReveal, request),
  syncReplays: (request) => ipcRenderer.invoke(IPC_CHANNELS.replaysSync, request),
  onReplaySyncProgress: (listener) => {
    const handler = (_event, progress) => listener(progress);
    ipcRenderer.on(IPC_CHANNELS.replaysSyncProgress, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.replaysSyncProgress, handler);
  },
  openLocalStorage: () => ipcRenderer.invoke(IPC_CHANNELS.storageOpen),
  clearStats: () => ipcRenderer.invoke(IPC_CHANNELS.statsClear),
  rebuildStats: () => ipcRenderer.invoke(IPC_CHANNELS.statsRebuild),
  startMonitoring: () => ipcRenderer.invoke(IPC_CHANNELS.monitoringStart),
  stopMonitoring: () => ipcRenderer.invoke(IPC_CHANNELS.monitoringStop),
  getMonitoringStatus: () => ipcRenderer.invoke(IPC_CHANNELS.monitoringStatus),
  startReplayWatcher: () => ipcRenderer.invoke(IPC_CHANNELS.replayWatcherStart),
  stopReplayWatcher: () => ipcRenderer.invoke(IPC_CHANNELS.replayWatcherStop),
  getReplayWatcherStatus: () => ipcRenderer.invoke(IPC_CHANNELS.replayWatcherStatus),
  minimizeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.windowMinimize),
  closeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.windowClose),
  setCompactWindow: (request) => ipcRenderer.invoke(IPC_CHANNELS.windowSetCompact, request),
  showOverlay: () => ipcRenderer.invoke(IPC_CHANNELS.overlayShow),
  hideOverlay: () => ipcRenderer.invoke(IPC_CHANNELS.overlayHide),
  setOverlayPosition: (position) => ipcRenderer.invoke(IPC_CHANNELS.overlaySetPosition, position),
  setOverlayPlacementMode: (enabled) =>
    ipcRenderer.invoke(IPC_CHANNELS.overlaySetPlacementMode, enabled),
  onVoiceSpeak: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.voiceSpeak, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.voiceSpeak, handler);
  },
  listAvailableVoices: () => ipcRenderer.invoke(IPC_CHANNELS.voiceListAvailable),
  synthesizeSilero: (request) => ipcRenderer.invoke(IPC_CHANNELS.voiceSileroSynthesize, request)
});
