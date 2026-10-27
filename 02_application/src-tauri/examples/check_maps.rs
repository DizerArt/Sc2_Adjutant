//! Explicit offline map acceptance: writes only an owned temporary profile.
use sc2_compose_core::{map_background, replay::ReplayRunner};
use serde_json::Value;
use std::{collections::BTreeSet, path::PathBuf};
#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    if args.len() != 3 {
        eprintln!("Usage: check_maps <node> <worker> <map-bank>");
        std::process::exit(2);
    }
    if let Err(error) = run(&args).await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
async fn run(args: &[PathBuf]) -> Result<(), String> {
    let catalog: Value = serde_json::from_slice(
        &std::fs::read(args[2].join("catalog.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let mut hashes = BTreeSet::new();
    for row in catalog["maps"].as_array().ok_or("Missing catalog")? {
        for hash in row["map_sha256"].as_array().ok_or("Missing map hashes")? {
            let hash = hash.as_str().ok_or("Invalid hash")?;
            if !map_background::is_sha(hash) {
                return Err("Invalid map hash".into());
            }
            hashes.insert(hash.to_string());
        }
    }
    let profile = tempfile::tempdir().map_err(|e| e.to_string())?;
    let runner = ReplayRunner::new(args[0].clone(), args[1].clone());
    let mut exports = 0;
    for hash in &hashes {
        let background =
            map_background::resolve(profile.path(), Some(&args[2]), &runner, hash).await;
        if background["status"] != "ready" || background["source_kind"] != "editor-export" {
            return Err(format!("Editor resolution failed: {hash}"));
        }
        map_background::image(
            profile.path(),
            background["image_sha256"].as_str().ok_or("Missing image")?,
        )?;
        exports += 1;
    }
    let first = hashes.first().ok_or("Empty bank")?;
    let fallback_root = profile.path().join("minimap-only");
    std::fs::create_dir(&fallback_root).map_err(|e| e.to_string())?;
    let background = map_background::resolve(&fallback_root, None, &runner, first).await;
    if background["status"] != "ready" || background["source_kind"] != "minimap" {
        return Err(format!(
            "Real local minimap resolution failed: {background}"
        ));
    }
    map_background::image(
        &fallback_root,
        background["image_sha256"]
            .as_str()
            .ok_or("Missing minimap image")?,
    )?;
    println!(
        "{}",
        serde_json::json!({"ok":true,"exactEditorRevisions":exports,"minimap":background,"noNetwork":true})
    );
    Ok(())
}
