//! Browser-source settings are separate from the optional desktop card.
use crate::storage::Store;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const DEFAULT_PORT: u16 = 8766;
pub const POSITIONS: &[&str] = &[
    "top-left",
    "top-center",
    "top-right",
    "middle-left",
    "middle-right",
    "bottom-1",
    "bottom-2",
    "bottom-3",
    "bottom-4",
    "bottom-5",
    "bottom-6",
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ObsConfig {
    pub enabled: bool,
    pub position: String,
    pub width: u32,
    pub height: u32,
}

impl Default for ObsConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            position: "top-right".into(),
            width: 1920,
            height: 1080,
        }
    }
}
impl ObsConfig {
    pub fn validate(&self) -> Result<(), String> {
        if !POSITIONS.contains(&self.position.as_str()) {
            return Err("Choose a supported OBS widget position".into());
        }
        if !(640..=7680).contains(&self.width) || !(360..=4320).contains(&self.height) {
            return Err("OBS canvas must be 640–7680 by 360–4320 pixels".into());
        }
        Ok(())
    }
    pub fn from_settings(settings: &Value) -> Result<Self, String> {
        let value = match settings.get("obsOverlay") {
            Some(value) => serde_json::from_value(value.clone())
                .map_err(|_| "Invalid saved OBS settings".to_string())?,
            None => Self::default(),
        };
        value.validate()?;
        Ok(value)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfigureInput {
    enabled: bool,
    position: String,
    width: Option<u32>,
    height: Option<u32>,
}

pub fn configure(store: &Store, input: Value) -> Result<ObsConfig, String> {
    let request: ConfigureInput =
        serde_json::from_value(input).map_err(|_| "Invalid OBS settings request".to_string())?;
    let previous = store.settings()?;
    let current = ObsConfig::from_settings(&previous)?;
    let next = ObsConfig {
        enabled: request.enabled,
        position: request.position,
        width: request.width.unwrap_or(current.width),
        height: request.height.unwrap_or(current.height),
    };
    next.validate()?;
    let mut value = previous
        .get("obsOverlay")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or(json!({}));
    for (key, field) in serde_json::to_value(&next).unwrap().as_object().unwrap() {
        value[key] = field.clone();
    }
    store.save_settings(json!({"obsOverlay":value}))?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn obs_settings_do_not_enable_or_reposition_desktop_card_and_survive_restart() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path().to_path_buf()).unwrap();
        store.save_settings(json!({"overlayEnabled":false,"overlayPosition":"bottom-2","obsOverlay":{"future":42}})).unwrap();
        configure(
            &store,
            json!({"enabled":true,"position":"top-left","width":2560,"height":1440}),
        )
        .unwrap();
        let saved = store.settings().unwrap();
        assert_eq!(saved["overlayEnabled"], false);
        assert_eq!(saved["overlayPosition"], "bottom-2");
        assert_eq!(saved["obsOverlay"]["future"], 42);
        drop(store);
        let reopened = Store::open(root.path().to_path_buf()).unwrap();
        let config = ObsConfig::from_settings(&reopened.settings().unwrap()).unwrap();
        assert!(config.enabled);
        assert_eq!(config.width, 2560);
    }
    #[test]
    fn invalid_obs_requests_leave_previous_settings_unchanged() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path().to_path_buf()).unwrap();
        let before = store.settings().unwrap();
        for value in [
            json!({"enabled":"yes","position":"top-left"}),
            json!({"enabled":true,"position":"outside"}),
            json!({"enabled":true,"position":"top-left","width":100000}),
            json!({"enabled":true,"position":"top-left","height":0}),
            json!({"enabled":true,"position":"top-left","shell":"bad"}),
        ] {
            assert!(configure(&store, value).is_err());
        }
        assert_eq!(store.settings().unwrap(), before);
    }
}
