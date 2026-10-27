//! Retail SC2 presentation state, inferred only from fresh bounded game/UI samples.
use serde_json::Value;
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct PhaseTracker {
    clock: Option<ClockSample>,
}
struct ClockSample {
    identity: String,
    timer: f64,
    first: Instant,
    last: Instant,
    count: u32,
}
impl PhaseTracker {
    pub fn reset(&mut self) {
        self.clock = None;
    }
    pub fn observe(&mut self, game: &Value, ui: &Value, now: Instant) -> &'static str {
        let phase = classify(game, ui);
        if phase != "game" {
            self.reset();
            return phase;
        }
        let Some(timer) = game["displayTime"]
            .as_f64()
            .filter(|n| n.is_finite() && *n > 0.)
        else {
            self.reset();
            return "game";
        };
        let identity = serde_json::to_string(&(
            game["isReplay"].clone(),
            game["players"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p["name"].clone())
                .collect::<Vec<_>>(),
        ))
        .unwrap();
        if let Some(previous) = self.clock.as_mut()
            && previous.identity == identity
            && (timer - previous.timer).abs() <= 0.001
            && now
                .checked_duration_since(previous.last)
                .is_some_and(|gap| gap <= Duration::from_secs(3))
        {
            previous.last = now;
            previous.count = previous.count.saturating_add(1);
            if previous.count >= 4 && now.duration_since(previous.first) >= Duration::from_secs(3) {
                return "pause";
            }
            return "game";
        }
        self.clock = Some(ClockSample {
            identity,
            timer,
            first: now,
            last: now,
            count: 1,
        });
        "game"
    }
}

pub fn classify(game: &Value, ui: &Value) -> &'static str {
    let Some(players) = game["players"]
        .as_array()
        .filter(|p| p.len() <= 32 && p.iter().all(|p| p["name"].is_string()))
    else {
        return "unknown";
    };
    let Some(screens) = ui["activeScreens"].as_array().filter(|s| {
        s.len() <= 128
            && s.iter()
                .all(|s| s.as_str().is_some_and(|v| v.len() <= 1024))
    }) else {
        return "unknown";
    };
    if !game["isReplay"].is_boolean() || !game["displayTime"].as_f64().is_some_and(f64::is_finite) {
        return "unknown";
    }
    let names: Vec<_> = screens
        .iter()
        .flat_map(|s| s.as_str().unwrap().split('/'))
        .filter(|s| !s.is_empty())
        .collect();
    if names.contains(&"ScreenLoading") {
        "loading"
    } else if names.contains(&"ScreenScore")
        || [
            "ScreenMultiplayer",
            "ScreenCustom",
            "ScreenHome",
            "ScreenReplay",
        ]
        .iter()
        .any(|s| names.contains(s))
    {
        "menu"
    } else if !players.is_empty() && names.is_empty() {
        "game"
    } else {
        "unknown"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn game() -> Value {
        json!({"players":[{"name":"One"},{"name":"Two"}],"displayTime":45,"isReplay":false})
    }
    #[test]
    fn named_screens_take_precedence_over_old_players_and_replay_uses_game() {
        let game = game();
        assert_eq!(
            classify(
                &game,
                &json!({"activeScreens":["ScreenRoot/ScreenLoading"]})
            ),
            "loading"
        );
        for screen in [
            "ScreenScore",
            "ScreenMultiplayer",
            "ScreenHome",
            "ScreenCustom",
            "ScreenReplay",
        ] {
            assert_eq!(classify(&game, &json!({"activeScreens":[screen]})), "menu");
        }
        assert_eq!(
            classify(&game, &json!({"activeScreens":["UnknownScreen"]})),
            "unknown"
        );
        let mut replay = game;
        replay["isReplay"] = json!(true);
        assert_eq!(classify(&replay, &json!({"activeScreens":[]})), "game");
        assert_eq!(classify(&replay, &json!({"activeScreens":[12]})), "unknown");
    }
    #[test]
    fn pause_needs_four_fresh_samples_three_seconds_and_same_identity() {
        let mut tracker = PhaseTracker::default();
        let start = Instant::now();
        let mut game = game();
        let ui = json!({"activeScreens":[]});
        for i in 0..3 {
            assert_eq!(
                tracker.observe(&game, &ui, start + Duration::from_secs(i)),
                "game"
            );
        }
        assert_eq!(
            tracker.observe(&game, &ui, start + Duration::from_secs(3)),
            "pause"
        );
        game["displayTime"] = json!(46);
        assert_eq!(
            tracker.observe(&game, &ui, start + Duration::from_secs(4)),
            "game"
        );
        assert_eq!(
            tracker.observe(&game, &ui, start + Duration::from_secs(8)),
            "game"
        );
        game["players"][0]["name"] = json!("New");
        assert_eq!(
            tracker.observe(&game, &ui, start + Duration::from_secs(9)),
            "game"
        );
        assert_eq!(
            tracker.observe(
                &game,
                &json!({"activeScreens":["ScreenLoading"]}),
                start + Duration::from_secs(10)
            ),
            "loading"
        );
        assert_eq!(
            tracker.observe(&game, &ui, start + Duration::from_secs(11)),
            "game"
        );
    }

    #[test]
    fn generic_settings_cannot_bypass_smart_overlay_revision_or_media_validation() {
        let root = tempfile::tempdir().unwrap();
        let store = crate::storage::Store::open(root.path().to_path_buf()).unwrap();
        let before = store.settings().unwrap();
        assert!(
            store
                .handle(
                    "saveSettings",
                    json!({"obsOverlay":{"smartRevision":10,"smartApplied":{"enabled":true}}})
                )
                .is_err()
        );
        assert_eq!(store.settings().unwrap(), before);
    }
}
