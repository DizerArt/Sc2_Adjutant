//! Native lifecycle, bounded SC2 HTTP polling and replay-watcher orchestration.
//!
//! Complex opponent identity/enrichment/replay reconciliation deliberately uses
//! the incumbent domain compatibility adapter until native parity is proven.

use crate::replay::{ReplayRunner, scan_replays};
use crate::storage::Store;
use chrono::{DateTime, SecondsFormat, Utc};
use regex::Regex;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::task::JoinHandle;

pub type EventSink = Arc<dyn Fn(&str, Value) + Send + Sync>;

#[derive(Clone, Copy)]
enum Operation {
    Monitor(u64),
    Watcher(u64),
}

fn require_generation(current: u64, expected: u64) -> Result<(), String> {
    if current == expected {
        Ok(())
    } else {
        Err("Operation was cancelled.".into())
    }
}

struct Inner {
    lifecycle_generation: Mutex<u64>,
    shutting_down: std::sync::atomic::AtomicBool,
    // A stop/reload takes this lock before returning. A completed helper may
    // commit only while holding the matching generation lock, so an aborted
    // task cannot write an old snapshot after stop/restart.
    monitor_generation: Mutex<u64>,
    watcher_generation: Mutex<u64>,
    monitoring: Mutex<Value>,
    watcher: Mutex<Value>,
    monitor_task: Mutex<Option<JoinHandle<()>>>,
    smart_task: Mutex<Option<JoinHandle<()>>>,
    watcher_task: Mutex<Option<JoinHandle<()>>>,
    autostart_task: Mutex<Option<JoinHandle<()>>>,
    voice_task: Mutex<Option<JoinHandle<()>>>,
    announced_session: Mutex<Option<String>>,
    poller: Mutex<SessionTracker>,
    smart_phase: Mutex<crate::smart_phase::PhaseTracker>,
    sync_in_flight: std::sync::atomic::AtomicBool,
    postmatch_generation: Mutex<u64>,
    postmatch_task: Mutex<Option<JoinHandle<()>>>,
    postmatch: Mutex<Value>,
    last_live_replay: Mutex<Option<LiveReplayContext>>,
}
#[derive(Clone)]
struct LiveReplayContext {
    names: Vec<String>,
    seconds: f64,
    menu_samples: u32,
    ended_at: Option<std::time::Instant>,
    candidates: HashSet<PathBuf>,
}

#[derive(Clone)]
pub struct Runtime {
    pub operation_gate: Arc<tokio::sync::Mutex<()>>,
    store: Arc<Store>,
    replay: ReplayRunner,
    events: EventSink,
    client: reqwest::Client,
    network_enabled: bool,
    review_replays: Option<PathBuf>,
    inner: Arc<Inner>,
}

impl Runtime {
    pub fn new(store: Arc<Store>, replay: ReplayRunner, events: EventSink) -> Result<Self, String> {
        let latest = store.postmatch_latest()?;
        let postmatch = if latest["id"].as_str().is_some_and(|s| s.len() == 64) {
            json!({"status":"ready","id":latest["id"],"matchId":latest["matchId"],"startedAt":latest["startedAt"],"automatic":latest["automatic"]==true})
        } else {
            json!({"status":"empty"})
        };
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(1))
            .timeout(Duration::from_secs(1))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            operation_gate: Arc::new(tokio::sync::Mutex::new(())),
            store,
            replay,
            events,
            client,
            network_enabled: true,
            review_replays: None,
            inner: Arc::new(Inner {
                lifecycle_generation: Mutex::new(0),
                shutting_down: std::sync::atomic::AtomicBool::new(false),
                monitor_generation: Mutex::new(0),
                watcher_generation: Mutex::new(0),
                monitoring: Mutex::new(json!({"running":false})),
                watcher: Mutex::new(json!({"running":false})),
                monitor_task: Mutex::new(None),
                smart_task: Mutex::new(None),
                watcher_task: Mutex::new(None),
                autostart_task: Mutex::new(None),
                voice_task: Mutex::new(None),
                announced_session: Mutex::new(None),
                poller: Mutex::new(SessionTracker::default()),
                smart_phase: Mutex::new(crate::smart_phase::PhaseTracker::default()),
                sync_in_flight: std::sync::atomic::AtomicBool::new(false),
                postmatch_generation: Mutex::new(0),
                postmatch_task: Mutex::new(None),
                postmatch: Mutex::new(postmatch),
                last_live_replay: Mutex::new(None),
            }),
        })
    }

    pub async fn dispatch(&self, command: &str, payload: Value) -> Option<Result<Value, String>> {
        if self
            .inner
            .shutting_down
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Some(Err("Application is shutting down.".into()));
        }
        Some(match command {
            "startMonitoring" => self.start_monitoring(),
            "stopMonitoring" => Ok(self.stop_monitoring()),
            "getMonitoringStatus" => Ok(self.monitoring_status()),
            "startReplayWatcher" => self.start_watcher(),
            "stopReplayWatcher" => Ok(self.stop_watcher()),
            "getReplayWatcherStatus" => Ok(self.watcher_status()),
            "getDiagnostics" => self.diagnostics().await,
            "getMatchDetails" => self.match_details(payload).await,
            "syncReplays" => self.sync_replays(payload).await,
            "clearStats" => {
                let _gate = self.operation_gate.lock().await;
                self.cancel_postmatch(true);
                self.store.handle("clearStats", payload)
            }
            "getPostmatchStatus" => Ok(self.postmatch_status(false)),
            "getPostmatchData" => self.postmatch_data(false).map(|v| v.unwrap_or(Value::Null)),
            "preparePostmatch" => {
                if payload.as_object().is_none_or(|p| p.len() != 1)
                    || !payload["matchId"].is_string()
                {
                    Err("Choose a saved match for post-match analysis".into())
                } else {
                    self.prepare_postmatch(payload["matchId"].as_str().unwrap(), false)
                }
            }
            _ => return None,
        })
    }

    pub fn without_network(mut self) -> Self {
        self.network_enabled = false;
        self
    }

    pub fn for_visual_review(mut self) -> Result<Self, String> {
        let expected = self.store.root().join("fixtures/replays");
        let root = expected
            .canonicalize()
            .map_err(|_| "Prepare the visual review replay fixtures first")?;
        if root != expected {
            return Err("Visual review replays must stay inside the marked profile".into());
        }
        self.store.save_settings(json!({"replayDirectory":root}))?;
        self.network_enabled = false;
        self.review_replays = Some(root);
        Ok(self)
    }

    pub fn validate_review_settings(&self, input: &Value) -> Result<(), String> {
        if let Some(root) = &self.review_replays
            && let Some(value) = input.get("replayDirectory")
        {
            let normalized = |s: &str| {
                s.trim_start_matches(r"\\?\")
                    .trim_end_matches(['\\', '/'])
                    .replace('/', "\\")
            };
            if !value.as_str().is_some_and(|s| {
                normalized(s).eq_ignore_ascii_case(&normalized(&root.to_string_lossy()))
            }) {
                return Err("Visual review uses only its own fixtures/replays folder".into());
            }
        }
        Ok(())
    }

    fn configured_replay_directory(&self, settings: &Value) -> Option<PathBuf> {
        self.review_replays
            .clone()
            .or_else(|| replay_directory(settings))
    }

    fn validate_review_replay(&self, path: &Path) -> Result<(), String> {
        if let Some(root) = &self.review_replays
            && (!path.starts_with(root)
                || !path.canonicalize().is_ok_and(|file| file.starts_with(root)))
        {
            return Err("Visual review reads only its own replay fixtures".into());
        }
        Ok(())
    }

    pub fn monitoring_status(&self) -> Value {
        self.inner
            .monitoring
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn watcher_status(&self) -> Value {
        self.inner
            .watcher
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub fn postmatch_status(&self, preview: bool) -> Value {
        let mut status = self
            .inner
            .postmatch
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        status["available"] = json!(status["status"] == "ready");
        status["visible"] = json!(
            status["status"] == "ready"
                && (preview
                    || self
                        .store
                        .settings()
                        .is_ok_and(|s| crate::postmatch::visible(&s, &self.monitoring_status())))
        );
        status
    }
    pub fn postmatch_data(&self, preview: bool) -> Result<Option<Value>, String> {
        let status = self.postmatch_status(preview);
        if status["visible"] != true {
            return Ok(None);
        }
        let id = status["id"]
            .as_str()
            .ok_or("Post-match identity is unavailable")?;
        let Some(facts) = self.store.postmatch_facts(id)? else {
            return Ok(None);
        };
        let mut facts = crate::postmatch::sanitize(&facts, id)?;
        if let Some(map_sha) = facts["map_sha256"].as_str() {
            facts["map_background"] = crate::map_background::cached(self.store.root(), map_sha)
                .unwrap_or_else(|_| crate::map_background::unavailable());
        }
        facts["startedAt"] = status["startedAt"].clone();
        Ok(Some(facts))
    }
    fn cancel_postmatch(&self, clear: bool) {
        self.cancel_postmatch_owned(clear, false);
    }
    fn cancel_postmatch_owned(&self, clear: bool, automatic_only: bool) {
        let mut slot = self
            .inner
            .postmatch_task
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if automatic_only && self.postmatch_status(true)["automatic"] != true {
            return;
        }
        let mut generation = self
            .inner
            .postmatch_generation
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *generation = generation.wrapping_add(1);
        if let Some(task) = slot.take() {
            task.abort();
        }
        if clear {
            *self
                .inner
                .postmatch
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = json!({"status":"empty"});
            let _ = self.store.clear_postmatch_latest();
        }
    }
    fn prepare_postmatch(&self, match_id: &str, automatic: bool) -> Result<Value, String> {
        if self
            .inner
            .shutting_down
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err("Application is shutting down".into());
        }
        let record = self
            .store
            .records("matches")?
            .into_iter()
            .find(|m| m["id"] == match_id)
            .ok_or("Saved match was not found")?;
        let path = record["replayPath"]
            .as_str()
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
            .ok_or("This match has no linked replay")?;
        self.prepare_postmatch_source(Some(match_id), path, automatic)
    }
    /// Only the native file picker may provide this path; it never crosses renderer IPC.
    pub fn prepare_selected_postmatch(&self, selected: Option<&Path>) -> Result<Value, String> {
        match selected {
            Some(path) => self.prepare_postmatch_source(None, path.to_path_buf(), false),
            None => Ok(Value::Null),
        }
    }
    fn prepare_postmatch_source(
        &self,
        match_id: Option<&str>,
        path: PathBuf,
        automatic: bool,
    ) -> Result<Value, String> {
        // Background discovery must never replace an explicit selection or restart its clock.
        if automatic && self.postmatch_status(true)["status"] != "empty" {
            return Err("Post-match analysis already has an active selection".into());
        }
        if self
            .inner
            .shutting_down
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err("Application is shutting down".into());
        }
        if !path.is_absolute() {
            return Err("The match replay path must be absolute".into());
        }
        self.validate_review_replay(&path)?;
        crate::replay::validate_replay(&path)
            .map_err(|_| "The selected replay is unavailable or unsupported")?;
        if automatic && !match_id.is_some_and(|id| self.auto_postmatch_eligible(id)) {
            return Err("Automatic post-match identity is not confirmed".into());
        }
        let mut slot = self
            .inner
            .postmatch_task
            .lock()
            .map_err(|e| e.to_string())?;
        // Recheck under the task owner lock: an explicit request may have started during validation.
        if automatic && self.postmatch_status(true)["status"] != "empty" {
            return Err("Post-match analysis already has an active selection".into());
        }
        let generation = {
            let mut value = self
                .inner
                .postmatch_generation
                .lock()
                .map_err(|e| e.to_string())?;
            *value = value.wrapping_add(1);
            *value
        };
        if let Some(task) = slot.take() {
            task.abort();
        }
        *self.inner.postmatch.lock().map_err(|e| e.to_string())? =
            json!({"status":"processing","matchId":match_id,"automatic":automatic});
        let runtime = self.clone();
        let match_id = match_id.map(str::to_string);
        *slot = Some(tokio::spawn(async move {
            let outcome = runtime
                .produce_postmatch(match_id.as_deref(), &path, generation, automatic)
                .await;
            if let Err(error) = outcome {
                runtime.publish_postmatch_failure(
                    match_id.as_deref(),
                    generation,
                    automatic,
                    &error,
                );
            }
            (runtime.events)("postmatch-updated", runtime.postmatch_status(false));
        }));
        drop(slot);
        Ok(self.postmatch_status(false))
    }
    fn publish_postmatch_failure(
        &self,
        match_id: Option<&str>,
        generation: u64,
        automatic: bool,
        error: &str,
    ) {
        let current = self
            .inner
            .postmatch_generation
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if *current != generation {
            return;
        }
        let settings = self.store.settings().unwrap_or(Value::Null);
        let language = settings["language"].as_str().unwrap_or("ru");
        let (code, message) = crate::postmatch::failure_message(error, language);
        *self
            .inner
            .postmatch
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = json!({"status":"error","matchId":match_id,"automatic":automatic,"errorCode":code,"error":message});
    }
    fn auto_postmatch_eligible(&self, match_id: &str) -> bool {
        let status = self.monitoring_status();
        if status["lastSavedMatchId"] != match_id
            || self
                .store
                .settings()
                .map_or(true, |s| !crate::postmatch::visible(&s, &status))
        {
            return false;
        }
        self.inner
            .last_live_replay
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|context| {
                context.seconds > 120.
                    && context.menu_samples >= 2
                    && context.candidates.len() == 1
                    && context
                        .ended_at
                        .is_some_and(|t| t.elapsed() <= Duration::from_secs(120))
            })
    }
    async fn produce_postmatch(
        &self,
        match_id: Option<&str>,
        path: &Path,
        generation: u64,
        automatic: bool,
    ) -> Result<(), String> {
        let source = path.to_path_buf();
        let id = tokio::task::spawn_blocking(move || crate::postmatch::fingerprint(&source))
            .await
            .map_err(|e| format!("source: {e}"))?
            .map_err(|e| format!("source: {e}"))?;
        let facts = match self
            .store
            .postmatch_facts(&id)
            .map_err(|e| format!("cache: {e}"))?
        {
            Some(value) => {
                crate::postmatch::sanitize(&value, &id).map_err(|e| format!("cache: {e}"))?
            }
            None => {
                let decoded = self
                    .replay
                    .postmatch(path)
                    .await
                    .map_err(|e| format!("decode: {e}"))?;
                crate::postmatch::sanitize(&decoded, &id).map_err(|e| format!("projection: {e}"))?
            }
        };
        if let Some(map_sha) = facts["map_sha256"].as_str() {
            let bank = self
                .replay
                .resources_root()
                .map(|root| root.join("map-bank"));
            // Background failure is independent from replay facts; public reads use only a validated cache.
            let _ = crate::map_background::resolve(
                self.store.root(),
                bank.as_deref(),
                &self.replay,
                map_sha,
            )
            .await;
        }
        // A source changed while decoding cannot be attributed to the fingerprint read before it.
        let source = path.to_path_buf();
        let after = tokio::task::spawn_blocking(move || crate::postmatch::fingerprint(&source))
            .await
            .map_err(|e| format!("source: {e}"))?
            .map_err(|e| format!("source: {e}"))?;
        if after != id {
            return Err("Replay changed while preparing facts".into());
        }
        let current = self
            .inner
            .postmatch_generation
            .lock()
            .map_err(|e| e.to_string())?;
        require_generation(*current, generation)?;
        if self
            .inner
            .shutting_down
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err("Post-match analysis was cancelled".into());
        }
        if automatic {
            let match_id = match_id.ok_or("Automatic analysis requires a saved match")?;
            if !self.auto_postmatch_eligible(match_id) {
                return Err("Automatic replay identity is no longer confirmed".into());
            }
            let context = self
                .inner
                .last_live_replay
                .lock()
                .map_err(|e| e.to_string())?
                .clone()
                .ok_or("Live replay identity is unavailable")?;
            if !context.candidates.contains(
                &path
                    .canonicalize()
                    .map_err(|_| "Replay became unavailable")?,
            ) {
                return Err("Replay candidate identity changed".into());
            }
            let mut names = facts["players"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p["name"].as_str().unwrap_or("").trim().to_lowercase())
                .collect::<Vec<_>>();
            names.sort();
            let seconds = facts["game_seconds"].as_f64().unwrap_or(0.);
            if names != context.names
                || (seconds - context.seconds).abs() > 30f64.max(context.seconds * 0.1)
            {
                return Err("Replay roster or duration did not match the observed game".into());
            }
        }
        if let Some(match_id) = match_id {
            let linked = self
                .store
                .records("matches")?
                .into_iter()
                .find(|m| m["id"] == match_id)
                .ok_or("Saved match was removed")?;
            if linked["replayPath"].as_str().map(Path::new) != Some(path) {
                return Err("The match replay link changed during analysis".into());
            }
        }
        let started_at = Utc::now().timestamp_millis() as f64 / 1000.;
        let latest =
            json!({"id":id,"matchId":match_id,"startedAt":started_at,"automatic":automatic});
        self.store
            .save_postmatch(&id, &facts, &latest)
            .map_err(|e| format!("storage: {e}"))?;
        *self.inner.postmatch.lock().map_err(|e| e.to_string())? = json!({"status":"ready","id":id,"matchId":match_id,"startedAt":started_at,"automatic":automatic});
        Ok(())
    }

    pub fn start_monitoring(&self) -> Result<Value, String> {
        let mut task = self.inner.monitor_task.lock().map_err(|e| e.to_string())?;
        if self
            .inner
            .shutting_down
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err("Application is shutting down.".into());
        }
        if task.as_ref().is_some_and(|t| !t.is_finished()) {
            return Ok(self.monitoring_status());
        }
        let generation = {
            let mut generation = self
                .inner
                .monitor_generation
                .lock()
                .map_err(|e| e.to_string())?;
            *generation = generation.wrapping_add(1);
            let mut status = self.inner.monitoring.lock().map_err(|e| e.to_string())?;
            status["running"] = json!(true);
            status["smartPhase"] = json!("unknown");
            if let Some(fields) = status.as_object_mut() {
                fields.remove("smartSampleAt");
            }
            self.inner
                .smart_phase
                .lock()
                .map_err(|e| e.to_string())?
                .reset();
            *generation
        };
        self.start_smart_sampling(generation)?;
        let runtime = self.clone();
        *task = Some(tokio::spawn(async move {
            loop {
                if let Err(error) = runtime.poll_once(generation).await {
                    runtime.monitor_error(generation, &error);
                }
                let settings = runtime.store.settings().unwrap_or_else(|_| json!({}));
                let configured = std::env::var("SC2_ASSISTANT_POLL_INTERVAL_MS")
                    .ok()
                    .and_then(|value| value.parse::<u64>().ok())
                    .filter(|value| *value > 0)
                    .or_else(|| settings["pollingIntervalMs"].as_u64())
                    .unwrap_or(1000)
                    .clamp(100, 60_000);
                let active = runtime.monitoring_status()["currentSession"]["active"]
                    .as_bool()
                    .unwrap_or(false);
                let delay = if active {
                    configured
                } else {
                    (configured * 4).max(4000)
                };
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }
        }));
        Ok(self.monitoring_status())
    }

    pub fn stop_monitoring(&self) -> Value {
        let mut task = self
            .inner
            .monitor_task
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut generation = self
            .inner
            .monitor_generation
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *generation = generation.wrapping_add(1);
        if let Some(task) = task.take() {
            task.abort();
        }
        if let Some(task) = self
            .inner
            .smart_task
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            task.abort();
        }
        self.cancel_voice();
        self.inner
            .smart_phase
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reset();
        self.inner
            .monitoring
            .lock()
            .unwrap_or_else(|e| e.into_inner())["running"] = json!(false);
        self.monitoring_status()
    }

    /// Called only by the interactive desktop lifecycle, never by constructors/tests.
    pub fn start_autostart(&self) {
        let mut slot = self
            .inner
            .autostart_task
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if self
            .inner
            .shutting_down
            .load(std::sync::atomic::Ordering::SeqCst)
            || slot.as_ref().is_some_and(|t| !t.is_finished())
        {
            return;
        }
        let runtime = self.clone();
        *slot = Some(tokio::spawn(async move {
            loop {
                if runtime.read_game().await.is_ok() {
                    let _ = runtime.start_monitoring();
                    let _ = runtime.start_watcher();
                    break;
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }));
    }

    pub fn shutdown(&self) {
        self.inner
            .shutting_down
            .store(true, std::sync::atomic::Ordering::SeqCst);
        {
            let mut generation = self
                .inner
                .lifecycle_generation
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            *generation = generation.wrapping_add(1);
        }
        if let Some(task) = self
            .inner
            .autostart_task
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            task.abort();
        }
        self.stop_monitoring();
        self.stop_watcher();
        self.cancel_postmatch(false);
    }

    pub fn reload_settings(&self) -> Result<(), String> {
        // Restart live polling so a request started with the previous user or
        // region cannot commit after Settings has been saved.
        let monitoring = self.monitoring_status()["running"] == true;
        if monitoring {
            self.stop_monitoring();
        }
        *self.inner.poller.lock().map_err(|e| e.to_string())? = SessionTracker::default();
        self.cancel_voice();
        *self
            .inner
            .announced_session
            .lock()
            .map_err(|e| e.to_string())? = None;
        let was_running = self.watcher_status()["running"].as_bool().unwrap_or(false);
        if was_running {
            self.stop_watcher();
            self.start_watcher()?;
        }
        if monitoring {
            self.start_monitoring()?;
        }
        Ok(())
    }

    async fn read_sc2_document(&self, name: &str) -> Result<Value, String> {
        if !self.network_enabled {
            return Err("SC2 network access is disabled for isolated verification.".into());
        }
        let mut response = self
            .client
            .get(format!("http://127.0.0.1:6119/{name}"))
            .send()
            .await
            .map_err(|_| "Unable to read SC2 Client API".to_owned())?;
        if !response.status().is_success() {
            return Err(format!("SC2 Client API returned {}", response.status()));
        }
        let mut data = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if data.len() + chunk.len() > 65_536 {
                return Err("SC2 Client API response exceeds 64 KiB.".into());
            }
            data.extend_from_slice(&chunk);
        }
        let payload: Value = serde_json::from_slice(&data)
            .map_err(|_| "SC2 Client API returned invalid JSON.".to_owned())?;
        Ok(payload)
    }

    async fn read_game(&self) -> Result<Value, String> {
        session_from_payload(&self.read_sc2_document("game").await?, Utc::now())
    }

    /// Artwork has its own owned read loop so slow identity/replay enrichment
    /// cannot delay a loading cover or make a healthy SC2 sample look stale.
    fn start_smart_sampling(&self, generation: u64) -> Result<(), String> {
        let mut slot = self.inner.smart_task.lock().map_err(|e| e.to_string())?;
        if let Some(previous) = slot.take() {
            previous.abort();
        }
        let runtime = self.clone();
        *slot = Some(tokio::spawn(async move {
            loop {
                let enabled = runtime
                    .store
                    .settings()
                    .is_ok_and(|s| s["obsOverlay"]["smartApplied"]["enabled"] == true);
                let sample = if enabled {
                    match runtime.read_sc2_document("game").await {
                        Ok(game) => runtime
                            .read_sc2_document("ui")
                            .await
                            .ok()
                            .map(|ui| (game, ui)),
                        Err(_) => None,
                    }
                } else {
                    None
                };
                let phase = match runtime.publish_smart_sample(generation, sample) {
                    Ok(phase) => phase,
                    Err(_) => break,
                };
                tokio::time::sleep(Duration::from_millis(if phase == "loading" {
                    250
                } else {
                    1000
                }))
                .await;
            }
        }));
        Ok(())
    }

    fn publish_smart_sample(
        &self,
        generation: u64,
        sample: Option<(Value, Value)>,
    ) -> Result<&'static str, String> {
        let current = self
            .inner
            .monitor_generation
            .lock()
            .map_err(|e| e.to_string())?;
        require_generation(*current, generation)?;
        let mut status = self.inner.monitoring.lock().map_err(|e| e.to_string())?;
        let mut tracker = self.inner.smart_phase.lock().map_err(|e| e.to_string())?;
        let mut new_live_game = false;
        let phase = if let Some((game, ui)) = sample {
            let phase = tracker.observe(&game, &ui, std::time::Instant::now());
            let mut context = self
                .inner
                .last_live_replay
                .lock()
                .map_err(|e| e.to_string())?;
            if matches!(phase, "game" | "pause") && game["isReplay"] == false {
                let mut names = game["players"]
                    .as_array()
                    .unwrap_or(&Vec::new())
                    .iter()
                    .filter_map(|p| p["name"].as_str())
                    .map(|s| s.trim().to_lowercase())
                    .collect::<Vec<_>>();
                names.sort();
                let seconds = game["displayTime"].as_f64().unwrap_or(0.);
                new_live_game = context.as_ref().is_none_or(|c| {
                    c.ended_at.is_some() || c.names != names || seconds + 5. < c.seconds
                });
                if new_live_game {
                    *context = Some(LiveReplayContext {
                        names,
                        seconds,
                        menu_samples: 0,
                        ended_at: None,
                        candidates: HashSet::new(),
                    });
                } else if let Some(context) = context.as_mut() {
                    context.seconds = seconds;
                    context.menu_samples = 0;
                    context.ended_at = None;
                }
            } else if phase == "menu"
                && let Some(context) = context.as_mut()
            {
                context.menu_samples = context.menu_samples.saturating_add(1);
                context.ended_at.get_or_insert_with(std::time::Instant::now);
            }
            phase
        } else {
            tracker.reset();
            "unknown"
        };
        status["smartPhase"] = json!(phase);
        status["smartSampleAt"] = json!(crate::domain::now());
        drop(tracker);
        drop(status);
        drop(current);
        if new_live_game {
            self.cancel_postmatch(true);
        } else if phase == "menu"
            && let Some(id) = self.monitoring_status()["lastSavedMatchId"].as_str()
        {
            let status = self.postmatch_status(false);
            if status["status"] == "empty" {
                let _ = self.prepare_postmatch(id, true);
            }
        }
        Ok(phase)
    }

    async fn poll_once(&self, generation: u64) -> Result<(), String> {
        let settings = self.store.settings()?;
        let session = self.read_game().await?;
        let (session, changed) = {
            let current = self
                .inner
                .monitor_generation
                .lock()
                .map_err(|e| e.to_string())?;
            require_generation(*current, generation)?;
            self.inner
                .poller
                .lock()
                .map_err(|e| e.to_string())?
                .observe(session)
        };
        let user_name = configured_user(&settings);
        {
            let current = self
                .inner
                .monitor_generation
                .lock()
                .map_err(|e| e.to_string())?;
            require_generation(*current, generation)?;
            let mut status = self.inner.monitoring.lock().map_err(|e| e.to_string())?;
            status["lastSampleAt"] = json!(crate::domain::now());
            status["currentSession"] = json!({
                "active":session["isActive"],"mode":session["mode"],
                "detectedAt":session["detectedAt"],"players":session["players"]
            });
            if let Some(object) = status.as_object_mut() {
                object.remove("lastError");
            }
        }
        if session["mode"] != "ranked-1v1"
            || session["isActive"] != true
            || has_final_result(&session)
        {
            self.cancel_voice();
        }
        if !changed || session["mode"] != "ranked-1v1" || session["isActive"] != true {
            return Ok(());
        }
        if find_user_index(
            session["players"].as_array().unwrap_or(&Vec::new()),
            &user_name,
        )
        .is_none()
        {
            return Err("Set SC2 name in Settings so the opponent can be identified.".into());
        }
        let result = self.domain_request("registerDetectedGame",json!({
            "session":session,"userName":user_name,"region":settings["region"].as_str().unwrap_or("unknown").to_uppercase()
        }), Some(Operation::Monitor(generation))).await?;
        if result.is_null() {
            return Ok(());
        }
        {
            let current = self
                .inner
                .monitor_generation
                .lock()
                .map_err(|e| e.to_string())?;
            require_generation(*current, generation)?;
            let mut status = self.inner.monitoring.lock().map_err(|e| e.to_string())?;
            status["lastDetectedOpponent"] = result["enrichedOpponent"]["nickname"].clone();
            status["lastSavedMatchId"] = result["match"]["id"].clone();
        }
        if !has_final_result(&session) {
            let age = session["startedAt"]
                .as_str()
                .and_then(parse_time)
                .map(|start| Utc::now().signed_duration_since(start).num_seconds());
            if age.is_none_or(|seconds| seconds <= 120) {
                // Exact domain result is used; no invented MMR or race fallback.
                let opponent = &result["enrichedOpponent"];
                let nickname = opponent["revealedNickname"]
                    .as_str()
                    .or_else(|| opponent["nickname"].as_str());
                self.schedule_voice(generation,session["id"].as_str().unwrap_or("").to_owned(),json!({"kind":"opponent","data":{
                    "nickname":nickname,"race":result["match"]["opponentRace"],"mmr":opponent["mmrAtLastMatch"],
                    "encounters":opponent["encounters"],"wins":opponent["wins"],"losses":opponent["losses"],
                    "strategyTags":opponent["strategyTags"],"notes":opponent["notes"]
                }}));
            }
        }
        Ok(())
    }

    fn monitor_error(&self, generation: u64, error: &str) {
        let current = self
            .inner
            .monitor_generation
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if *current != generation {
            return;
        }
        self.inner
            .monitoring
            .lock()
            .unwrap_or_else(|e| e.into_inner())["lastError"] = json!(error);
    }

    fn cancel_voice(&self) {
        if let Some(task) = self
            .inner
            .voice_task
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            task.abort();
        }
    }

    fn schedule_voice(&self, generation: u64, session_id: String, event: Value) {
        let current = self
            .inner
            .monitor_generation
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if *current != generation {
            return;
        }
        if self
            .inner
            .announced_session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_deref()
            == Some(&session_id)
        {
            return;
        }
        self.cancel_voice();
        let runtime = self.clone();
        let task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            let current = runtime
                .inner
                .monitor_generation
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if *current != generation {
                return;
            }
            let status = runtime.monitoring_status();
            if status["running"] != true
                || status["currentSession"]["active"] != true
                || status["currentSession"]["players"]
                    .as_array()
                    .is_some_and(|p| {
                        p.iter()
                            .any(|p| p["result"] == "Victory" || p["result"] == "Defeat")
                    })
            {
                return;
            }
            *runtime
                .inner
                .announced_session
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Some(session_id);
            (runtime.events)("voice-speak", event);
        });
        *self
            .inner
            .voice_task
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(task);
    }

    pub fn start_watcher(&self) -> Result<Value, String> {
        let mut task = self.inner.watcher_task.lock().map_err(|e| e.to_string())?;
        if self
            .inner
            .shutting_down
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err("Application is shutting down.".into());
        }
        if task.as_ref().is_some_and(|t| !t.is_finished()) {
            return Ok(self.watcher_status());
        }
        let directory = self.configured_replay_directory(&self.store.settings()?);
        let generation = {
            let mut generation = self
                .inner
                .watcher_generation
                .lock()
                .map_err(|e| e.to_string())?;
            *generation = generation.wrapping_add(1);
            *self.inner.watcher.lock().map_err(|e| e.to_string())? =
                json!({"running":true,"directory":directory});
            *generation
        };
        let runtime = self.clone();
        *task = Some(tokio::spawn(async move {
            let mut seen = HashSet::new();
            let mut snapshot_only = true;
            loop {
                let result = runtime
                    .watch_once(directory.clone(), &mut seen, snapshot_only, generation)
                    .await;
                if result.is_ok() {
                    snapshot_only = false;
                }
                if let Err(error) = result {
                    let current = runtime
                        .inner
                        .watcher_generation
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    if *current == generation {
                        runtime
                            .inner
                            .watcher
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())["lastError"] = json!(error);
                    }
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }));
        Ok(self.watcher_status())
    }

    pub fn stop_watcher(&self) -> Value {
        let mut task = self
            .inner
            .watcher_task
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut generation = self
            .inner
            .watcher_generation
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *generation = generation.wrapping_add(1);
        if let Some(task) = task.take() {
            task.abort();
        }
        self.inner.watcher.lock().unwrap_or_else(|e| e.into_inner())["running"] = json!(false);
        self.watcher_status()
    }

    async fn watch_once(
        &self,
        directory: Option<PathBuf>,
        seen: &mut HashSet<PathBuf>,
        snapshot_only: bool,
        generation: u64,
    ) -> Result<(), String> {
        let directory = directory.ok_or("Replay directory is not configured.")?;
        let files = tokio::task::spawn_blocking(move || scan_replays(&directory))
            .await
            .map_err(|e| e.to_string())??;
        let mut last_error = None;
        for file in files {
            let old_enough = parse_time(&file.modified_at)
                .is_some_and(|t| Utc::now().signed_duration_since(t).num_seconds() >= 10);
            if !old_enough || seen.contains(&file.path) {
                continue;
            }
            if snapshot_only {
                seen.insert(file.path);
                continue;
            }
            let settings = self.store.settings()?;
            let user_name = configured_user(&settings);
            let outcome = async {
                let metadata = self.replay.metadata(&file, &user_name).await?;
                self.domain_request(
                    "processReplay",
                    json!({"metadata":metadata,"userName":user_name,"region":settings["region"]}),
                    Some(Operation::Watcher(generation)),
                )
                .await
            }
            .await;
            let result = match outcome {
                Ok(result) => result,
                Err(error) => {
                    let current = self
                        .inner
                        .watcher_generation
                        .lock()
                        .map_err(|e| e.to_string())?;
                    require_generation(*current, generation)?;
                    last_error = Some(error);
                    // A bad/unsupported replay must not starve every later file.
                    continue;
                }
            };
            // Mark only successfully parsed files. A transient parser failure is retried.
            seen.insert(file.path.clone());
            let current = self
                .inner
                .watcher_generation
                .lock()
                .map_err(|e| e.to_string())?;
            require_generation(*current, generation)?;
            let mut status = self.inner.watcher.lock().map_err(|e| e.to_string())?;
            status["lastReplayPath"] = json!(file.path);
            status["lastLinkedMatchId"] = result["match"]["id"].clone();
            if let Some(object) = status.as_object_mut() {
                object.remove("lastError");
            }
            let linked = result["match"]["id"].as_str().map(str::to_string);
            drop(status);
            drop(current);
            if linked.as_deref() == self.monitoring_status()["lastSavedMatchId"].as_str()
                && linked.is_some()
            {
                let mut context = self
                    .inner
                    .last_live_replay
                    .lock()
                    .map_err(|e| e.to_string())?;
                if let Some(context) = context.as_mut()
                    && let Ok(path) = file.path.canonicalize()
                {
                    context.candidates.insert(path);
                }
            }
        }
        self.reconcile_postmatch_candidates()?;
        match last_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn reconcile_postmatch_candidates(&self) -> Result<(), String> {
        let ambiguous = self
            .inner
            .last_live_replay
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .is_some_and(|c| c.candidates.len() > 1);
        if ambiguous {
            // Uncertain automatic attribution does not invalidate a file the user selected.
            self.cancel_postmatch_owned(true, true);
        } else if let Some(id) = self.monitoring_status()["lastSavedMatchId"].as_str()
            && self.postmatch_status(false)["status"] == "empty"
        {
            let _ = self.prepare_postmatch(id, true);
        }
        Ok(())
    }

    async fn domain_request(
        &self,
        command: &str,
        mut payload: Value,
        operation: Option<Operation>,
    ) -> Result<Value, String> {
        let _guard = self.operation_gate.lock().await;
        let lifecycle_generation = *self
            .inner
            .lifecycle_generation
            .lock()
            .map_err(|e| e.to_string())?;
        if self
            .inner
            .shutting_down
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err("Application is shutting down.".into());
        }
        payload["settings"] = self.worker_settings()?;
        payload["records"] = json!({
            "opponents":self.store.records("opponents")?,"matches":self.store.records("matches")?,
            "candidates":self.store.records("candidates")?,"fixtures":self.store.records("fixtures")?,
            "sourceCache":self.store.source_cache()?
        });
        let response = self.replay.request(command, payload).await?;
        self.commit_domain_response(&response, operation, lifecycle_generation)
    }

    fn worker_settings(&self) -> Result<Value, String> {
        let mut settings = self.store.settings()?;
        if !self.network_enabled {
            settings["externalSourcesEnabled"] = json!(false);
            settings["externalSources"] = json!({"sc2Pulse":false,"localFixture":false});
        }
        Ok(settings)
    }

    fn commit_domain_response(
        &self,
        response: &Value,
        operation: Option<Operation>,
        lifecycle_generation: u64,
    ) -> Result<Value, String> {
        let result = response
            .get("result")
            .cloned()
            .ok_or("Domain compatibility worker omitted its result.")?;
        let current_lifecycle = self
            .inner
            .lifecycle_generation
            .lock()
            .map_err(|e| e.to_string())?;
        require_generation(*current_lifecycle, lifecycle_generation)?;
        let generation = match operation {
            Some(Operation::Monitor(expected)) => Some((
                self.inner
                    .monitor_generation
                    .lock()
                    .map_err(|e| e.to_string())?,
                expected,
            )),
            Some(Operation::Watcher(expected)) => Some((
                self.inner
                    .watcher_generation
                    .lock()
                    .map_err(|e| e.to_string())?,
                expected,
            )),
            None => None,
        };
        if let Some((current, expected)) = &generation {
            require_generation(**current, *expected)?;
        }
        self.store.replace_records_atomic(&response["records"])?;
        Ok(result)
    }

    async fn sync_replays(&self, request: Value) -> Result<Value, String> {
        use std::sync::atomic::Ordering;
        if self.inner.sync_in_flight.swap(true, Ordering::SeqCst) {
            return Err("Replay synchronization is already running.".into());
        }
        struct Reset<'a>(&'a std::sync::atomic::AtomicBool);
        impl Drop for Reset<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _reset = Reset(&self.inner.sync_in_flight);
        let mode = request["mode"]
            .as_str()
            .ok_or("Choose full or partial replay synchronization.")?;
        if mode != "full" && mode != "partial" {
            return Err("Choose full or partial replay synchronization.".into());
        }
        let limit = if mode == "partial" {
            request
                .get("limit")
                .map(|v| {
                    v.as_u64()
                        .filter(|n| *n > 0 && *n <= 100_000)
                        .ok_or("Replay limit must be a positive integer.")
                })
                .transpose()?
                .unwrap_or(25)
        } else {
            100_000
        };
        let settings = self.store.settings()?;
        let user_name = configured_user(&settings);
        if user_name.is_empty() {
            return Err("SC2 name is not configured.".into());
        }
        let directory = self
            .configured_replay_directory(&settings)
            .ok_or("Replay directory is not configured.")?;
        let files = tokio::task::spawn_blocking(move || scan_replays(&directory))
            .await
            .map_err(|e| e.to_string())??;
        let mut totals = json!({"scannedCount":files.len(),"inspectedCount":files.len().min(limit as usize),
            "processedCount":0,"importedCount":0,"linkedCount":0,"skippedExistingCount":0,"skippedUnsupportedCount":0,"failedCount":0});
        (self.events)("replays-sync-progress", totals.clone());
        for file in files.into_iter().take(limit as usize) {
            if self.inner.shutting_down.load(Ordering::SeqCst) {
                return Err("Replay synchronization was cancelled.".into());
            }
            let outcome = async {
                let metadata = self.replay.metadata(&file,&user_name).await?;
                self.domain_request("syncReplay",json!({"metadata":metadata,"file":{"path":file.path,"modifiedAt":file.modified_at},
                    "userName":user_name,"region":settings["region"]}),None).await
            }.await;
            match outcome {
                Ok(result) => {
                    for key in [
                        "importedCount",
                        "linkedCount",
                        "skippedExistingCount",
                        "skippedUnsupportedCount",
                        "failedCount",
                    ] {
                        totals[key] = json!(
                            totals[key].as_u64().unwrap_or(0) + result[key].as_u64().unwrap_or(0)
                        );
                    }
                }
                Err(_) => {
                    totals["failedCount"] = json!(totals["failedCount"].as_u64().unwrap_or(0) + 1)
                }
            }
            totals["processedCount"] = json!(totals["processedCount"].as_u64().unwrap_or(0) + 1);
            (self.events)("replays-sync-progress", totals.clone());
        }
        if let Some(id) = self.monitoring_status()["lastSavedMatchId"].as_str() {
            let _ = self.prepare_postmatch(id, true);
        }
        Ok(totals)
    }

    async fn match_details(&self, request: Value) -> Result<Value, String> {
        let id = request["matchId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Match id is required.")?;
        let Some(record) = self
            .store
            .records("matches")?
            .into_iter()
            .find(|m| m["id"] == id)
        else {
            return Ok(json!({"details":null}));
        };
        let opponent = self
            .store
            .records("opponents")?
            .into_iter()
            .find(|o| o["id"] == record["opponentId"]);
        let mut details = json!({"match":record,"opponent":opponent,"mapName":record["map"].as_str().unwrap_or("Unknown map"),
            "playedAt":record["playedAt"],"durationSeconds":record["durationSeconds"],"replayPath":record["replayPath"],
            "players":[],"graphs":[],"buildOrders":[]});
        if let Some(path) = record["replayPath"].as_str().filter(|s| !s.is_empty()) {
            if let Err(error) = self.validate_review_replay(Path::new(path)) {
                details["parseError"] = json!(error);
                return Ok(json!({"details":details}));
            }
            let name = opponent.as_ref().and_then(|o| o["nickname"].as_str());
            match self.replay.analysis(Path::new(path), name).await {
                Ok(analysis) => {
                    for key in [
                        "players",
                        "graphs",
                        "buildOrders",
                        "averageApm",
                        "suspicion",
                        "parseError",
                    ] {
                        if let Some(value) = analysis.get(key) {
                            details[key] = value.clone();
                        }
                    }
                }
                Err(error) => details["parseError"] = json!(error),
            }
        }
        Ok(json!({"details":details}))
    }

    async fn diagnostics(&self) -> Result<Value, String> {
        let sc2 = match self.read_game().await {
            Ok(session) => {
                json!({"name":"SC2 Client API","status":if session["isActive"]==true {"ok"} else {"warning"},
                "message":"SC2 Client API is reachable.","details":{"mode":session["mode"],"players":session["players"]}})
            }
            Err(error) => json!({"name":"SC2 Client API","status":"error","message":error}),
        };
        let opponents = self.store.records("opponents")?;
        let matches = self.store.records("matches")?;
        let orphan = matches
            .iter()
            .filter(|m| !opponents.iter().any(|o| o["id"] == m["opponentId"]))
            .count();
        let drift = opponents
            .iter()
            .filter(|o| {
                o["encounters"].as_u64().unwrap_or(0)
                    != matches
                        .iter()
                        .filter(|m| m["opponentId"] == o["id"])
                        .count() as u64
            })
            .count();
        let settings = self.store.settings()?;
        let mut sources = Vec::new();
        if settings["externalSourcesEnabled"] == true {
            if settings["externalSources"]["sc2Pulse"] == true {
                sources.push("SC2Pulse");
            }
            if settings["externalSources"]["localFixture"] == true {
                sources.push("Local Fixture Source");
            }
        }
        let items = vec![
            sc2,
            json!({"name":"Local Storage","status":"ok","message":"SQLite store is available.","details":{"opponents":opponents.len(),"matches":matches.len()}}),
            json!({"name":"External Sources","status":if sources.is_empty(){"warning"}else{"ok"},"message":if sources.is_empty(){"External opponent sources are disabled or unconfigured."}else{"Configured adapters run only during explicit or live opponent processing."},"details":{"enabled":settings["externalSourcesEnabled"],"configuredSources":sources}}),
            json!({"name":"Stats Health","status":if orphan+drift>0{"warning"}else{"ok"},"message":format!("{} orphan matches; {} opponents with encounter drift.",orphan,drift)}),
            json!({"name":"Replay Parser","status":if self.replay.available(){"ok"}else{"error"},"message":if self.replay.available(){"Bundled compatibility decoder is available; native Rust decoder remains pending."}else{"Replay compatibility decoder is missing."}}),
        ];
        let overall = if items.iter().any(|v| v["status"] == "error") {
            "error"
        } else if items.iter().any(|v| v["status"] == "warning") {
            "warning"
        } else {
            "ok"
        };
        Ok(json!({"checkedAt":now(),"overallStatus":overall,"items":items}))
    }
}

pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn parse_time(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}
fn configured_user(settings: &Value) -> String {
    std::env::var("SC2_ASSISTANT_PLAYER_NAME")
        .ok()
        .unwrap_or_else(|| settings["playerName"].as_str().unwrap_or("").to_owned())
        .trim()
        .to_owned()
}

fn replay_directory(settings: &Value) -> Option<PathBuf> {
    if let Some(path) = settings["replayDirectory"]
        .as_str()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        return Some(PathBuf::from(path));
    }
    for base in [
        std::env::var_os("USERPROFILE"),
        std::env::var_os("OneDrive"),
    ]
    .into_iter()
    .flatten()
    {
        let documents = PathBuf::from(base).join("Documents/StarCraft II");
        for candidate in [documents.join("Accounts"), documents] {
            if candidate.is_dir() {
                return Some(candidate);
            }
        }
    }
    None
}

pub fn normalize_identity(value: &str) -> String {
    let start = Regex::new(r"^(?:<[^>]+>\s*)+").unwrap();
    let end = Regex::new(r"(?:\s*<[^>]+>)+$").unwrap();
    let tag = Regex::new(r"#\d+$").unwrap();
    let value = start.replace_all(value, "");
    let value = end.replace_all(&value, "");
    tag.replace_all(&value, "").trim().to_lowercase()
}

fn find_user_index(players: &[Value], user: &str) -> Option<usize> {
    let key = normalize_identity(user);
    if !key.is_empty()
        && let Some(index) = players
            .iter()
            .position(|p| normalize_identity(p["name"].as_str().unwrap_or("")) == key)
    {
        return Some(index);
    }
    players.iter().position(|p| p["isUser"] == true)
}

pub fn session_from_payload(payload: &Value, detected: DateTime<Utc>) -> Result<Value, String> {
    static BATTLE_TAG: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"^[^#\s]+#\d+$").unwrap());
    static TOON: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"^\d+-S2-\d+-\d+$").unwrap());
    if !payload.is_object() {
        return Err("Unsupported SC2 Client API payload.".into());
    }
    let mut players = Vec::new();
    if let Some(raw) = payload["players"].as_array() {
        if raw.len() > 32 {
            return Err("SC2 Client API player list is too large.".into());
        }
        for player in raw {
            let name = ["name", "nickname", "displayName"]
                .into_iter()
                .find_map(|k| player[k].as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let Some(name) = name else {
                continue;
            };
            let race = [
                "race",
                "playedRace",
                "actualRace",
                "raceActual",
                "selectedRace",
                "raceSelected",
                "type",
            ]
            .into_iter()
            .map(|k| normalize_race(player[k].as_str().unwrap_or("")))
            .find(|s| *s != "Unknown")
            .unwrap_or("Unknown");
            let result = player["result"]
                .as_str()
                .filter(|r| ["Victory", "Defeat", "Undecided"].contains(r))
                .unwrap_or("Unknown");
            let mut value = json!({"name":name,"race":race,"result":result});
            if let Some(is_user) = player["isUser"].as_bool() {
                value["isUser"] = json!(is_user);
            }
            if let Some(mmr) = [
                "mmr",
                "MMR",
                "rating",
                "ladderMmr",
                "ladderMMR",
                "oneVsOneMmr",
                "currentMmr",
            ]
            .into_iter()
            .find_map(|key| normalized_mmr(&player[key]))
            .or_else(|| find_mmr(player, 2))
            {
                value["mmr"] = json!(mmr);
            }
            if let Some(tag) = find_string(player, 3, &|key, s| {
                key.to_lowercase().contains("battle")
                    && key.to_lowercase().contains("tag")
                    && BATTLE_TAG.is_match(s)
            }) {
                value["battleTag"] = json!(tag);
            }
            if let Some(profile) = find_profile_link(player, 3) {
                value["profileLink"] = json!(profile);
            } else if let Some(toon) = find_string(player, 3, &|_, s| TOON.is_match(s)) {
                let parts: Vec<_> = toon.split('-').collect();
                value["profileLink"] = json!(format!(
                    "battlenet:://starcraft/profile/{}/{}",
                    parts[0], parts[3]
                ));
            }
            players.push(value);
        }
    }
    let replay = payload["isReplay"].as_bool().unwrap_or(false);
    let mode = if replay || players.len() != 2 {
        "unsupported"
    } else {
        "ranked-1v1"
    };
    let started = payload["displayTime"]
        .as_f64()
        .filter(|n| n.is_finite() && *n <= 365.0 * 86400.0)
        .map(|seconds| {
            DateTime::from_timestamp(detected.timestamp() - seconds.max(0.0).floor() as i64, 0)
                .unwrap_or(detected)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        });
    let mut keys: Vec<_> = players
        .iter()
        .map(|p| {
            p["profileLink"]
                .as_str()
                .or_else(|| p["name"].as_str())
                .unwrap_or("")
                .trim()
                .to_lowercase()
        })
        .collect();
    keys.sort();
    let mut session = json!({"id":format!("{}:{}",keys.join("|"),started.as_deref().unwrap_or("no-start")),"isActive":!players.is_empty()&&!replay,"mode":mode,"players":players,"detectedAt":detected.to_rfc3339_opts(SecondsFormat::Millis,true)});
    if let Some(started) = started {
        session["startedAt"] = json!(started);
    }
    Ok(session)
}

fn normalize_race(value: &str) -> &'static str {
    match value.trim().to_ascii_lowercase().as_str() {
        "terran" | "t" => "Terran",
        "protoss" | "p" => "Protoss",
        "zerg" | "z" => "Zerg",
        "random" | "r" => "Random",
        _ => "Unknown",
    }
}
fn find_mmr(value: &Value, depth: usize) -> Option<u64> {
    if let Some(array) = value.as_array() {
        return if depth > 0 {
            array.iter().find_map(|value| find_mmr(value, depth - 1))
        } else {
            None
        };
    }
    let object = value.as_object()?;
    for (key, candidate) in object {
        let key = key.to_ascii_lowercase();
        if key != "rating" && !key.ends_with("mmr") {
            continue;
        }
        if let Some(n) = normalized_mmr(candidate) {
            return Some(n);
        }
    }
    if depth > 0 {
        for candidate in object.values() {
            if let Some(n) = find_mmr(candidate, depth - 1) {
                return Some(n);
            }
        }
    }
    None
}
fn normalized_mmr(value: &Value) -> Option<u64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|s| s.trim().parse().ok()))
        .filter(|n| n.is_finite() && *n > 0.0 && *n <= 1_000_000.0)
        .map(|n| n.round() as u64)
}
fn find_profile_link(value: &Value, depth: usize) -> Option<String> {
    let profile=Regex::new(r"(?i)battlenet:://starcraft/profile/\d+/\d+|https?://starcraft2\.blizzard\.com/profile/\d+/\d+/\d+").unwrap();
    find_string(value, depth, &|_, s| profile.is_match(s)).and_then(|s| {
        profile.find(&s).map(|m| {
            let found = m.as_str();
            if found.to_ascii_lowercase().starts_with("battlenet") {
                format!("battlenet{}", &found[9..])
            } else {
                found.to_owned()
            }
        })
    })
}
fn find_string(
    value: &Value,
    depth: usize,
    predicate: &dyn Fn(&str, &str) -> bool,
) -> Option<String> {
    if let Some(object) = value.as_object() {
        for (key, candidate) in object {
            if let Some(s) = candidate
                .as_str()
                .map(str::trim)
                .filter(|s| s.len() <= 2048 && predicate(key, s))
            {
                return Some(s.to_owned());
            }
        }
        if depth > 0 {
            for candidate in object.values() {
                if let Some(s) = find_string(candidate, depth - 1, predicate) {
                    return Some(s);
                }
            }
        }
    } else if depth > 0
        && let Some(array) = value.as_array()
    {
        for candidate in array {
            if let Some(s) = find_string(candidate, depth - 1, predicate) {
                return Some(s);
            }
        }
    }
    None
}
fn has_final_result(session: &Value) -> bool {
    session["players"].as_array().is_some_and(|players| {
        players
            .iter()
            .any(|p| p["result"] == "Victory" || p["result"] == "Defeat")
    })
}

#[derive(Default)]
pub struct SessionTracker {
    anchor: Option<(String, String, bool)>,
    last_event: Option<String>,
}
impl SessionTracker {
    pub fn observe(&mut self, mut session: Value) -> (Value, bool) {
        if session["isActive"] != true || session["mode"] != "ranked-1v1" {
            self.anchor = None;
            self.last_event = None;
            return (session, false);
        }
        let players = session["players"].as_array().cloned().unwrap_or_default();
        let mut keys: Vec<_> = players
            .iter()
            .map(|p| {
                format!(
                    "{}:{}",
                    p["name"].as_str().unwrap_or("").to_lowercase(),
                    p["race"].as_str().unwrap_or("Unknown")
                )
            })
            .collect();
        keys.sort();
        let key = keys.join("|");
        let raw = session["startedAt"]
            .as_str()
            .unwrap_or_else(|| session["detectedAt"].as_str().unwrap_or(""))
            .to_owned();
        let final_result = has_final_result(&session);
        let fresh = self.anchor.as_ref().is_none_or(|(old, start, _)| {
            old != &key
                || (!final_result
                    && parse_time(start)
                        .zip(parse_time(&raw))
                        .is_some_and(|(a, b)| (b - a).num_milliseconds().abs() > 5000))
        });
        if fresh {
            self.anchor = Some((key, raw, final_result));
        } else if final_result && let Some(anchor) = self.anchor.as_mut() {
            anchor.2 = true;
        }
        let Some((_, start, had_final)) = self.anchor.as_ref() else {
            return (session, false);
        };
        let mut names: Vec<_> = players
            .iter()
            .map(|p| p["name"].as_str().unwrap_or("").trim().to_lowercase())
            .collect();
        names.sort();
        session["startedAt"] = json!(start);
        session["id"] = json!(format!("{}:{}", names.join("|"), start));
        let mut result_keys: Vec<_> = players
            .iter()
            .map(|p| {
                format!(
                    "{}:{}:{}",
                    p["name"].as_str().unwrap_or("").to_lowercase(),
                    p["result"].as_str().unwrap_or("Unknown"),
                    p["mmr"]
                )
            })
            .collect();
        result_keys.sort();
        let event = format!("{}:{}", session["id"], result_keys.join("|"));
        let changed = (!*had_final || final_result) && self.last_event.as_deref() != Some(&event);
        if changed {
            self.last_event = Some(event);
        }
        (session, changed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn at(value: &str) -> DateTime<Utc> {
        parse_time(value).unwrap()
    }
    fn payload() -> Value {
        json!({"players":[{"name":"<TAG>Игрок","race":"Terran","isUser":true},{"name":"Enemy","race":"Zerg","MMR":"4300"}],"displayTime":100,"isReplay":false})
    }
    #[test]
    fn normalizes_real_fields_without_claiming_replays_or_team_games_are_ranked() {
        let mut raw = payload();
        let session = session_from_payload(&raw, at("2026-01-01T12:00:00Z")).unwrap();
        assert_eq!(session["players"][1]["mmr"], 4300);
        assert_eq!(session["mode"], "ranked-1v1");
        assert_eq!(session["startedAt"], "2026-01-01T11:58:20.000Z");
        assert_eq!(
            find_user_index(session["players"].as_array().unwrap(), "Игрок"),
            Some(0)
        );
        raw["isReplay"] = json!(true);
        let replay = session_from_payload(&raw, Utc::now()).unwrap();
        assert_eq!(replay["mode"], "unsupported");
        assert_eq!(replay["isActive"], false);
    }
    #[test]
    fn stable_session_survives_timer_jitter_but_accepts_final_result_once() {
        let mut tracker = SessionTracker::default();
        let mut raw = payload();
        let (first, changed) =
            tracker.observe(session_from_payload(&raw, at("2026-01-01T12:00:00Z")).unwrap());
        assert!(changed);
        raw["displayTime"] = json!(101);
        let (next, changed) =
            tracker.observe(session_from_payload(&raw, at("2026-01-01T12:00:02Z")).unwrap());
        assert!(!changed);
        assert_eq!(first["id"], next["id"]);
        raw["players"][0]["result"] = json!("Victory");
        assert!(
            tracker
                .observe(session_from_payload(&raw, at("2026-01-01T12:00:02Z")).unwrap())
                .1
        );
        assert!(
            !tracker
                .observe(session_from_payload(&raw, at("2026-01-01T12:00:03Z")).unwrap())
                .1
        );
        raw["players"][0]["result"] = json!("Undecided");
        assert!(
            !tracker
                .observe(session_from_payload(&raw, at("2026-01-01T12:00:03Z")).unwrap())
                .1
        );
    }
    #[test]
    fn malformed_payload_does_not_become_an_active_match() {
        assert!(session_from_payload(&Value::Null, Utc::now()).is_err());
        assert_eq!(
            session_from_payload(&json!({}), Utc::now()).unwrap()["isActive"],
            false
        );
    }

    #[test]
    fn profile_links_match_incumbent_substring_and_case_normalization() {
        let mut raw = payload();
        raw["players"][1]["profile"] = json!("Player BATTLEnet:://starcraft/profile/2/12345 (EU)");
        raw["players"][1]["ladder"] = json!({"currentRankedMMR":"4567"});
        raw["players"][1].as_object_mut().unwrap().remove("MMR");
        let session = session_from_payload(&raw, Utc::now()).unwrap();
        assert_eq!(
            session["players"][1]["profileLink"],
            "battlenet:://starcraft/profile/2/12345"
        );
        assert_eq!(session["players"][1]["mmr"], 4567);
    }

    fn isolated_runtime() -> (tempfile::TempDir, Runtime) {
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(directory.path().to_path_buf()).unwrap());
        let runtime = Runtime::new(
            store,
            ReplayRunner::new(
                PathBuf::from("missing-node"),
                PathBuf::from("missing-worker"),
            ),
            Arc::new(|_, _| {}),
        )
        .unwrap();
        (directory, runtime)
    }

    fn changed_snapshot() -> Value {
        json!({"result":{"changed":true},"records":{"opponents":[{"id":"opponent","nickname":"from-worker"}],"matches":[],"candidates":[]}})
    }

    #[test]
    fn background_ambiguity_and_sync_cannot_replace_manual_postmatch_selection() {
        let (_directory, runtime) = isolated_runtime();
        *runtime.inner.last_live_replay.lock().unwrap() = Some(LiveReplayContext {
            names: vec![],
            seconds: 300.0,
            menu_samples: 2,
            ended_at: Some(std::time::Instant::now()),
            candidates: [
                PathBuf::from("one.SC2Replay"),
                PathBuf::from("two.SC2Replay"),
            ]
            .into_iter()
            .collect(),
        });
        for status in ["processing", "ready", "error"] {
            let manual = json!({"status":status,"automatic":false,"matchId":null,"id":"manual","startedAt":123});
            *runtime.inner.postmatch.lock().unwrap() = manual.clone();
            runtime.reconcile_postmatch_candidates().unwrap();
            assert_eq!(*runtime.inner.postmatch.lock().unwrap(), manual);
            assert!(
                runtime
                    .prepare_postmatch_source(
                        Some("automatic-match"),
                        PathBuf::from("never-read.SC2Replay"),
                        true
                    )
                    .unwrap_err()
                    .contains("active selection")
            );
            assert_eq!(*runtime.inner.postmatch.lock().unwrap(), manual);
        }
        *runtime.inner.postmatch.lock().unwrap() = json!({"status":"ready","automatic":true});
        runtime.reconcile_postmatch_candidates().unwrap();
        assert_eq!(runtime.postmatch_status(true)["status"], "empty");
    }

    #[test]
    fn public_postmatch_failures_are_distinct_safe_and_cannot_override_a_new_generation() {
        let (_directory, runtime) = isolated_runtime();
        let mut codes = HashSet::new();
        for error in [
            "decode: Replay analysis timed out after 45 seconds.",
            "decode: Post-match widgets require a supported modern scaled Faster game clock",
            "projection: Invalid post-match numeric fact C:/private/source.SC2Replay",
            "storage: disk error C:/private/profile.sqlite",
        ] {
            runtime.publish_postmatch_failure(None, 0, false, error);
            let status = runtime.postmatch_status(true);
            assert_eq!(status["status"], "error");
            assert!(codes.insert(status["errorCode"].as_str().unwrap().to_string()));
            assert!(!status.to_string().contains("private"));
            assert!(!status.to_string().contains("SC2Replay"));
        }
        *runtime.inner.postmatch_generation.lock().unwrap() = 1;
        let ready = json!({"status":"ready","id":"new","automatic":false});
        *runtime.inner.postmatch.lock().unwrap() = ready.clone();
        runtime.publish_postmatch_failure(Some("old"), 0, true, "decode: timed out");
        assert_eq!(*runtime.inner.postmatch.lock().unwrap(), ready);
    }

    #[test]
    fn same_live_session_keeps_a_watcher_candidate_until_two_menu_observations() {
        let (_directory, runtime) = isolated_runtime();
        let mut appearance = crate::smart_overlay::Appearance {
            enabled: true,
            ..Default::default()
        };
        appearance
            .menu_layout
            .widgets
            .get_mut("fountain")
            .unwrap()
            .enabled = true;
        runtime
            .store
            .save_settings(json!({"obsOverlay":{"smartApplied":appearance}}))
            .unwrap();
        *runtime.inner.monitoring.lock().unwrap() = json!({"running":true,"lastSavedMatchId":"m1"});
        let mut game = payload();
        game["displayTime"] = json!(300);
        runtime
            .publish_smart_sample(0, Some((game.clone(), json!({"activeScreens":[]}))))
            .unwrap();
        runtime
            .inner
            .last_live_replay
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .candidates
            .insert(PathBuf::from("D:/synthetic/candidate.SC2Replay"));
        game["displayTime"] = json!(301);
        runtime
            .publish_smart_sample(0, Some((game.clone(), json!({"activeScreens":[]}))))
            .unwrap();
        for _ in 0..2 {
            runtime
                .publish_smart_sample(
                    0,
                    Some((game.clone(), json!({"activeScreens":["ScreenMultiplayer"]}))),
                )
                .unwrap();
        }
        assert!(runtime.auto_postmatch_eligible("m1"));
        game["displayTime"] = json!(1);
        runtime
            .publish_smart_sample(0, Some((game, json!({"activeScreens":[]}))))
            .unwrap();
        assert!(
            runtime
                .inner
                .last_live_replay
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .candidates
                .is_empty()
        );
    }

    #[tokio::test]
    async fn selected_replay_uses_owned_cache_without_inventing_an_opponent_or_match() {
        let (directory, runtime) = isolated_runtime();
        let path = directory.path().join("team-game.SC2Replay");
        let original = b"synthetic source fixture; never a user replay";
        std::fs::write(&path, original).unwrap();
        let id = crate::postmatch::fingerprint(&path).unwrap();
        let fixture = serde_json::from_str::<Value>(include_str!(
            "../../tests/fixtures/postmatch-review.json"
        ))
        .unwrap()["payload"]
            .clone();
        let facts = crate::postmatch::sanitize(&fixture, &id).unwrap();
        runtime
            .store
            .save_postmatch(
                &id,
                &facts,
                &json!({"id":id,"matchId":null,"startedAt":1000}),
            )
            .unwrap();
        let before = runtime.postmatch_status(true);
        assert!(runtime.prepare_selected_postmatch(None).unwrap().is_null());
        assert_eq!(runtime.postmatch_status(true), before);
        let processing = runtime.prepare_selected_postmatch(Some(&path)).unwrap();
        assert_eq!(processing["status"], "processing");
        assert!(processing["matchId"].is_null());
        let task = runtime.inner.postmatch_task.lock().unwrap().take().unwrap();
        task.await.unwrap();
        assert_eq!(runtime.postmatch_status(true)["status"], "ready");
        assert_eq!(runtime.postmatch_status(true)["id"], id);
        assert!(runtime.store.records("matches").unwrap().is_empty());
        assert!(runtime.store.records("opponents").unwrap().is_empty());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert!(
            !runtime
                .postmatch_status(true)
                .to_string()
                .contains("SC2Replay")
        );
        let reopened = Runtime::new(
            runtime.store.clone(),
            ReplayRunner::new(PathBuf::from("missing"), PathBuf::from("missing")),
            Arc::new(|_, _| {}),
        )
        .unwrap();
        assert_eq!(reopened.postmatch_status(true)["id"], id);
        assert!(reopened.postmatch_status(true)["matchId"].is_null());
    }

    #[test]
    fn selected_replay_rejects_paths_outside_review_boundary_before_touching_analysis() {
        let (directory, runtime) = isolated_runtime();
        std::fs::create_dir_all(directory.path().join("fixtures/replays")).unwrap();
        let runtime = runtime.for_visual_review().unwrap();
        let outside = directory.path().join("outside.SC2Replay");
        std::fs::write(&outside, b"synthetic unchanged").unwrap();
        assert!(
            runtime
                .prepare_selected_postmatch(Some(&outside))
                .unwrap_err()
                .contains("only its own")
        );
        assert!(
            runtime
                .prepare_selected_postmatch(Some(Path::new("relative.SC2Replay")))
                .is_err()
        );
        assert_eq!(runtime.postmatch_status(true)["status"], "empty");
        assert_eq!(std::fs::read(outside).unwrap(), b"synthetic unchanged");
    }

    #[tokio::test]
    async fn clear_stats_cancels_postmatch_and_hides_cached_data_in_preview_and_after_restart() {
        let (directory, runtime) = isolated_runtime();
        let id = "d".repeat(64);
        let fixture = serde_json::from_str::<Value>(include_str!(
            "../../tests/fixtures/postmatch-review.json"
        ))
        .unwrap()["payload"]
            .clone();
        let facts = crate::postmatch::sanitize(&fixture, &id).unwrap();
        runtime
            .store
            .save_postmatch(
                &id,
                &facts,
                &json!({"id":id,"matchId":"m1","startedAt":1000}),
            )
            .unwrap();
        *runtime.inner.postmatch.lock().unwrap() =
            json!({"status":"ready","id":id,"matchId":"m1","startedAt":1000});
        assert!(runtime.postmatch_data(true).unwrap().is_some());
        runtime
            .dispatch("clearStats", Value::Null)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(runtime.postmatch_status(true)["status"], "empty");
        assert!(runtime.postmatch_data(true).unwrap().is_none());
        assert!(runtime.store.postmatch_facts(&id).unwrap().is_none());
        let reopened = Runtime::new(
            Arc::new(Store::open(directory.path().to_path_buf()).unwrap()),
            ReplayRunner::new(PathBuf::from("missing"), PathBuf::from("missing")),
            Arc::new(|_, _| {}),
        )
        .unwrap();
        assert_eq!(reopened.postmatch_status(true)["status"], "empty");
    }

    #[test]
    fn isolated_runtime_cannot_enable_external_worker_sources_through_settings() {
        let (_directory, runtime) = isolated_runtime();
        runtime.store.save_settings(json!({"externalSourcesEnabled":true,"externalSources":{"sc2Pulse":true,"localFixture":true}})).unwrap();
        let runtime = runtime.without_network();
        let settings = runtime.worker_settings().unwrap();
        assert_eq!(settings["externalSourcesEnabled"], false);
        assert_eq!(settings["externalSources"]["sc2Pulse"], false);
        assert_eq!(settings["externalSources"]["localFixture"], false);
        assert_eq!(
            runtime.store.settings().unwrap()["externalSourcesEnabled"],
            true
        );
    }

    #[test]
    fn visual_review_never_uses_personal_replay_fallback_or_edited_settings() {
        let (_directory, runtime) = isolated_runtime();
        let owned = runtime.store.root().join("fixtures/replays");
        std::fs::create_dir_all(&owned).unwrap();
        let runtime = runtime.for_visual_review().unwrap();
        assert_eq!(
            runtime.configured_replay_directory(&json!({"replayDirectory":"C:/personal/replays"})),
            Some(owned.clone())
        );
        assert!(
            runtime
                .validate_review_settings(&json!({"replayDirectory":"C:/personal/replays"}))
                .is_err()
        );
        assert!(
            runtime
                .validate_review_settings(&json!({"replayDirectory":owned}))
                .is_ok()
        );
        let outside = runtime.store.root().join("outside.SC2Replay");
        std::fs::write(&outside, b"read-only fixture").unwrap();
        assert!(runtime.validate_review_replay(&outside).is_err());
        let inside = owned.join("inside.SC2Replay");
        std::fs::write(&inside, b"read-only fixture").unwrap();
        assert!(runtime.validate_review_replay(&inside).is_ok());
        assert_eq!(std::fs::read(&outside).unwrap(), b"read-only fixture");
    }

    #[tokio::test]
    async fn artwork_samples_do_not_wait_for_enrichment_gate_and_cancel_on_stop() {
        let (_directory, runtime) = isolated_runtime();
        runtime.inner.monitoring.lock().unwrap()["running"] = json!(true);
        // Simulate an enrichment transaction waiting on its independent operation gate.
        let _slow_enrichment = runtime.operation_gate.lock().await;
        for phase in ["ScreenLoading", "ScreenMultiplayer"] {
            let sample = (payload(), json!({"activeScreens":[phase]}));
            let result = runtime.publish_smart_sample(0, Some(sample)).unwrap();
            assert_eq!(
                result,
                if phase == "ScreenLoading" {
                    "loading"
                } else {
                    "menu"
                }
            );
        }
        assert_eq!(runtime.monitoring_status()["smartPhase"], "menu");
        runtime.stop_monitoring();
        assert!(
            runtime
                .publish_smart_sample(0, Some((payload(), json!({"activeScreens":[]}))))
                .is_err()
        );
    }

    #[tokio::test]
    async fn monitor_restart_does_not_reuse_previous_artwork_sample() {
        let (_directory, runtime) = isolated_runtime();
        let runtime = runtime.without_network();
        runtime
            .publish_smart_sample(
                0,
                Some((payload(), json!({"activeScreens":["ScreenLoading"]}))),
            )
            .unwrap();
        runtime.start_monitoring().unwrap();
        let status = runtime.monitoring_status();
        assert_eq!(status["smartPhase"], "unknown");
        assert!(status.get("smartSampleAt").is_none());
        runtime.stop_monitoring();
    }

    #[tokio::test]
    async fn stopped_monitor_cannot_commit_inflight_worker_result_or_change_status() {
        let (_directory, runtime) = isolated_runtime();
        runtime.inner.monitoring.lock().unwrap()["running"] = json!(true);
        runtime.stop_monitoring();
        assert!(
            runtime
                .commit_domain_response(&changed_snapshot(), Some(Operation::Monitor(0)), 0)
                .is_err()
        );
        runtime.monitor_error(0, "stale error");
        assert_eq!(
            runtime.store.records("opponents").unwrap(),
            Vec::<Value>::new()
        );
        assert_eq!(runtime.monitoring_status(), json!({"running":false}));
    }

    #[tokio::test]
    async fn stopped_watcher_and_shutdown_invalidate_old_snapshots() {
        let (_directory, runtime) = isolated_runtime();
        runtime.stop_watcher();
        assert!(
            runtime
                .commit_domain_response(&changed_snapshot(), Some(Operation::Watcher(0)), 0)
                .is_err()
        );
        runtime.shutdown();
        assert!(
            runtime
                .commit_domain_response(&changed_snapshot(), None, 0)
                .is_err()
        );
        assert!(runtime.start_monitoring().is_err());
        assert!(runtime.start_watcher().is_err());
        assert!(runtime.store.records("opponents").unwrap().is_empty());
    }

    #[tokio::test]
    async fn malformed_worker_snapshot_rolls_back_all_collections() {
        let (_directory, runtime) = isolated_runtime();
        runtime
            .store
            .save_record("opponents", json!({"id":"kept","nickname":"preserved"}))
            .unwrap();
        let mut response = changed_snapshot();
        response["records"]["matches"] = json!([{"playedAt":"missing-id"}]);
        assert!(runtime.commit_domain_response(&response, None, 0).is_err());
        assert_eq!(runtime.store.records("opponents").unwrap()[0]["id"], "kept");
    }

    #[tokio::test]
    async fn reload_invalidates_both_live_generations_and_resets_identity_tracker() {
        let (_directory, runtime) = isolated_runtime();
        runtime.start_monitoring().unwrap();
        runtime.start_watcher().unwrap();
        let old_monitor = *runtime.inner.monitor_generation.lock().unwrap();
        let old_watcher = *runtime.inner.watcher_generation.lock().unwrap();
        runtime.reload_settings().unwrap();
        assert_ne!(
            *runtime.inner.monitor_generation.lock().unwrap(),
            old_monitor
        );
        assert_ne!(
            *runtime.inner.watcher_generation.lock().unwrap(),
            old_watcher
        );
        assert!(
            runtime
                .commit_domain_response(
                    &changed_snapshot(),
                    Some(Operation::Monitor(old_monitor)),
                    0
                )
                .is_err()
        );
        assert!(
            runtime
                .commit_domain_response(
                    &changed_snapshot(),
                    Some(Operation::Watcher(old_watcher)),
                    0
                )
                .is_err()
        );
        runtime.shutdown();
    }

    #[tokio::test]
    async fn unsupported_replay_does_not_starve_later_files() {
        let (directory, mut runtime) = isolated_runtime();
        let helper = directory.path().join("worker.cjs");
        let node_name = if cfg!(windows) { "node.exe" } else { "node" };
        let node = std::env::var_os("PATH")
            .and_then(|paths| {
                std::env::split_paths(&paths)
                    .map(|path| path.join(node_name))
                    .find(|path| path.is_file())
            })
            .expect("Node development dependency is required");
        std::fs::write(&helper,r#"let input=''; process.stdin.on('data',b=>input+=b); process.stdin.on('end',()=>{ const r=JSON.parse(input); if(r.command==='metadata'&&r.payload.file.path.includes('bad.SC2Replay')) { process.stdout.write(JSON.stringify({ok:false,error:'Unsupported build'})); } else if(r.command==='metadata') { process.stdout.write(JSON.stringify({ok:true,result:{replayPath:r.payload.file.path}})); } else { process.stdout.write(JSON.stringify({ok:true,result:{result:{match:{id:'linked'}},records:r.payload.records}})); } });"#).unwrap();
        runtime.replay = ReplayRunner::new(node, helper);
        let replays = directory.path().join("replays");
        std::fs::create_dir(&replays).unwrap();
        for name in ["bad.SC2Replay", "good.SC2Replay"] {
            let path = replays.join(name);
            std::fs::write(&path, b"read-only-source").unwrap();
            let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
            file.set_times(
                std::fs::FileTimes::new()
                    .set_modified(std::time::SystemTime::now() - Duration::from_secs(30)),
            )
            .unwrap();
        }
        let mut seen = HashSet::new();
        let error = runtime
            .watch_once(Some(replays.clone()), &mut seen, false, 0)
            .await
            .unwrap_err();
        assert_eq!(error, "Unsupported build");
        assert!(!seen.contains(&replays.join("bad.SC2Replay").canonicalize().unwrap()));
        assert!(seen.contains(&replays.join("good.SC2Replay").canonicalize().unwrap()));
        assert_eq!(runtime.watcher_status()["lastLinkedMatchId"], "linked");
        assert_eq!(
            std::fs::read(replays.join("good.SC2Replay")).unwrap(),
            b"read-only-source"
        );
    }
}
