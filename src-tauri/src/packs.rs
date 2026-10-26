//! Sample packs: the built-in catalogue and the downloader.
//!
//! A pack is any `strudel.json`-style manifest (`{ "_base": url, sound: files }`
//! where files is a path, a list of paths, or note → path(s) for pitched
//! sounds). Installing downloads every file into `samples/packs/.<id>.partial/`
//! as `<sound>/NN_<name>`, so the manifest order becomes the sample index, then
//! moves the folder into place. A failed install keeps the partial folder and
//! a retry skips files it already has.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::error::{Error, Result};
use crate::samples::{PackMeta, is_valid_name, packs_dir};

const CATALOGUE: &str = include_str!("../resources/packs.json");
const CONCURRENCY: usize = 8;
const ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueEntry {
    pub id: String,
    pub name: String,
    pub source: String,
    pub description: String,
    pub sounds: usize,
    pub files: usize,
}

pub fn catalogue() -> Vec<CatalogueEntry> {
    serde_json::from_str(CATALOGUE).expect("resources/packs.json is valid")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub id: String,
    pub done: usize,
    pub total: usize,
    pub failed: usize,
}

/// Cancellation flags for installs in flight, by pack id.
#[derive(Default)]
pub struct Downloads(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl Downloads {
    pub fn cancel(&self, id: &str) {
        if let Some(flag) = self.0.lock().unwrap().get(id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

struct Job {
    url: String,
    dest: PathBuf,
}

/// `github:user/repo[/branch[/path]]` → the raw URL of its `strudel.json`.
/// Plain URLs pass through.
pub fn manifest_url(source: &str) -> Result<String> {
    if let Some(path) = source.strip_prefix("github:") {
        return Ok(format!("{}strudel.json", github_base(path)));
    }
    if source.starts_with("https://") || source.starts_with("http://") {
        return Ok(source.to_string());
    }
    Err(Error::Pack(format!("expected a URL or github:user/repo, got \"{source}\"")))
}

fn github_base(path: &str) -> String {
    let mut parts = path.trim_end_matches('/').split('/');
    let user = parts.next().unwrap_or_default();
    let repo = parts.next().unwrap_or("samples");
    let branch = parts.next().unwrap_or("main");
    let rest: String = parts.map(|p| format!("{p}/")).collect();
    format!("https://raw.githubusercontent.com/{user}/{repo}/{branch}/{rest}")
}

/// A pack id for a custom source: the repo name or the manifest's file stem.
pub fn default_id(source: &str) -> String {
    let trimmed = source.trim_end_matches('/');
    let name = match trimmed.strip_prefix("github:") {
        Some(path) => path.split('/').nth(1).unwrap_or(path),
        None => {
            let last = trimmed.rsplit('/').next().unwrap_or(trimmed);
            last.strip_suffix(".json").unwrap_or(last)
        }
    };
    let id: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    id.trim_matches('-').to_lowercase()
}

pub async fn install(
    app: &AppHandle,
    downloads: &Downloads,
    root: &Path,
    id: &str,
    name: &str,
    source: &str,
) -> Result<()> {
    if !is_valid_name(id) {
        return Err(Error::Pack(format!("invalid pack id \"{id}\"")));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut map = downloads.0.lock().unwrap();
        if map.contains_key(id) {
            return Err(Error::Pack(format!("{id} is already downloading")));
        }
        map.insert(id.to_string(), cancel.clone());
    }
    let result = run_install(app, &cancel, root, id, name, source).await;
    downloads.0.lock().unwrap().remove(id);
    result
}

async fn run_install(
    app: &AppHandle,
    cancel: &AtomicBool,
    root: &Path,
    id: &str,
    name: &str,
    source: &str,
) -> Result<()> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("uaithne/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .build()?;
    let url = manifest_url(source)?;
    let body = client.get(&url).send().await?.error_for_status()?.bytes().await?;
    let manifest: Value = serde_json::from_slice(&body)?;

    let partial = packs_dir(root).join(format!(".{id}.partial"));
    let (jobs, pitched) = plan(&manifest, &url, &partial)?;
    let total = jobs.len();
    if total == 0 {
        return Err(Error::Pack(format!("{url} lists no samples")));
    }

    let done = AtomicUsize::new(0);
    let failed = AtomicUsize::new(0);
    let progress = |done: usize, failed: usize| {
        let _ = app.emit("pack-progress", Progress { id: id.to_string(), done, total, failed });
    };
    progress(0, 0);
    let errors: Vec<String> = futures_util::stream::iter(jobs)
        .map(|job| {
            let (client, done, failed, progress) = (&client, &done, &failed, &progress);
            async move {
                if cancel.load(Ordering::Relaxed) {
                    return None;
                }
                let res = fetch_to(client, &job, cancel).await;
                let f = match res {
                    Ok(()) => failed.load(Ordering::Relaxed),
                    Err(_) => failed.fetch_add(1, Ordering::Relaxed) + 1,
                };
                progress(done.fetch_add(1, Ordering::Relaxed) + 1, f);
                res.err().map(|e| format!("{}: {e}", job.url))
            }
        })
        .buffer_unordered(CONCURRENCY)
        .filter_map(|e| async move { e })
        .collect()
        .await;

    if cancel.load(Ordering::Relaxed) {
        let _ = std::fs::remove_dir_all(&partial);
        return Err(Error::Pack("cancelled".into()));
    }
    if let Some(first) = errors.first() {
        return Err(Error::Pack(format!(
            "{} of {total} files failed (first: {first}). Install again to retry the rest.",
            errors.len()
        )));
    }

    let installed = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let meta = PackMeta { id: id.into(), name: name.into(), source: source.into(), installed, pitched };
    std::fs::write(partial.join("pack.json"), serde_json::to_string_pretty(&meta)?)?;
    let target = packs_dir(root).join(id);
    if target.exists() {
        std::fs::remove_dir_all(&target)?;
    }
    std::fs::rename(&partial, &target)?;
    Ok(())
}

/// Turns a manifest into download jobs and the pitched-sound map for pack.json.
fn plan(
    manifest: &Value,
    manifest_url: &str,
    dest: &Path,
) -> Result<(Vec<Job>, BTreeMap<String, BTreeMap<String, Vec<String>>>)> {
    let obj = manifest.as_object().ok_or_else(|| Error::Pack("manifest is not a JSON object".into()))?;
    let default_base = manifest_url.rsplit_once('/').map_or(String::new(), |(dir, _)| format!("{dir}/"));
    let base = resolve_base(obj.get("_base").and_then(Value::as_str), &default_base);

    let mut jobs = Vec::new();
    let mut pitched = BTreeMap::new();
    for (sound, value) in obj {
        if sound.starts_with('_') || !is_valid_name(sound) {
            continue;
        }
        // Flatten to (note, path) in manifest order.
        let mut entries: Vec<(Option<&str>, &str)> = Vec::new();
        let mut sound_base = base.clone();
        match value {
            Value::String(path) => entries.push((None, path)),
            Value::Array(paths) => entries.extend(paths.iter().filter_map(Value::as_str).map(|p| (None, p))),
            Value::Object(notes) => {
                if let Some(b) = notes.get("_base").and_then(Value::as_str) {
                    sound_base = resolve_base(Some(b), &base);
                }
                for (note, paths) in notes.iter().filter(|(k, _)| !k.starts_with('_')) {
                    match paths {
                        Value::String(p) => entries.push((Some(note), p)),
                        Value::Array(ps) => entries.extend(ps.iter().filter_map(Value::as_str).map(|p| (Some(note.as_str()), p))),
                        _ => {}
                    }
                }
            }
            _ => continue,
        }
        let width = (entries.len().saturating_sub(1)).to_string().len().max(2);
        let mut notes: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (i, (note, path)) in entries.into_iter().enumerate() {
            let absolute = path.starts_with("http://") || path.starts_with("https://");
            // Relative paths are file paths, so a `#` or `?` is part of the name.
            let path = if absolute { path.to_string() } else { escape_path(path) };
            let file = format!("{i:0width$}_{}", file_name(&path));
            if let Some(note) = note {
                notes.entry(note.to_string()).or_default().push(file.clone());
            }
            let url = if absolute { path } else { format!("{sound_base}{path}") };
            jobs.push(Job { url, dest: dest.join(sound).join(file) });
        }
        if !notes.is_empty() {
            pitched.insert(sound.clone(), notes);
        }
    }
    Ok((jobs, pitched))
}

fn resolve_base(base: Option<&str>, default: &str) -> String {
    match base {
        Some(b) if b.starts_with("github:") => github_base(&b["github:".len()..]),
        Some(b) => b.to_string(),
        None => default.to_string(),
    }
}

/// Escapes the characters that would end a URL path (`#`, `?`) and any `%`
/// that doesn't start an escape (`200%_1000.wav`), keeping existing escapes.
fn escape_path(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut out = String::with_capacity(path.len());
    for (i, c) in path.char_indices() {
        match c {
            '#' => out.push_str("%23"),
            '?' => out.push_str("%3F"),
            '%' if !(bytes.len() > i + 2 && bytes[i + 1].is_ascii_hexdigit() && bytes[i + 2].is_ascii_hexdigit()) => {
                out.push_str("%25")
            }
            c => out.push(c),
        }
    }
    out
}

/// The decoded last path segment, made safe for the filesystem.
fn file_name(path: &str) -> String {
    let last = path.split(['?', '#']).next().unwrap_or(path).rsplit('/').next().unwrap_or(path);
    let decoded = percent_encoding::percent_decode_str(last).decode_utf8_lossy();
    decoded.chars().map(|c| if matches!(c, '/' | '\\' | '\0') { '_' } else { c }).collect()
}

async fn fetch_to(client: &reqwest::Client, job: &Job, cancel: &AtomicBool) -> Result<()> {
    if std::fs::metadata(&job.dest).is_ok_and(|m| m.len() > 0) {
        return Ok(());
    }
    let mut last = None;
    for attempt in 0..ATTEMPTS {
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::Pack("cancelled".into()));
        }
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(500 << attempt)).await;
        }
        match download(client, &job.url).await {
            Ok(bytes) => {
                let dir = job.dest.parent().expect("job paths have a sound folder");
                tokio::fs::create_dir_all(dir).await?;
                let tmp = job.dest.with_extension("part");
                tokio::fs::write(&tmp, &bytes).await?;
                tokio::fs::rename(&tmp, &job.dest).await?;
                return Ok(());
            }
            Err(e) => last = Some(e),
        }
    }
    Err(last.expect("at least one attempt"))
}

async fn download(client: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    let res = client.get(url).timeout(Duration::from_secs(60)).send().await?.error_for_status()?;
    Ok(res.bytes().await?.to_vec())
}

/// Deletes an installed pack (and any partial download of it).
pub fn remove(root: &Path, id: &str) -> Result<()> {
    if !is_valid_name(id) {
        return Err(Error::Pack(format!("invalid pack id \"{id}\"")));
    }
    let dir = packs_dir(root);
    for path in [dir.join(id), dir.join(format!(".{id}.partial"))] {
        if path.exists() {
            std::fs::remove_dir_all(path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn github_sources() {
        assert_eq!(
            manifest_url("github:tidalcycles/dirt-samples").unwrap(),
            "https://raw.githubusercontent.com/tidalcycles/dirt-samples/main/strudel.json"
        );
        assert_eq!(
            manifest_url("github:a/b/dev/sub").unwrap(),
            "https://raw.githubusercontent.com/a/b/dev/sub/strudel.json"
        );
        assert_eq!(default_id("github:tidalcycles/Dirt-Samples"), "dirt-samples");
        assert_eq!(default_id("https://x.org/foo/My Pack.json"), "my-pack");
    }

    #[test]
    fn plans_indexed_files() {
        let manifest = json!({
            "_base": "https://h/",
            "bd": ["bd/a.wav", "bd/b%20c.wav"],
            "sd": "sd/x.wav",
            "piano": { "C4": "C4.mp3", "A4": ["A4a.mp3", "A4b.mp3"] },
            "_ignored": "x",
        });
        let (jobs, pitched) = plan(&manifest, "https://m/strudel.json", Path::new("/d")).unwrap();
        let urls: Vec<_> = jobs.iter().map(|j| (j.url.as_str(), j.dest.to_str().unwrap())).collect();
        assert!(urls.contains(&("https://h/bd/b%20c.wav", "/d/bd/01_b c.wav")));
        assert!(urls.contains(&("https://h/sd/x.wav", "/d/sd/00_x.wav")));
        assert_eq!(jobs.len(), 6);
        assert_eq!(escape_path("mute/000_FH A#2 SCF.wav"), "mute/000_FH A%232 SCF.wav");
        assert_eq!(escape_path("h/001_0_da0-200%_1000_0_R.wav"), "h/001_0_da0-200%25_1000_0_R.wav");
        assert_eq!(file_name(&escape_path("h/x?%_1.wav")), "x?%_1.wav");
        // serde_json maps are sorted, so A4 comes before C4.
        assert_eq!(pitched["piano"]["A4"], vec!["00_A4a.mp3", "01_A4b.mp3"]);
    }
}
