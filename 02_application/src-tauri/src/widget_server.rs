//! Read-only OBS display boundary. Never expose desktop commands or profile records over HTTP.
use crate::{domain, obs_config::ObsConfig, runtime::Runtime, smart_overlay, storage::Store};
use axum::{
    Router,
    body::Body,
    extract::{Path as RoutePath, Query, Request, State},
    http::{HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};
use std::{
    net::Ipv4Addr,
    path::{Component, Path, PathBuf},
    sync::Arc,
};
use tokio::{net::TcpListener, sync::watch, task::JoinHandle};

pub const DEFAULT_OBS_PORT: u16 = 8766;
const MAX_ASSET_BYTES: u64 = 32 * 1024 * 1024;
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-src 'self'; frame-ancestors 'self' tauri://localhost http://tauri.localhost http://127.0.0.1:5173; base-uri 'none'; form-action 'none'";

#[derive(Clone)]
struct DisplayState {
    store: Arc<Store>,
    runtime: Runtime,
    assets: PathBuf,
    port: u16,
}

pub struct ObsServer {
    store: Arc<Store>,
    port: u16,
    shutdown: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl ObsServer {
    /// Await binding before returning: an occupied port is an error, never a foreign server to reuse.
    pub async fn start(
        store: Arc<Store>,
        runtime: Runtime,
        assets_root: PathBuf,
        port: u16,
    ) -> Result<Self, String> {
        if port != 0 && port < 1024 {
            return Err("The OBS port must be between 1024 and 65535.".into());
        }
        let assets = assets_root
            .canonicalize()
            .map_err(|_| "Build the OBS page before starting its local source.".to_string())?;
        contained_asset(&assets, "obs.html")
            .map_err(|_| "The built OBS page is unavailable; rebuild the frontend.".to_string())?;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))
            .await
            .map_err(|_| format!("The local OBS port {port} is unavailable. Choose another port; no other service was stopped."))?;
        let actual_port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let state = DisplayState {
            store: store.clone(),
            runtime,
            assets,
            port: actual_port,
        };
        let router = Router::new()
            .route("/widgets/", get(page))
            .route("/widgets/postmatch.html", get(postmatch_page))
            .route("/api/overlay/postmatch/status", get(postmatch_status))
            .route("/api/overlay/postmatch/data", get(postmatch_data))
            .route("/api/battle/icons/{key}", get(battle_icon))
            .route("/api/overlay/maps/{key}/image", get(map_image))
            .route("/widgets/assets/{*path}", get(asset))
            .route("/widgets/media/{id}", get(media))
            .route("/widgets/media/{id}/poster", get(media_poster))
            .route("/api/overlay/state", get(display_state))
            .route("/api/overlay/health", get(health))
            .layer(middleware::from_fn_with_state(
                state.clone(),
                local_read_only,
            ))
            .with_state(state);
        let (shutdown, mut signal) = watch::channel(false);
        let task = tokio::spawn(async move {
            let stopped = async move {
                if !*signal.borrow() {
                    let _ = signal.changed().await;
                }
            };
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(stopped)
                .await;
        });
        Ok(Self {
            store,
            port: actual_port,
            shutdown,
            task,
        })
    }

    pub fn info(&self) -> Value {
        let config = self
            .store
            .settings()
            .ok()
            .and_then(|s| ObsConfig::from_settings(&s).ok())
            .unwrap_or_default();
        json!({
            "status":if *self.shutdown.borrow() || self.task.is_finished(){"stopped"}else{"running"},
            "url":format!("http://127.0.0.1:{}/widgets/",self.port),
            "port":self.port,"width":config.width,"height":config.height,"schemaVersion":1
        })
    }

    pub fn shutdown(&self) {
        let _ = self.shutdown.send(true);
    }
}

impl Drop for ObsServer {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
        // Stop only this task/listener. Existing services, OBS and SC2 are never touched.
        self.task.abort();
    }
}

async fn local_read_only(
    State(state): State<DisplayState>,
    request: Request,
    next: Next,
) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok());
    let allowed_hosts = [
        format!("127.0.0.1:{}", state.port),
        format!("localhost:{}", state.port),
    ];
    if !host.is_some_and(|host| allowed_hosts.iter().any(|allowed| allowed == host)) {
        return failure(StatusCode::FORBIDDEN);
    }
    if let Some(origin) = request.headers().get(header::ORIGIN) {
        let allowed_origins = [
            format!("http://127.0.0.1:{}", state.port),
            format!("http://localhost:{}", state.port),
        ];
        if !origin
            .to_str()
            .ok()
            .is_some_and(|origin| allowed_origins.iter().any(|allowed| allowed == origin))
        {
            return failure(StatusCode::FORBIDDEN);
        }
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return failure(StatusCode::METHOD_NOT_ALLOWED);
    }
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CSP),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

fn failure(status: StatusCode) -> Response {
    let mut response = (status, "OBS source unavailable").into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn page(State(state): State<DisplayState>) -> Response {
    serve_file(&state.assets, "obs.html", "no-store").await
}
async fn postmatch_page(State(state): State<DisplayState>) -> Response {
    serve_file(&state.assets, "postmatch.html", "no-store").await
}
async fn battle_icon(
    State(state): State<DisplayState>,
    RoutePath(key): RoutePath<String>,
) -> Response {
    if key.is_empty()
        || key.len() > 80
        || !key
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
    {
        return failure(StatusCode::NOT_FOUND);
    }
    serve_file(
        &state.assets,
        &format!("assets/postmatch-icons/{key}.png"),
        "public, max-age=31536000, immutable",
    )
    .await
}

async fn map_image(
    State(state): State<DisplayState>,
    RoutePath(key): RoutePath<String>,
) -> Response {
    let result =
        tokio::task::spawn_blocking(move || crate::map_background::image(state.store.root(), &key))
            .await;
    match result {
        Ok(Ok(bytes)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "image/png")
            .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
            .body(Body::from(bytes))
            .unwrap(),
        _ => failure(StatusCode::NOT_FOUND),
    }
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct PostmatchQuery {
    preview: Option<u8>,
    id: Option<String>,
}
async fn postmatch_status(
    State(state): State<DisplayState>,
    Query(query): Query<PostmatchQuery>,
) -> Response {
    let mut response =
        axum::Json(state.runtime.postmatch_status(query.preview == Some(1))).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
async fn postmatch_data(
    State(state): State<DisplayState>,
    Query(query): Query<PostmatchQuery>,
) -> Response {
    let result =
        tokio::task::spawn_blocking(move || state.runtime.postmatch_data(query.preview == Some(1)))
            .await;
    let mut response = match result {
        Ok(Ok(Some(facts)))
            if query
                .id
                .as_deref()
                .is_none_or(|id| facts["id"].as_str() == Some(id)) =>
        {
            axum::Json(facts).into_response()
        }
        Ok(Ok(_)) => StatusCode::NO_CONTENT.into_response(),
        _ => failure(StatusCode::SERVICE_UNAVAILABLE),
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
async fn media(State(state): State<DisplayState>, RoutePath(id): RoutePath<String>) -> Response {
    serve_media(state, id, false).await
}
async fn media_poster(
    State(state): State<DisplayState>,
    RoutePath(id): RoutePath<String>,
) -> Response {
    serve_media(state, id, true).await
}
async fn serve_media(state: DisplayState, id: String, poster: bool) -> Response {
    let file =
        tokio::task::spawn_blocking(move || smart_overlay::media_file(&state.store, &id, poster))
            .await;
    let Ok(Ok((path, mime))) = file else {
        return failure(StatusCode::NOT_FOUND);
    };
    let Ok(metadata) = tokio::fs::metadata(&path).await else {
        return failure(StatusCode::NOT_FOUND);
    };
    if metadata.len() > smart_overlay::MAX_GIF as u64 {
        return failure(StatusCode::NOT_FOUND);
    }
    let Ok(bytes) = tokio::fs::read(path).await else {
        return failure(StatusCode::NOT_FOUND);
    };
    if bytes.len() > smart_overlay::MAX_GIF {
        return failure(StatusCode::NOT_FOUND);
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .body(Body::from(bytes))
        .unwrap()
}

async fn asset(State(state): State<DisplayState>, RoutePath(path): RoutePath<String>) -> Response {
    let extension = Path::new(&path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if ![
        "js", "mjs", "css", "png", "jpg", "jpeg", "gif", "svg", "webp", "woff", "woff2",
    ]
    .contains(&extension.as_str())
    {
        return failure(StatusCode::NOT_FOUND);
    }
    serve_file(
        &state.assets,
        &format!("assets/{path}"),
        "public, max-age=3600",
    )
    .await
}

fn contained_asset(root: &Path, relative: &str) -> Result<PathBuf, ()> {
    let relative = Path::new(relative);
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(());
    }
    let resolved = root.join(relative).canonicalize().map_err(|_| ())?;
    if !resolved.starts_with(root) || !resolved.is_file() {
        return Err(());
    }
    Ok(resolved)
}

async fn serve_file(root: &Path, relative: &str, cache: &'static str) -> Response {
    let Ok(file) = contained_asset(root, relative) else {
        return failure(StatusCode::NOT_FOUND);
    };
    let Ok(metadata) = tokio::fs::metadata(&file).await else {
        return failure(StatusCode::NOT_FOUND);
    };
    let limit = if file.extension().is_some_and(|s| s == "gif") {
        smart_overlay::MAX_GIF as u64
    } else {
        MAX_ASSET_BYTES
    };
    if metadata.len() > limit {
        return failure(StatusCode::NOT_FOUND);
    }
    let Ok(bytes) = tokio::fs::read(&file).await else {
        return failure(StatusCode::NOT_FOUND);
    };
    if bytes.len() as u64 > limit {
        return failure(StatusCode::NOT_FOUND);
    }
    let mime = if file.extension().is_some_and(|s| s == "mjs") {
        "text/javascript".to_string()
    } else {
        mime_guess::from_path(&file)
            .first_or_octet_stream()
            .to_string()
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, cache)
        .body(Body::from(bytes))
        .unwrap()
}

async fn health() -> Response {
    let mut response =
        axum::Json(json!({"application":"sc2-adjutant-compose-obs","schemaVersion":1}))
            .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn display_state(State(state): State<DisplayState>) -> Response {
    let snapshot = state.runtime.monitoring_status();
    let result = tokio::task::spawn_blocking(move || {
        let settings = state.store.settings()?;
        let opponents = state.store.records("opponents")?;
        let matches = state.store.records("matches")?;
        Ok::<_, String>(public_snapshot(&settings, &snapshot, &opponents, &matches))
    })
    .await;
    match result {
        Ok(Ok(payload)) => {
            let mut response = axum::Json(payload).into_response();
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        _ => failure(StatusCode::SERVICE_UNAVAILABLE),
    }
}

/// Public display schema is intentionally assembled field by field. Private profile data stays local.
pub fn public_snapshot(
    settings: &Value,
    monitoring: &Value,
    opponents: &[Value],
    matches: &[Value],
) -> Value {
    let config = ObsConfig::from_settings(settings).unwrap_or_default();
    let enabled = config.enabled;
    let width = config.width;
    let height = config.height;
    let position = config.position;
    let mut payload = json!({"schemaVersion":1,"generatedAt":domain::now(),"enabled":enabled,"active":false,
        "width":width,"height":height,"position":position,"language":if settings["language"]=="ru"{"ru"}else{"en"},
        "smart":smart_overlay::public_state(settings,monitoring)});
    let session = &monitoring["currentSession"];
    let freshness_ms = settings["pollingIntervalMs"]
        .as_i64()
        .unwrap_or(1000)
        .clamp(500, 10000)
        .saturating_mul(3)
        .saturating_add(2000)
        .clamp(5000, 35000);
    let fresh = monitoring["lastSampleAt"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .is_some_and(|sample| {
            let age = chrono::Utc::now()
                .signed_duration_since(sample)
                .num_milliseconds();
            (-1000..=freshness_ms).contains(&age)
        });
    if !enabled
        || matches!(monitoring["smartPhase"].as_str(), Some("menu" | "loading"))
        || !fresh
        || monitoring["running"] != true
        || monitoring["lastError"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
        || session["active"] != true
        || session["mode"] != "ranked-1v1"
    {
        return payload;
    }
    let Some(players) = session["players"].as_array().filter(|p| p.len() == 2) else {
        return payload;
    };
    if players
        .iter()
        .any(|p| p["result"] == "Victory" || p["result"] == "Defeat")
    {
        return payload;
    }
    let configured_name = identity(settings["playerName"].as_str().unwrap_or_default());
    let users: Vec<usize> = players
        .iter()
        .enumerate()
        .filter_map(|(i, p)| {
            let name = identity(p["name"].as_str().unwrap_or_default());
            ((!configured_name.is_empty() && name == configured_name) || p["isUser"] == true)
                .then_some(i)
        })
        .collect();
    if users.len() != 1 {
        return payload;
    }
    let live = &players[1 - users[0]];
    let live_name = identity(live["name"].as_str().unwrap_or_default());
    if live_name.is_empty() {
        return payload;
    }
    let Some(match_id) = monitoring["lastSavedMatchId"].as_str() else {
        return payload;
    };
    let linked: Vec<&Value> = matches.iter().filter(|m| m["id"] == match_id).collect();
    if linked.len() != 1 {
        return payload;
    }
    let Some(opponent_id) = linked[0]["opponentId"].as_str() else {
        return payload;
    };
    let candidates: Vec<&Value> = opponents
        .iter()
        .filter(|o| o["id"] == opponent_id)
        .collect();
    if candidates.len() != 1 {
        return payload;
    }
    let opponent = candidates[0];
    let known_names = [
        opponent["nickname"].as_str(),
        opponent["revealedNickname"].as_str(),
    ];
    let matches_name = known_names
        .into_iter()
        .flatten()
        .any(|name| identity(name) == live_name)
        || opponent["aliases"].as_array().is_some_and(|aliases| {
            aliases
                .iter()
                .filter_map(Value::as_str)
                .any(|name| identity(name) == live_name)
        });
    if !matches_name {
        return payload;
    }
    let race = domain::race(&live["race"]);
    let race = if race == "Unknown" {
        domain::race(&linked[0]["opponentRace"])
    } else {
        race
    };
    let nickname = opponent["revealedNickname"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| opponent["nickname"].as_str())
        .unwrap_or_default();
    let profile = &opponent["raceProfiles"][race];
    let race_matches: Vec<&Value> = matches
        .iter()
        .filter(|m| {
            m["opponentId"] == opponent_id
                && (race == "Unknown" || domain::race(&m["opponentRace"]) == race)
        })
        .collect();
    let wins = race_matches.iter().filter(|m| m["result"] == "win").count();
    let losses = race_matches
        .iter()
        .filter(|m| m["result"] == "loss")
        .count();
    let mut display = json!({"nickname":nickname.chars().take(120).collect::<String>(),"race":race,
        "encounters":race_matches.len(),"wins":wins,"losses":losses});
    let same_record_race = race != "Unknown" && domain::race(&opponent["race"]) == race;
    if let Some(mmr) = positive_number(&live["mmr"])
        .or_else(|| positive_number(&profile["mmrAtLastMatch"]))
        .or_else(|| {
            same_record_race
                .then(|| positive_number(&opponent["mmrAtLastMatch"]))
                .flatten()
        })
    {
        display["mmr"] = json!(mmr.round());
    }
    if let Some(league) = profile["league"]
        .as_str()
        .or_else(|| {
            same_record_race
                .then(|| opponent["league"].as_str())
                .flatten()
        })
        .filter(|s| !s.trim().is_empty())
    {
        display["league"] = json!(league.chars().take(64).collect::<String>());
    }
    if let Some(total) = positive_number(&profile["totalGamesAtLastMatch"]) {
        display["totalGames"] = json!(total);
    }
    if wins + losses > 0 {
        display["winRate"] = json!(wins as f64 * 100. / (wins + losses) as f64);
    }
    payload["active"] = json!(true);
    payload["opponent"] = display;
    payload
}

fn positive_number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite() && *n > 0.)
}

fn identity(name: &str) -> String {
    let mut name = name.trim();
    while let Some(rest) = name.strip_prefix('<') {
        let Some((_, remaining)) = rest.split_once('>') else {
            break;
        };
        name = remaining.trim();
    }
    let name = name.split_once('#').map(|(base, _)| base).unwrap_or(name);
    name.trim().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::replay::ReplayRunner;
    use std::fs;

    fn fixtures() -> (Value, Value, Vec<Value>, Vec<Value>) {
        (
            json!({"playerName":"Local","language":"ru","obsOverlay":{"enabled":true,"position":"top-right","width":1920,"height":1080}}),
            json!({"running":true,"lastSampleAt":domain::now(),"lastSavedMatchId":"m1","currentSession":{"active":true,"mode":"ranked-1v1","players":[{"name":"Local","race":"Terran","isUser":true},{"name":"Opponent","race":"Zerg"}]}}),
            vec![
                json!({"id":"o1","nickname":"Opponent","race":"Zerg","aliases":["secret-alias"],"notes":["private note"],"battleTag":"Private#123","raceProfiles":{"Zerg":{"mmrAtLastMatch":5000,"league":"Master","notes":["secret"]}}}),
            ],
            vec![
                json!({"id":"m1","opponentId":"o1","opponentRace":"Zerg","result":"unknown","replayPath":"C:/private/replay.SC2Replay"}),
            ],
        )
    }

    #[test]
    fn snapshot_exposes_display_fields_only_and_hides_unconfirmed_cards() {
        let (settings, mut status, opponents, matches) = fixtures();
        let visible = public_snapshot(&settings, &status, &opponents, &matches);
        assert_eq!(visible["active"], true);
        assert_eq!(visible["opponent"]["mmr"], 5000.);
        assert!(visible["opponent"].get("winRate").is_none());
        let text = visible.to_string();
        for secret in [
            "private note",
            "secret-alias",
            "Private#123",
            "C:/private",
            "battleTag",
            "notes",
            "aliases",
        ] {
            assert!(!text.contains(secret));
        }
        status["lastError"] = json!("SC2 unavailable");
        assert_eq!(
            public_snapshot(&settings, &status, &opponents, &matches)["active"],
            false
        );
        status.as_object_mut().unwrap().remove("lastError");
        status["currentSession"]["players"][1]["name"] = json!("Different opponent");
        assert_eq!(
            public_snapshot(&settings, &status, &opponents, &matches)["active"],
            false
        );
    }

    #[test]
    fn disabled_finished_ambiguous_and_unknown_data_never_become_guessed_public_stats() {
        let (mut settings, mut status, mut opponents, matches) = fixtures();
        settings["obsOverlay"]["enabled"] = json!(false);
        assert_eq!(
            public_snapshot(&settings, &status, &opponents, &matches)["active"],
            false
        );
        settings["obsOverlay"]["enabled"] = json!(true);
        status["currentSession"]["players"][0]["result"] = json!("Victory");
        assert_eq!(
            public_snapshot(&settings, &status, &opponents, &matches)["active"],
            false
        );
        status["currentSession"]["players"][0]
            .as_object_mut()
            .unwrap()
            .remove("result");
        status["currentSession"]["players"][1]["isUser"] = json!(true);
        assert_eq!(
            public_snapshot(&settings, &status, &opponents, &matches)["active"],
            false
        );
        status["currentSession"]["players"][1]
            .as_object_mut()
            .unwrap()
            .remove("isUser");
        opponents[0].as_object_mut().unwrap().remove("raceProfiles");
        opponents[0]["race"] = json!("Terran");
        opponents[0]["mmrAtLastMatch"] = json!(6000);
        opponents[0]["league"] = json!("Grandmaster");
        let value = public_snapshot(&settings, &status, &opponents, &matches);
        assert!(value["opponent"].get("mmr").is_none());
        assert!(value["opponent"].get("league").is_none());
    }

    #[test]
    fn stale_missing_invalid_and_future_sc2_samples_hide_the_card() {
        let (settings, mut status, opponents, matches) = fixtures();
        for stamp in [
            Value::Null,
            json!("invalid"),
            json!("2000-01-01T00:00:00Z"),
            json!("2099-01-01T00:00:00Z"),
        ] {
            status["lastSampleAt"] = stamp;
            let snapshot = public_snapshot(&settings, &status, &opponents, &matches);
            assert_eq!(snapshot["active"], false);
            assert!(snapshot.get("opponent").is_none());
        }
        status["lastSampleAt"] = json!(domain::now());
        assert_eq!(
            public_snapshot(&settings, &status, &opponents, &matches)["active"],
            true
        );
    }

    fn setup() -> (tempfile::TempDir, Arc<Store>, Runtime, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(temp.path().join("profile")).unwrap());
        let runtime = Runtime::new(
            store.clone(),
            ReplayRunner::new(PathBuf::new(), PathBuf::new()),
            Arc::new(|_, _| {}),
        )
        .unwrap()
        .without_network();
        let assets = temp.path().join("dist");
        fs::create_dir_all(assets.join("assets")).unwrap();
        fs::write(assets.join("obs.html"), "<!doctype html><h1>fixture</h1>").unwrap();
        fs::write(
            assets.join("assets/fixture.js"),
            "export const fixture = true;",
        )
        .unwrap();
        fs::write(temp.path().join("private.js"), "private fixture").unwrap();
        (temp, store, runtime, assets)
    }

    #[tokio::test]
    async fn map_images_are_checksum_bound_pngs_and_read_only() {
        use sha2::Digest;
        let (_temp, store, runtime, assets) = setup();
        let mut png = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_pixel(2, 2, image::Rgb([1, 2, 3]))
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let png = png.into_inner();
        let key = format!("{:x}", sha2::Sha256::digest(&png));
        let directory = store.root().join("map-backgrounds");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(format!("{key}.png")), &png).unwrap();
        let server = ObsServer::start(store, runtime, assets, 0).await.unwrap();
        let url = format!(
            "http://127.0.0.1:{}/api/overlay/maps/{key}/image",
            server.port
        );
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let response = client.get(&url).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(response.bytes().await.unwrap().as_ref(), png);
        assert_eq!(
            client.post(&url).send().await.unwrap().status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        fs::write(directory.join(format!("{key}.png")), b"tampered").unwrap();
        assert_eq!(
            client.get(&url).send().await.unwrap().status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            client
                .get(url.replace(&key, "not-a-hash"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        server.shutdown();
    }
    #[tokio::test]
    async fn serves_local_html_assets_and_state_with_read_only_security_boundary() {
        let (_temp, store, runtime, assets) = setup();
        let server = ObsServer::start(store, runtime, assets, 0).await.unwrap();
        let base = format!("http://127.0.0.1:{}", server.port);
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let html = client.get(format!("{base}/widgets/")).send().await.unwrap();
        assert_eq!(html.status(), StatusCode::OK);
        assert!(
            html.headers()[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap()
                .contains("script-src 'self'")
        );
        assert_eq!(html.headers()[header::CACHE_CONTROL], "no-store");
        assert!(html.text().await.unwrap().contains("fixture"));
        assert_eq!(
            client
                .get(format!("{base}/widgets/assets/fixture.js"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let snapshot: Value = client
            .get(format!("{base}/api/overlay/state"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(snapshot["enabled"], false);
        assert_eq!(snapshot["active"], false);
        let health: Value = client
            .get(format!("{base}/api/overlay/health"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(health["application"], "sc2-adjutant-compose-obs");
        assert_eq!(
            client
                .get(format!("{base}/api/overlay/state"))
                .header(header::HOST, "attacker.example")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            client
                .get(format!("{base}/api/overlay/state"))
                .header(header::ORIGIN, "https://attacker.example")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            client
                .post(format!("{base}/api/overlay/state"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        assert_eq!(
            client
                .get(format!(
                    "{base}/widgets/assets/%2e%2e%2f%2e%2e%2fprivate.js"
                ))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            client
                .get(format!("{base}/api/projects"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        server.shutdown();
    }

    #[tokio::test]
    async fn registered_media_serves_only_owned_images_with_correct_mime_and_read_only_methods() {
        let (_temp, store, runtime, assets) = setup();
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(2, 2)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let result = smart_overlay::import_bytes(
            &store,
            &smart_overlay::ChooseInput {
                revision: 0,
                mode: "menu".into(),
            },
            png.get_ref(),
            "private-name.png",
        )
        .unwrap();
        let url = result["draft"]["modes"]["menu"]["image"]["url"]
            .as_str()
            .unwrap();
        let server = ObsServer::start(store, runtime, assets, 0).await.unwrap();
        let base = format!("http://127.0.0.1:{}", server.port);
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let response = client.get(format!("{base}{url}")).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(response.bytes().await.unwrap().as_ref(), png.get_ref());
        assert_eq!(
            client
                .head(format!("{base}{url}"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            client
                .get(format!("{base}{url}/poster"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            client
                .get(format!("{base}/widgets/media/%2e%2e%2fcompose.sqlite3"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            client
                .post(format!("{base}{url}"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        assert_eq!(
            client
                .get(format!("{base}{url}"))
                .header(header::ORIGIN, "https://attacker.example")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        server.shutdown();
    }

    #[tokio::test]
    async fn postmatch_is_read_only_and_preview_reads_one_sanitized_cached_match() {
        let (_temp, store, _runtime, assets) = setup();
        fs::write(
            assets.join("postmatch.html"),
            "<!doctype html><h1>postmatch fixture</h1>",
        )
        .unwrap();
        let id = "e".repeat(64);
        let raw: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/postmatch-review.json"))
                .unwrap();
        let facts = crate::postmatch::sanitize(&raw["payload"], &id).unwrap();
        store
            .save_postmatch(
                &id,
                &facts,
                &json!({"id":id,"matchId":"m1","startedAt":1000}),
            )
            .unwrap();
        let runtime = Runtime::new(
            store.clone(),
            crate::replay::ReplayRunner::new(PathBuf::from("missing"), PathBuf::from("missing")),
            Arc::new(|_, _| {}),
        )
        .unwrap()
        .without_network();
        let server = ObsServer::start(store, runtime, assets, 0).await.unwrap();
        let base = format!("http://127.0.0.1:{}", server.port);
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        assert_eq!(
            client
                .get(format!("{base}/api/overlay/postmatch/data"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        let status: Value = client
            .get(format!("{base}/api/overlay/postmatch/status?preview=1"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(status["status"], "ready");
        assert_eq!(status["id"], id);
        assert_eq!(status["visible"], true);
        let result: Value = client
            .get(format!(
                "{base}/api/overlay/postmatch/data?preview=1&id={id}"
            ))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(result["id"], id);
        assert_eq!(result["events"], facts["events"]);
        assert!(result.get("replayPath").is_none());
        assert_eq!(
            client
                .get(format!(
                    "{base}/api/overlay/postmatch/data?preview=1&id=wrong"
                ))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            client
                .post(format!("{base}/api/overlay/postmatch/data?preview=1"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        let page = client
            .get(format!("{base}/widgets/postmatch.html?kind=heroes"))
            .send()
            .await
            .unwrap();
        assert_eq!(page.status(), StatusCode::OK);
        assert!(
            page.headers()[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap()
                .contains("frame-src 'self'")
        );
        server.shutdown();
    }

    #[tokio::test]
    async fn port_conflict_is_reported_without_taking_over_listener() {
        let (_temp, store, runtime, assets) = setup();
        let occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = occupied.local_addr().unwrap().port();
        assert!(
            ObsServer::start(store, runtime, assets, port)
                .await
                .is_err()
        );
        assert_eq!(
            occupied.local_addr().unwrap(),
            std::net::SocketAddr::from((Ipv4Addr::LOCALHOST, port))
        );
    }
}
