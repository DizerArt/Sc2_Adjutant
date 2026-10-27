(async () => {
  for (let i = 0; i < 100 && !window.sc2Assistant; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  const native = (command, payload = null) => window.__TAURI_INTERNALS__.invoke("dispatch", { command, payload });
  try {
    const bridge = window.sc2Assistant;
    if (!bridge) throw Error("Bridge unavailable");
    const initial = await bridge.listOpponents();
    const persistedNote = initial.opponents[0]?.raceProfiles?.Terran?.notes?.includes("native smoke note") ?? false;
    const opponents = await bridge.addOpponentNote({ opponentId: "o1", note: "native smoke note", race: "Terran" });
    if (!opponents.opponent.raceProfiles?.Terran?.notes?.includes("native smoke note")) throw Error("Race-scoped note was not saved");
    const favorite = await bridge.toggleMatchFavorite({ matchId: "m1" });
    const details = await bridge.getMatchDetails({ matchId: "m1" });
    if (details.details?.mapName !== 'Map, "A" & B' || !details.details.parseError) throw Error("Match detail/error contract changed");
    const before = await native("smokeWindowState");
    await bridge.setCompactWindow({ compact: true, width: 400, height: 220, offsetX: 10, offsetY: 10 });
    const compact = await native("smokeWindowState");
    await bridge.setCompactWindow({ compact: false });
    const restored = await native("smokeWindowState");
    if (Math.abs(compact.width - 400) > 2 || Math.abs(compact.height - 220) > 2) throw Error("Native compact size was constrained");
    if (Math.abs(restored.width - before.width) > 2 || Math.abs(restored.height - before.height) > 2) throw Error("Native window size did not restore");
    await bridge.saveSettings({ overlayCustomPosition: { x: -5.5, y: 100.5 } });
    const settings = await bridge.getSettings();
    if (settings.settings.overlayCustomPosition?.x !== -5 || settings.settings.overlayCustomPosition?.y !== 101) throw Error("Coordinate normalization changed");
    const voiceModule = await import("http://voice-model.localhost/wasm/ort-wasm-simd-threaded.mjs");
    if (!voiceModule) throw Error("Local voice module did not load");
    let rejectedExternal = false;
    try { await native("openExternalUrl", { url: "file:///C:/Windows" }); } catch { rejectedExternal = true; }
    if (!rejectedExternal) throw Error("External URL validation failed");
    const initialObs = await native("getObsOverlayInfo");
    const persistedObs = initialObs.enabled === true && initialObs.position === "bottom-3"
      && initialObs.width === 2560 && initialObs.height === 1440;
    if (!initialObs.running || !initialObs.url?.startsWith("http://127.0.0.1:")) throw Error("Native OBS source unavailable");
    const configuredObs = await native("configureObsOverlay", { enabled: true, position: "bottom-3", width: 2560, height: 1440 });
    if (!configuredObs.running || configuredObs.url !== initialObs.url) throw Error("OBS source address changed during configuration");
    const finalSettings = await bridge.getSettings();
    if (finalSettings.settings.overlayEnabled !== settings.settings.overlayEnabled
      || finalSettings.settings.overlayPosition !== settings.settings.overlayPosition) throw Error("OBS configuration changed native card settings");
    const obsBeforeClose = await native("smokeObsHttpCheck");
    const initialSmart = await native("getSmartOverlaySettings");
    const persistedMenuLayout = initialSmart.applied.menuLayout?.widgets?.fountain?.x === 1
      && Object.values(initialSmart.applied.menuLayout.widgets).every((widget) => widget.enabled);
    const persistedSmart = initialSmart.draft.enabled === true && initialSmart.applied.enabled === true;
    const menuLayout = structuredClone(initialSmart.draft.menuLayout);
    for (const widget of Object.values(menuLayout.widgets)) widget.enabled = true;
    Object.assign(menuLayout.widgets.fountain, { x: 1, y: 2, w: 14, h: 30 });
    const smartDraft = await native("saveSmartOverlayDraft", { revision: initialSmart.revision, enabled: true, modes: initialSmart.draft.modes, menuLayout });
    if (smartDraft.appliedRevision !== initialSmart.appliedRevision) throw Error("Draft unexpectedly changed applied smart overlay");
    let staleSmartRejected = false;
    try { await native("applySmartOverlay", { revision: initialSmart.revision }); } catch { staleSmartRejected = true; }
    if (!staleSmartRejected) throw Error("Stale smart overlay revision was accepted");
    const smartApplied = await native("applySmartOverlay", { revision: smartDraft.revision });
    if (!smartApplied.applied.enabled || smartApplied.appliedRevision !== smartApplied.revision) throw Error("Smart overlay Apply did not persist");
    if (smartApplied.applied.menuLayout.widgets.fountain.x !== 1) throw Error("Menu layout was not applied");
    let postmatch = await native("getPostmatchStatus");
    const postmatchPreparation = await native("smokePreparePostmatch");
    let postmatchCounts = null;
    let mapBackground = null;
    if (postmatchPreparation.requested) {
      const deadline = performance.now() + 50000;
      do {
        postmatch = await native("getPostmatchStatus");
        if (postmatch.status !== "processing") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (performance.now() < deadline);
      if (postmatch.status !== "ready") throw Error("Native postmatch preparation: " + JSON.stringify(postmatch));
      postmatchCounts = await native("smokePostmatchCounts");
      if (!postmatchCounts || postmatchCounts.players < 2 || postmatchCounts.teams < 2) throw Error("Native postmatch facts were omitted");
      if (JSON.stringify(postmatchCounts) !== JSON.stringify(postmatchPreparation.decoded)) throw Error("Native projection changed replay fact counts");
      mapBackground = await native("smokeMapBackground");
    } else if (postmatch.status !== "empty") throw Error("Postmatch analysis was invented without a replay");
    let missingPostmatchRejected = false;
    try { await native("preparePostmatch", { matchId: "__not_saved__" }); } catch { missingPostmatchRejected = true; }
    if (!missingPostmatchRejected) throw Error("Unknown postmatch was accepted");
    await bridge.closeWindow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const obsAfterClose = await native("smokeObsHttpCheck");
    if (!obsAfterClose.mainWindowHidden) throw Error("Closing settings did not hide the main window");
    await native("smokeReport", { ok: true, settings: finalSettings, opponents: await bridge.listOpponents(), matches: await bridge.listMatches(),
      monitoring: await bridge.getMonitoringStatus(), voices: await bridge.listAvailableVoices(), favorite, persistedNote,
      nativeWindow: { before, compact, restored }, localVoiceModuleImported: true, invalidExternalRejected: true,
      persistedObs, persistedSmart, persistedMenuLayout, smartApplied, staleSmartRejected, missingPostmatchRejected,
      postmatch: { requested: postmatchPreparation.requested, initialStatus: postmatchPreparation.initialStatus, status: postmatch.status, counts: postmatchCounts, mapBackground },
      obs: { beforeClose: obsBeforeClose, afterClose: obsAfterClose, configured: configuredObs } });
  } catch (error) {
    await native("smokeReport", { ok: false, error: String(error) });
  }
})();
