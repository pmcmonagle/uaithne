//! The sample library: scanning `samples/`, watching it, and serving files to
//! the webview over the `uaithne://` protocol.
//!
//! Layout: `samples/local/**/<sound>/<files>` (any folder holding audio files is
//! a sound) and `samples/packs/<pack>/<sound>/<files>`. Files sort by name and
//! that order is the sample index, so `bd:3` means the same file everywhere.

use std::collections::{BTreeMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::http::{Response, StatusCode, header};
use tauri::{AppHandle, Emitter};

use crate::error::Result;

pub const AUDIO_EXTENSIONS: &[&str] =
    &["wav", "wave", "flac", "mp3", "ogg", "opus", "aif", "aiff", "m4a"];

/// What a pack install writes to `samples/packs/<pack>/pack.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackMeta {
    pub id: String,
    pub name: String,
    /// The manifest it came from: a URL or `github:user/repo`.
    pub source: String,
    /// Unix seconds.
    pub installed: u64,
    /// Pitched sounds: sound → note → file names in the sound's folder.
    #[serde(default)]
    pub pitched: BTreeMap<String, BTreeMap<String, Vec<String>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sound {
    pub name: String,
    /// `local` or the pack id.
    pub origin: String,
    /// Paths relative to the workspace root, `/`-separated, in index order.
    pub files: Vec<String>,
    /// For pitched sounds, note → indices into `files`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<BTreeMap<String, Vec<usize>>>,
    /// Newest file mtime, so changed files get fresh URLs.
    pub stamp: u64,
    /// Another sound with the same name takes precedence.
    pub shadowed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPack {
    pub id: String,
    pub name: String,
    pub source: Option<String>,
    pub sounds: usize,
    pub files: usize,
    pub bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    /// Precedence order: local first, then packs by id.
    pub sounds: Vec<Sound>,
    pub packs: Vec<InstalledPack>,
}

pub fn samples_dir(root: &Path) -> PathBuf {
    root.join("samples")
}

pub fn packs_dir(root: &Path) -> PathBuf {
    samples_dir(root).join("packs")
}

pub fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

fn is_hidden(path: &Path) -> bool {
    path.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'))
}

/// A name that is safe as a single path component and as a sound name.
pub fn is_valid_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.contains(['/', '\\', '\0'])
        && !name.chars().any(char::is_whitespace)
}

pub fn scan(root: &Path) -> Result<Library> {
    let mut library = Library::default();
    let local = samples_dir(root).join("local");
    if local.is_dir() {
        scan_local(root, &local, &mut library.sounds)?;
    }
    let packs = packs_dir(root);
    if packs.is_dir() {
        let mut dirs: Vec<_> = sorted_entries(&packs)?.into_iter().filter(|p| p.is_dir()).collect();
        dirs.retain(|p| !is_hidden(p));
        for dir in dirs {
            let (pack, sounds) = scan_pack(root, &dir)?;
            library.packs.push(pack);
            library.sounds.extend(sounds);
        }
    }
    let mut seen = HashSet::new();
    for sound in &mut library.sounds {
        sound.shadowed = !seen.insert(sound.name.clone());
    }
    Ok(library)
}

fn sorted_entries(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut entries = std::fs::read_dir(dir)?
        .map(|e| e.map(|e| e.path()))
        .collect::<std::io::Result<Vec<_>>>()?;
    entries.sort();
    Ok(entries)
}

/// Every non-hidden folder under `samples/local` that holds audio files is a sound.
fn scan_local(root: &Path, dir: &Path, out: &mut Vec<Sound>) -> Result<()> {
    let entries = sorted_entries(dir)?;
    if let Some(sound) = sound_from_dir(root, dir, "local")? {
        out.push(sound);
    }
    for path in entries {
        if path.is_dir() && !is_hidden(&path) {
            scan_local(root, &path, out)?;
        }
    }
    Ok(())
}

fn sound_from_dir(root: &Path, dir: &Path, origin: &str) -> Result<Option<Sound>> {
    let name = dir.file_name().unwrap_or_default().to_string_lossy().to_string();
    if !is_valid_name(&name) {
        return Ok(None);
    }
    let mut files = Vec::new();
    let mut stamp = 0;
    for path in sorted_entries(dir)? {
        if path.is_file() && !is_hidden(&path) && is_audio_file(&path) {
            stamp = stamp.max(mtime(&path));
            if let Some(rel) = relative(root, &path) {
                files.push(rel);
            }
        }
    }
    if files.is_empty() {
        return Ok(None);
    }
    Ok(Some(Sound { name, origin: origin.to_string(), files, notes: None, stamp, shadowed: false }))
}

fn scan_pack(root: &Path, dir: &Path) -> Result<(InstalledPack, Vec<Sound>)> {
    let id = dir.file_name().unwrap_or_default().to_string_lossy().to_string();
    let meta: Option<PackMeta> = std::fs::read_to_string(dir.join("pack.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());
    let mut sounds = Vec::new();
    let mut bytes = 0;
    for path in sorted_entries(dir)? {
        if !path.is_dir() || is_hidden(&path) {
            continue;
        }
        let Some(mut sound) = sound_from_dir(root, &path, &id)? else { continue };
        for file in &sound.files {
            bytes += std::fs::metadata(root.join(file)).map(|m| m.len()).unwrap_or(0);
        }
        if let Some(notes) = meta.as_ref().and_then(|m| m.pitched.get(&sound.name)) {
            let index_of = |f: &String| sound.files.iter().position(|p| p.ends_with(&format!("/{f}")));
            sound.notes = Some(
                notes
                    .iter()
                    .map(|(note, files)| (note.clone(), files.iter().filter_map(index_of).collect()))
                    .collect(),
            );
        }
        sounds.push(sound);
    }
    let pack = InstalledPack {
        name: meta.as_ref().map_or_else(|| id.clone(), |m| m.name.clone()),
        source: meta.map(|m| m.source),
        id,
        sounds: sounds.len(),
        files: sounds.iter().map(|s| s.files.len()).sum(),
        bytes,
    };
    Ok((pack, sounds))
}

fn mtime(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs())
}

fn relative(base: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(base).ok()?;
    let parts: Vec<_> = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect();
    Some(parts.join("/"))
}

/// Emits `samples-changed` when anything visible under `samples/` changes.
/// Pack downloads happen in hidden `.partial` folders, so they only show up
/// once they're moved into place.
pub fn watch(app: AppHandle, dir: PathBuf) -> Result<RecommendedWatcher> {
    let base = dir.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if event.kind.is_access() {
            return;
        }
        let visible = event.paths.iter().any(|p| {
            p.strip_prefix(&base).is_ok_and(|rel| {
                !rel.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
            })
        });
        if visible {
            let _ = app.emit("samples-changed", ());
        }
    })?;
    watcher.watch(&dir, RecursiveMode::Recursive)?;
    Ok(watcher)
}

/// Handles `uaithne://localhost/<percent-encoded path>`, serving files under
/// `<workspace>/samples/` only.
pub fn serve(root: Option<PathBuf>, uri_path: &str) -> Response<Vec<u8>> {
    let not_found = || {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Vec::new())
            .unwrap()
    };
    let Some(root) = root else { return not_found() };
    let decoded = percent_encoding::percent_decode_str(uri_path.trim_start_matches('/')).decode_utf8_lossy();
    let rel = Path::new(decoded.as_ref());
    let safe = rel.starts_with("samples")
        && rel.components().all(|c| matches!(c, Component::Normal(p) if !p.to_string_lossy().starts_with('.')));
    if !safe || !is_audio_file(rel) {
        return not_found();
    }
    match std::fs::read(root.join(rel)) {
        Ok(body) => Response::builder()
            .header(header::CONTENT_TYPE, content_type(rel))
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(body)
            .unwrap(),
        Err(_) => not_found(),
    }
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("wav" | "wave") => "audio/wav",
        Some("flac") => "audio/flac",
        Some("mp3") => "audio/mpeg",
        Some("ogg") => "audio/ogg",
        Some("opus") => "audio/opus",
        Some("aif" | "aiff") => "audio/aiff",
        Some("m4a") => "audio/mp4",
        _ => "application/octet-stream",
    }
}
