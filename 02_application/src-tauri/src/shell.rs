//! Desktop adapter. The core store/runtime do not depend on Tauri.
use crate::{
    obs_config::{self, ObsConfig},
    replay::ReplayRunner,
    runtime::Runtime,
    smart_overlay,
    storage::Store,
    widget_server::ObsServer,
};
use serde_json::{Value, json};
use std::{
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{
    Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

struct Desktop {
    store: Arc<Store>,
    runtime: Runtime,
    resources: PathBuf,
    compact: Mutex<Option<(PhysicalPosition<i32>, PhysicalSize<u32>)>>,
    smoke_report: Option<PathBuf>,
    obs_server: Option<ObsServer>,
    obs_error: Option<String>,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn smoke_postmatch_counts(value: &Value) -> Value {
    json!({"players":value["players"].as_array().map(Vec::len),
        "teams":value["teams"].as_array().map(Vec::len),
        "losses":value["events"].as_array().map(Vec::len),
        "lifecycle":value["story"]["events"].as_array().map(Vec::len),
        "movement":value["story"]["movement"]["samples"].as_array().map(Vec::len)})
}

/// Explicit smoke diagnostics may preserve the cause, but never the selected/resource paths.
fn smoke_replay_error(error: String, replay: &Path, resources: &Path) -> String {
    let mut message = error;
    for original in [replay, resources] {
        for path in [
            original.to_path_buf(),
            crate::replay::node_entrypoint(original),
        ] {
            let value = path.to_string_lossy();
            for spelling in [
                value.to_string(),
                value.replace('\\', "/"),
                value.replace('\\', "\\\\"),
            ] {
                if let Ok(pattern) = regex::RegexBuilder::new(&regex::escape(&spelling))
                    .case_insensitive(true)
                    .build()
                {
                    message = pattern.replace_all(&message, "<local-path>").into_owned();
                }
            }
        }
    }
    message
        .chars()
        .filter(|c| !c.is_control())
        .take(1024)
        .collect()
}

/// Isolated native verification only: the URL is derived from our listener, never renderer input.
async fn smoke_obs_http_check(desktop: &Desktop, window: &WebviewWindow) -> Result<Value, String> {
    if desktop.smoke_report.is_none() {
        return Err("Smoke reporting is disabled".into());
    }
    let info = obs_info(desktop)?;
    if info["running"] != true {
        return Err("The isolated OBS server is not running".into());
    }
    let source =
        url::Url::parse(info["url"].as_str().ok_or("OBS source URL is missing")?).map_err(err)?;
    if source.scheme() != "http" || source.host_str() != Some("127.0.0.1") {
        return Err("Smoke only permits the owned IPv4 loopback source".into());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(err)?;
    let health_url = source.join("/api/overlay/health").map_err(err)?;
    let health: Value =
        serde_json::from_slice(&smoke_get(&client, health_url.as_str(), 65536).await?)
            .map_err(err)?;
    if health["application"] != "sc2-adjutant-compose-obs" || health["schemaVersion"] != 1 {
        return Err("Unexpected OBS health identity".into());
    }
    let state_url = source.join("/api/overlay/state").map_err(err)?;
    let public_state: Value =
        serde_json::from_slice(&smoke_get(&client, state_url.as_str(), 65536).await?)
            .map_err(err)?;
    if public_state["schemaVersion"] != 1
        || public_state["enabled"] != true
        || public_state["active"] != false
        || public_state["width"] != 2560
        || public_state["height"] != 1440
        || public_state["position"] != "bottom-3"
    {
        return Err("OBS public state does not match isolated settings".into());
    }
    let fields = public_state
        .as_object()
        .ok_or("OBS state must be an object")?;
    if fields.keys().any(|key| {
        ![
            "schemaVersion",
            "generatedAt",
            "enabled",
            "active",
            "width",
            "height",
            "position",
            "language",
            "smart",
        ]
        .contains(&key.as_str())
    }) {
        return Err("Inactive OBS state exposed unexpected private fields".into());
    }
    let html = String::from_utf8(smoke_get(&client, source.as_str(), 2 * 1024 * 1024).await?)
        .map_err(err)?;
    if !html.to_lowercase().contains("<!doctype html>") {
        return Err("OBS HTML page was not served".into());
    }
    let pattern = regex::Regex::new(r#"<script[^>]*src="([^"]+)""#).unwrap();
    let module = pattern
        .captures(&html)
        .and_then(|c| c.get(1))
        .ok_or("OBS page has no built script module")?
        .as_str();
    let module_url = source.join(module).map_err(err)?;
    if module_url.origin() != source.origin() || !module_url.path().starts_with("/widgets/assets/")
    {
        return Err("OBS module escaped the owned static asset boundary".into());
    }
    let module_bytes = smoke_get(&client, module_url.as_str(), 2 * 1024 * 1024).await?;
    if module_bytes.is_empty() {
        return Err("OBS script module was empty".into());
    }
    Ok(
        json!({"httpChecked":true,"htmlChecked":true,"assetChecked":true,"privateFieldsExcluded":true,
        "inactiveWithoutSc2":true,"port":source.port(),"mainWindowHidden":!window.is_visible().map_err(err)?}),
    )
}

async fn smoke_get(
    client: &reqwest::Client,
    url: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let mut response = client.get(url).send().await.map_err(err)?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!("Isolated OBS HTTP returned {}", response.status()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(err)? {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err("Isolated OBS response exceeded its limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn obs_info(desktop: &Desktop) -> Result<Value, String> {
    let config = ObsConfig::from_settings(&desktop.store.settings()?)?;
    let mut info = serde_json::to_value(config).map_err(err)?;
    info["running"] = json!(false);
    if let Some(server) = &desktop.obs_server {
        let server_info = server.info();
        if server_info["status"] == "running" {
            info["running"] = json!(true);
            info["url"] = server_info["url"].clone();
        } else {
            info["error"] = json!("Local OBS source has stopped; restart the application");
        }
    }
    if let Some(error) = &desktop.obs_error {
        info["error"] = json!(error);
    }
    Ok(info)
}

fn open_obs_preview(desktop: &Desktop) -> Result<Value, String> {
    let info = obs_info(desktop)?;
    let url =
        url::Url::parse(info["url"].as_str().ok_or("OBS server is unavailable")?).map_err(err)?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.path() != "/widgets/" {
        return Err("Invalid local OBS preview URL".into());
    }
    let mut process = std::process::Command::new("rundll32.exe");
    process.arg("url.dll,FileProtocolHandler").arg(url.as_str());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(0x08000000);
    }
    process.spawn().map_err(err)?;
    Ok(Value::Null)
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };
    let show = MenuItem::with_id(app, "show", "Открыть SC2 Adjutant", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::with_id("compose-main")
        .tooltip("SC2 Adjutant Compose")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
                && let Some(window) = tray.app_handle().get_webview_window("main")
            {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn local_resource(resources: &Path, request_path: &str) -> Result<PathBuf, String> {
    let text = percent_encoding::percent_decode_str(request_path)
        .decode_utf8()
        .map_err(err)?;
    let text = text.trim_start_matches('/');
    let (kind, filename) = text.split_once('/').ok_or("Missing resource filename")?;
    let folder = match kind {
        "local" | "models" => "voice-models",
        "wasm" => "voice-wasm",
        _ => return Err("Unknown resource kind".into()),
    };
    let path = Path::new(filename);
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Invalid resource path".into());
    }
    let base = resources.join(folder).canonicalize().map_err(err)?;
    let file = base.join(path).canonicalize().map_err(err)?;
    if !file.starts_with(&base) || !file.is_file() {
        return Err("Resource is unavailable".into());
    }
    Ok(file)
}

fn resource_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        Ok(Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources"))
    } else {
        app.path().resource_dir().map_err(err)
    }
}

fn profile_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("SC2_ASSISTANT_DATA_DIR") {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err("SC2_ASSISTANT_DATA_DIR must be an absolute profile directory".into());
        }
        return Ok(path);
    }
    app.path()
        .app_data_dir()
        .map(|p| p.join("data"))
        .map_err(err)
}

fn show_overlay(app: &tauri::AppHandle, desktop: &Desktop) -> Result<(), String> {
    let settings = desktop.store.settings()?;
    let window = match app.get_webview_window("overlay") {
        Some(window) => window,
        None => WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
            .title("SC2 Adjutant Overlay")
            .inner_size(360., 128.)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .visible(false)
            .build()
            .map_err(err)?,
    };
    position_overlay(&window, &settings)?;
    let placement = settings["overlayPlacementMode"].as_bool().unwrap_or(false);
    window.set_ignore_cursor_events(!placement).map_err(err)?;
    window.show().map_err(err)
}

fn position_overlay(window: &WebviewWindow, settings: &Value) -> Result<(), String> {
    let monitor = window
        .primary_monitor()
        .map_err(err)?
        .ok_or("No display available")?;
    let scale = monitor.scale_factor();
    let width = (360. * scale) as i32;
    let height = (128. * scale) as i32;
    let margin = (16. * scale) as i32;
    let area = monitor.work_area();
    let left = area.position.x + margin;
    let right = area.position.x + area.size.width as i32 - width - margin;
    let top = area.position.y + margin;
    let bottom = area.position.y + area.size.height as i32 - height - margin;
    let position = settings["overlayPosition"].as_str().unwrap_or("top-right");
    let (mut x, mut y) = if let Some(slot) = position
        .strip_prefix("bottom-")
        .and_then(|s| s.parse::<i32>().ok())
    {
        (left + (right - left) * (slot.clamp(1, 6) - 1) / 5, bottom)
    } else {
        (
            if position.ends_with("left") {
                left
            } else if position.ends_with("center") {
                (left + right) / 2
            } else {
                right
            },
            if position.starts_with("middle") {
                (top + bottom) / 2
            } else {
                top
            },
        )
    };
    if let (Some(cx), Some(cy)) = (
        settings["overlayCustomPosition"]["x"].as_i64(),
        settings["overlayCustomPosition"]["y"].as_i64(),
    ) {
        x = ((cx as f64 * scale).round() as i32).clamp(left, right.max(left));
        y = ((cy as f64 * scale).round() as i32).clamp(top, bottom.max(top));
    }
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(err)
}

fn open_explorer(path: &Path, select: bool) -> Result<Value, String> {
    if !path.exists() {
        return Err("The selected path is unavailable".into());
    }
    let mut command = std::process::Command::new("explorer.exe");
    if select {
        command.arg(format!("/select,{}", path.display()));
    } else {
        command.arg(path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.spawn().map_err(err)?;
    Ok(Value::Null)
}

#[tauri::command]
async fn dispatch(
    app: tauri::AppHandle,
    window: WebviewWindow,
    command: String,
    payload: Value,
    state: tauri::State<'_, Desktop>,
) -> Result<Value, String> {
    if window.label() != "main"
        && ![
            "getSettings",
            "getMonitoringStatus",
            "listOpponents",
            "listMatches",
            "getAppVersion",
            "startDragging",
        ]
        .contains(&command.as_str())
    {
        return Err("This command is only available in the main window".into());
    }
    if let Some(result) = state.runtime.dispatch(&command, payload.clone()).await {
        return result;
    }
    match command.as_str() {
        "getObsOverlayInfo" => obs_info(&state),
        "getSmartOverlaySettings" => smart_overlay::get(&state.store),
        "saveSmartOverlayDraft" => {
            let _gate = state.runtime.operation_gate.lock().await;
            smart_overlay::save_draft(&state.store, payload)
        }
        "applySmartOverlay" => {
            let _gate = state.runtime.operation_gate.lock().await;
            smart_overlay::apply(&state.store, payload)
        }
        "choosePostmatchReplay" => {
            if !payload.is_null() {
                return Err("Replay selection does not accept a renderer path".into());
            }
            let selected = tokio::task::spawn_blocking(|| {
                rfd::FileDialog::new()
                    .set_title("Выберите реплей для анализа")
                    .add_filter("StarCraft II replay", &["SC2Replay"])
                    .pick_file()
            })
            .await
            .map_err(err)?;
            let _gate = state.runtime.operation_gate.lock().await;
            state
                .runtime
                .prepare_selected_postmatch(selected.as_deref())
        }
        "chooseSmartOverlayImage" => {
            let input: smart_overlay::ChooseInput =
                serde_json::from_value(payload).map_err(|_| "Invalid image selection request")?;
            {
                let _gate = state.runtime.operation_gate.lock().await;
                smart_overlay::validate_choice(&state.store, &input)?;
            }
            let selected = tokio::task::spawn_blocking(|| {
                rfd::FileDialog::new()
                    .add_filter("Images", &["png", "jpg", "jpeg", "gif"])
                    .pick_file()
            })
            .await
            .map_err(err)?;
            let _gate = state.runtime.operation_gate.lock().await;
            let store = state.store.clone();
            tokio::task::spawn_blocking(move || {
                smart_overlay::import_selection(&store, &input, selected.as_deref())
            })
            .await
            .map_err(err)?
        }
        "configureObsOverlay" => {
            let _gate = state.runtime.operation_gate.lock().await;
            obs_config::configure(&state.store, payload)?;
            obs_info(&state)
        }
        "openObsOverlayPreview" => open_obs_preview(&state),
        "getAppVersion" => Ok(json!({"version":app.package_info().version.to_string()})),
        "minimizeWindow" => {
            window.minimize().map_err(err)?;
            Ok(Value::Null)
        }
        "startDragging" => {
            if window.label() == "overlay"
                && state.store.settings()?["overlayPlacementMode"] != true
            {
                return Err("Overlay placement mode is disabled".into());
            }
            window.start_dragging().map_err(err)?;
            Ok(Value::Null)
        }
        "closeWindow" => {
            window.close().map_err(err)?;
            Ok(Value::Null)
        }
        "openLocalStorage" => open_explorer(state.store.root(), false),
        "openExternalUrl" => {
            let url = url::Url::parse(payload["url"].as_str().ok_or("Missing external URL")?)
                .map_err(err)?;
            if url.scheme() != "https"
                || !url.username().is_empty()
                || url.password().is_some()
                || !["github.com", "paypal.me", "www.donationalerts.com"]
                    .contains(&url.host_str().unwrap_or(""))
            {
                return Err("External URL is not approved".into());
            }
            let mut process = std::process::Command::new("rundll32.exe");
            process.arg("url.dll,FileProtocolHandler").arg(url.as_str());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                process.creation_flags(0x08000000);
            }
            process.spawn().map_err(err)?;
            Ok(Value::Null)
        }
        "revealReplay" => {
            let path = payload["replayPath"]
                .as_str()
                .ok_or("Missing replay path")?;
            let permitted = state
                .store
                .records("matches")?
                .iter()
                .any(|m| m["replayPath"] == path);
            if !permitted {
                return Err("Replay is not in this profile's match history".into());
            }
            open_explorer(Path::new(path), true)
        }
        "listAvailableVoices" => {
            let folder = state.resources.join("voice-models");
            let mut available = Vec::new();
            if folder.is_dir() {
                for entry in std::fs::read_dir(&folder).map_err(err)? {
                    let path = entry.map_err(err)?.path();
                    if path.extension().is_some_and(|e| e == "onnx")
                        && path.with_extension("onnx.json").is_file()
                        && let Some(id) = path.file_stem().and_then(|s| s.to_str())
                    {
                        available.push(id.to_string());
                    }
                }
            }
            available.sort();
            Ok(json!({"available":available}))
        }
        "setCompactWindow" => {
            let compact = payload["compact"].as_bool().ok_or("Invalid compact mode")?;
            if compact {
                let number = |key: &str, min: f64, max: f64| -> Result<f64, String> {
                    payload[key]
                        .as_f64()
                        .filter(|n| n.is_finite() && *n >= min && *n <= max)
                        .ok_or_else(|| format!("Invalid {key}"))
                };
                let width = number("width", 120., 2000.)?;
                let height = number("height", 60., 2000.)?;
                let dx = number("offsetX", -2000., 2000.)?;
                let dy = number("offsetY", -2000., 2000.)?;
                let mut old = state.compact.lock().map_err(err)?;
                if old.is_none() {
                    *old = Some((
                        window.outer_position().map_err(err)?,
                        window.inner_size().map_err(err)?,
                    ));
                }
                let scale = window.scale_factor().map_err(err)?;
                let origin = old.as_ref().unwrap().0;
                window
                    .set_min_size(None::<tauri::LogicalSize<f64>>)
                    .map_err(err)?;
                window
                    .set_size(tauri::LogicalSize::new(width, height))
                    .map_err(err)?;
                window
                    .set_position(PhysicalPosition::new(
                        origin.x + (dx * scale) as i32,
                        origin.y + (dy * scale) as i32,
                    ))
                    .map_err(err)?;
            } else if let Some((position, size)) = state.compact.lock().map_err(err)?.take() {
                window.set_size(size).map_err(err)?;
                window.set_position(position).map_err(err)?;
                window
                    .set_min_size(Some(tauri::LogicalSize::new(1000., 650.)))
                    .map_err(err)?;
            }
            Ok(Value::Null)
        }
        "showOverlay" | "hideOverlay" | "setOverlayPosition" | "setOverlayPlacementMode" => {
            let _gate = state.runtime.operation_gate.lock().await;
            match command.as_str() {
                "showOverlay" => {
                    state.store.save_settings(json!({"overlayEnabled":true}))?;
                    show_overlay(&app, &state)?;
                }
                "hideOverlay" => {
                    state.store.save_settings(json!({"overlayEnabled":false}))?;
                    if let Some(w) = app.get_webview_window("overlay") {
                        w.hide().map_err(err)?;
                    }
                }
                "setOverlayPosition" => {
                    if payload["position"].as_str().is_none() {
                        return Err("Invalid overlay position".into());
                    }
                    state.store.save_settings(
                        json!({"overlayPosition":payload["position"],"overlayCustomPosition":null}),
                    )?;
                    if let Some(w) = app.get_webview_window("overlay") {
                        position_overlay(&w, &state.store.settings()?)?;
                    }
                }
                _ => {
                    let enabled = payload["enabled"]
                        .as_bool()
                        .ok_or("Invalid placement mode")?;
                    state
                        .store
                        .save_settings(json!({"overlayPlacementMode":enabled}))?;
                    if enabled {
                        show_overlay(&app, &state)?;
                    } else if let Some(w) = app.get_webview_window("overlay") {
                        w.set_ignore_cursor_events(true).map_err(err)?;
                    }
                }
            }
            Ok(Value::Null)
        }
        "smokeReport" => {
            let path = state
                .smoke_report
                .as_ref()
                .ok_or("Smoke reporting is disabled")?;
            std::fs::write(path, payload.to_string()).map_err(err)?;
            app.exit(if payload["ok"] == true { 0 } else { 1 });
            Ok(Value::Null)
        }
        "smokeWindowState" => {
            if state.smoke_report.is_none() {
                return Err("Smoke reporting is disabled".into());
            }
            let scale = window.scale_factor().map_err(err)?;
            let size = window.inner_size().map_err(err)?;
            Ok(json!({"width":size.width as f64/scale,"height":size.height as f64/scale}))
        }
        "smokeObsHttpCheck" => smoke_obs_http_check(&state, &window).await,
        "smokePreparePostmatch" => {
            if state.smoke_report.is_none() || !payload.is_null() {
                return Err("Explicit native smoke replay preparation is disabled".into());
            }
            let Some(selected) = std::env::var_os("SC2_COMPOSE_SMOKE_REPLAY") else {
                return Ok(json!({"requested":false}));
            };
            let path = PathBuf::from(selected);
            if !path.is_absolute() {
                return Err("Smoke replay must be an absolute path".into());
            }
            // Exercise the same Tauri host/resources as the real application before cache reuse.
            let parser = state.resources.join("compose-runtime");
            let facts = ReplayRunner::new(parser.join("node.exe"), parser.join("worker.mjs"))
                .postmatch(&path)
                .await
                .map_err(|e| {
                    format!(
                        "Native smoke replay decode: {}",
                        smoke_replay_error(e, &path, &state.resources)
                    )
                })?;
            let initial = state.runtime.postmatch_status(true);
            let _gate = state.runtime.operation_gate.lock().await;
            state.runtime.prepare_selected_postmatch(Some(&path))?;
            Ok(
                json!({"requested":true,"decoded":smoke_postmatch_counts(&facts),"initialStatus":initial["status"]}),
            )
        }
        "smokePostmatchCounts" => {
            if state.smoke_report.is_none() || !payload.is_null() {
                return Err("Explicit native smoke replay preparation is disabled".into());
            }
            let Some(value) = state.runtime.postmatch_data(true)? else {
                return Ok(Value::Null);
            };
            Ok(smoke_postmatch_counts(&value))
        }
        "smokeMapBackground" => {
            if state.smoke_report.is_none()
                || !payload.is_null()
                || std::env::var_os("SC2_COMPOSE_SMOKE_REPLAY").is_none()
            {
                return Err("Explicit native map smoke is disabled".into());
            }
            let facts = state
                .runtime
                .postmatch_data(true)?
                .ok_or("Prepared facts are missing")?;
            let map_sha = facts["map_sha256"]
                .as_str()
                .ok_or("Replay omitted primary map identity")?;
            if std::env::var_os("SC2_COMPOSE_SMOKE_MINIMAP").is_some() {
                let parser = state.resources.join("compose-runtime");
                let raw = ReplayRunner::new(parser.join("node.exe"), parser.join("worker.mjs"))
                    .request("mapImage", json!({"mapSha256":map_sha}))
                    .await
                    .map_err(|_| "Native minimap extraction failed")?;
                crate::map_background::minimap(state.store.root(), map_sha, &raw)?;
            }
            let facts = state
                .runtime
                .postmatch_data(true)?
                .ok_or("Prepared facts are missing")?;
            let background = facts["map_background"].clone();
            if background["status"] == "ready" {
                use sha2::Digest;
                let source = url::Url::parse(
                    obs_info(&state)?["url"]
                        .as_str()
                        .ok_or("Source URL missing")?,
                )
                .map_err(err)?;
                let map_url = source
                    .join(background["url"].as_str().ok_or("Map URL missing")?)
                    .map_err(err)?;
                if map_url.origin() != source.origin()
                    || !map_url.path().starts_with("/api/overlay/maps/")
                {
                    return Err("Map smoke URL escaped owned source".into());
                }
                let client = reqwest::Client::builder()
                    .no_proxy()
                    .timeout(std::time::Duration::from_secs(5))
                    .build()
                    .map_err(err)?;
                let bytes = smoke_get(&client, map_url.as_str(), 16 * 1024 * 1024).await?;
                if background["image_sha256"] != format!("{:x}", sha2::Sha256::digest(&bytes))
                    || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
                {
                    return Err("Native HTTP map checksum mismatch".into());
                }
            }
            Ok(background)
        }
        _ => {
            // Serialize every native mutation with snapshot read/compute/commit operations.
            let _gate = state.runtime.operation_gate.lock().await;
            if command == "saveSettings" {
                state.runtime.validate_review_settings(&payload)?;
            }
            let result = state.store.handle(&command, payload)?;
            if command == "saveSettings" {
                state.runtime.reload_settings()?;
            }
            Ok(result)
        }
    }
}

fn visual_review_profile(explicit: Option<&std::ffi::OsStr>) -> Result<PathBuf, String> {
    use std::io::Read;
    let requested =
        PathBuf::from(explicit.ok_or("Visual review requires an explicit SC2_ASSISTANT_DATA_DIR")?);
    if !requested.is_absolute() {
        return Err("Visual review profile must be an absolute path".into());
    }
    let root = requested
        .canonicalize()
        .map_err(|_| "Visual review profile does not exist")?;
    let marker = root.join(".compose-visual-review.json");
    let resolved = marker
        .canonicalize()
        .map_err(|_| "Visual review profile marker is missing")?;
    if resolved.parent() != Some(root.as_path()) || !resolved.is_file() {
        return Err("Visual review marker escaped its profile".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&resolved)
        .map_err(|_| "Cannot read visual review marker")?
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read visual review marker")?;
    if bytes.len() > 4096 {
        return Err("Visual review marker exceeds its limit".into());
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid visual review marker")?;
    let identity = value["profile"]
        .as_str()
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .and_then(|p| p.canonicalize().ok());
    if value["schemaVersion"] != 1
        || value["kind"] != "sc2-compose-visual-review"
        || identity.as_ref() != Some(&root)
        || value["instanceId"]
            .as_str()
            .and_then(|s| uuid::Uuid::parse_str(s).ok())
            .is_none()
    {
        return Err("Visual review marker does not identify this profile".into());
    }
    Ok(root)
}

pub fn run() {
    let visual_review = std::env::var("SC2_COMPOSE_VISUAL_REVIEW").is_ok_and(|value| value == "1");
    // Validate before the single-instance plugin and Store::open: invalid review mode must never touch a real profile.
    let visual_root = if visual_review {
        assert!(
            std::env::var_os("SC2_COMPOSE_SMOKE_REPORT").is_none(),
            "Visual review and automated smoke must use separate instances"
        );
        Some(
            visual_review_profile(std::env::var_os("SC2_ASSISTANT_DATA_DIR").as_deref())
                .expect("Refusing unmarked visual review profile"),
        )
    } else {
        None
    };
    let builder = tauri::Builder::default();
    // Isolated verification must not attach to or focus the user's running instance.
    let builder = if std::env::var_os("SC2_COMPOSE_SMOKE_REPORT").is_none() && !visual_review {
        builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
    } else {
        builder
    };
    builder
        .register_uri_scheme_protocol("voice-model",|context,request|{
            let response=(||->Result<_,String>{
                let root=resource_root(context.app_handle())?;
                let path=local_resource(&root,request.uri().path())?;
                let data=std::fs::read(&path).map_err(err)?;
                let mime=if path.extension().is_some_and(|e|e=="mjs"){"text/javascript".to_string()}else{mime_guess::from_path(&path).first_or_octet_stream().to_string()};
                Ok(tauri::http::Response::builder().status(200).header("Content-Type",mime).header("Access-Control-Allow-Origin","*").body(data).unwrap())
            })();
            response.unwrap_or_else(|_|tauri::http::Response::builder().status(404).body(Vec::new()).unwrap())
        })
        .invoke_handler(tauri::generate_handler![dispatch])
        .setup(move |app|{
            let root=if let Some(root)=visual_root.clone(){root}else{profile_root(app.handle())?};
            let store=Arc::new(Store::open(root)?);
            let resources=resource_root(app.handle())?;
            let parser=resources.join("compose-runtime");
            let replay=ReplayRunner::new(parser.join("node.exe"),parser.join("worker.mjs"));
            let handle=app.handle().clone();
            let smoke_report=std::env::var_os("SC2_COMPOSE_SMOKE_REPORT").map(PathBuf::from);
            let runtime=Runtime::new(store.clone(),replay,Arc::new(move |event,value|{let _=handle.emit(event,value);}))?;
            let runtime=if visual_review{runtime.for_visual_review()?}else if smoke_report.is_some(){runtime.without_network()}else{runtime};
            let obs_assets=if cfg!(debug_assertions){Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist-obs")}else{resources.join("obs-web")};
            let port=match std::env::var("SC2_COMPOSE_OVERLAY_PORT"){
                Ok(value)=>value.parse::<u16>().ok().filter(|port|*port>=1024||(*port==0&&(smoke_report.is_some()||visual_review))).ok_or("OBS port must be between1024and65535"),
                Err(_)=>Ok(obs_config::DEFAULT_PORT),
            };
            let obs_result=match port{
                Ok(port)=>tauri::async_runtime::block_on(ObsServer::start(store.clone(),runtime.clone(),obs_assets,port)),
                Err(error)=>Err(error.to_string()),
            };
            let (obs_server,obs_error)=match obs_result{Ok(server)=>(Some(server),None),Err(error)=>(None,Some(error))};
            if smoke_report.is_none(){
                // Interactive startup only, matching incumbent automatic SC2 detection.
                if !visual_review {tauri::async_runtime::block_on(async {runtime.start_autostart();});}
                setup_tray(app)?;
            }
            app.manage(Desktop{store,runtime,resources,compact:Mutex::new(None),smoke_report:smoke_report.clone(),obs_server,obs_error});
            if let Some(window)=app.get_webview_window("main") {
                if smoke_report.is_some(){
                    let script=include_str!("smoke.js");
                    let w=window.clone();
                    tauri::async_runtime::spawn(async move{tokio::time::sleep(std::time::Duration::from_secs(2)).await;let _=w.eval(script);});
                } else {
                    if visual_review { window.set_title("SC2 Adjutant Compose — визуальная проверка (тестовый профиль)")?; }
                    window.show()?;
                    if app.state::<Desktop>().store.settings()?["overlayEnabled"]==true {show_overlay(app.handle(),&app.state::<Desktop>())?;}
                }
            }
            Ok(())
        })
        .on_window_event(|window,event|{
            if window.label()=="main"
                && let tauri::WindowEvent::CloseRequested{api,..}=event {api.prevent_close();let _=window.hide();}
            if window.label()=="overlay"
                && let tauri::WindowEvent::Moved(position)=event {
                    let state=window.state::<Desktop>();
                    if state.store.settings().is_ok_and(|s|s["overlayPlacementMode"]==true) {
                        let scale=window.scale_factor().unwrap_or(1.);
                        let _=state.store.save_settings(json!({"overlayCustomPosition":{"x":(position.x as f64/scale).round(),"y":(position.y as f64/scale).round()}}));
                    }
                }
        })
        .build(tauri::generate_context!()).expect("Unable to build SC2 Adjutant Compose")
        .run(|app,event|{if matches!(event,tauri::RunEvent::Exit){let state=app.state::<Desktop>();if let Some(server)=&state.obs_server{server.shutdown();}state.runtime.shutdown();}});
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_smoke_errors_preserve_cause_without_selected_or_resource_paths() {
        let replay = Path::new(r"C:\private\selected.SC2Replay");
        let resources = Path::new(r"D:\private\resources");
        let message=smoke_replay_error(
            "Cannot load C:/PRIVATE/selected.SC2Replay from D:\\private\\resources\\worker.mjs\nDecode error".into(),
            replay,resources);
        assert!(message.contains("Cannot load <local-path>"));
        assert!(message.contains("Decode error"));
        assert!(!message.contains("private"));
        assert!(!message.contains('\n'));
        #[cfg(windows)]
        {
            for (path, exposed) in [
                (
                    r"\\?\D:\private\resources",
                    r"D:\private\resources\worker.mjs",
                ),
                (
                    r"\\?\UNC\server\private\resources",
                    r"\\server\private\resources\worker.mjs",
                ),
            ] {
                let cleaned =
                    smoke_replay_error(format!("Cannot load {exposed}"), replay, Path::new(path));
                assert!(!cleaned.contains("private"));
                assert!(cleaned.contains("<local-path>"));
            }
        }
    }
    #[test]
    fn visual_review_requires_an_explicit_absolute_profile_with_its_own_marker() {
        assert!(visual_review_profile(None).is_err());
        assert!(visual_review_profile(Some(std::ffi::OsStr::new("relative"))).is_err());
        let root = tempfile::tempdir().unwrap();
        assert!(visual_review_profile(Some(root.path().as_os_str())).is_err());
        let canonical = root.path().canonicalize().unwrap();
        let marker = canonical.join(".compose-visual-review.json");
        let mut value = json!({"schemaVersion":1,"kind":"sc2-compose-visual-review","instanceId":uuid::Uuid::new_v4().to_string(),"profile":canonical});
        std::fs::write(&marker, serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(
            visual_review_profile(Some(root.path().as_os_str())).unwrap(),
            canonical
        );
        let other = tempfile::tempdir().unwrap();
        value["profile"] = json!(other.path());
        std::fs::write(&marker, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(visual_review_profile(Some(root.path().as_os_str())).is_err());
    }
    #[test]
    fn resource_paths_are_contained() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("voice-models")).unwrap();
        std::fs::write(root.path().join("voice-models/voice.onnx"), b"fixture").unwrap();
        assert!(local_resource(root.path(), "/local/voice.onnx").is_ok());
        assert!(local_resource(root.path(), "/local/%2e%2e/Cargo.toml").is_err());
        assert!(local_resource(root.path(), "/secret/file").is_err());
    }
}
