//! JSON-domain transformations preserve fields added by older/newer application versions.
use chrono::{SecondsFormat, Utc};
use serde_json::{Value, json};

pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn race(value: &Value) -> &'static str {
    match value
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_lowercase()
        .as_str()
    {
        "terran" | "terr" | "t" => "Terran",
        "zerg" | "z" => "Zerg",
        "protoss" | "prot" | "p" => "Protoss",
        "random" | "r" => "Random",
        _ => "Unknown",
    }
}

pub fn default_settings() -> Value {
    json!({"language":"en","region":"unknown","defaultRace":"Unknown","pollingIntervalMs":1000,
        "externalSourcesEnabled":true,"externalSources":{"sc2Pulse":true,"localFixture":true},
        "overlayEnabled":false,"overlayPosition":"top-right","overlayPlacementMode":false,
        "voice":{"enabled":false,"provider":"piper","voiceEn":"en_US-glados","volume":0.7,
        "speakingRate":1,"announceOnLaunch":true,"announceOpponentCard":true,"announceMatchSummary":false},"updatedAt":now()})
}

#[cfg(test)]
mod coordinate_regression {
    use super::*;
    #[test]
    fn rounded_custom_coordinates_are_restorable_integers() {
        let settings = update_settings(
            &default_settings(),
            &json!({"overlayCustomPosition":{"x":-5.5,"y":100.5}}),
        )
        .unwrap();
        assert_eq!(settings["overlayCustomPosition"]["x"].as_i64(), Some(-5));
        assert_eq!(settings["overlayCustomPosition"]["y"].as_i64(), Some(101));
    }
}

pub fn update_settings(current: &Value, input: &Value) -> Result<Value, String> {
    let fields = input.as_object().ok_or("Settings must be an object")?;
    let mut result = current.clone();
    for (key, value) in fields {
        if key == "updatedAt" {
            continue;
        }
        match key.as_str() {
            "playerName" | "replayDirectory" => {
                if value.is_null() {
                    continue;
                }
                let normalized = value.as_str().ok_or("Expected text setting")?.trim();
                if normalized.is_empty() {
                    result.as_object_mut().unwrap().remove(key);
                } else {
                    result[key] = json!(normalized);
                }
            }
            "language" => result[key] = json!(if value == "ru" { "ru" } else { "en" }),
            "region" => {
                let region = value
                    .as_str()
                    .ok_or("Region must be text")?
                    .trim()
                    .to_lowercase();
                result[key] = json!(if ["us", "eu", "kr", "cn"].contains(&region.as_str()) {
                    region.as_str()
                } else {
                    "unknown"
                });
            }
            "defaultRace" => result[key] = json!(race(value)),
            "pollingIntervalMs" => {
                result[key] = json!(
                    value
                        .as_f64()
                        .ok_or("Polling interval must be a number")?
                        .round()
                        .clamp(500.0, 10_000.0) as u64
                )
            }
            "overlayEnabled" | "overlayPlacementMode" | "externalSourcesEnabled" => {
                result[key] = json!(value.as_bool().ok_or("Expected boolean setting")?);
            }
            "overlayPosition" => {
                let position = value.as_str().ok_or("Position must be text")?;
                result[key] = json!(match position {
                    "bottom-left" => "bottom-1",
                    "bottom-center" => "bottom-4",
                    "bottom-right" => "bottom-6",
                    "top-left" | "top-center" | "top-right" | "middle-left" | "middle-right"
                    | "bottom-1" | "bottom-2" | "bottom-3" | "bottom-4" | "bottom-5"
                    | "bottom-6" => position,
                    _ => "top-right",
                });
            }
            "overlayCustomPosition" => {
                if value.is_null() {
                    result.as_object_mut().unwrap().remove(key);
                } else {
                    let x = value["x"].as_f64().ok_or("Position x must be a number")?;
                    let y = value["y"].as_f64().ok_or("Position y must be a number")?;
                    // Match JavaScript Math.round, including negative half coordinates.
                    result[key] =
                        json!({"x":(x + 0.5).floor() as i64,"y":(y + 0.5).floor() as i64});
                }
            }
            "externalSources" | "voice" => {
                for (name, setting) in value.as_object().ok_or("Expected nested settings object")? {
                    let target = &mut result[key][name];
                    match (key.as_str(), name.as_str()) {
                        ("voice", "volume") => {
                            *target = json!(
                                setting
                                    .as_f64()
                                    .ok_or("Volume must be numeric")?
                                    .clamp(0.0, 1.0)
                            )
                        }
                        ("voice", "speakingRate") => {
                            *target = json!(
                                setting
                                    .as_f64()
                                    .ok_or("Rate must be numeric")?
                                    .clamp(0.5, 2.0)
                            )
                        }
                        ("voice", "provider") => {
                            *target = json!(if setting == "off" { "off" } else { "piper" })
                        }
                        ("voice", "voiceEn") => {
                            if ["en_US-glados", "en_US-amy-medium"]
                                .contains(&setting.as_str().unwrap_or_default())
                            {
                                *target = setting.clone();
                            }
                        }
                        (
                            _,
                            "enabled"
                            | "announceOnLaunch"
                            | "announceOpponentCard"
                            | "announceMatchSummary"
                            | "sc2Pulse"
                            | "localFixture",
                        ) => *target = json!(setting.as_bool().ok_or("Expected boolean setting")?),
                        _ => *target = setting.clone(),
                    }
                }
            }
            _ => result[key] = value.clone(),
        }
    }
    result["updatedAt"] = json!(now());
    Ok(result)
}

pub fn normalize_settings(value: &Value) -> Result<Value, String> {
    let mut settings = update_settings(&default_settings(), value)?;
    if let Some(date) = value.get("updatedAt") {
        settings["updatedAt"] = date.clone();
    }
    Ok(settings)
}

fn strings(value: &Value, width: Option<usize>, count: Option<usize>) -> Result<Value, String> {
    let mut items = Vec::<String>::new();
    for item in value.as_array().ok_or("Expected text array")? {
        let item = item.as_str().ok_or("Array entries must be text")?;
        let shortened = item
            .chars()
            .take(width.unwrap_or(usize::MAX))
            .collect::<String>();
        let trimmed = shortened.trim().to_string();
        if !trimmed.is_empty() && !items.contains(&trimmed) {
            items.push(trimmed);
        }
    }
    items.truncate(count.unwrap_or(usize::MAX));
    Ok(json!(items))
}

pub fn edit_opponent(mut opponent: Value, input: &Value) -> Result<Value, String> {
    let fields = input.as_object().ok_or("Profile must be an object")?;
    let mut update_profile = false;
    for (key, value) in fields {
        match key.as_str() {
            "opponentId" => (),
            "nickname" | "battleTag" | "league" => {
                let text = value.as_str().unwrap_or_default().trim();
                if !text.is_empty() {
                    opponent[key] = json!(text);
                } else if key != "nickname" {
                    opponent.as_object_mut().unwrap().remove(key);
                }
                update_profile |= key == "league";
            }
            "race" => {
                if !value.is_null() && value.as_str().is_some_and(|s| !s.is_empty()) {
                    opponent[key] = json!(race(value));
                }
                update_profile = true;
            }
            "aliases" => {
                if !value.is_null() {
                    opponent[key] = strings(value, None, None)?;
                }
            }
            "strategyTags" => {
                if !value.is_null() {
                    opponent[key] = strings(value, Some(16), Some(12))?;
                }
                update_profile = true;
            }
            "markers" => {
                let mut valid = Vec::new();
                if let Some(markers) = value.as_array() {
                    for marker in markers {
                        if ["skull", "heart", "blocked"]
                            .contains(&marker.as_str().unwrap_or_default())
                            && !valid.contains(marker)
                        {
                            valid.push(marker.clone());
                        }
                    }
                } else if !value.is_null() {
                    return Err("Markers must be an array".into());
                }
                opponent[key] = json!(valid);
            }
            "confidenceScore" | "mmrAtLastMatch" => {
                if value.is_null() {
                    opponent.as_object_mut().unwrap().remove(key);
                } else {
                    let number = value.as_f64().ok_or("Expected finite profile number")?;
                    opponent[key] = json!(if key == "confidenceScore" {
                        number.clamp(0.0, 1.0)
                    } else {
                        number
                    });
                }
                update_profile = true;
            }
            _ => return Err(format!("Unsupported profile field: {key}")),
        }
    }
    let stamp = now();
    if update_profile {
        let target = race(&opponent["race"]);
        if !opponent["raceProfiles"].is_object() {
            opponent["raceProfiles"] = json!({});
        }
        if !opponent["raceProfiles"][target].is_object() {
            opponent["raceProfiles"][target] = json!({});
        }
        for key in [
            "mmrAtLastMatch",
            "league",
            "strategyTags",
            "confidenceScore",
        ] {
            let value = opponent.get(key).cloned();
            if let Some(value) = value {
                opponent["raceProfiles"][target][key] = value;
            } else {
                opponent["raceProfiles"][target]
                    .as_object_mut()
                    .unwrap()
                    .remove(key);
            }
        }
        opponent["raceProfiles"][target]["updatedAt"] = json!(stamp);
    }
    opponent["updatedAt"] = json!(stamp);
    Ok(opponent)
}

pub fn change_note(mut opponent: Value, input: &Value, remove: bool) -> Result<Value, String> {
    let target = race(&input["race"]);
    let mut notes = if target == "Unknown" {
        opponent["notes"].as_array().cloned().unwrap_or_default()
    } else {
        opponent["raceProfiles"][target]["notes"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    };
    if remove {
        let Some(index) = input["noteIndex"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
        else {
            return Ok(opponent);
        };
        if index >= notes.len() {
            return Ok(opponent);
        }
        notes.remove(index);
    } else {
        let note = input["note"]
            .as_str()
            .ok_or("Note must be text")?
            .trim()
            .chars()
            .take(96)
            .collect::<String>();
        if note.is_empty() {
            return Ok(opponent);
        }
        notes.push(json!(note));
        if notes.len() > 5 {
            notes.drain(0..notes.len() - 5);
        }
    }
    let stamp = now();
    if target == "Unknown" {
        opponent["notes"] = json!(notes);
    } else {
        if !opponent["raceProfiles"].is_object() {
            opponent["raceProfiles"] = json!({});
        }
        if !opponent["raceProfiles"][target].is_object() {
            opponent["raceProfiles"][target] = json!({});
        }
        opponent["raceProfiles"][target]["notes"] = json!(notes);
        opponent["raceProfiles"][target]["updatedAt"] = json!(stamp);
    }
    opponent["updatedAt"] = json!(stamp);
    Ok(opponent)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn comparable(mut value: Value) -> Value {
        match &mut value {
            Value::Object(fields) => {
                fields.remove("updatedAt");
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
    fn profile_updates_match_incumbent_typescript() {
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/domain-parity.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let actual = edit_opponent(fixture["opponent"].clone(), &case["input"]).unwrap();
            assert_eq!(
                comparable(actual),
                comparable(case["expected"].clone()),
                "input: {}",
                case["input"]
            );
        }
    }
    #[test]
    fn settings_update_matches_incumbent_typescript() {
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/domain-parity.json")).unwrap();
        let case = &fixture["settings"];
        assert_eq!(
            comparable(update_settings(&case["current"], &case["input"]).unwrap()),
            comparable(case["expected"].clone())
        );
    }
    #[test]
    fn invalid_note_removal_is_unchanged() {
        let original = json!({"id":"o","notes":["keep"],"updatedAt":"original"});
        for index in [json!(-1), json!(1.5), json!(100), Value::Null] {
            assert_eq!(
                change_note(original.clone(), &json!({"noteIndex":index}), true).unwrap(),
                original
            );
        }
    }
    #[test]
    fn settings_limits_and_nested_preservation() {
        let mut current = default_settings();
        current["future"] = json!({"kept":true});
        let updated = update_settings(
            &current,
            &json!({"pollingIntervalMs":40,"voice":{"volume":4},"overlayPosition":"bottom-center"}),
        )
        .unwrap();
        assert_eq!(updated["pollingIntervalMs"], 500);
        assert_eq!(updated["voice"]["volume"], 1.0);
        assert_eq!(updated["voice"]["announceOnLaunch"], true);
        assert_eq!(updated["future"]["kept"], true);
        assert_eq!(updated["overlayPosition"], "bottom-4");
    }
    #[test]
    fn notes_are_scoped_to_race() {
        let original = json!({"id":"o","notes":["global"],"raceProfiles":{"Terran":{"notes":["old"],"custom":1}}});
        let result = change_note(original, &json!({"race":"t","note":"new"}), false).unwrap();
        assert_eq!(result["notes"], json!(["global"]));
        assert_eq!(
            result["raceProfiles"]["Terran"]["notes"],
            json!(["old", "new"])
        );
        assert_eq!(result["raceProfiles"]["Terran"]["custom"], 1);
    }
}
