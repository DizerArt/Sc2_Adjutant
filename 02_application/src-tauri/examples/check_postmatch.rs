//! Explicit diagnostic: replay read-only; SQLite writes only in a temporary profile.
//! Never starts SC2/OBS monitoring or network services.
use sc2_compose_core::{postmatch, replay::ReplayRunner};
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    if args.len() != 3 {
        eprintln!("Usage: check_postmatch <bundled-node> <worker> <replay>");
        std::process::exit(2);
    }
    let result = async {
        let id = postmatch::fingerprint(&args[2]).map_err(|e| format!("fingerprint: {e}"))?;
        let facts = ReplayRunner::new(args[0].clone(), args[1].clone())
            .postmatch(&args[2]).await.map_err(|e| format!("decode: {e}"))?;
        let public = postmatch::sanitize(&facts, &id).map_err(|e| format!("projection: {e}"))?;
        let after = postmatch::fingerprint(&args[2])?;
        if id != after { return Err("source changed".to_string()); }
        let directory=tempfile::tempdir().map_err(|e|e.to_string())?;
        let store=std::sync::Arc::new(sc2_compose_core::storage::Store::open(directory.path().to_path_buf())?);
        let runtime=sc2_compose_core::runtime::Runtime::new(store,ReplayRunner::new(args[0].clone(),args[1].clone()),std::sync::Arc::new(|_,_|{}))?.without_network();
        runtime.prepare_selected_postmatch(Some(&args[2]))?;
        let state=tokio::time::timeout(std::time::Duration::from_secs(50),async {
            loop {let state=runtime.postmatch_status(true);if state["status"]!="processing"{break state;}tokio::time::sleep(std::time::Duration::from_millis(50)).await;}
        }).await.map_err(|_|"runtime timeout")?;
        if state["status"]!="ready"{return Err(format!("runtime: {state}"));}
        let published=runtime.postmatch_data(true)?.ok_or("runtime omitted public facts")?;
        if published["id"]!=id{return Err("runtime cache identity mismatch".into());}
        runtime.shutdown();
        println!("{}", serde_json::json!({"ok":true,"players":public["players"].as_array().map(Vec::len),"teams":public["teams"].as_array().map(Vec::len),"losses":public["events"].as_array().map(Vec::len),"lifecycle":public["story"]["events"].as_array().map(Vec::len),"movement":public["story"]["movement"]["samples"].as_array().map(Vec::len),"sourceUnchanged":true}));
        Ok::<(),String>(())
    }.await;
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
