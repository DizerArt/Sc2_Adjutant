//! Local, exact-map terrain. Editor exports are preferred; minimaps are bounded fallbacks.
use crate::replay::ReplayRunner;
use base64::Engine;
use image::ImageFormat;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{Cursor, Write},
    path::{Path, PathBuf},
};

const MAX_IMAGE: usize = 16 * 1024 * 1024;
const MAX_CATALOG: usize = 256 * 1024;
const MAX_INFO: usize = 1024 * 1024;
const MAX_SIDE: u32 = 4096;

pub fn is_sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn unavailable() -> Value {
    json!({"status":"unavailable","reason":"Local map image is unavailable; observed tracker geometry is shown"})
}

fn no_links(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Map asset path must be absolute".into());
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        if !matches!(path.components().next(),Some(Component::Prefix(p)) if matches!(p.kind(),Prefix::Disk(_)|Prefix::VerbatimDisk(_)))
        {
            return Err("Map asset path must be local".into());
        }
    }
    for ancestor in path.ancestors() {
        match std::fs::symlink_metadata(ancestor) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err("Map assets cannot use links".into());
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 {
                        return Err("Map assets cannot use reparse points".into());
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Map asset metadata is unavailable".into()),
        }
    }
    Ok(())
}
fn read_bounded(path: &Path, max: usize) -> Result<Vec<u8>, String> {
    use std::io::Read;
    no_links(path)?;
    let meta = std::fs::metadata(path).map_err(|_| "Map asset is unavailable")?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > max as u64 {
        return Err("Map asset size is invalid".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|_| "Map asset is unavailable")?
        .take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Map asset cannot be read")?;
    if bytes.len() > max {
        return Err("Map asset size is invalid".into());
    }
    Ok(bytes)
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    no_links(path)?;
    let parent = path.parent().ok_or("Invalid map asset directory")?;
    std::fs::create_dir_all(parent).map_err(|_| "Map asset directory cannot be created")?;
    no_links(parent)?;
    let temporary = parent.join(format!(".map-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "Map asset cannot be staged")?;
        file.write_all(bytes)
            .map_err(|_| "Map asset cannot be staged")?;
        file.sync_all().map_err(|_| "Map asset cannot be synced")?;
        drop(file);
        no_links(path)?;
        std::fs::rename(&temporary, path).map_err(|_| "Map asset cannot be published")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}
fn root(profile: &Path) -> PathBuf {
    profile.join("map-backgrounds")
}
fn bounds(value: &Value) -> Result<[f64; 4], String> {
    let mut out = [0.; 4];
    for (i, key) in ["min_x", "min_y", "max_x", "max_y"].iter().enumerate() {
        out[i] = value[key]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0. && *n <= 4096.)
            .ok_or("Invalid map bounds")?;
    }
    if out[2] <= out[0] || out[3] <= out[1] {
        return Err("Invalid map bounds".into());
    }
    Ok(out)
}
fn image_dimensions(bytes: &[u8], format: ImageFormat) -> Result<(u32, u32), String> {
    let reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let size = reader
        .into_dimensions()
        .map_err(|_| "Map image dimensions are invalid")?;
    if size.0 == 0 || size.1 == 0 || size.0 > MAX_SIDE || size.1 > MAX_SIDE {
        return Err("Map image dimensions exceed limits".into());
    }
    Ok(size)
}
fn validate_descriptor(value: &Value, map_sha: &str) -> Result<(), String> {
    if !is_sha(map_sha)
        || value["status"] != "ready"
        || value["map_sha256"] != map_sha
        || !value["image_sha256"].as_str().is_some_and(is_sha)
        || !["editor-export", "minimap"]
            .iter()
            .any(|k| value["source_kind"] == *k)
    {
        return Err("Invalid map image descriptor".into());
    }
    let bound = bounds(&value["bounds"])?;
    let size = value["image_size"]
        .as_array()
        .filter(|a| a.len() == 2)
        .ok_or("Invalid map image size")?;
    if !size
        .iter()
        .all(|v| v.as_u64().is_some_and(|n| n > 0 && n <= MAX_SIDE as u64))
    {
        return Err("Invalid map image size".into());
    }
    let expected_height = size[0].as_f64().unwrap() * (bound[3] - bound[1]) / (bound[2] - bound[0]);
    if (size[1].as_f64().unwrap() - expected_height).abs() > 1. {
        return Err("Map image world aspect mismatch".into());
    }
    if value["geometry_sha256"].as_str() != Some(geometry_sha(value).as_str()) {
        return Err("Map image geometry checksum changed".into());
    }
    Ok(())
}
fn geometry_sha(value: &Value) -> String {
    digest(
        &serde_json::to_vec(&json!([
            value["map_sha256"],
            value["image_sha256"],
            value["image_size"],
            value["bounds"],
            value["source_kind"]
        ]))
        .unwrap_or_default(),
    )
}
fn public_descriptor(value: &Value) -> Value {
    json!({"status":"ready","map_sha256":value["map_sha256"],"image_sha256":value["image_sha256"],"source_kind":value["source_kind"],"image_size":value["image_size"],"bounds":{"min_x":value["bounds"]["min_x"],"min_y":value["bounds"]["min_y"],"max_x":value["bounds"]["max_x"],"max_y":value["bounds"]["max_y"]},"registration":{"accuracy":"approximate","ground_control_verified":false,"method":if value["source_kind"]=="editor-export"{"camera-bounds"}else{"MapInfo-Minimap-center-crop"}},"url":format!("/api/overlay/maps/{}/image",value["image_sha256"].as_str().unwrap_or(""))})
}
pub fn image(profile: &Path, image_sha: &str) -> Result<Vec<u8>, String> {
    if !is_sha(image_sha) {
        return Err("Invalid map image identity".into());
    }
    let bytes = read_bounded(&root(profile).join(format!("{image_sha}.png")), MAX_IMAGE)?;
    if digest(&bytes) != image_sha {
        return Err("Map image checksum changed".into());
    }
    image_dimensions(&bytes, ImageFormat::Png)?;
    image::load_from_memory_with_format(&bytes, ImageFormat::Png)
        .map_err(|_| "Map PNG pixels are invalid")?;
    Ok(bytes)
}
pub fn cached(profile: &Path, map_sha: &str) -> Result<Value, String> {
    if !is_sha(map_sha) {
        return Err("Invalid map identity".into());
    }
    let bytes = read_bounded(&root(profile).join(format!("{map_sha}.json")), 16 * 1024)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid map descriptor")?;
    validate_descriptor(&value, map_sha)?;
    let bytes = image(profile, value["image_sha256"].as_str().unwrap())?;
    let size = image_dimensions(&bytes, ImageFormat::Png)?;
    if value["image_size"] != json!([size.0, size.1]) {
        return Err("Map descriptor dimensions changed".into());
    }
    Ok(public_descriptor(&value))
}
fn publish(
    profile: &Path,
    map_sha: &str,
    bytes: &[u8],
    bound: Value,
    kind: &str,
) -> Result<Value, String> {
    let size = image_dimensions(bytes, ImageFormat::Png)?;
    bounds(&bound)?;
    image::load_from_memory_with_format(bytes, ImageFormat::Png)
        .map_err(|_| "Map PNG pixels are invalid")?;
    let image_sha = digest(bytes);
    let mut value = json!({"status":"ready","map_sha256":map_sha,"image_sha256":image_sha,"source_kind":kind,"image_size":[size.0,size.1],"bounds":bound,"registration":{"accuracy":"approximate","ground_control_verified":false,"method":if kind=="editor-export"{"camera-bounds"}else{"MapInfo-Minimap-center-crop"}}});
    value["geometry_sha256"] = json!(geometry_sha(&value));
    validate_descriptor(&value, map_sha)?;
    let path = root(profile).join(format!("{image_sha}.png"));
    match image(profile, &image_sha) {
        Ok(_) => {}
        Err(_) => atomic_write(&path, bytes)?,
    };
    atomic_write(
        &root(profile).join(format!("{map_sha}.json")),
        &serde_json::to_vec(&value).map_err(|_| "Map descriptor encoding failed")?,
    )?;
    Ok(public_descriptor(&value))
}
fn editor(profile: &Path, bank: &Path, map_sha: &str) -> Result<Value, String> {
    let catalog: Value =
        serde_json::from_slice(&read_bounded(&bank.join("catalog.json"), MAX_CATALOG)?)
            .map_err(|_| "Invalid editor catalog")?;
    if catalog["schema_version"] != 1 {
        return Err("Invalid editor catalog version".into());
    }
    let rows = catalog["maps"]
        .as_array()
        .filter(|a| a.len() <= 1024)
        .ok_or("Invalid editor catalog maps")?;
    let matching = rows
        .iter()
        .filter(|row| {
            row["map_sha256"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v == map_sha))
        })
        .collect::<Vec<_>>();
    if matching.len() != 1 {
        return Err("No unique exact editor export".into());
    }
    let row = matching[0];
    let name = row["image"]
        .as_str()
        .filter(|s| {
            s.len() < 160
                && s.ends_with(".png")
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
                && !s.contains("..")
        })
        .ok_or("Invalid editor filename")?;
    let bytes = read_bounded(&bank.join(name), MAX_IMAGE)?;
    if !row["image_sha256"]
        .as_str()
        .is_some_and(|s| is_sha(s) && digest(&bytes) == s)
    {
        return Err("Editor image checksum mismatch".into());
    }
    let size = image_dimensions(&bytes, ImageFormat::Png)?;
    if row["image_size"] != json!([size.0, size.1]) {
        return Err("Editor image dimensions mismatch".into());
    }
    publish(
        profile,
        map_sha,
        &bytes,
        row["bounds"].clone(),
        "editor-export",
    )
}

struct MapInfo {
    width: u32,
    height: u32,
    bounds: [u32; 4],
}
fn map_info(bytes: &[u8]) -> Result<MapInfo, String> {
    struct Reader<'a> {
        bytes: &'a [u8],
        at: usize,
    }
    impl Reader<'_> {
        fn u32(&mut self) -> Result<u32, String> {
            let end = self.at.checked_add(4).ok_or("Invalid MapInfo offset")?;
            let b = self.bytes.get(self.at..end).ok_or("Truncated MapInfo")?;
            self.at = end;
            Ok(u32::from_le_bytes(b.try_into().unwrap()))
        }
        fn string(&mut self) -> Result<(), String> {
            let tail = self.bytes.get(self.at..).ok_or("Truncated MapInfo")?;
            let len = tail
                .iter()
                .take(4097)
                .position(|b| *b == 0)
                .ok_or("Invalid MapInfo string")?;
            self.at += len + 1;
            Ok(())
        }
    }
    if bytes.len() > MAX_INFO || bytes.get(..4) != Some(b"IpaM") {
        return Err("Invalid MapInfo header".into());
    }
    let mut r = Reader { bytes, at: 4 };
    let version = r.u32()?;
    if version > 0x40 {
        return Err("Unsupported MapInfo version".into());
    }
    if version >= 0x18 {
        r.u32()?;
        r.u32()?;
    }
    let width = r.u32()?;
    let height = r.u32()?;
    if r.u32()? == 2 {
        r.string()?;
    }
    if r.u32()? == 2 {
        r.string()?;
    }
    if version >= 0x1f {
        r.string()?;
    }
    if version >= 0x26 {
        r.string()?;
    }
    if version >= 0x1f {
        r.u32()?;
    }
    r.u32()?;
    r.string()?;
    r.string()?;
    let bound = [r.u32()?, r.u32()?, r.u32()?, r.u32()?];
    if width == 0
        || height == 0
        || width > MAX_SIDE
        || height > MAX_SIDE
        || bound[0] >= bound[2]
        || bound[1] >= bound[3]
        || bound[2] > width
        || bound[3] > height
    {
        return Err("Invalid MapInfo camera bounds".into());
    }
    Ok(MapInfo {
        width,
        height,
        bounds: bound,
    })
}
pub(crate) fn minimap(profile: &Path, map_sha: &str, value: &Value) -> Result<Value, String> {
    if value["mapSha256"] != map_sha {
        return Err("Minimap identity mismatch".into());
    }
    let engine = base64::engine::general_purpose::STANDARD;
    let info_text = value["mapInfoBase64"]
        .as_str()
        .filter(|s| s.len() <= MAX_INFO * 4 / 3 + 8)
        .ok_or("Missing MapInfo")?;
    let tga_text = value["minimapBase64"]
        .as_str()
        .filter(|s| s.len() <= 8 * 1024 * 1024 * 4 / 3 + 8)
        .ok_or("Missing minimap")?;
    let info = map_info(
        &engine
            .decode(info_text)
            .map_err(|_| "Invalid MapInfo encoding")?,
    )?;
    let tga = engine
        .decode(tga_text)
        .map_err(|_| "Invalid minimap encoding")?;
    let (w, h) = image_dimensions(&tga, ImageFormat::Tga)?;
    let dx = info.bounds[2] - info.bounds[0];
    let dy = info.bounds[3] - info.bounds[1];
    let sx = w as f64 / dx.next_power_of_two() as f64;
    let sy = h as f64 / dy.next_power_of_two() as f64;
    if (sx - sy).abs() > 1e-6 {
        return Err("Minimap world aspect mismatch".into());
    }
    let cw = dx as f64 * sx;
    let ch = dy as f64 * sy;
    let x = (w as f64 - cw) / 2.;
    let y = (h as f64 - ch) / 2.;
    if [x, y, cw, ch]
        .iter()
        .any(|n| !n.is_finite() || *n < 0. || (*n - n.round()).abs() > 1e-6)
    {
        return Err("Minimap crop is not pixel aligned".into());
    }
    let image = image::load_from_memory_with_format(&tga, ImageFormat::Tga)
        .map_err(|_| "Invalid minimap pixels")?
        .to_rgb8();
    // Verify the padding before registration; otherwise do not invent a map projection.
    let mut actual = [w, h, 0, 0];
    let mut any = false;
    for (px, py, pixel) in image.enumerate_pixels() {
        if pixel.0.iter().any(|n| *n != 0) {
            any = true;
            actual[0] = actual[0].min(px);
            actual[1] = actual[1].min(py);
            actual[2] = actual[2].max(px + 1);
            actual[3] = actual[3].max(py + 1);
        }
    }
    let expected = [x as u32, y as u32, (x + cw) as u32, (y + ch) as u32];
    if !any || actual.iter().zip(expected).any(|(a, e)| a.abs_diff(e) > 1) {
        return Err("Minimap padding does not match camera bounds".into());
    }
    let terrain =
        image::imageops::crop_imm(&image, x as u32, y as u32, cw as u32, ch as u32).to_image();
    let mut png = Cursor::new(Vec::new());
    terrain
        .write_to(&mut png, ImageFormat::Png)
        .map_err(|_| "Minimap PNG encoding failed")?;
    let bytes = png.into_inner();
    if bytes.len() > MAX_IMAGE {
        return Err("Minimap PNG exceeds limit".into());
    }
    let [left, bottom, right, top] = info.bounds;
    let _ = (info.width, info.height);
    publish(
        profile,
        map_sha,
        &bytes,
        json!({"min_x":left,"min_y":bottom,"max_x":right,"max_y":top}),
        "minimap",
    )
}

/// Map failures never discard valid replay facts. Only exact IDs are considered.
pub async fn resolve(
    profile: &Path,
    bank: Option<&Path>,
    runner: &ReplayRunner,
    map_sha: &str,
) -> Value {
    if !is_sha(map_sha) {
        return unavailable();
    }
    if let Some(bank) = bank
        && let Ok(value) = editor(profile, bank, map_sha)
    {
        return value;
    }
    if let Ok(value) = cached(profile, map_sha) {
        return value;
    }
    match runner
        .request("mapImage", json!({"mapSha256":map_sha}))
        .await
    {
        Ok(value) => minimap(profile, map_sha, &value).unwrap_or_else(|_| unavailable()),
        Err(_) => unavailable(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png() -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        image::RgbImage::from_pixel(6, 4, image::Rgb([9, 20, 31]))
            .write_to(&mut out, ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }
    fn map_info_bytes() -> Vec<u8> {
        let mut out = b"IpaM".to_vec();
        for n in [0x20u32, 0, 0, 16, 16, 0, 0] {
            out.extend(n.to_le_bytes());
        }
        out.push(0);
        for n in [0u32, 0] {
            out.extend(n.to_le_bytes());
        }
        out.extend([0, 0]);
        for n in [2u32, 4, 8, 8] {
            out.extend(n.to_le_bytes());
        }
        out
    }
    fn tga(top: bool) -> Vec<u8> {
        let mut out = vec![0; 18];
        out[2] = 2;
        out[12] = 8;
        out[14] = 4;
        out[16] = 24;
        out[17] = if top { 0x20 } else { 0 };
        for row in 0..4 {
            let y = if top { row } else { 3 - row };
            for x in 0..8 {
                let rgb = if x == 0 || x == 7 {
                    [0, 0, 0]
                } else if y == 0 {
                    [255, 0, 0]
                } else {
                    [0, 0, 255]
                };
                out.extend([rgb[2], rgb[1], rgb[0]]);
            }
        }
        out
    }
    fn raw_minimap(map_sha: &str, top: bool) -> Value {
        let engine = base64::engine::general_purpose::STANDARD;
        json!({"mapSha256":map_sha,"mapInfoBase64":engine.encode(map_info_bytes()),"minimapBase64":engine.encode(tga(top))})
    }
    fn bank(directory: &Path, map_sha: &str) -> PathBuf {
        let root = directory.join("bank");
        std::fs::create_dir(&root).unwrap();
        let bytes = png();
        std::fs::write(root.join("map.png"), &bytes).unwrap();
        std::fs::write(root.join("catalog.json"),json!({"schema_version":1,"maps":[{"image":"map.png","image_sha256":digest(&bytes),"image_size":[6,4],"map_sha256":[map_sha],"bounds":{"min_x":2,"min_y":4,"max_x":8,"max_y":8}}]}).to_string()).unwrap();
        root
    }
    #[test]
    fn mapinfo_minimap_crop_and_both_tga_origins_match_world_orientation() {
        for top in [true, false] {
            let directory = tempfile::tempdir().unwrap();
            let sha = "a".repeat(64);
            let result = minimap(directory.path(), &sha, &raw_minimap(&sha, top)).unwrap();
            assert_eq!(result["image_size"], json!([6, 4]));
            assert_eq!(
                result["bounds"],
                json!({"min_x":2,"min_y":4,"max_x":8,"max_y":8})
            );
            let image = image::load_from_memory(
                &image(directory.path(), result["image_sha256"].as_str().unwrap()).unwrap(),
            )
            .unwrap()
            .to_rgb8();
            assert_eq!(image.get_pixel(0, 0).0, [255, 0, 0]);
            assert_eq!(image.get_pixel(0, 3).0, [0, 0, 255]);
            assert_eq!(cached(directory.path(), &sha).unwrap(), result);
        }
    }
    #[tokio::test]
    async fn exact_editor_export_wins_over_cached_minimap_without_running_worker() {
        let directory = tempfile::tempdir().unwrap();
        let profile = directory.path().join("profile");
        let sha = "b".repeat(64);
        minimap(&profile, &sha, &raw_minimap(&sha, true)).unwrap();
        let bank = bank(directory.path(), &sha);
        let runner = ReplayRunner::new(PathBuf::from("missing"), PathBuf::from("missing"));
        let result = resolve(&profile, Some(&bank), &runner, &sha).await;
        assert_eq!(result["source_kind"], "editor-export");
        assert_eq!(result["registration"]["accuracy"], "approximate");
        assert!(!result.to_string().contains("profile"));
        // A different map with the same title is never substituted.
        assert_eq!(
            resolve(&profile, Some(&bank), &runner, &"c".repeat(64)).await["status"],
            "unavailable"
        );
    }
    #[tokio::test]
    async fn corrupted_editor_export_falls_back_to_valid_minimap_cache() {
        let directory = tempfile::tempdir().unwrap();
        let profile = directory.path().join("profile");
        let sha = "d".repeat(64);
        minimap(&profile, &sha, &raw_minimap(&sha, true)).unwrap();
        let bank = bank(directory.path(), &sha);
        std::fs::write(bank.join("map.png"), b"corrupt").unwrap();
        let runner = ReplayRunner::new(PathBuf::from("missing"), PathBuf::from("missing"));
        assert_eq!(
            resolve(&profile, Some(&bank), &runner, &sha).await["source_kind"],
            "minimap"
        );
    }
    #[test]
    fn map_assets_reject_unknown_ids_tampering_and_unregistered_geometry() {
        let directory = tempfile::tempdir().unwrap();
        let sha = "e".repeat(64);
        let result = minimap(directory.path(), &sha, &raw_minimap(&sha, true)).unwrap();
        assert!(image(directory.path(), "../private").is_err());
        std::fs::write(
            root(directory.path())
                .join(format!("{}.png", result["image_sha256"].as_str().unwrap())),
            b"changed",
        )
        .unwrap();
        assert!(cached(directory.path(), &sha).is_err());
        let mut invalid = raw_minimap(&sha, true);
        let mut raw = tga(true);
        // A one-pixel bounding-box discrepancy is tolerated like the original decoder;
        // shrink terrain by two pixels to exercise a genuinely invalid registration.
        for row in 0..4 {
            for x in [1, 2] {
                raw[18 + (row * 8 + x) * 3..18 + (row * 8 + x) * 3 + 3].fill(0);
            }
        }
        invalid["minimapBase64"] = json!(base64::engine::general_purpose::STANDARD.encode(raw));
        assert!(minimap(directory.path(), &sha, &invalid).is_err());
        let mut info = map_info_bytes();
        info.truncate(20);
        assert!(map_info(&info).is_err());
    }
    #[test]
    fn cached_geometry_is_bound_and_public_metadata_is_whitelisted() {
        let directory = tempfile::tempdir().unwrap();
        let sha = "f".repeat(64);
        minimap(directory.path(), &sha, &raw_minimap(&sha, true)).unwrap();
        let path = root(directory.path()).join(format!("{sha}.json"));
        let mut value: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        value["bounds"]["max_x"] = json!(9);
        std::fs::write(&path, value.to_string()).unwrap();
        assert!(cached(directory.path(), &sha).is_err());
        value["bounds"]["max_x"] = json!(8);
        value["bounds"]["private_path"] = json!("C:/private/map");
        value["registration"]["private_path"] = json!("C:/private/map");
        value["geometry_sha256"] = json!(geometry_sha(&value));
        std::fs::write(&path, value.to_string()).unwrap();
        let public = cached(directory.path(), &sha).unwrap();
        assert!(!public.to_string().contains("private"));
        assert!(public.get("geometry_sha256").is_none());
    }
}
