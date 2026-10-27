//! Transactional local storage with a one-time, non-destructive legacy import.
//! Original CSV/XML/JSON bytes are never rewritten by the compose runtime.
use crate::domain;
use quick_xml::Reader;
use quick_xml::events::Event;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

pub struct Store {
    root: PathBuf,
    database: Mutex<Connection>,
}

#[cfg(test)]
mod cache_persistence_tests {
    use super::*;
    #[test]
    fn source_cache_commits_with_records_and_survives_restart_without_partial_replacement() {
        let profile = tempfile::tempdir().unwrap();
        let store = Store::open(profile.path().to_path_buf()).unwrap();
        let cache = json!({"schema":1,"entries":[],"consecutiveFailures":3,"cooldownUntil":1000});
        store
            .replace_records_atomic(
                &json!({"opponents":[],"matches":[],"candidates":[],"sourceCache":cache}),
            )
            .unwrap();
        assert!(store.replace_records_atomic(&json!({"opponents":[],"matches":[],"candidates":[{}],"sourceCache":{"schema":99}})).is_err());
        assert_eq!(store.source_cache().unwrap(), cache);
        drop(store);
        let reopened = Store::open(profile.path().to_path_buf()).unwrap();
        assert_eq!(reopened.source_cache().unwrap(), cache);
    }
}

impl Store {
    pub fn open(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root).map_err(error)?;
        let root = fs::canonicalize(root).map_err(error)?;
        let database_path = root.join("compose.sqlite3");
        reject_link(&database_path, &root)?;
        reject_link(&root.join("compose.sqlite3-wal"), &root)?;
        reject_link(&root.join("compose.sqlite3-shm"), &root)?;
        let database = Connection::open(database_path).map_err(error)?;
        database
            .busy_timeout(std::time::Duration::from_secs(10))
            .map_err(error)?;
        database.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS compose_records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
            CREATE TABLE IF NOT EXISTS compose_meta(key TEXT PRIMARY KEY,body TEXT NOT NULL);").map_err(error)?;
        let store = Self {
            root,
            database: Mutex::new(database),
        };
        store.import_legacy()?;
        Ok(store)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.database
            .lock()
            .map_err(|_| "Storage lock poisoned".to_string())
    }

    pub fn records(&self, kind: &str) -> Result<Vec<Value>, String> {
        check_kind(kind)?;
        let db = self.lock()?;
        let mut query = db
            .prepare("SELECT body FROM compose_records WHERE kind=?1 ORDER BY rowid")
            .map_err(error)?;
        let text = query
            .query_map([kind], |r| r.get::<_, String>(0))
            .map_err(error)?;
        text.map(|v| serde_json::from_str(&v.map_err(error)?).map_err(error))
            .collect()
    }

    pub fn save_record(&self, kind: &str, record: Value) -> Result<(), String> {
        check_kind(kind)?;
        let id = record["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Record needs a nonempty id")?;
        self.lock()?.execute("INSERT INTO compose_records(kind,id,body) VALUES(?1,?2,?3) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body", params![kind,id,record.to_string()]).map_err(error)?;
        Ok(())
    }

    pub fn replace_records(&self, kind: &str, records: Vec<Value>) -> Result<(), String> {
        check_kind(kind)?;
        let mut db = self.lock()?;
        let tx = db.transaction().map_err(error)?;
        tx.execute("DELETE FROM compose_records WHERE kind=?1", [kind])
            .map_err(error)?;
        for record in records {
            let id = record["id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("Record needs a nonempty id")?;
            tx.execute(
                "INSERT INTO compose_records(kind,id,body) VALUES(?1,?2,?3)",
                params![kind, id, record.to_string()],
            )
            .map_err(error)?;
        }
        tx.commit().map_err(error)
    }

    /// Commit a compatibility-adapter result as one unit. The caller serializes
    /// the complete read/compute/write operation against other mutations.
    pub fn replace_records_atomic(&self, records: &Value) -> Result<(), String> {
        let mut db = self.lock()?;
        let tx = db.transaction().map_err(error)?;
        for kind in ["opponents", "matches", "candidates"] {
            let values = records[kind]
                .as_array()
                .ok_or_else(|| format!("Missing snapshot collection: {kind}"))?;
            tx.execute("DELETE FROM compose_records WHERE kind=?1", [kind])
                .map_err(error)?;
            for record in values {
                let id = record["id"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or("Snapshot record needs an id")?;
                tx.execute(
                    "INSERT INTO compose_records(kind,id,body) VALUES(?1,?2,?3)",
                    params![kind, id, record.to_string()],
                )
                .map_err(error)?;
            }
        }
        if let Some(cache) = records.get("sourceCache") {
            tx.execute("INSERT INTO compose_meta(key,body) VALUES('source-cache-v1',?1) ON CONFLICT(key) DO UPDATE SET body=excluded.body", [cache.to_string()]).map_err(error)?;
        }
        tx.commit().map_err(error)
    }

    pub fn source_cache(&self) -> Result<Value, String> {
        let text: Option<String> = self
            .lock()?
            .query_row(
                "SELECT body FROM compose_meta WHERE key='source-cache-v1'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)?;
        text.map(|body| serde_json::from_str(&body).map_err(error))
            .transpose()
            .map(|value| value.unwrap_or(Value::Null))
    }
    pub fn postmatch_facts(&self, id: &str) -> Result<Option<Value>, String> {
        if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid post-match cache identity".into());
        }
        let text: Option<String> = self
            .lock()?
            .query_row(
                "SELECT body FROM compose_meta WHERE key=?1",
                [format!("postmatch-facts-v1:{id}")],
                |r| r.get(0),
            )
            .optional()
            .map_err(error)?;
        text.map(|v| serde_json::from_str(&v).map_err(error))
            .transpose()
    }
    pub fn postmatch_latest(&self) -> Result<Value, String> {
        let text: Option<String> = self
            .lock()?
            .query_row(
                "SELECT body FROM compose_meta WHERE key='postmatch-latest-v1'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(error)?;
        text.map(|v| serde_json::from_str(&v).map_err(error))
            .transpose()
            .map(|v| v.unwrap_or(Value::Null))
    }
    pub fn clear_postmatch_latest(&self) -> Result<(), String> {
        self.lock()?
            .execute(
                "DELETE FROM compose_meta WHERE key='postmatch-latest-v1'",
                [],
            )
            .map_err(error)?;
        Ok(())
    }
    pub fn save_postmatch(&self, id: &str, facts: &Value, latest: &Value) -> Result<(), String> {
        if id.len() != 64
            || !id.bytes().all(|b| b.is_ascii_hexdigit())
            || facts["id"] != id
            || latest["id"] != id
        {
            return Err("Invalid post-match cache identity".into());
        }
        let body = serde_json::to_string(facts).map_err(error)?;
        if body.len() > crate::postmatch::MAX_BYTES {
            return Err("Post-match facts exceed their cache limit".into());
        }
        let mut db = self.lock()?;
        let tx = db.transaction().map_err(error)?;
        tx.execute(
            "INSERT INTO compose_meta(key,body) VALUES(?1,?2) ON CONFLICT(key) DO NOTHING",
            params![format!("postmatch-facts-v1:{id}"), body],
        )
        .map_err(error)?;
        tx.execute("INSERT INTO compose_meta(key,body) VALUES('postmatch-latest-v1',?1) ON CONFLICT(key) DO UPDATE SET body=excluded.body",[latest.to_string()]).map_err(error)?;
        tx.commit().map_err(error)
    }

    pub fn settings(&self) -> Result<Value, String> {
        let text: Option<String> = self
            .lock()?
            .query_row(
                "SELECT body FROM compose_meta WHERE key='settings'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(error)?;
        match text {
            Some(text) => serde_json::from_str(&text).map_err(error),
            None => Ok(domain::default_settings()),
        }
    }

    pub fn save_settings(&self, input: Value) -> Result<Value, String> {
        let mut db = self.lock()?;
        let tx = db.transaction().map_err(error)?;
        let text: Option<String> = tx
            .query_row(
                "SELECT body FROM compose_meta WHERE key='settings'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(error)?;
        let current = match text {
            Some(text) => serde_json::from_str(&text).map_err(error)?,
            None => domain::default_settings(),
        };
        let settings = domain::update_settings(&current, &input)?;
        tx.execute("INSERT INTO compose_meta(key,body) VALUES('settings',?1) ON CONFLICT(key) DO UPDATE SET body=excluded.body",[settings.to_string()]).map_err(error)?;
        tx.commit().map_err(error)?;
        Ok(settings)
    }

    pub fn handle(&self, command: &str, payload: Value) -> Result<Value, String> {
        match command {
            "getSettings" => Ok(json!({"settings":self.settings()?})),
            "saveSettings" => {
                if payload.get("obsOverlay").is_some() {
                    return Err("Use dedicated OBS settings commands".into());
                }
                Ok(json!({"settings":self.save_settings(payload)?}))
            }
            "listOpponents" | "listKnownOpponents" => {
                let mut values = self.records("opponents")?;
                values.sort_by(|a, b| date(b).cmp(date(a)));
                Ok(json!({"opponents":values}))
            }
            "listMatches" => {
                let opponents = self.records("opponents")?;
                let mut matches = self.records("matches")?;
                matches.sort_by(|a, b| b["playedAt"].as_str().cmp(&a["playedAt"].as_str()));
                Ok(
                    json!({"items":matches.into_iter().map(|record| { let opponent=opponents.iter().find(|o| o["id"]==record["opponentId"]); json!({"match":record,"opponent":opponent}) }).collect::<Vec<_>>()}),
                )
            }
            "listOpponentCandidates" => {
                let id = required_text(&payload, "opponentId")?;
                let mut candidates = self
                    .records("candidates")?
                    .into_iter()
                    .filter(|v| v["opponentId"] == id)
                    .collect::<Vec<_>>();
                candidates.sort_by(|a, b| {
                    b["selected"]
                        .as_bool()
                        .cmp(&a["selected"].as_bool())
                        .then_with(|| {
                            b["confidenceScore"]
                                .as_f64()
                                .unwrap_or(0.0)
                                .total_cmp(&a["confidenceScore"].as_f64().unwrap_or(0.0))
                        })
                });
                Ok(json!({"candidates":candidates}))
            }
            "addOpponentNote" | "removeOpponentNote" | "updateOpponentProfile" => {
                let id = required_text(&payload, "opponentId")?;
                let value = self
                    .records("opponents")?
                    .into_iter()
                    .find(|v| v["id"] == id)
                    .ok_or("Opponent not found")?;
                let updated = if command == "updateOpponentProfile" {
                    domain::edit_opponent(value, &payload)?
                } else {
                    domain::change_note(value, &payload, command == "removeOpponentNote")?
                };
                self.save_record("opponents", updated.clone())?;
                Ok(json!({"opponent":updated}))
            }
            "toggleMatchFavorite" => {
                let id = required_text(&payload, "matchId")?;
                let record = self.records("matches")?.into_iter().find(|v| v["id"] == id);
                if let Some(mut record) = record {
                    record["favorite"] = json!(!record["favorite"].as_bool().unwrap_or(false));
                    record["updatedAt"] = json!(domain::now());
                    self.save_record("matches", record.clone())?;
                    Ok(json!({"match":record}))
                } else {
                    Ok(json!({"match":null}))
                }
            }
            "getMatchDetails" => self.match_details(&payload),
            "clearStats" => {
                let mut db = self.lock()?;
                let tx = db.transaction().map_err(error)?;
                tx.execute("DELETE FROM compose_records WHERE kind IN ('opponents','matches','candidates')",[]).map_err(error)?;
                tx.execute("DELETE FROM compose_meta WHERE key='postmatch-latest-v1' OR key LIKE 'postmatch-facts-v1:%'",[]).map_err(error)?;
                tx.commit().map_err(error)?;
                Ok(json!({"clearedAt":domain::now()}))
            }
            "rebuildStats" => self.rebuild_stats(),
            _ => Err(format!("Unknown storage command: {command}")),
        }
    }

    fn match_details(&self, payload: &Value) -> Result<Value, String> {
        let id = required_text(payload, "matchId")?;
        let Some(record) = self.records("matches")?.into_iter().find(|v| v["id"] == id) else {
            return Ok(json!({"details":null}));
        };
        let opponent = self
            .records("opponents")?
            .into_iter()
            .find(|v| v["id"] == record["opponentId"]);
        let mut details = json!({"match":record,"opponent":opponent,"mapName":record["map"].as_str().unwrap_or("Unknown map"),"playedAt":record["playedAt"],"players":[],"graphs":[],"buildOrders":[]});
        for key in ["durationSeconds", "replayPath"] {
            if let Some(v) = record.get(key) {
                details[key] = v.clone();
            }
        }
        if record["replayPath"].is_string() {
            details["parseError"] =
                json!("Replay analysis has not been requested from the replay adapter.");
        }
        Ok(json!({"details":details}))
    }

    fn rebuild_stats(&self) -> Result<Value, String> {
        let matches = self.records("matches")?;
        let mut opponents = self.records("opponents")?;
        let mut rebuilt = 0;
        for opponent in &mut opponents {
            let records = matches
                .iter()
                .filter(|v| v["opponentId"] == opponent["id"])
                .collect::<Vec<_>>();
            let wins = records.iter().filter(|v| v["result"] == "win").count();
            let losses = records.iter().filter(|v| v["result"] == "loss").count();
            let latest = records.iter().filter_map(|v| v["playedAt"].as_str()).max();
            if opponent["encounters"].as_u64() != Some(records.len() as u64)
                || opponent["wins"].as_u64() != Some(wins as u64)
                || opponent["losses"].as_u64() != Some(losses as u64)
                || latest.is_some_and(|s| opponent["lastMatchDate"] != s)
            {
                opponent["encounters"] = json!(records.len());
                opponent["wins"] = json!(wins);
                opponent["losses"] = json!(losses);
                opponent["updatedAt"] = json!(domain::now());
                if let Some(latest) = latest {
                    opponent["lastMatchDate"] = json!(latest);
                }
                rebuilt += 1;
            }
        }
        let inspected = opponents.len();
        self.replace_records("opponents", opponents)?;
        Ok(json!({"inspectedCount":inspected,"rebuiltCount":rebuilt}))
    }

    fn import_legacy(&self) -> Result<(), String> {
        let mut db = self.lock()?;
        let tx = db.transaction().map_err(error)?;
        if tx
            .query_row(
                "SELECT body FROM compose_meta WHERE key='legacy-import-v1'",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(error)?
            .is_some()
        {
            return Ok(());
        }
        let mut originals = BTreeMap::<String, Vec<u8>>::new();
        let manifest = read_legacy(&self.root, "storage-manifest.json", &mut originals)?
            .map(|s| serde_json::from_str::<Value>(&s).map_err(error))
            .transpose()?;
        if let Some(m) = &manifest
            && (m["appName"] != "SC2 Assistant"
                || !["csv", "xml"].contains(&m["storageFormat"].as_str().unwrap_or_default())
                || m["schemaVersion"].as_u64() != Some(1))
        {
            return Err("Unsupported legacy storage manifest; originals preserved".into());
        }
        let format = manifest
            .as_ref()
            .and_then(|v| v["storageFormat"].as_str())
            .unwrap_or(
                if self.root.join("opponents.xml").is_file()
                    && !self.root.join("opponents.csv").is_file()
                {
                    "xml"
                } else {
                    "csv"
                },
            );
        for (kind, key, fallback) in [
            ("opponents", "opponents", format!("opponents.{format}")),
            ("matches", "matches", format!("matches.{format}")),
            (
                "candidates",
                "enrichmentCandidates",
                "enrichment-candidates.json".into(),
            ),
            (
                "fixtures",
                "opponentSourceFixtures",
                "opponent-source-fixtures.json".into(),
            ),
        ] {
            let filename = manifest
                .as_ref()
                .and_then(|m| m["files"][key].as_str())
                .unwrap_or(&fallback);
            if let Some(content) = read_legacy(&self.root, filename, &mut originals)? {
                let mut records = if kind == "opponents" || kind == "matches" {
                    if format == "xml" {
                        decode_xml(&content, kind)?
                    } else {
                        decode_csv(&content, kind)?
                    }
                } else {
                    serde_json::from_str::<Value>(&content)
                        .map_err(error)?
                        .as_array()
                        .cloned()
                        .ok_or("Legacy source must be a JSON array")?
                };
                let mut ids = HashSet::new();
                for (index, record) in records.iter_mut().enumerate() {
                    if !record.is_object() {
                        return Err("Legacy record must be an object".into());
                    }
                    if kind == "fixtures" && record["id"].as_str().is_none() {
                        record["id"] = json!(format!("fixture-{index}"));
                    }
                    let id = record["id"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .ok_or("Legacy record has no id; originals preserved")?;
                    if !ids.insert(id.to_owned()) {
                        return Err(format!(
                            "Duplicate legacy {kind} id: {id}; originals preserved"
                        ));
                    }
                    tx.execute(
                        "INSERT INTO compose_records(kind,id,body) VALUES(?1,?2,?3)",
                        params![kind, id, record.to_string()],
                    )
                    .map_err(error)?;
                }
            }
        }
        let settings_name = manifest
            .as_ref()
            .and_then(|m| m["files"]["settings"].as_str())
            .unwrap_or("settings.json");
        let settings = match read_legacy(&self.root, settings_name, &mut originals)? {
            Some(content) => domain::normalize_settings(
                &serde_json::from_str::<Value>(&content).map_err(error)?,
            )?,
            None => domain::default_settings(),
        };
        tx.execute(
            "INSERT INTO compose_meta(key,body) VALUES('settings',?1)",
            [settings.to_string()],
        )
        .map_err(error)?;
        if let Some(manifest) = manifest {
            tx.execute(
                "INSERT INTO compose_meta(key,body) VALUES('legacy-manifest',?1)",
                [manifest.to_string()],
            )
            .map_err(error)?;
        }
        let backup = if originals.is_empty() {
            None
        } else {
            Some(snapshot(&self.root, &originals)?)
        };
        tx.execute("INSERT INTO compose_meta(key,body) VALUES('legacy-import-v1',?1)",[json!({"importedAt":domain::now(),"backup":backup,"sourceFiles":originals.keys().collect::<Vec<_>>()}).to_string()]).map_err(error)?;
        tx.commit().map_err(error)
    }
}

fn check_kind(kind: &str) -> Result<(), String> {
    if ["opponents", "matches", "candidates", "fixtures"].contains(&kind) {
        Ok(())
    } else {
        Err("Unknown record collection".into())
    }
}
fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn required_text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Missing {key}"))
}
fn date(value: &Value) -> &str {
    value["lastMatchDate"]
        .as_str()
        .or_else(|| value["updatedAt"].as_str())
        .unwrap_or_default()
}

fn reject_link(path: &Path, root: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            let resolved = fs::canonicalize(path).map_err(error)?;
            if !resolved.starts_with(root) {
                return Err("Storage file escapes the profile directory".into());
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(error(e)),
    }
    Ok(())
}
fn read_legacy(
    root: &Path,
    name: &str,
    originals: &mut BTreeMap<String, Vec<u8>>,
) -> Result<Option<String>, String> {
    let path = Path::new(name);
    if path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
        || name.contains(['/', '\\', ':'])
    {
        return Err("Legacy filename escapes the profile directory".into());
    }
    let path = root.join(path);
    reject_link(&path, root)?;
    match fs::read(&path) {
        Ok(bytes) => {
            let text = String::from_utf8(bytes.clone()).map_err(error)?;
            originals.insert(name.into(), bytes);
            Ok(Some(text.trim_start_matches('\u{feff}').into()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(error(e)),
    }
}
fn snapshot(root: &Path, originals: &BTreeMap<String, Vec<u8>>) -> Result<String, String> {
    let base = root.join("compose-backups");
    reject_link(&base, root)?;
    fs::create_dir_all(&base).map_err(error)?;
    for suffix in 0..1000 {
        let folder = base.join(format!(
            "legacy-{}-{}-{suffix}",
            chrono::Utc::now().timestamp_millis(),
            std::process::id()
        ));
        match fs::create_dir(&folder) {
            Ok(()) => {
                for (name, bytes) in originals {
                    let mut out = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(folder.join(name))
                        .map_err(error)?;
                    out.write_all(bytes).map_err(error)?;
                    out.sync_all().map_err(error)?;
                }
                return Ok(folder.file_name().unwrap().to_string_lossy().into());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(error(e)),
        }
    }
    Err("Cannot allocate legacy backup directory".into())
}

fn decode_csv(content: &str, kind: &str) -> Result<Vec<Value>, String> {
    if content.trim().is_empty() {
        return Ok(vec![]);
    }
    let mut reader = csv::ReaderBuilder::new().from_reader(content.as_bytes());
    let headers = reader.headers().map_err(error)?.clone();
    reader
        .records()
        .map(|row| {
            let row = row.map_err(error)?;
            let record = headers
                .iter()
                .zip(row.iter())
                .map(|(k, v)| (k.into(), json!(v)))
                .collect::<Map<_, _>>();
            normalize_legacy(Value::Object(record), kind)
        })
        .collect()
}

fn decode_xml(content: &str, kind: &str) -> Result<Vec<Value>, String> {
    if content.trim().is_empty() {
        return Ok(vec![]);
    }
    let singular = if kind == "opponents" {
        "opponent"
    } else {
        "match"
    };
    let mut reader = Reader::from_str(content);
    reader.config_mut().trim_text(false);
    let mut stack = Vec::<(String, Map<String, Value>, String)>::new();
    let mut records = Vec::new();
    let mut root_seen = false;
    loop {
        match reader.read_event().map_err(error)? {
            Event::Start(start) => {
                let name = String::from_utf8_lossy(start.name().as_ref()).into_owned();
                if stack.is_empty() {
                    if root_seen || name != kind {
                        return Err("Invalid legacy XML root".into());
                    }
                    root_seen = true;
                }
                stack.push((name, Map::new(), String::new()));
            }
            Event::Empty(start) => {
                let name = String::from_utf8_lossy(start.name().as_ref()).into_owned();
                if let Some((_, fields, _)) = stack.last_mut() {
                    insert_xml(fields, name, json!(""));
                } else {
                    if root_seen || name != kind {
                        return Err("Invalid legacy XML root".into());
                    }
                    root_seen = true;
                }
            }
            Event::Text(text) => {
                if let Some((_, _, body)) = stack.last_mut() {
                    body.push_str(&text.decode().map_err(error)?);
                }
            }
            Event::CData(text) => {
                if let Some((_, _, body)) = stack.last_mut() {
                    body.push_str(&text.decode().map_err(error)?);
                }
            }
            Event::GeneralRef(reference) => {
                let name = reference.decode().map_err(error)?;
                let encoded = format!("&{name};");
                let decoded = quick_xml::escape::unescape(&encoded).map_err(error)?;
                if let Some((_, _, body)) = stack.last_mut() {
                    body.push_str(&decoded);
                }
            }
            Event::End(_) => {
                let (name, fields, text) = stack.pop().ok_or("Malformed legacy XML")?;
                let value = if fields.is_empty() {
                    json!(text.trim())
                } else {
                    Value::Object(fields)
                };
                if name == singular {
                    records.push(normalize_legacy(value, kind)?);
                } else if let Some((_, fields, _)) = stack.last_mut() {
                    insert_xml(fields, name, value);
                }
            }
            Event::DocType(_) => return Err("DTD is not supported in legacy storage".into()),
            Event::Eof => break,
            _ => (),
        }
    }
    if !stack.is_empty() || !root_seen {
        return Err("Truncated legacy XML".into());
    }
    Ok(records)
}
fn insert_xml(fields: &mut Map<String, Value>, name: String, value: Value) {
    if let Some(old) = fields.get_mut(&name) {
        if let Some(array) = old.as_array_mut() {
            array.push(value);
        } else {
            *old = json!([old.clone(), value]);
        }
    } else {
        fields.insert(name, value);
    }
}

fn normalize_legacy(mut value: Value, kind: &str) -> Result<Value, String> {
    let fields = value.as_object_mut().ok_or("Legacy row is not an object")?;
    for name in if kind == "opponents" {
        vec!["aliases", "notes", "strategyTags", "markers"]
    } else {
        vec!["notes"]
    } {
        let raw = fields.remove(name).unwrap_or(json!(""));
        let array = if let Some(text) = raw.as_str() {
            if text.trim().is_empty() {
                vec![]
            } else {
                let parsed: Value = serde_json::from_str(text).map_err(error)?;
                if let Some(a) = parsed.as_array() {
                    a.clone()
                } else {
                    vec![parsed]
                }
            }
        } else if let Some(items) = raw.get("item") {
            if let Some(a) = items.as_array() {
                a.clone()
            } else {
                vec![items.clone()]
            }
        } else {
            vec![]
        };
        fields.insert(name.into(), json!(array));
    }
    for name in [
        "mmrAtLastMatch",
        "confidenceScore",
        "encounters",
        "wins",
        "losses",
        "mmrBefore",
        "mmrAfter",
        "durationSeconds",
    ] {
        if let Some(raw) = fields.get(name).and_then(Value::as_str) {
            let text = raw.to_owned();
            if text.trim().is_empty() {
                if ["encounters", "wins", "losses"].contains(&name) {
                    fields.insert(name.into(), json!(0));
                } else {
                    fields.remove(name);
                }
            } else {
                let number = text
                    .trim()
                    .parse::<f64>()
                    .map_err(|_| format!("Invalid legacy number in {name}"))?;
                if !number.is_finite() {
                    return Err("Non-finite legacy number".into());
                }
                let value = if number >= 0.0 && number.fract() == 0.0 && number < (u64::MAX as f64)
                {
                    json!(number as u64)
                } else if number < 0.0 && number.fract() == 0.0 && number >= (i64::MIN as f64) {
                    json!(number as i64)
                } else {
                    json!(number)
                };
                fields.insert(name.into(), value);
            }
        }
    }
    if kind == "opponents" {
        for key in ["encounters", "wins", "losses"] {
            if !fields.contains_key(key) {
                fields.insert(key.into(), json!(0));
            }
        }
        if let Some(raw) = fields.get("raceProfiles").and_then(Value::as_str) {
            let raw = raw.to_owned();
            if raw.trim().is_empty() {
                fields.remove("raceProfiles");
            } else {
                fields.insert(
                    "raceProfiles".into(),
                    serde_json::from_str(&raw).map_err(error)?,
                );
            }
        }
        let normalized = domain::race(fields.get("race").unwrap_or(&Value::Null));
        fields.insert("race".into(), json!(normalized));
    } else {
        for name in ["playerRace", "opponentRace"] {
            let normalized = domain::race(fields.get(name).unwrap_or(&Value::Null));
            fields.insert(name.into(), json!(normalized));
        }
        let favorite = matches!(
            fields.get("favorite").and_then(Value::as_str),
            Some("true" | "1" | "yes")
        );
        fields.insert("favorite".into(), json!(favorite));
        if !["win", "loss", "unknown"].contains(
            &fields
                .get("result")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ) {
            fields.insert("result".into(), json!("unknown"));
        }
    }
    for name in [
        "revealedNickname",
        "battleTag",
        "league",
        "lastMatchDate",
        "map",
        "replayPath",
    ] {
        if fields
            .get(name)
            .and_then(Value::as_str)
            .is_some_and(|s| s.trim().is_empty())
        {
            fields.remove(name);
        }
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn comparable(mut value: Value) -> Value {
        match &mut value {
            Value::Object(fields) => {
                for child in fields.values_mut() {
                    *child = comparable(child.take());
                }
            }
            Value::Array(items) => {
                for item in items {
                    *item = comparable(item.take());
                }
            }
            Value::Number(number) => return json!(number.as_f64().unwrap()),
            _ => (),
        }
        value
    }
    #[test]
    fn native_import_matches_incumbent_csv_and_xml_codecs() {
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/storage-parity.json")).unwrap();
        for format in ["csv", "xml"] {
            let dir = folder();
            let case = &fixture[format];
            fs::write(
                dir.join(format!("opponents.{format}")),
                case["opponents"].as_str().unwrap(),
            )
            .unwrap();
            fs::write(
                dir.join(format!("matches.{format}")),
                case["matches"].as_str().unwrap(),
            )
            .unwrap();
            let store = Store::open(dir.clone()).unwrap();
            assert_eq!(
                comparable(json!(store.records("opponents").unwrap())),
                comparable(case["expectedOpponents"].clone()),
                "{format} opponents"
            );
            assert_eq!(
                comparable(json!(store.records("matches").unwrap())),
                comparable(case["expectedMatches"].clone()),
                "{format} matches"
            );
            assert_eq!(
                store.records("opponents").unwrap()[0]["encounters"].as_u64(),
                Some(2)
            );
            assert_eq!(
                store.records("opponents").unwrap()[0]["wins"].as_u64(),
                Some(1)
            );
            drop(store);
            fs::remove_dir_all(dir).unwrap();
        }
    }
    fn folder() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "compose-storage-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn import_preserves_original_and_unknown_data() {
        let dir = folder();
        let csv = "id,nickname,race,notes,aliases,encounters,wins,losses,future\no1,Тест,Terran,[],[],2,1,0,retained\n";
        fs::write(dir.join("opponents.csv"), csv).unwrap();
        let store = Store::open(dir.clone()).unwrap();
        let record = store.records("opponents").unwrap().pop().unwrap();
        assert_eq!(record["future"], "retained");
        assert_eq!(record["nickname"], "Тест");
        store
            .handle("addOpponentNote", json!({"opponentId":"o1","note":"hello"}))
            .unwrap();
        assert_eq!(fs::read_to_string(dir.join("opponents.csv")).unwrap(), csv);
        drop(store);
        let reopened = Store::open(dir.clone()).unwrap();
        assert_eq!(
            reopened.records("opponents").unwrap()[0]["notes"],
            json!(["hello"])
        );
        assert_eq!(
            fs::read_dir(dir.join("compose-backups")).unwrap().count(),
            1
        );
        drop(reopened);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn xml_entities_nested_and_unknown_fields() {
        let xml = "<opponents><opponent><id>x</id><nickname>A &amp; B</nickname><race>Z</race><notes><item>one</item><item>two</item></notes><future><nested>value</nested></future></opponent></opponents>";
        let result = decode_xml(xml, "opponents").unwrap();
        assert_eq!(result[0]["nickname"], "A & B");
        assert_eq!(result[0]["notes"], json!(["one", "two"]));
        assert_eq!(result[0]["future"]["nested"], "value");
    }
    #[test]
    fn invalid_import_rolls_back_and_retries() {
        let dir = folder();
        fs::write(dir.join("opponents.csv"), "id,nickname\nx,one\nx,two\n").unwrap();
        assert!(Store::open(dir.clone()).is_err());
        fs::write(dir.join("opponents.csv"), "id,nickname\nx,one\n").unwrap();
        let store = Store::open(dir.clone()).unwrap();
        assert_eq!(store.records("opponents").unwrap().len(), 1);
        drop(store);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn manifest_cannot_escape_profile() {
        let dir = folder();
        fs::write(dir.join("storage-manifest.json"),json!({"appName":"SC2 Assistant","schemaVersion":1,"storageFormat":"csv","files":{"opponents":"../outside.csv"}}).to_string()).unwrap();
        assert!(
            Store::open(dir.clone())
                .unwrap_err_message()
                .contains("escapes")
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn snapshot_replacement_is_atomic_on_bad_record() {
        let dir = folder();
        let store = Store::open(dir.clone()).unwrap();
        store
            .save_record("opponents", json!({"id":"old","nickname":"original"}))
            .unwrap();
        let failed = store.replace_records_atomic(
            &json!({"opponents":[{"id":"new"}],"matches":[{"missing":"id"}],"candidates":[]}),
        );
        assert!(failed.is_err());
        assert_eq!(store.records("opponents").unwrap()[0]["id"], "old");
        drop(store);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn clear_does_not_reimport_originals() {
        let dir = folder();
        fs::write(dir.join("opponents.csv"), "id,nickname\no1,old\n").unwrap();
        let store = Store::open(dir.clone()).unwrap();
        store.handle("clearStats", json!({})).unwrap();
        drop(store);
        let store = Store::open(dir.clone()).unwrap();
        assert!(store.records("opponents").unwrap().is_empty());
        assert_eq!(
            fs::read_to_string(dir.join("opponents.csv")).unwrap(),
            "id,nickname\no1,old\n"
        );
        drop(store);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn settings_import_is_non_destructive_and_lossless() {
        let dir = folder();
        let original=json!({"language":"ru","voice":{"enabled":true,"futureVoiceSetting":7},"futureSettings":{"preserved":true},"updatedAt":"2026-01-01T00:00:00Z"}).to_string();
        fs::write(dir.join("settings.json"), &original).unwrap();
        let store = Store::open(dir.clone()).unwrap();
        let saved = store
            .save_settings(json!({"voice":{"volume":0.3}}))
            .unwrap();
        assert_eq!(saved["futureSettings"]["preserved"], true);
        assert_eq!(saved["voice"]["futureVoiceSetting"], 7);
        assert_eq!(saved["voice"]["enabled"], true);
        assert_eq!(
            fs::read_to_string(dir.join("settings.json")).unwrap(),
            original
        );
        drop(store);
        fs::remove_dir_all(dir).unwrap();
    }
    trait ErrorMessage {
        fn unwrap_err_message(self) -> String;
    }
    impl ErrorMessage for Result<Store, String> {
        fn unwrap_err_message(self) -> String {
            match self {
                Err(e) => e,
                Ok(_) => panic!("expected error"),
            }
        }
    }
}
