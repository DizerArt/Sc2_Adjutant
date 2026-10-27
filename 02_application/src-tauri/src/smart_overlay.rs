//! Portable, profile-owned image versions and optimistic draft/apply configuration.
use crate::storage::Store;
use image::{ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
};

const MAX_IMAGE: usize = 16 * 1024 * 1024;
pub const MAX_GIF: usize = 128 * 1024 * 1024;
const MAX_PROFILE: u64 = 512 * 1024 * 1024;
const MODES: [&str; 4] = ["menu", "loading", "game", "pause"];
struct LimitedBytes(Vec<u8>);
impl Write for LimitedBytes {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > MAX_GIF {
            return Err(std::io::Error::other("Normalized GIF exceeds 128 MiB"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageRef {
    pub id: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub animated: bool,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poster_url: Option<String>,
    pub name: String,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mode {
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<ImageRef>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Appearance {
    pub enabled: bool,
    pub modes: BTreeMap<String, Mode>,
    #[serde(default, rename = "menuLayout")]
    pub menu_layout: MenuLayout,
}
pub const POSTMATCH_WIDGETS: [&str; 4] = ["fountain", "battle_map", "armies", "heroes"];
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GridWidget {
    pub enabled: bool,
    pub x: u8,
    pub y: u8,
    pub w: u8,
    pub h: u8,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MenuLayout {
    pub columns: u8,
    pub rows: u8,
    pub widgets: BTreeMap<String, GridWidget>,
}
impl Default for MenuLayout {
    fn default() -> Self {
        Self {
            columns: 32,
            rows: 64,
            widgets: POSTMATCH_WIDGETS
                .iter()
                .enumerate()
                .map(|(i, k)| {
                    (
                        k.to_string(),
                        GridWidget {
                            enabled: false,
                            x: (i % 2) as u8 * 16,
                            y: (i / 2) as u8 * 32,
                            w: 16,
                            h: 32,
                        },
                    )
                })
                .collect(),
        }
    }
}
impl MenuLayout {
    pub fn validate(&self) -> Result<(), String> {
        if self.columns != 32
            || self.rows != 64
            || self.widgets.len() != 4
            || POSTMATCH_WIDGETS
                .iter()
                .any(|k| !self.widgets.contains_key(*k))
            || self.widgets.values().any(|w| {
                w.w == 0
                    || w.h == 0
                    || u16::from(w.x) + u16::from(w.w) > 32
                    || u16::from(w.y) + u16::from(w.h) > 64
            })
        {
            return Err("Menu widgets must fit the 32 column by 64 row grid".into());
        }
        Ok(())
    }
    pub fn any_enabled(&self) -> bool {
        self.widgets.values().any(|w| w.enabled)
    }
}
impl Default for Appearance {
    fn default() -> Self {
        Self {
            enabled: false,
            menu_layout: MenuLayout::default(),
            modes: MODES
                .iter()
                .map(|m| {
                    (
                        m.to_string(),
                        Mode {
                            enabled: true,
                            image: None,
                        },
                    )
                })
                .collect(),
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub revision: u64,
    pub applied_revision: u64,
    pub draft: Appearance,
    pub applied: Appearance,
}

fn manifest(settings: &Value) -> Result<BTreeMap<String, ImageRef>, String> {
    serde_json::from_value(
        settings["obsOverlay"]
            .get("smartMedia")
            .cloned()
            .unwrap_or(json!({})),
    )
    .map_err(|_| "Invalid saved image registry".into())
}
fn validate_ref(image: &ImageRef) -> Result<(), String> {
    if uuid::Uuid::parse_str(&image.id).is_err()
        || image.id.len() != 36
        || image.url != format!("/widgets/media/{}", image.id)
        || image.poster_url
            != image
                .animated
                .then(|| format!("/widgets/media/{}/poster", image.id))
        || !["image/png", "image/jpeg", "image/gif"].contains(&image.mime.as_str())
        || image.animated != (image.mime == "image/gif")
        || image.width == 0
        || image.height == 0
        || image.width > 4096
        || image.height > 4096
        || u64::from(image.width) * u64::from(image.height) > 16_000_000
        || image.name.chars().count() > 160
    {
        return Err("Invalid image reference".into());
    }
    Ok(())
}
fn validate(appearance: &Appearance, registry: &BTreeMap<String, ImageRef>) -> Result<(), String> {
    appearance.menu_layout.validate()?;
    if appearance.modes.len() != 4 || MODES.iter().any(|m| !appearance.modes.contains_key(*m)) {
        return Err("All four overlay modes are required".into());
    }
    for mode in appearance.modes.values() {
        if let Some(image) = &mode.image {
            validate_ref(image)?;
            if registry.get(&image.id) != Some(image) {
                return Err("Choose a registered overlay image".into());
            }
        }
    }
    Ok(())
}
pub fn from_settings(settings: &Value) -> Result<Settings, String> {
    let obs = &settings["obsOverlay"];
    let draft = obs
        .get("smartDraft")
        .map(|v| serde_json::from_value(v.clone()))
        .transpose()
        .map_err(|_| "Invalid overlay draft")?
        .unwrap_or_default();
    let applied = obs
        .get("smartApplied")
        .map(|v| serde_json::from_value(v.clone()))
        .transpose()
        .map_err(|_| "Invalid applied overlay")?
        .unwrap_or_default();
    let registry = manifest(settings)?;
    validate(&draft, &registry)?;
    validate(&applied, &registry)?;
    let revision = obs
        .get("smartRevision")
        .map(|v| v.as_u64().ok_or("Invalid overlay revision"))
        .transpose()?
        .unwrap_or(0);
    let applied_revision = obs
        .get("smartAppliedRevision")
        .map(|v| v.as_u64().ok_or("Invalid applied revision"))
        .transpose()?
        .unwrap_or(0);
    if applied_revision > revision {
        return Err("Invalid overlay revisions".into());
    }
    Ok(Settings {
        revision,
        applied_revision,
        draft,
        applied,
    })
}
pub fn get(store: &Store) -> Result<Value, String> {
    serde_json::to_value(from_settings(&store.settings()?)?).map_err(|e| e.to_string())
}
fn check_revision(current: &Settings, revision: u64) -> Result<u64, String> {
    if current.revision != revision {
        return Err("Overlay settings changed in another window; reload before saving".into());
    }
    revision
        .checked_add(1)
        .ok_or("Overlay revision limit reached".into())
}
fn persist(
    store: &Store,
    previous: &Value,
    current: &Settings,
    registry: Option<&BTreeMap<String, ImageRef>>,
) -> Result<Value, String> {
    let mut obs = previous
        .get("obsOverlay")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or(json!({}));
    obs["smartRevision"] = json!(current.revision);
    obs["smartAppliedRevision"] = json!(current.applied_revision);
    obs["smartDraft"] = json!(current.draft);
    obs["smartApplied"] = json!(current.applied);
    if let Some(registry) = registry {
        obs["smartMedia"] = json!(registry);
    }
    store.save_settings(json!({"obsOverlay":obs}))?;
    serde_json::to_value(current).map_err(|e| e.to_string())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveInput {
    revision: u64,
    enabled: bool,
    modes: BTreeMap<String, Mode>,
    #[serde(default, rename = "menuLayout")]
    menu_layout: Option<MenuLayout>,
}
pub fn save_draft(store: &Store, input: Value) -> Result<Value, String> {
    let request: SaveInput =
        serde_json::from_value(input).map_err(|_| "Invalid overlay draft request")?;
    let previous = store.settings()?;
    let mut current = from_settings(&previous)?;
    current.revision = check_revision(&current, request.revision)?;
    let draft = Appearance {
        enabled: request.enabled,
        modes: request.modes,
        menu_layout: request
            .menu_layout
            .unwrap_or_else(|| current.draft.menu_layout.clone()),
    };
    validate(&draft, &manifest(&previous)?)?;
    current.draft = draft;
    persist(store, &previous, &current, None)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Revision {
    revision: u64,
}
pub fn apply(store: &Store, input: Value) -> Result<Value, String> {
    let request: Revision =
        serde_json::from_value(input).map_err(|_| "Invalid overlay apply request")?;
    let previous = store.settings()?;
    let mut current = from_settings(&previous)?;
    current.revision = check_revision(&current, request.revision)?;
    current.applied = current.draft.clone();
    current.applied_revision = current.revision;
    persist(store, &previous, &current, None)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChooseInput {
    pub revision: u64,
    pub mode: String,
}
pub fn validate_choice(store: &Store, input: &ChooseInput) -> Result<(), String> {
    if !MODES.contains(&input.mode.as_str()) {
        return Err("Choose an overlay mode".into());
    }
    check_revision(&from_settings(&store.settings()?)?, input.revision)?;
    Ok(())
}
pub fn import_path(store: &Store, input: &ChooseInput, path: &Path) -> Result<Value, String> {
    validate_choice(store, input)?;
    let file = fs::File::open(path).map_err(|_| "Cannot read selected image")?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Choose an image file".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_GIF as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("Image");
    import_bytes(store, input, &bytes, name)
}
pub fn import_selection(
    store: &Store,
    input: &ChooseInput,
    path: Option<&Path>,
) -> Result<Value, String> {
    match path {
        Some(path) => import_path(store, input, path),
        None => Ok(Value::Null),
    }
}
fn media_root(store: &Store, create: bool) -> Result<PathBuf, String> {
    let expected = store.root().join("overlay-media");
    if create {
        fs::create_dir_all(&expected).map_err(|e| e.to_string())?;
    }
    let root = expected.canonicalize().map_err(|e| e.to_string())?;
    if root != expected {
        return Err("Overlay image directory must be inside this profile".into());
    }
    Ok(root)
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}
fn validate_pixels(width: u32, height: u32) -> Result<(), String> {
    if width == 0
        || height == 0
        || width > 4096
        || height > 4096
        || u64::from(width) * u64::from(height) > 16_000_000
    {
        return Err("Image must fit 4096 pixels per side and 16 million pixels".into());
    }
    Ok(())
}
/// Content is decoded and copied into a new immutable version; source bytes are never modified.
pub fn import_bytes(
    store: &Store,
    input: &ChooseInput,
    bytes: &[u8],
    name: &str,
) -> Result<Value, String> {
    validate_choice(store, input)?;
    if bytes.len() > MAX_GIF {
        return Err("Image exceeds 128 MiB".into());
    }
    let format = image::guess_format(bytes).map_err(|_| "Choose a valid PNG, JPEG or GIF image")?;
    if ![ImageFormat::Png, ImageFormat::Jpeg, ImageFormat::Gif].contains(&format) {
        return Err("Only PNG, JPEG and GIF images are supported".into());
    }
    let animated = format == ImageFormat::Gif;
    if format == ImageFormat::Png {
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(4096);
        limits.max_image_height = Some(4096);
        limits.max_alloc = Some(128 * 1024 * 1024);
        let decoder = image::codecs::png::PngDecoder::with_limits(Cursor::new(bytes), limits)
            .map_err(|_| "Invalid PNG image")?;
        if decoder
            .is_apng()
            .map_err(|_| "Invalid PNG animation metadata")?
        {
            return Err("Animated PNG is not supported; choose a GIF animation instead".into());
        }
    }
    if !animated && bytes.len() > MAX_IMAGE {
        return Err("PNG and JPEG images must fit 16 MiB".into());
    }
    let dimensions = ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|_| "Invalid image dimensions")?;
    validate_pixels(dimensions.0, dimensions.1)?;
    let mut normalized = LimitedBytes(Vec::new());
    if animated {
        let mut options = gif::DecodeOptions::new();
        options.set_color_output(gif::ColorOutput::Indexed);
        let mut decoder = options
            .read_info(Cursor::new(bytes))
            .map_err(|_| "Invalid GIF image")?;
        let palette = decoder.global_palette().unwrap_or(&[]).to_vec();
        let mut encoder =
            gif::Encoder::new(&mut normalized, decoder.width(), decoder.height(), &palette)
                .map_err(|e| e.to_string())?;
        encoder
            .set_repeat(gif::Repeat::Infinite)
            .map_err(|e| e.to_string())?;
        let mut frames = 0u64;
        let mut ticks = 0u64;
        while let Some(frame) = decoder.read_next_frame().map_err(|_| "Invalid GIF frame")? {
            if u32::from(frame.left) + u32::from(frame.width) > dimensions.0
                || u32::from(frame.top) + u32::from(frame.height) > dimensions.1
            {
                return Err("GIF frame exceeds its canvas".into());
            }
            frames += 1;
            let delay = if frame.delay < 2 { 10 } else { frame.delay };
            ticks += u64::from(delay);
            if frames > 1800
                || ticks > 6000
                || frames * u64::from(dimensions.0) * u64::from(dimensions.1) > 600_000_000
            {
                return Err(
                    "GIF exceeds 1800 frames, 60 seconds or 600 million decoded pixels".into(),
                );
            }
            let mut frame = frame.clone();
            frame.delay = delay;
            encoder.write_frame(&frame).map_err(|e| e.to_string())?;
        }
        if frames == 0 {
            return Err("GIF has no frames".into());
        }
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|_| "Image could not be decoded safely")?;
    let mut poster = Cursor::new(Vec::new());
    if animated {
        decoded
            .write_to(&mut poster, ImageFormat::Png)
            .map_err(|e| e.to_string())?;
    }
    let saved = if animated {
        normalized.0.as_slice()
    } else {
        bytes
    };
    if saved.len() > MAX_GIF {
        return Err("Normalized GIF exceeds 128 MiB".into());
    }
    let previous = store.settings()?;
    let mut current = from_settings(&previous)?;
    let next_revision = check_revision(&current, input.revision)?;
    let root = media_root(store, true)?;
    let mut total = 0u64;
    let mut count = 0;
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        total = total.saturating_add(metadata.len());
        if entry.path().extension().is_some_and(|e| e == "image") {
            count += 1;
        }
    }
    if count >= 128
        || total
            .saturating_add(saved.len() as u64)
            .saturating_add(poster.get_ref().len() as u64)
            > MAX_PROFILE
    {
        return Err("Overlay image library reached 128 images or 512 MiB".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    write_new(&root.join(format!("{id}.image")), saved)?;
    if animated {
        write_new(&root.join(format!("{id}.poster.png")), poster.get_ref())?;
    }
    let reference = ImageRef {
        id: id.clone(),
        mime: match format {
            ImageFormat::Png => "image/png",
            ImageFormat::Jpeg => "image/jpeg",
            _ => "image/gif",
        }
        .into(),
        width: dimensions.0,
        height: dimensions.1,
        animated,
        url: format!("/widgets/media/{id}"),
        poster_url: animated.then(|| format!("/widgets/media/{id}/poster")),
        name: name.chars().filter(|c| !c.is_control()).take(160).collect(),
    };
    let mut registry = manifest(&previous)?;
    registry.insert(id, reference.clone());
    let mode = current
        .draft
        .modes
        .get_mut(&input.mode)
        .ok_or("Invalid overlay mode")?;
    mode.image = Some(reference);
    mode.enabled = true;
    current.revision = next_revision;
    persist(store, &previous, &current, Some(&registry))
}
/// Only validated registered UUIDs map to immutable profile-owned files.
pub fn media_file(store: &Store, id: &str, poster: bool) -> Result<(PathBuf, String), String> {
    if uuid::Uuid::parse_str(id).is_err() || id.len() != 36 {
        return Err("Unknown image".into());
    }
    let registry = manifest(&store.settings()?)?;
    let image = registry.get(id).ok_or("Unknown image")?;
    validate_ref(image)?;
    if poster && !image.animated {
        return Err("Unknown poster".into());
    }
    let root = media_root(store, false)?;
    let path = root
        .join(if poster {
            format!("{id}.poster.png")
        } else {
            format!("{id}.image")
        })
        .canonicalize()
        .map_err(|_| "Image unavailable")?;
    if path.parent() != Some(root.as_path()) || !path.is_file() {
        return Err("Image escaped profile".into());
    }
    Ok((
        path,
        if poster {
            "image/png".into()
        } else {
            image.mime.clone()
        },
    ))
}

pub fn public_state(settings: &Value, monitoring: &Value) -> Value {
    let Ok(config) = from_settings(settings) else {
        return json!({"enabled":false,"loadingEnabled":false,"phase":"unknown","mode":{"enabled":false}});
    };
    let enabled = config.applied.enabled && monitoring["running"] == true;
    let fresh = monitoring["smartSampleAt"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .is_some_and(|s| {
            (-1000..=5000).contains(
                &chrono::Utc::now()
                    .signed_duration_since(s)
                    .num_milliseconds(),
            )
        });
    let phase = monitoring["smartPhase"]
        .as_str()
        .filter(|p| MODES.contains(p))
        .filter(|_| fresh)
        .unwrap_or("unknown");
    let mut mode = if enabled {
        config
            .applied
            .modes
            .get(phase)
            .map(|m| json!(m))
            .unwrap_or(json!({"enabled":false}))
    } else {
        json!({"enabled":false})
    };
    if let Some(image) = mode.get_mut("image").and_then(Value::as_object_mut) {
        image.remove("name");
    }
    let mut result = json!({"enabled":enabled,"loadingEnabled":enabled &&config.applied.modes["loading"].enabled,"phase":if enabled{phase}else{"unknown"},"mode":mode});
    if enabled && phase == "menu" {
        result["menuLayout"] = json!(config.applied.menu_layout);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn menu_grid_is_backward_compatible_bounded_and_only_applied_explicitly() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path().to_path_buf()).unwrap();
        let mut old = serde_json::to_value(Appearance::default()).unwrap();
        old.as_object_mut().unwrap().remove("menuLayout");
        store
            .save_settings(json!({"obsOverlay":{"smartDraft":old,"smartApplied":old}}))
            .unwrap();
        let initial = get(&store).unwrap();
        assert_eq!(initial["draft"]["menuLayout"]["columns"], 32);
        let mut draft = initial["draft"].clone();
        draft["menuLayout"]["widgets"]["fountain"]["enabled"] = json!(true);
        draft["revision"] = json!(0);
        let saved = save_draft(&store, draft.clone()).unwrap();
        assert_eq!(
            saved["draft"]["menuLayout"]["widgets"]["fountain"]["enabled"],
            true
        );
        assert_eq!(
            saved["applied"]["menuLayout"]["widgets"]["fountain"]["enabled"],
            false
        );
        draft["revision"] = saved["revision"].clone();
        draft["menuLayout"]["widgets"]["fountain"]["x"] = json!(31);
        assert!(save_draft(&store, draft).is_err());
        assert_eq!(get(&store).unwrap()["revision"], saved["revision"]);
        let applied = apply(&store, json!({"revision":saved["revision"]})).unwrap();
        assert_eq!(
            applied["applied"]["menuLayout"]["widgets"]["fountain"]["enabled"],
            true
        );
    }
    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(width, height)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }
    fn input(revision: u64) -> ChooseInput {
        ChooseInput {
            revision,
            mode: "menu".into(),
        }
    }
    #[test]
    fn draft_apply_cas_are_separate_and_survive_restart() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path().into()).unwrap();
        store
            .save_settings(json!({"obsOverlay":{"future":17},"overlayEnabled":false}))
            .unwrap();
        let draft = Appearance {
            enabled: true,
            ..Appearance::default()
        };
        let saved = save_draft(
            &store,
            json!({"revision":0,"enabled":true,"modes":draft.modes}),
        )
        .unwrap();
        assert_eq!(saved["revision"], 1);
        assert_eq!(saved["applied"]["enabled"], false);
        let before = store.settings().unwrap();
        assert!(apply(&store, json!({"revision":0})).is_err());
        assert_eq!(store.settings().unwrap(), before);
        apply(&store, json!({"revision":1})).unwrap();
        assert_eq!(store.settings().unwrap()["obsOverlay"]["future"], 17);
        assert_eq!(store.settings().unwrap()["overlayEnabled"], false);
        drop(store);
        let store = Store::open(root.path().into()).unwrap();
        let config = get(&store).unwrap();
        assert_eq!(config["revision"], 2);
        assert_eq!(config["appliedRevision"], 2);
        assert_eq!(config["applied"]["enabled"], true);
    }
    #[test]
    fn content_validation_reference_security_and_source_preservation() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path().into()).unwrap();
        let source = root.path().join("original.wrong-extension");
        let bytes = png(4, 3);
        let cancelled_before = store.settings().unwrap();
        assert_eq!(
            import_selection(&store, &input(0), None).unwrap(),
            Value::Null
        );
        assert_eq!(store.settings().unwrap(), cancelled_before);
        fs::write(&source, &bytes).unwrap();
        let result = import_path(&store, &input(0), &source).unwrap();
        let reference = &result["draft"]["modes"]["menu"]["image"];
        let id = reference["id"].as_str().unwrap();
        let (file, mime) = media_file(&store, id, false).unwrap();
        assert_eq!(fs::read(&source).unwrap(), bytes);
        assert_eq!(fs::read(file).unwrap(), bytes);
        assert_eq!(mime, "image/png");
        assert_eq!(reference["width"], 4);
        assert_eq!(result["draft"]["modes"]["menu"]["enabled"], true);
        assert_eq!(result["applied"]["modes"]["menu"].get("image"), None);
        assert!(media_file(&store, "../original", false).is_err());
        assert!(media_file(&store, id, true).is_err());
        let mut forged = result["draft"].clone();
        forged["modes"]["menu"]["image"]["url"] = json!("file:///private");
        assert!(
            save_draft(
                &store,
                json!({"revision":1,"enabled":false,"modes":forged["modes"]})
            )
            .is_err()
        );
        let before = store.settings().unwrap();
        assert!(import_bytes(&store, &input(1), b"<svg/>", "bad.png").is_err());
        assert!(import_bytes(&store, &input(1), &bytes[..20], "bad.png").is_err());
        assert_eq!(store.settings().unwrap(), before);
        assert!(validate_pixels(4097, 1).is_err());
        assert!(validate_pixels(4096, 4096).is_err());
        assert!(
            validate_choice(
                &store,
                &ChooseInput {
                    revision: 1,
                    mode: "../menu".into()
                }
            )
            .is_err()
        );
    }
    fn gif_bytes(delay: u16, frames: usize) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder =
                gif::Encoder::new(&mut bytes, 2, 2, &[0, 0, 0, 255, 255, 255]).unwrap();
            for _ in 0..frames {
                let frame = gif::Frame {
                    width: 2,
                    height: 2,
                    delay,
                    buffer: std::borrow::Cow::Borrowed(&[0, 1, 0, 1]),
                    ..Default::default()
                };
                encoder.write_frame(&frame).unwrap();
            }
        }
        bytes
    }
    #[test]
    fn animated_png_cannot_bypass_gif_limits_or_reduced_motion() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path().into()).unwrap();
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 1, 1);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.set_animated(2, 0).unwrap();
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[255, 0, 0, 255]).unwrap();
            writer.write_image_data(&[0, 0, 255, 255]).unwrap();
        }
        assert!(
            import_bytes(&store, &input(0), &bytes, "animated.png")
                .unwrap_err()
                .contains("Animated PNG")
        );
        assert_eq!(get(&store).unwrap()["revision"], 0);
        assert!(!root.path().join("overlay-media").exists());
    }
    #[test]
    fn gifs_get_infinite_loop_and_static_poster_and_enforce_duration_quota() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path().into()).unwrap();
        let result = import_bytes(&store, &input(0), &gif_bytes(5, 2), "animation.gif").unwrap();
        let reference = &result["draft"]["modes"]["menu"]["image"];
        assert_eq!(reference["animated"], true);
        let id = reference["id"].as_str().unwrap();
        let (path, _) = media_file(&store, id, false).unwrap();
        let mut decoder = gif::DecodeOptions::new()
            .read_info(fs::File::open(path).unwrap())
            .unwrap();
        while decoder.read_next_frame().unwrap().is_some() {}
        assert_eq!(decoder.repeat(), gif::Repeat::Infinite);
        let (poster, mime) = media_file(&store, id, true).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(image::open(poster).unwrap().width(), 2);
        assert!(import_bytes(&store, &input(1), &gif_bytes(6001, 1), "too-long.gif").is_err());
        let media = root.path().join("overlay-media");
        for n in 0..127 {
            fs::write(media.join(format!("quota-{n}.image")), []).unwrap();
        }
        assert!(import_bytes(&store, &input(1), &png(1, 1), "quota.png").is_err());
    }
    #[test]
    fn public_smart_state_uses_applied_only_and_keeps_loading_enabled_on_stale_samples() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path().into()).unwrap();
        let image = import_bytes(&store, &input(0), &png(2, 2), "private-name.png").unwrap();
        save_draft(
            &store,
            json!({"revision":1,"enabled":true,"modes":image["draft"]["modes"]}),
        )
        .unwrap();
        let monitor = json!({"running":true,"smartPhase":"menu","smartSampleAt":crate::domain::now(),"lastError":null});
        assert_eq!(
            public_state(&store.settings().unwrap(), &monitor)["enabled"],
            false
        );
        apply(&store, json!({"revision":2})).unwrap();
        let state = public_state(&store.settings().unwrap(), &monitor);
        assert_eq!(state["phase"], "menu");
        let mut enrichment_error = monitor.clone();
        enrichment_error["lastError"] = json!("Enrichment timeout");
        assert_eq!(
            public_state(&store.settings().unwrap(), &enrichment_error)["phase"],
            "menu"
        );
        assert_eq!(state["mode"]["image"]["width"], 2);
        assert!(!state.to_string().contains("private-name"));
        let stale =
            json!({"running":true,"smartPhase":"loading","smartSampleAt":"2000-01-01T00:00:00Z"});
        let state = public_state(&store.settings().unwrap(), &stale);
        assert_eq!(state["enabled"], true);
        assert_eq!(state["phase"], "unknown");
        assert_eq!(state["loadingEnabled"], true);
        let current = get(&store).unwrap();
        let mut modes = current["draft"]["modes"].clone();
        modes["loading"]["enabled"] = json!(false);
        save_draft(&store, json!({"revision":3,"enabled":true,"modes":modes})).unwrap();
        apply(&store, json!({"revision":4})).unwrap();
        assert_eq!(
            public_state(&store.settings().unwrap(), &stale)["loadingEnabled"],
            false
        );
        assert_eq!(
            public_state(&store.settings().unwrap(), &json!({"running":false}))["enabled"],
            false
        );
    }
}
