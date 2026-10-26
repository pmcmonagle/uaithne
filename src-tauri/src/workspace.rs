//! The workspace folder: layout, `uaithne.toml`, track files and the file watcher.

use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::error::{Error, Result};

pub const TRACK_EXTENSIONS: &[&str] = &["strudel", "tidal"];

const TEMPLATE_CONFIG: &str = include_str!("../resources/workspace/uaithne.toml");
const TEMPLATE_TRACKS: &[(&str, &str)] = &[
    ("hello.strudel", include_str!("../resources/workspace/tracks/hello.strudel")),
    ("hello.tidal", include_str!("../resources/workspace/tracks/hello.tidal")),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub editor: EditorConfig,
    pub tidal: TidalConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct EditorConfig {
    pub vim: bool,
    pub font_size: u32,
    /// What `<leader>` means in vim mappings.
    pub leader: String,
    /// vimrc-style mappings, e.g. `inoremap jk <Esc>`.
    pub vim_mappings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TidalConfig {
    /// Command for GHCi, e.g. `ghci` or `stack exec -- ghci`.
    pub ghci: String,
    /// Your own BootTidal.hs; empty uses Uaithne's.
    pub boot_file: String,
    pub sclang: String,
    /// Port SuperDirt listens on (and Tidal sends to).
    pub port: u16,
    /// PipeWire sink for SuperCollider, or "default".
    pub output: String,
    /// Have Tidal report where events come from, to highlight them.
    pub highlight: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self { editor: EditorConfig::default(), tidal: TidalConfig::default() }
    }
}

impl Default for TidalConfig {
    fn default() -> Self {
        Self {
            ghci: "ghci".into(),
            boot_file: String::new(),
            sclang: "sclang".into(),
            port: 57120,
            output: "default".into(),
            highlight: true,
        }
    }
}

pub fn load_config(root: &Path) -> Result<Config> {
    Ok(toml::from_str(&std::fs::read_to_string(root.join("uaithne.toml"))?)?)
}

impl Default for EditorConfig {
    fn default() -> Self {
        Self { vim: true, font_size: 15, leader: "\\".into(), vim_mappings: Vec::new() }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub root: PathBuf,
    pub config: Config,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackInfo {
    /// Path relative to `tracks/`, always `/`-separated.
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TracksChanged {
    pub paths: Vec<String>,
}

pub struct Workspace {
    pub root: PathBuf,
    _watcher: RecommendedWatcher,
    _samples_watcher: RecommendedWatcher,
}

impl Workspace {
    /// Opens `root` as a workspace, creating the folder layout and example
    /// tracks if it isn't one yet, and starts watching `tracks/`.
    pub fn open(app: &AppHandle, root: PathBuf) -> Result<(Self, WorkspaceInfo)> {
        migrate_from_yuzu(&root)?;
        let fresh = !root.join("uaithne.toml").exists();
        for dir in ["tracks", "samples/local", "samples/packs", "recordings"] {
            std::fs::create_dir_all(root.join(dir))?;
        }
        if fresh {
            std::fs::write(root.join("uaithne.toml"), TEMPLATE_CONFIG)?;
            for (name, body) in TEMPLATE_TRACKS {
                let path = root.join("tracks").join(name);
                if !path.exists() {
                    std::fs::write(path, body)?;
                }
            }
        }
        let config = load_config(&root)?;
        let watcher = watch_tracks(app.clone(), root.join("tracks"))?;
        let samples_watcher = crate::samples::watch(app.clone(), crate::samples::samples_dir(&root))?;
        let info = WorkspaceInfo { root: root.clone(), config };
        Ok((Self { root, _watcher: watcher, _samples_watcher: samples_watcher }, info))
    }

    fn tracks_dir(&self) -> PathBuf {
        self.root.join("tracks")
    }

    /// Resolves a frontend-supplied track path, rejecting anything that could
    /// escape `tracks/` or isn't a track file.
    fn resolve(&self, rel: &str) -> Result<PathBuf> {
        let invalid = || Error::InvalidPath(rel.to_string());
        let path = Path::new(rel);
        if rel.is_empty() || !is_track_file(path) {
            return Err(invalid());
        }
        for component in path.components() {
            match component {
                Component::Normal(part) if !part.to_string_lossy().starts_with('.') => {}
                _ => return Err(invalid()),
            }
        }
        Ok(self.tracks_dir().join(path))
    }

    pub fn list_tracks(&self) -> Result<Vec<TrackInfo>> {
        let mut tracks = Vec::new();
        collect_tracks(&self.tracks_dir(), &self.tracks_dir(), &mut tracks)?;
        tracks.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(tracks)
    }

    pub fn read_track(&self, rel: &str) -> Result<String> {
        Ok(std::fs::read_to_string(self.resolve(rel)?)?)
    }

    /// Writes via a temp file and rename, so a crash mid-save can't truncate a track.
    /// Emptying a non-empty track first copies the old version to the trash.
    pub fn write_track(&self, rel: &str, content: &str) -> Result<()> {
        let path = self.resolve(rel)?;
        if content.trim().is_empty() && std::fs::metadata(&path).is_ok_and(|m| m.len() > 0) {
            std::fs::copy(&path, self.trash_path(rel)?)?;
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_file_name(format!(
            ".{}.tmp",
            path.file_name().unwrap_or_default().to_string_lossy()
        ));
        std::fs::write(&tmp, content)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    pub fn create_track(&self, rel: &str, content: &str) -> Result<()> {
        if self.resolve(rel)?.exists() {
            return Err(Error::AlreadyExists(rel.to_string()));
        }
        self.write_track(rel, content)
    }

    pub fn rename_track(&self, from: &str, to: &str) -> Result<()> {
        let (src, dst) = (self.resolve(from)?, self.resolve(to)?);
        if dst.exists() {
            return Err(Error::AlreadyExists(to.to_string()));
        }
        if let Some(dir) = dst.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::rename(src, dst)?;
        Ok(())
    }

    /// Moves the track into `.uaithne/trash/` rather than deleting it outright.
    pub fn delete_track(&self, rel: &str) -> Result<()> {
        let src = self.resolve(rel)?;
        std::fs::rename(src, self.trash_path(rel)?)?;
        Ok(())
    }

    /// A fresh `.uaithne/trash/<unix time>-<path with / as __>` for a track.
    fn trash_path(&self, rel: &str) -> Result<PathBuf> {
        let trash = self.root.join(".uaithne").join("trash");
        std::fs::create_dir_all(&trash)?;
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        Ok(trash.join(format!("{stamp}-{}", rel.replace('/', "__"))))
    }
}

/// Renames a workspace made before the app was renamed (Yuzu → Uaithne):
/// `yuzu.toml` and `.yuzu/` take the new names, unless those exist already.
fn migrate_from_yuzu(root: &Path) -> Result<()> {
    for (old, new) in [("yuzu.toml", "uaithne.toml"), (".yuzu", ".uaithne")] {
        let (old, new) = (root.join(old), root.join(new));
        if old.exists() && !new.exists() {
            std::fs::rename(old, new)?;
        }
    }
    Ok(())
}

fn is_track_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| TRACK_EXTENSIONS.contains(&e))
}

fn is_hidden(path: &Path) -> bool {
    path.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'))
}

fn relative(base: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(base).ok()?;
    let parts: Vec<_> = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect();
    Some(parts.join("/"))
}

fn collect_tracks(base: &Path, dir: &Path, out: &mut Vec<TrackInfo>) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if is_hidden(&path) {
            continue;
        }
        if path.is_dir() {
            collect_tracks(base, &path, out)?;
        } else if is_track_file(&path) {
            if let Some(rel) = relative(base, &path) {
                out.push(TrackInfo { path: rel });
            }
        }
    }
    Ok(())
}

/// Emits `tracks-changed` with the affected track paths. The frontend
/// debounces these and ignores changes that match what it last saved.
fn watch_tracks(app: AppHandle, dir: PathBuf) -> Result<RecommendedWatcher> {
    let base = dir.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if event.kind.is_access() {
            return;
        }
        let paths: Vec<String> = event
            .paths
            .iter()
            // Directories count too: renaming or deleting a folder moves its tracks.
            .filter(|p| !is_hidden(p) && (is_track_file(p) || p.extension().is_none()))
            .filter_map(|p| relative(&base, p))
            .collect();
        if !paths.is_empty() {
            let _ = app.emit("tracks-changed", TracksChanged { paths });
        }
    })?;
    watcher.watch(&dir, RecursiveMode::Recursive)?;
    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_a_yuzu_workspace() {
        let root = std::env::temp_dir().join(format!("uaithne-migrate-test-{}", std::process::id()));
        std::fs::create_dir_all(root.join(".yuzu/trash")).unwrap();
        std::fs::write(root.join("yuzu.toml"), "[editor]\nvim = false\n").unwrap();
        migrate_from_yuzu(&root).unwrap();
        assert!(!root.join("yuzu.toml").exists() && root.join(".uaithne/trash").is_dir());
        assert!(!load_config(&root).unwrap().editor.vim);

        // An existing uaithne.toml wins; the old file is left alone.
        std::fs::write(root.join("yuzu.toml"), "old").unwrap();
        migrate_from_yuzu(&root).unwrap();
        assert!(root.join("yuzu.toml").exists());
        assert!(!load_config(&root).unwrap().editor.vim);
        std::fs::remove_dir_all(root).unwrap();
    }
}
