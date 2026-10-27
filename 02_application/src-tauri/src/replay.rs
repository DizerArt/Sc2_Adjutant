//! Bounded compatibility worker for the existing replay parser.
//!
//! The worker is a temporary adapter, not a native Rust replay decoder. It reads
//! source replays only; all application writes remain owned by the Rust store.

use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const MAX_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_REPLAY_BYTES: u64 = 64 * 1024 * 1024;

/// Rust/Tauri canonical paths use Windows verbatim prefixes. Node 26 cannot
/// resolve such a main-module argument (EISDIR at the drive root). Keep the
/// validated executable/source paths intact; adapt only the module argument.
pub(crate) fn node_entrypoint(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        let mut parts = path.components();
        if let Some(Component::Prefix(prefix)) = parts.next() {
            let mut normal = match prefix.kind() {
                Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:\\", drive as char)),
                Prefix::VerbatimUNC(server, share) => {
                    let mut root = std::ffi::OsString::from(r"\\");
                    root.push(server);
                    root.push(r"\");
                    root.push(share);
                    PathBuf::from(root)
                }
                _ => return path.to_path_buf(),
            };
            for part in parts {
                if !matches!(part, Component::RootDir) {
                    normal.push(part.as_os_str());
                }
            }
            return normal;
        }
    }
    path.to_path_buf()
}

#[derive(Clone, Debug)]
pub struct ReplayRunner {
    node: PathBuf,
    helper: PathBuf,
    timeout: Duration,
}

impl ReplayRunner {
    pub fn new(node: PathBuf, helper: PathBuf) -> Self {
        Self {
            node,
            helper,
            timeout: Duration::from_secs(45),
        }
    }

    pub fn available(&self) -> bool {
        self.node.is_file() && self.helper.is_file()
    }
    pub(crate) fn resources_root(&self) -> Option<PathBuf> {
        Some(self.helper.parent()?.parent()?.to_path_buf())
    }

    pub async fn request(&self, command: &str, payload: Value) -> Result<Value, String> {
        if !self.available() {
            return Err("The bundled replay compatibility worker is unavailable.".into());
        }
        let request = serde_json::to_vec(&json!({"command": command, "payload": payload}))
            .map_err(|e| e.to_string())?;
        if request.len() > MAX_REQUEST_BYTES {
            return Err("Replay worker request exceeds the supported size.".into());
        }
        let mut process = tokio::process::Command::new(&self.node);
        process
            .arg("--max-old-space-size=384")
            .arg(node_entrypoint(&self.helper))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        process.creation_flags(0x08000000); // CREATE_NO_WINDOW; only this owned child.
        let mut child = process.spawn().map_err(|e| format!("Replay worker: {e}"))?;
        let mut input = child
            .stdin
            .take()
            .ok_or("Replay worker stdin is unavailable.")?;
        let output = child
            .stdout
            .take()
            .ok_or("Replay worker stdout is unavailable.")?;
        let work = async {
            input.write_all(&request).await.map_err(|e| e.to_string())?;
            input.write_all(b"\n").await.map_err(|e| e.to_string())?;
            drop(input);
            let mut bytes = Vec::new();
            output
                .take(MAX_RESPONSE_BYTES + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|e| e.to_string())?;
            if bytes.len() as u64 > MAX_RESPONSE_BYTES {
                return Err("Replay worker response exceeds the supported size.".into());
            }
            let status = child.wait().await.map_err(|e| e.to_string())?;
            if !status.success() {
                // A worker may report a concrete bounded protocol error and
                // exit nonzero. Preserve that error, but never accept an
                // apparent success from a process which failed.
                if serde_json::from_slice::<Value>(&bytes)
                    .ok()
                    .is_some_and(|response| response.get("ok") == Some(&Value::Bool(false)))
                {
                    return decode_response(&bytes);
                }
                return Err("Replay worker exited without a successful result.".into());
            }
            decode_response(&bytes)
        };
        match tokio::time::timeout(self.timeout, work).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(error)) => {
                // An invalid/oversized response can arrive while the child is
                // still alive. Reap that owned child before returning the error.
                let _ = child.kill().await;
                let _ = child.wait().await;
                Err(error)
            }
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                Err("Replay analysis timed out after 45 seconds.".into())
            }
        }
    }

    pub async fn metadata(&self, file: &ReplayFile, user_name: &str) -> Result<Value, String> {
        validate_replay(&file.path)?;
        self.request(
            "metadata",
            json!({
                "file": {"path": file.path, "modifiedAt": file.modified_at},
                "userName": user_name
            }),
        )
        .await
    }

    pub async fn analysis(&self, path: &Path, opponent: Option<&str>) -> Result<Value, String> {
        validate_replay(path)?;
        self.request(
            "analysis",
            json!({"replayPath":path,"opponentName":opponent}),
        )
        .await
    }
    pub async fn postmatch(&self, path: &Path) -> Result<Value, String> {
        validate_replay(path).map_err(|_| "The match replay is unavailable or unsupported")?;
        self.request("postMatchFacts", json!({"replayPath":path,"duration":20}))
            .await
    }
}

fn decode_response(bytes: &[u8]) -> Result<Value, String> {
    let response: Value = serde_json::from_slice(bytes)
        .map_err(|_| "Replay worker returned an invalid response.".to_owned())?;
    match response.get("ok").and_then(Value::as_bool) {
        Some(true) => response
            .get("result")
            .cloned()
            .ok_or_else(|| "Replay worker omitted its result.".into()),
        Some(false) => Err(response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Replay worker failed.")
            .chars()
            .take(2048)
            .collect()),
        None => Err("Replay worker omitted its response status.".into()),
    }
}

pub fn validate_replay(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || !path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("SC2Replay"))
    {
        return Err("Choose an existing regular .SC2Replay file.".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("Replay reparse points are not supported.".into());
        }
    }
    if metadata.len() == 0 || metadata.len() > MAX_REPLAY_BYTES {
        return Err("Replay size is outside the supported range.".into());
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub struct ReplayFile {
    pub path: PathBuf,
    pub modified_at: String,
}

/// Bounded scan with no symbolic-link or Windows junction traversal.
pub fn scan_replays(root: &Path) -> Result<Vec<ReplayFile>, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    if !root.is_dir() {
        return Err("Replay directory does not exist.".into());
    }
    let mut pending = vec![(root, 0_usize)];
    let mut files = Vec::new();
    let mut visited = 0_usize;
    while let Some((directory, depth)) = pending.pop() {
        if depth > 32 {
            return Err("Replay directory nesting exceeds 32 levels.".into());
        }
        for entry in std::fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            visited += 1;
            if visited > 100_000 {
                return Err("Replay scan exceeds 100000 entries.".into());
            }
            let metadata = std::fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    continue;
                }
            }
            if metadata.is_dir() {
                pending.push((entry.path(), depth + 1));
            } else if metadata.is_file()
                && entry
                    .path()
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("SC2Replay"))
            {
                let modified: chrono::DateTime<chrono::Utc> =
                    metadata.modified().map_err(|e| e.to_string())?.into();
                files.push(ReplayFile {
                    path: entry.path(),
                    modified_at: modified.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                });
            }
        }
    }
    files.sort_by(|a, b| {
        b.modified_at
            .cmp(&a.modified_at)
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_protocol_never_reports_missing_or_failed_result_as_success() {
        assert_eq!(
            decode_response(br#"{"ok":true,"result":{"players":[]}}"#).unwrap(),
            json!({"players":[]})
        );
        assert!(decode_response(br#"{"ok":true}"#).is_err());
        assert!(
            decode_response(br#"{"ok":false,"error":"unsupported build"}"#)
                .unwrap_err()
                .contains("unsupported build")
        );
        assert!(decode_response(b"garbage").is_err());
    }

    #[test]
    fn scan_is_recursive_case_insensitive_and_does_not_modify_original() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("Account")).unwrap();
        let replay = root.path().join("Account/match.SC2Replay");
        std::fs::write(&replay, b"source").unwrap();
        std::fs::write(root.path().join("other.txt"), b"skip").unwrap();
        let files = scan_replays(root.path()).unwrap();
        assert_eq!(files.len(), 1);
        assert!(files[0].path.ends_with("Account/match.SC2Replay"));
        assert_eq!(std::fs::read(replay).unwrap(), b"source");
    }

    #[test]
    fn invalid_replay_types_and_empty_files_are_rejected_without_writes() {
        let directory = tempfile::tempdir().unwrap();
        let text = directory.path().join("not-a-replay.txt");
        std::fs::write(&text, b"source").unwrap();
        assert!(validate_replay(&text).is_err());
        let empty = directory.path().join("empty.SC2Replay");
        std::fs::write(&empty, []).unwrap();
        assert!(validate_replay(&empty).is_err());
        assert_eq!(std::fs::read(&text).unwrap(), b"source");
    }

    fn node() -> PathBuf {
        let name = if cfg!(windows) { "node.exe" } else { "node" };
        std::env::var_os("PATH")
            .and_then(|paths| {
                std::env::split_paths(&paths)
                    .map(|path| path.join(name))
                    .find(|path| path.is_file())
            })
            .expect("Node is a required development dependency for replay-worker integration tests")
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn canonical_windows_module_path_with_spaces_and_unicode_starts_node() {
        let directory = tempfile::tempdir().unwrap();
        let folder = directory.path().join("worker path Юникод");
        std::fs::create_dir(&folder).unwrap();
        let helper = folder.join("worker.mjs");
        std::fs::write(&helper,"process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({ok:true,result:{started:true}}))); ").unwrap();
        let canonical = helper.canonicalize().unwrap();
        assert!(canonical.to_string_lossy().starts_with(r"\\?\"));
        let runner = ReplayRunner::new(node().canonicalize().unwrap(), canonical);
        assert_eq!(
            runner.request("metadata", Value::Null).await.unwrap()["started"],
            true
        );
    }

    #[cfg(windows)]
    #[test]
    fn node_entrypoint_preserves_unc_roots_and_does_not_rewrite_device_paths() {
        assert_eq!(
            node_entrypoint(Path::new(r"\\?\UNC\server\share\space dir\worker.mjs")),
            PathBuf::from(r"\\server\share\space dir\worker.mjs")
        );
        assert_eq!(
            node_entrypoint(Path::new(r"\\?\GLOBALROOT\Device\worker.mjs")),
            PathBuf::from(r"\\?\GLOBALROOT\Device\worker.mjs")
        );
    }

    #[tokio::test]
    async fn malformed_worker_is_reaped_instead_of_lingering() {
        let directory = tempfile::tempdir().unwrap();
        let helper = directory.path().join("worker.cjs");
        let pid_path = directory.path().join("pid");
        // A worker which never closes stdout must be killed by the deadline.
        std::fs::write(&helper,format!("require('node:fs').writeFileSync({},String(process.pid)); process.stdout.write('malformed'); setInterval(()=>{{}},1000);",serde_json::to_string(&pid_path).unwrap())).unwrap();
        let mut runner = ReplayRunner::new(node(), helper);
        runner.timeout = Duration::from_secs(1);
        let started = std::time::Instant::now();
        assert!(
            runner
                .request("metadata", Value::Null)
                .await
                .unwrap_err()
                .contains("timed out")
        );
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_child_dead(&pid_path);
    }

    #[tokio::test]
    async fn worker_failures_and_invalid_protocol_are_not_success() {
        let directory = tempfile::tempdir().unwrap();
        let helper = directory.path().join("worker.cjs");
        std::fs::write(&helper,"process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({ok:false,error:'Unsupported build'})));").unwrap();
        let runner = ReplayRunner::new(node(), helper.clone());
        assert_eq!(
            runner
                .request("metadata", json!({"path":"test"}))
                .await
                .unwrap_err(),
            "Unsupported build"
        );
        std::fs::write(
            helper,
            "process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write('{}'));",
        )
        .unwrap();
        assert!(
            runner
                .request("metadata", Value::Null)
                .await
                .unwrap_err()
                .contains("response status")
        );
    }

    #[tokio::test]
    async fn nonzero_worker_preserves_declared_error_but_rejects_declared_success() {
        let directory = tempfile::tempdir().unwrap();
        let helper = directory.path().join("worker.cjs");
        std::fs::write(&helper,"process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({ok:false,error:'Unsupported replay build 12345'}),()=>process.exit(1)));").unwrap();
        let runner = ReplayRunner::new(node(), helper.clone());
        assert_eq!(
            runner.request("metadata", Value::Null).await.unwrap_err(),
            "Unsupported replay build 12345"
        );
        std::fs::write(&helper,"process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({ok:true,result:{players:[]}}),()=>process.exit(1)));").unwrap();
        assert_eq!(
            runner.request("metadata", Value::Null).await.unwrap_err(),
            "Replay worker exited without a successful result."
        );
        std::fs::write(&helper,"process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write('not JSON',()=>process.exit(1)));").unwrap();
        assert_eq!(
            runner.request("metadata", Value::Null).await.unwrap_err(),
            "Replay worker exited without a successful result."
        );
    }

    fn assert_child_dead(pid_path: &Path) {
        let pid = std::fs::read_to_string(pid_path).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let result=std::process::Command::new(node()).args(["-e","try { process.kill(Number(process.argv[1]),0); process.exit(1); } catch { process.exit(0); }",pid.trim()]).status().unwrap();
            if result.success() {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "Owned worker still exists after cancellation/timeout"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    #[tokio::test]
    async fn cancelling_request_kills_its_owned_child() {
        let directory = tempfile::tempdir().unwrap();
        let helper = directory.path().join("worker.cjs");
        let pid_path = directory.path().join("pid");
        std::fs::write(&helper,format!("require('node:fs').writeFileSync({},String(process.pid)); setInterval(()=>{{}},1000);",serde_json::to_string(&pid_path).unwrap())).unwrap();
        let runner = ReplayRunner::new(node(), helper);
        let task = tokio::spawn(async move { runner.request("metadata", Value::Null).await });
        tokio::time::timeout(Duration::from_secs(5), async {
            while !pid_path.is_file() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("Fake worker did not start");
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_child_dead(&pid_path);
    }
}
