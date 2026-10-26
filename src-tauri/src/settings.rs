//! Per-machine app settings (last workspace, volume), stored as JSON in the
//! app config dir. Per-workspace settings live in `uaithne.toml` instead.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::Result;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub workspace: Option<PathBuf>,
    /// Slider position, 0..1 (the perceptual taper is applied by the frontend).
    pub volume: f32,
    pub muted: bool,
    /// Strudel's `.midi()` output when the code names none: a port name or
    /// part of one; empty means the first port.
    pub midi_output: String,
    /// The output Tidal's `s "midi"` plays on; empty turns it off.
    pub tidal_midi_output: String,
    /// Where Strudel's `.osc()` sends ("host:port"); SuperDirt by default.
    pub osc_target: String,
    /// Colour theme id (src/lib/themes.ts), or "auto" to follow the system.
    pub theme: String,
    /// Shortcuts changed from their defaults: command id → keys (src/lib/keys.svelte.ts).
    pub keybindings: std::collections::BTreeMap<String, Vec<String>>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            workspace: None,
            volume: 0.8,
            muted: false,
            midi_output: String::new(),
            tidal_midi_output: String::new(),
            osc_target: "127.0.0.1:57120".into(),
            theme: "auto".into(),
            keybindings: Default::default(),
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_config_dir()?.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// `theme.css` in the app config dir, which can override any colour, if there is one.
pub fn user_css(app: &AppHandle) -> Result<Option<String>> {
    let path = app.path().app_config_dir()?.join("theme.css");
    Ok(std::fs::read_to_string(path).ok())
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<()> {
    let path = settings_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(settings)?)?;
    Ok(())
}
