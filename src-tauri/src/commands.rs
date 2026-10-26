use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

use crate::error::{Error, Result};
use crate::midi::{self, Midi, Timed};
use crate::osc::{self, Osc};
use crate::packs::{self, CatalogueEntry, Downloads};
use crate::record::Recorder;
use crate::samples::{self, Library};
use crate::settings::{self, Settings};
use crate::tidal::{self, Prereq, Tidal, TidalStatus, ghci::EvalReply};
use crate::workspace::{TrackInfo, Workspace, WorkspaceInfo};

#[derive(Default)]
pub struct AppState {
    pub workspace: Mutex<Option<Workspace>>,
    pub downloads: Downloads,
}

impl AppState {
    pub fn root(&self) -> Option<PathBuf> {
        self.workspace.lock().unwrap().as_ref().map(|w| w.root.clone())
    }
}

fn with_workspace<T>(state: &State<AppState>, f: impl FnOnce(&Workspace) -> Result<T>) -> Result<T> {
    let guard = state.workspace.lock().unwrap();
    f(guard.as_ref().ok_or(Error::NoWorkspace)?)
}

/// Mirrors the frontend log to the terminal, so `tauri dev` output has it too.
#[tauri::command]
pub fn frontend_log(level: String, source: String, message: String) {
    eprintln!("[uaithne:{level}] {source}: {message}");
}

/// Dev aid: `UAITHNE_SELFTEST=1` makes the frontend play the open track on launch.
#[tauri::command]
pub fn selftest_enabled() -> bool {
    std::env::var("UAITHNE_SELFTEST").is_ok_and(|v| v == "1")
}

/// Dev aid: `UAITHNE_SELFTEST_PACK=<catalogue id>` makes the self-test install
/// that pack if it's missing, then play from it.
#[tauri::command]
pub fn selftest_pack() -> Option<String> {
    std::env::var("UAITHNE_SELFTEST_PACK").ok().filter(|v| !v.is_empty())
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Settings {
    settings::load(&app)
}

/// Changes the settings named in `patch` (camelCase keys, as the frontend sees them).
#[tauri::command]
pub fn update_settings(app: AppHandle, patch: serde_json::Map<String, serde_json::Value>) -> Result<Settings> {
    let mut value = serde_json::to_value(settings::load(&app))?;
    let fields = value.as_object_mut().expect("settings serialize to an object");
    for (key, v) in patch {
        if fields.contains_key(&key) {
            fields.insert(key, v);
        }
    }
    let s: Settings = serde_json::from_value(value)?;
    settings::save(&app, &s)?;
    Ok(s)
}

/// The user's `theme.css` (app config dir), if any.
#[tauri::command]
pub fn user_theme_css(app: AppHandle) -> Result<Option<String>> {
    settings::user_css(&app)
}

#[tauri::command]
pub fn set_volume(app: AppHandle, volume: f32, muted: bool) -> Result<()> {
    let mut s = settings::load(&app);
    s.volume = volume.clamp(0.0, 1.0);
    s.muted = muted;
    settings::save(&app, &s)
}

#[tauri::command]
pub fn open_workspace(app: AppHandle, state: State<AppState>, root: PathBuf) -> Result<WorkspaceInfo> {
    let (workspace, info) = Workspace::open(&app, root.clone())?;
    *state.workspace.lock().unwrap() = Some(workspace);
    let mut s = settings::load(&app);
    s.workspace = Some(root);
    settings::save(&app, &s)?;
    Ok(info)
}

#[tauri::command]
pub fn list_tracks(state: State<AppState>) -> Result<Vec<TrackInfo>> {
    with_workspace(&state, |w| w.list_tracks())
}

#[tauri::command]
pub fn read_track(state: State<AppState>, path: String) -> Result<String> {
    with_workspace(&state, |w| w.read_track(&path))
}

#[tauri::command]
pub fn write_track(state: State<AppState>, path: String, content: String) -> Result<()> {
    with_workspace(&state, |w| w.write_track(&path, &content))
}

#[tauri::command]
pub fn create_track(state: State<AppState>, path: String, content: String) -> Result<()> {
    with_workspace(&state, |w| w.create_track(&path, &content))
}

#[tauri::command]
pub fn rename_track(state: State<AppState>, from: String, to: String) -> Result<()> {
    with_workspace(&state, |w| w.rename_track(&from, &to))
}

#[tauri::command]
pub fn delete_track(state: State<AppState>, path: String) -> Result<()> {
    with_workspace(&state, |w| w.delete_track(&path))
}

#[tauri::command]
pub fn sample_library(state: State<AppState>) -> Result<Library> {
    samples::scan(&state.root().ok_or(Error::NoWorkspace)?)
}

#[tauri::command]
pub fn pack_catalogue() -> Vec<CatalogueEntry> {
    packs::catalogue()
}

/// Suggested id for a custom pack source.
#[tauri::command]
pub fn pack_id_for(source: String) -> String {
    packs::default_id(&source)
}

/// Downloads a pack, emitting `pack-progress` as files arrive. Reinstalling
/// replaces the pack once the new download is complete.
#[tauri::command]
pub async fn install_pack(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    name: String,
    source: String,
) -> Result<()> {
    let root = state.root().ok_or(Error::NoWorkspace)?;
    packs::install(&app, &state.downloads, &root, &id, &name, &source).await
}

#[tauri::command]
pub fn cancel_pack(state: State<AppState>, id: String) {
    state.downloads.cancel(&id);
}

#[tauri::command]
pub fn delete_pack(state: State<AppState>, id: String) -> Result<()> {
    packs::remove(&state.root().ok_or(Error::NoWorkspace)?, &id)
}

/// Dev aid: `UAITHNE_SELFTEST_TIDAL=1` makes the self-test start Tidal and play from it.
#[tauri::command]
pub fn selftest_tidal() -> bool {
    std::env::var("UAITHNE_SELFTEST_TIDAL").is_ok_and(|v| v == "1")
}

/// Runs a blocking engine call off the async runtime's worker threads.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| Error::Engine(e.to_string()))?
}

/// What Tidal needs and whether it's installed (takes a few seconds).
#[tauri::command]
pub async fn tidal_check(state: State<'_, AppState>) -> Result<Vec<Prereq>> {
    let root = state.root();
    blocking(move || Ok(tidal::check(root.as_deref()))).await
}

#[tauri::command]
pub fn tidal_status(tidal: State<Tidal>) -> TidalStatus {
    tidal.status()
}

#[tauri::command]
pub async fn tidal_start(app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    let root = state.root().ok_or(Error::NoWorkspace)?;
    blocking(move || app.state::<Tidal>().start(&app, &root)).await
}

#[tauri::command]
pub async fn tidal_stop(app: AppHandle) -> Result<()> {
    blocking(move || {
        app.state::<Tidal>().stop(Some(&app));
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn tidal_eval(app: AppHandle, code: String) -> Result<EvalReply> {
    blocking(move || app.state::<Tidal>().eval(&app, &code)).await
}

#[tauri::command]
pub fn tidal_volume(tidal: State<Tidal>, gain: f32) {
    tidal.set_volume(gain);
}

#[tauri::command]
pub async fn tidal_relink(app: AppHandle) -> Result<String> {
    blocking(move || app.state::<Tidal>().relink(&app)).await
}

#[tauri::command]
pub fn tidal_reload_samples(tidal: State<Tidal>) -> Result<()> {
    tidal.reload_samples()
}

#[tauri::command]
pub async fn tidal_meter(app: AppHandle, seconds: f32) -> Result<f32> {
    blocking(move || app.state::<Tidal>().meter(seconds)).await
}

/// Starts recording. `strudel_rate` is the page's sample rate when Strudel's
/// audio should be recorded; SuperCollider records too when it's running.
/// Returns the files being written.
#[tauri::command]
pub fn record_start(app: AppHandle, state: State<AppState>, strudel_rate: Option<u32>) -> Result<Vec<String>> {
    let root = state.root().ok_or(Error::NoWorkspace)?;
    let recorder = app.state::<Recorder>();
    let tidal = app.state::<Tidal>();
    finish_recording(&app);
    let paths = recorder.start(&root, strudel_rate, tidal.sclang_ready())?;
    if let Some(path) = &paths.tidal {
        if let Err(err) = tidal.record(path) {
            recorder.stop();
            return Err(err);
        }
    }
    Ok(paths.strudel.iter().chain(&paths.tidal).map(|p| p.display().to_string()).collect())
}

/// A chunk of Strudel's audio: interleaved little-endian f32 stereo, sent as raw bytes.
#[tauri::command]
pub fn record_chunk(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<()> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => app.state::<Recorder>().write_strudel(bytes),
        _ => Err(Error::Engine("record_chunk expects raw audio bytes".into())),
    }
}

/// Stops recording; returns the files written.
#[tauri::command]
pub fn record_stop(app: AppHandle) -> Vec<String> {
    finish_recording(&app)
}

/// Finishes any recording in progress (also on exit, so the WAV headers are written).
pub fn finish_recording(app: &AppHandle) -> Vec<String> {
    let Some(finished) = app.state::<Recorder>().stop() else { return Vec::new() };
    if finished.tidal {
        app.state::<Tidal>().stop_recording();
    }
    finished.files.iter().map(|p| p.display().to_string()).collect()
}

/// Dev aid for the self-test: a WAV file's channels, rate, length and peak,
/// then deletes it (it's a test recording).
#[tauri::command]
pub fn selftest_wav(path: String) -> Result<String> {
    let mut reader = hound::WavReader::open(&path).map_err(|e| Error::Engine(format!("{path}: {e}")))?;
    let spec = reader.spec();
    let frames = reader.duration();
    let peak = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().filter_map(|s| s.ok()).fold(0f32, |m, s| m.max(s.abs())),
        hound::SampleFormat::Int => {
            let full = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader.samples::<i32>().filter_map(|s| s.ok()).fold(0f32, |m, s| m.max(s.unsigned_abs() as f32 / full))
        }
    };
    let _ = std::fs::remove_file(&path);
    Ok(format!("{}ch {}Hz {:.2}s peak={peak:.3}", spec.channels, spec.sample_rate, frames as f32 / spec.sample_rate as f32))
}

/// MIDI output ports.
#[tauri::command]
pub async fn midi_outputs() -> Result<Vec<String>> {
    blocking(midi::outputs).await
}

/// Queues MIDI messages for a port (empty: the one in settings, else the first).
#[tauri::command]
pub fn midi_send(app: AppHandle, port: String, messages: Vec<Timed>) -> Result<()> {
    let port = if port.is_empty() { settings::load(&app).midi_output } else { port };
    app.state::<Midi>().send(&port, messages)
}

/// Sends an OSC message (to the target in settings unless one is given).
#[tauri::command]
pub fn osc_send(app: AppHandle, target: Option<String>, address: String, args: Vec<osc::Arg>, delay_ms: f64) -> Result<()> {
    let target = target.filter(|t| !t.is_empty()).unwrap_or_else(|| settings::load(&app).osc_target);
    app.state::<Osc>().send(&target, &address, args, delay_ms)
}

/// Saves the MIDI and OSC settings, pointing Tidal's MIDI at the new output.
#[tauri::command]
pub async fn set_io_settings(app: AppHandle, midi_output: String, tidal_midi_output: String, osc_target: String) -> Result<Settings> {
    let mut s = settings::load(&app);
    let tidal_changed = s.tidal_midi_output != tidal_midi_output;
    s.midi_output = midi_output;
    s.tidal_midi_output = tidal_midi_output.clone();
    s.osc_target = osc_target;
    settings::save(&app, &s)?;
    if tidal_changed {
        let handle = app.clone();
        blocking(move || Ok(handle.state::<Tidal>().set_midi(&handle, &tidal_midi_output))).await?;
    }
    Ok(s)
}

/// Dev aid: MIDI arriving on an input matching `port` during `ms` (hex messages).
#[tauri::command]
pub async fn selftest_midi_capture(port: String, ms: u64) -> Result<Vec<String>> {
    blocking(move || midi::capture(&port, ms)).await
}

/// Dev aid: kills `ghci`, `sclang` or `scsynth` as a crash would.
#[tauri::command]
pub fn selftest_crash(app: AppHandle, which: String) -> Result<()> {
    app.state::<Tidal>().crash_for_test(&which)
}

/// Dev aid: points Tidal's MIDI at `port` without saving it.
#[tauri::command]
pub async fn selftest_tidal_midi(app: AppHandle, port: String) -> Result<()> {
    blocking(move || Ok(app.state::<Tidal>().set_midi(&app, &port))).await
}
