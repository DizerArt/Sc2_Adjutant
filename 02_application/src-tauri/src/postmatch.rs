//! Read-only replay facts projected into the four original post-match renderers.
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path};
pub const MAX_BYTES: usize = 16 * 1024 * 1024;
const SAFE: f64 = 9_007_199_254_740_991.0;

/// Only fixed messages cross IPC/HTTP; worker/SQLite errors can contain private paths.
pub fn failure_message(error: &str, language: &str) -> (&'static str, &'static str) {
    let lower = error.to_lowercase();
    let (code, ru, en) = if lower.contains("timed out") {
        (
            "timeout",
            "Разбор занял больше 45 секунд. Повторите подготовку или выберите другой реплей.",
            "Analysis exceeded 45 seconds. Retry or choose another replay.",
        )
    } else if lower.contains("changed") {
        (
            "source_changed",
            "Файл реплея изменился во время чтения. Дождитесь окончания записи и повторите подготовку.",
            "The replay changed while being read. Wait for recording to finish and retry.",
        )
    } else if lower.contains("scaled faster") || lower.contains("supported clock") {
        (
            "unsupported_clock",
            "Не удалось определить поддерживаемое время игры в этом реплее. Выберите реплей на скорости «Очень быстро».",
            "The replay clock is unsupported. Choose a Faster replay.",
        )
    } else if lower.contains("two minutes") {
        (
            "too_short",
            "Матч короче двух минут: послематчевый анализ пока рассчитан на более длинные игры.",
            "The match is shorter than two minutes, which this analysis does not yet support.",
        )
    } else if lower.contains("teams")
        || lower.contains("player setup")
        || lower.contains("roster")
        || lower.contains("tracker pid")
        || lower.contains("working-set slot")
        || lower.contains("player slot")
    {
        (
            "unsupported_roster",
            "Не удалось однозначно определить игроков и команды реплея. Нужны данные tracker и минимум две стороны.",
            "Players and teams could not be identified. Tracker data and at least two sides are required.",
        )
    } else if lower.contains("exceed") || lower.contains("too many") || lower.contains("oversized")
    {
        (
            "size_limit",
            "Реплей или его события превышают лимит анализа. Выберите меньший файл или более короткий матч.",
            "The replay or event stream exceeds analysis limits. Choose a smaller replay or shorter match.",
        )
    } else if lower.contains("worker is unavailable") {
        (
            "worker_missing",
            "В сборке отсутствует модуль разбора реплеев. Запустите приложение из полной папки сборки.",
            "The replay worker is missing. Run the application from its complete build folder.",
        )
    } else if lower.starts_with("cache:") || lower.starts_with("storage:") {
        (
            "storage_error",
            "Не удалось прочитать или сохранить анализ в локальной базе. Повторите подготовку; исходный реплей не изменён.",
            "The local analysis cache could not be read or saved. Retry; the source replay is unchanged.",
        )
    } else if lower.starts_with("projection:") {
        (
            "invalid_facts",
            "Реплей прочитан, но данные анализа не прошли проверку приложения. Код: invalid_facts.",
            "The replay was read, but analysis data failed application validation. Code: invalid_facts.",
        )
    } else if lower.starts_with("source:") || lower.contains("cannot read") {
        (
            "source_unavailable",
            "Не удалось прочитать выбранный реплей. Проверьте доступность файла и выберите его снова.",
            "The selected replay could not be read. Check that the file is accessible and select it again.",
        )
    } else if lower.contains("cancel")
        || lower.contains("identity")
        || lower.contains("link changed")
        || lower.contains("removed")
        || lower.contains("did not match")
    {
        (
            "selection_changed",
            "Подготовка отменена: выбранный матч или его связь с реплеем изменились. Выберите файл напрямую и повторите.",
            "Preparation was cancelled because the match or replay link changed. Select the file directly and retry.",
        )
    } else if lower.starts_with("decode:") {
        (
            "decode_failed",
            "Модуль разбора не смог прочитать события этого реплея. Код: decode_failed. Попробуйте другой файл.",
            "The replay worker could not decode this replay's events. Code: decode_failed. Try another file.",
        )
    } else {
        (
            "analysis_failed",
            "Не удалось завершить подготовку анализа. Выберите реплей снова. Код: analysis_failed.",
            "Analysis preparation failed. Select the replay again. Code: analysis_failed.",
        )
    };
    (code, if language == "en" { en } else { ru })
}

pub fn fingerprint(path: &Path) -> Result<String, String> {
    crate::replay::validate_replay(path)
        .map_err(|_| "The match replay is unavailable or unsupported")?;
    let mut file = std::fs::File::open(path).map_err(|_| "Cannot read the match replay")?;
    let mut hash = Sha256::new();
    hash.update(
        b"compose-postmatch-tracker-v3-map-identity/sc2readerjs-0.1.9/schema1/duration20\0",
    );
    let mut buffer = [0u8; 65536];
    let mut size = 0usize;
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|_| "Cannot read the match replay")?;
        if n == 0 {
            break;
        }
        size += n;
        if size > 64 * 1024 * 1024 {
            return Err("Replay exceeds its size limit".into());
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn text(value: &Value, max: usize) -> Result<Value, String> {
    let text = value.as_str().ok_or("Invalid post-match display text")?;
    if text.chars().count() > max || text.chars().any(|c| c.is_control()) {
        return Err("Invalid post-match display text".into());
    }
    Ok(json!(text))
}
fn number(value: &Value, min: f64, max: f64, integer: bool) -> Result<f64, String> {
    let n = value
        .as_f64()
        .filter(|n| n.is_finite() && *n >= min && *n <= max && (!integer || n.fract() == 0.0))
        .ok_or("Invalid post-match numeric fact")?;
    Ok(n)
}
fn row(value: &Value, allowed: &[&str]) -> Result<Value, String> {
    let object = value.as_object().ok_or("Invalid post-match event")?;
    let mut out = Map::new();
    for key in allowed {
        if let Some(value) = object.get(*key) {
            if !value.is_null() {
                if ["ready", "eligible", "enemy_kill_candidate", "can_connect"].contains(key) {
                    if !value.is_boolean() {
                        return Err("Invalid post-match boolean fact".into());
                    }
                } else if [
                    "id",
                    "kind",
                    "unit",
                    "upgrade",
                    "owner_name",
                    "owner_color",
                    "category",
                    "position_basis",
                    "status",
                    "basis",
                    "cargo",
                    "reason",
                    "icon",
                ]
                .contains(key)
                {
                    text(value, 256)?;
                } else {
                    number(
                        value,
                        if ["x", "y", "min_x", "min_y", "max_x", "max_y"].contains(key) {
                            -1_000_000.
                        } else {
                            0.
                        },
                        SAFE,
                        ![
                            "at",
                            "x",
                            "y",
                            "min_x",
                            "min_y",
                            "max_x",
                            "max_y",
                            "game_clock_hz",
                            "max_connect_distance",
                        ]
                        .contains(key),
                    )?;
                }
            }
            let clean = match value {
                Value::Null | Value::Bool(_) => value.clone(),
                Value::String(_) => text(value, 256)?,
                Value::Number(_) => {
                    number(value, -1_000_000_000.0, SAFE, false)?;
                    value.clone()
                }
                _ => return Err("Nested post-match event data is not supported".into()),
            };
            out.insert(key.to_string(), clean);
        }
    }
    Ok(Value::Object(out))
}
fn timed(row: &Value, ticks: f64, timeline: f64) -> Result<(), String> {
    number(&row["tick"], 0.0, ticks, true)?;
    number(&row["at"], 0.0, timeline, false)?;
    Ok(())
}
fn coordinates(row: &Value) -> Result<(), String> {
    for key in ["x", "y"] {
        if let Some(v) = row.get(key).filter(|v| !v.is_null()) {
            number(v, -1_000_000.0, 1_000_000.0, false)?;
        }
    }
    Ok(())
}
fn actor_fields(row: &Value, ticks: f64, team_max: f64) -> Result<(), String> {
    for key in ["owner_pid", "previous_owner_pid", "killer_pid"] {
        if let Some(value) = row.get(key).filter(|v| !v.is_null()) {
            number(value, 0.0, 32.0, true)?;
        }
    }
    if let Some(value) = row.get("team").filter(|v| !v.is_null()) {
        number(value, 0.0, team_max, true)?;
    }
    if let Some(value) = row.get("position_tick").filter(|v| !v.is_null()) {
        number(value, 0.0, ticks, true)?;
    }
    if let Some(value) = row.get("category").filter(|v| !v.is_null())
        && !value
            .as_str()
            .is_some_and(|v| ["army", "worker", "building", "other", "unknown"].contains(&v))
    {
        return Err("Invalid post-match category".into());
    }
    Ok(())
}
fn icon(value: &Value) -> Value {
    if value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 80
            && s.bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
    }) {
        value.clone()
    } else {
        Value::Null
    }
}
fn color(value: &Value) -> Value {
    if value.as_str().is_some_and(|s| {
        s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
    }) {
        value.clone()
    } else {
        Value::Null
    }
}
fn array(value: &Value, max: usize) -> Result<&Vec<Value>, String> {
    value
        .as_array()
        .filter(|a| a.len() <= max)
        .ok_or("Post-match event limit exceeded or missing collection".into())
}

/// Whitelist every exported field; worker records and filesystem paths never cross HTTP.
pub fn sanitize(value: &Value, id: &str) -> Result<Value, String> {
    if serde_json::to_vec(value).map_err(|e| e.to_string())?.len() > MAX_BYTES {
        return Err("Post-match facts exceed 16 MiB".into());
    }
    let duration = number(&value["duration"], 3.0, 60.0, false)?;
    let timeline = number(&value["timeline_seconds"], 0.1, duration, false)?;
    let ticks = number(&value["elapsed_gameloops"], 1.0, 100_000_000.0, true)?;
    number(&value["game_seconds"], 0.1, 86400.0, false)?;
    number(&value["flight_seconds"], 0.0, duration, false)?;
    let team_labels = array(&value["teams"], 32)?;
    if team_labels.len() < 2 {
        return Err("Post-match requires at least two team labels".into());
    }
    let team_max = (team_labels.len() - 1) as f64;
    let mut players = Vec::new();
    for player in array(&value["players"], 32)? {
        number(&player["pid"], 1.0, 32.0, true)?;
        number(&player["team"], 0.0, team_max, true)?;
        players.push(json!({"pid":player["pid"],"team":player["team"],"name":text(&player["name"],160)?,"color":color(&player["color"])}));
    }
    if players.len() < 2
        || (0..team_labels.len()).any(|team| !players.iter().any(|p| p["team"] == team))
    {
        return Err("Post-match requires a player for every observed team".into());
    }
    let mut pids = std::collections::HashSet::new();
    if players
        .iter()
        .any(|p| !pids.insert(p["pid"].as_u64().unwrap_or(0)))
    {
        return Err("Duplicate post-match player".into());
    }
    let teams = team_labels
        .iter()
        .map(|t| Ok(json!({"label":text(&t["label"],512)?})))
        .collect::<Result<Vec<_>, String>>()?;
    let mut events = Vec::new();
    for event in array(&value["events"], 10000)? {
        let source = event;
        let mut event = row(
            event,
            &[
                "id",
                "tick",
                "team",
                "owner_pid",
                "owner_name",
                "owner_color",
                "unit",
                "tag",
                "x",
                "y",
                "killer_tag",
                "killer_pid",
                "at",
            ],
        )?;
        text(&event["id"], 64)?;
        text(&event["unit"], 160)?;
        timed(&event, ticks, timeline)?;
        coordinates(&event)?;
        actor_fields(&event, ticks, team_max)?;
        number(&event["team"], 0.0, team_max, true)?;
        number(&event["owner_pid"], 1.0, 32.0, true)?;
        if !players
            .iter()
            .any(|p| p["pid"] == event["owner_pid"] && p["team"] == event["team"])
        {
            return Err("Post-match death owner is not an observed player".into());
        }
        event["owner_color"] = color(&event["owner_color"]);
        event["icon"] = icon(&source["icon"]);
        events.push(event);
    }
    let mut resources = Vec::new();
    for sample in array(&value["resource_timeline"], 20000)? {
        let sample = row(sample, &["tick", "at", "team", "minerals", "gas"])?;
        timed(&sample, ticks, timeline)?;
        number(&sample["team"], 0.0, team_max, true)?;
        for key in ["minerals", "gas"] {
            if !sample[key].is_null() {
                number(&sample[key], 0.0, SAFE, true)?;
            }
        }
        resources.push(sample);
    }
    let story = &value["story"];
    if story["schema_version"] != 1 {
        return Err("Post-match lifecycle facts are unavailable".into());
    }
    let mut story_events = Vec::new();
    for event in array(&story["events"], 50000)? {
        let source = event;
        let mut event = row(
            event,
            &[
                "tick",
                "sequence",
                "kind",
                "tag",
                "unit",
                "owner_pid",
                "ready",
                "x",
                "y",
                "position_tick",
                "position_basis",
                "position_epoch",
                "previous_owner_pid",
                "eligible",
                "killer_pid",
                "killer_tag",
                "enemy_kill_candidate",
                "upgrade",
                "count",
                "team",
                "owner_name",
                "owner_color",
                "category",
                "at",
            ],
        )?;
        timed(&event, ticks, timeline)?;
        coordinates(&event)?;
        actor_fields(&event, ticks, team_max)?;
        if !event["kind"]
            .as_str()
            .is_some_and(|k| ["spawn", "ready", "type", "owner", "death", "upgrade"].contains(&k))
        {
            return Err("Unknown post-match lifecycle event".into());
        }
        event["owner_color"] = color(&event["owner_color"]);
        event["icon"] = icon(&source["icon"]);
        story_events.push(event);
    }
    let movement = &story["movement"];
    if movement["schema_version"] != 1 {
        return Err("Post-match movement facts are unavailable".into());
    }
    let mut samples = Vec::new();
    for sample in array(&movement["samples"], 40000)? {
        let mut sample = row(
            sample,
            &[
                "tick",
                "sequence",
                "sample_index",
                "tag",
                "owner_pid",
                "unit",
                "category",
                "x",
                "y",
                "position_epoch",
                "gap_ticks",
                "can_connect",
                "team",
                "owner_name",
                "owner_color",
                "at",
            ],
        )?;
        timed(&sample, ticks, timeline)?;
        coordinates(&sample)?;
        actor_fields(&sample, ticks, team_max)?;
        number(&sample["x"], -1_000_000., 1_000_000., false)?;
        number(&sample["y"], -1_000_000., 1_000_000., false)?;
        sample["owner_color"] = color(&sample["owner_color"]);
        samples.push(sample);
    }
    if story_events.len() + samples.len() > 50000 {
        return Err("Post-match lifecycle and movement exceed 50000 events".into());
    }
    let bounds = if story["bounds"].is_null() {
        Value::Null
    } else {
        let bounds = row(&story["bounds"], &["min_x", "max_x", "min_y", "max_y"])?;
        for key in ["min_x", "max_x", "min_y", "max_y"] {
            number(&bounds[key], -1_000_000.0, 1_000_000.0, false)?;
        }
        if bounds["min_x"].as_f64() > bounds["max_x"].as_f64()
            || bounds["min_y"].as_f64() > bounds["max_y"].as_f64()
        {
            return Err("Invalid post-match bounds".into());
        }
        bounds
    };
    let mut mapped_movement = row(
        movement,
        &[
            "schema_version",
            "status",
            "basis",
            "sampled_units",
            "unknown_samples",
            "game_clock_hz",
            "max_connect_ticks",
            "fresh_ticks",
            "max_connect_distance",
            "cargo",
            "reason",
        ],
    )?;
    mapped_movement["samples"] = json!(samples);
    number(&mapped_movement["game_clock_hz"], 0.1, 100., false)?;
    mapped_movement["max_connect_ticks"] = json!(480);
    mapped_movement["fresh_ticks"] = json!(240);
    mapped_movement["max_connect_distance"] = json!(16);
    let map_sha = value["map_sha256"].as_str().filter(|v| {
        v.len() == 64
            && v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    });
    let result = json!({"id":id,"animation":"fountain","duration":duration,"timeline_seconds":timeline,"flight_seconds":value["flight_seconds"],"game_seconds":value["game_seconds"],"elapsed_gameloops":value["elapsed_gameloops"],"map_sha256":map_sha,
        "map":text(&value["map"],256)?,"players":players,"teams":teams,"events":events,"resource_timeline":resources,
        "resource_basis":text(&value["resource_basis"],512)?,"excluded":number(&value["excluded"],0.0,SAFE,true)?,"policy":"enemy_kill_candidates_not_verified_combat_losses",
        "map_background":{"status":"unavailable","reason":"Local map image is unavailable; observed tracker geometry is shown"},
        "story":{"schema_version":1,"events":story_events,"bounds":bounds,"basis":"tracker_events_not_continuous_positions","movement":mapped_movement}});
    if serde_json::to_vec(&result)
        .map_err(|e| e.to_string())?
        .len()
        > MAX_BYTES
    {
        return Err("Public post-match facts exceed 16 MiB".into());
    }
    Ok(result)
}

pub fn visible(settings: &Value, monitoring: &Value) -> bool {
    let smart = crate::smart_overlay::public_state(settings, monitoring);
    smart["enabled"] == true
        && smart["phase"] == "menu"
        && smart["mode"]["enabled"] == true
        && smart["menuLayout"]["widgets"]
            .as_object()
            .is_some_and(|w| w.values().any(|v| v["enabled"] == true))
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn fixture() -> Value {
        serde_json::from_str::<Value>(include_str!("../../tests/fixtures/postmatch-review.json"))
            .unwrap()["payload"]
            .clone()
    }
    #[test]
    fn public_failures_identify_the_stage_without_echoing_private_paths() {
        for (error, expected) in [
            (
                "decode: Replay analysis timed out after 45 seconds.",
                "timeout",
            ),
            (
                "decode: Post-match widgets require a supported modern scaled Faster game clock",
                "unsupported_clock",
            ),
            (
                "projection: Invalid post-match numeric fact",
                "invalid_facts",
            ),
            (
                "storage: sqlite error C:/private/person/profile.sqlite",
                "storage_error",
            ),
            (
                "decode: Cannot find module C:/private/person/node_modules/pkg",
                "decode_failed",
            ),
            (
                "source: Cannot read C:/private/person/replay",
                "source_unavailable",
            ),
        ] {
            for language in ["ru", "en"] {
                let (code, message) = failure_message(error, language);
                assert_eq!(code, expected);
                assert!(!message.contains("private"));
                assert!(!message.contains("C:/"));
            }
        }
    }
    #[test]
    fn native_projection_accepts_tracker_fixture_and_removes_private_or_external_fields() {
        let mut input = fixture();
        input["replayPath"] = json!("C:/private/source.SC2Replay");
        input["events"][0]["path"] = json!("C:/private/icon.png");
        input["events"][0]["icon"] = json!("https://external.invalid/icon.png");
        let result = sanitize(&input, &"a".repeat(64)).unwrap();
        assert_eq!(result["id"], "a".repeat(64));
        assert!(result.get("replayPath").is_none());
        assert!(result["events"][0].get("path").is_none());
        assert!(result["events"][0]["icon"].is_null());
        assert_eq!(result["map_background"]["status"], "unavailable");
        let mut invalid = input.clone();
        invalid["events"][0]["team"] = json!(2);
        assert!(sanitize(&invalid, &"b".repeat(64)).is_err());
        invalid = input;
        invalid["story"]["events"][0]["tag"] = json!("wrong");
        assert!(sanitize(&invalid, &"b".repeat(64)).is_err());
    }
    #[test]
    fn projection_preserves_ffa_teams_and_rejects_unknown_team_indices() {
        let mut input = fixture();
        input["teams"]
            .as_array_mut()
            .unwrap()
            .extend([json!({"label":"Third"}), json!({"label":"Fourth"})]);
        input["players"].as_array_mut().unwrap().extend([
            json!({"pid":15,"team":2,"name":"Third","color":"#123456"}),
            json!({"pid":16,"team":3,"name":"Fourth","color":"#abcdef"}),
        ]);
        input["events"][0]["owner_pid"] = json!(15);
        input["events"][0]["team"] = json!(2);
        let output = sanitize(&input, &"d".repeat(64)).unwrap();
        assert_eq!(output["teams"].as_array().unwrap().len(), 4);
        assert_eq!(output["events"][0]["team"], 2);
        input["events"][0]["team"] = json!(4);
        assert!(sanitize(&input, &"d".repeat(64)).is_err());
        input["events"][0]["team"] = json!(2);
        input["players"].as_array_mut().unwrap().pop();
        assert!(sanitize(&input, &"d".repeat(64)).is_err());
    }
    #[test]
    fn immutable_cache_survives_restart_but_clear_stats_removes_all_postmatch_data() {
        let root = tempfile::tempdir().unwrap();
        let store = crate::storage::Store::open(root.path().to_path_buf()).unwrap();
        let id = "c".repeat(64);
        let facts = sanitize(&fixture(), &id).unwrap();
        store
            .save_postmatch(
                &id,
                &facts,
                &json!({"id":id,"matchId":"m1","startedAt":1000}),
            )
            .unwrap();
        let mut changed = facts.clone();
        changed["map"] = json!("changed");
        store
            .save_postmatch(
                &id,
                &changed,
                &json!({"id":id,"matchId":"m1","startedAt":2000}),
            )
            .unwrap();
        assert_eq!(
            store.postmatch_facts(&id).unwrap().unwrap()["map"],
            facts["map"]
        );
        drop(store);
        let store = crate::storage::Store::open(root.path().to_path_buf()).unwrap();
        assert_eq!(store.postmatch_latest().unwrap()["startedAt"], 2000);
        store.handle("clearStats", Value::Null).unwrap();
        assert!(store.postmatch_facts(&id).unwrap().is_none());
        assert!(store.postmatch_latest().unwrap().is_null());
    }
}
