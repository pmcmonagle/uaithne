//! The Tidal engine: GHCi running Tidal, which sends to SuperDirt running in
//! sclang. Uaithne starts both, reports their state as `tidal-status` events,
//! forwards their output as `engine-log` events, and on PipeWire links
//! SuperCollider's outputs to the speakers. A process that dies after coming
//! up is restarted (a few times, with backoff); when GHCi comes back, a
//! `tidal-recovered` event lets the frontend replay what was playing.

pub mod ghci;
mod highlight;
mod pipewire;
mod process;
mod sclang;

use std::fmt::Write as _;
use std::net::UdpSocket;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{Error, Result};
use crate::samples;
use crate::workspace::{self, TidalConfig};
use ghci::{EvalReply, Ghci, GhciEvent};
use sclang::{Level, Sclang, SclangEvent};

const BOOT_TIDAL: &str = include_str!("../../resources/tidal/BootTidal.hs");
const STARTUP_SCD: &str = include_str!("../../resources/tidal/startup.scd");

const GHCI_BOOT_TIMEOUT: Duration = Duration::from_secs(90);
const EVAL_TIMEOUT: Duration = Duration::from_secs(30);
const CHANNELS: usize = 2;
/// Waits before each automatic restart; more crashes than this within
/// RESTART_WINDOW leave Tidal stopped with an error.
const RESTART_DELAYS: [Duration; 3] = [Duration::from_secs(1), Duration::from_secs(3), Duration::from_secs(9)];
const RESTART_WINDOW: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcStatus {
    #[default]
    Stopped,
    Starting,
    Ready,
    Error,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcState {
    pub status: ProcStatus,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TidalStatus {
    pub sclang: ProcState,
    pub ghci: ProcState,
    /// The audio output SuperCollider is linked to, when Uaithne linked it.
    pub output: Option<String>,
    /// A crashed process is being restarted; what was playing comes back with it.
    pub recovering: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prereq {
    pub id: &'static str,
    pub name: &'static str,
    pub ok: bool,
    /// Tidal can't run without it.
    pub required: bool,
    pub detail: String,
}

#[derive(Clone, Serialize)]
struct LogLine {
    source: &'static str,
    level: &'static str,
    message: String,
}

#[derive(Default)]
pub struct Tidal {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    sclang: Option<Arc<Sclang>>,
    ghci: Option<Arc<Ghci>>,
    /// Bumped per spawn, so events from a replaced process are ignored.
    sclang_gen: u64,
    ghci_gen: u64,
    status: TidalStatus,
    root: Option<PathBuf>,
    config: TidalConfig,
    /// Whether Uaithne should link SuperCollider's outputs itself.
    autolink: bool,
    /// Last global volume, applied when SuperCollider comes up.
    gain: Option<f32>,
    /// Where Tidal sends highlight messages; the listener lives as long as the app.
    highlight_port: Option<u16>,
    /// When processes died unexpectedly, within RESTART_WINDOW.
    crashes: Vec<Instant>,
    /// GHCi is being restarted, so its patterns need replaying once it's up.
    ghci_restarting: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum Proc {
    Sclang,
    Ghci,
}

impl Proc {
    fn source(self) -> &'static str {
        match self {
            Proc::Sclang => "sclang",
            Proc::Ghci => "ghci",
        }
    }
    fn name(self) -> &'static str {
        match self {
            Proc::Sclang => "SuperCollider",
            Proc::Ghci => "GHCi",
        }
    }
    fn state(self, status: &mut TidalStatus) -> &mut ProcState {
        match self {
            Proc::Sclang => &mut status.sclang,
            Proc::Ghci => &mut status.ghci,
        }
    }
}

fn log(app: &AppHandle, source: &'static str, level: &'static str, message: impl Into<String>) {
    let _ = app.emit("engine-log", LogLine { source, level, message: message.into() });
}

impl Tidal {
    pub fn status(&self) -> TidalStatus {
        self.inner.lock().unwrap().status.clone()
    }

    fn update(&self, app: &AppHandle, f: impl FnOnce(&mut TidalStatus)) {
        let status = {
            let mut inner = self.inner.lock().unwrap();
            f(&mut inner.status);
            inner.status.clone()
        };
        let _ = app.emit("tidal-status", status);
    }

    /// Starts whichever of sclang and GHCi isn't running (or has failed).
    /// Returns at once; progress arrives as `tidal-status` events.
    pub fn start(&self, app: &AppHandle, root: &Path) -> Result<()> {
        let config = workspace::load_config(root)?.tidal;
        let (old_sclang, old_ghci) = {
            let mut inner = self.inner.lock().unwrap();
            let moved = inner.root.as_deref() != Some(root);
            let failed = |p: &ProcState| p.status == ProcStatus::Error;
            let old_sclang = if moved || failed(&inner.status.sclang) { inner.sclang.take() } else { None };
            let old_ghci = if moved || failed(&inner.status.ghci) { inner.ghci.take() } else { None };
            inner.root = Some(root.to_path_buf());
            inner.config = config.clone();
            (old_sclang, old_ghci)
        };
        if let Some(p) = old_sclang {
            p.stop();
        }
        if let Some(p) = old_ghci {
            p.stop();
        }

        let (need_sclang, need_ghci) = {
            let inner = self.inner.lock().unwrap();
            (inner.sclang.is_none(), inner.ghci.is_none())
        };
        if need_sclang {
            self.update(app, |s| {
                s.sclang = ProcState { status: ProcStatus::Starting, message: None };
                s.output = None;
            });
            if let Err(err) = self.spawn_sclang(app, root, &config) {
                log(app, "sclang", "error", err.to_string());
                self.update(app, |s| s.sclang = ProcState { status: ProcStatus::Error, message: Some(err.to_string()) });
            }
        }
        if need_ghci {
            self.update(app, |s| s.ghci = ProcState { status: ProcStatus::Starting, message: None });
            if let Err(err) = self.spawn_ghci(app, root, &config) {
                log(app, "ghci", "error", err.to_string());
                self.update(app, |s| s.ghci = ProcState { status: ProcStatus::Error, message: Some(err.to_string()) });
            }
        }
        Ok(())
    }

    fn spawn_sclang(&self, app: &AppHandle, root: &Path, config: &TidalConfig) -> Result<()> {
        if UdpSocket::bind(("127.0.0.1", config.port)).is_err() {
            return Err(Error::Engine(format!(
                "port {} is in use, probably by another SuperCollider running SuperDirt; quit it and start Tidal again",
                config.port
            )));
        }
        let server_port = (57110..57200)
            .find(|p| *p != config.port && UdpSocket::bind(("127.0.0.1", *p)).is_ok())
            .ok_or_else(|| Error::Engine("no free UDP port for the SuperCollider server".into()))?;
        let script = STARTUP_SCD
            .replace("{{port}}", &config.port.to_string())
            .replace("{{server_port}}", &server_port.to_string())
            .replace("{{samples}}", &sclang::quote(&write_sample_list(root)?.to_string_lossy()));

        // Run SC against PipeWire when possible, and link its outputs ourselves.
        let pw_jack = pipewire::pw_jack().filter(|_| pipewire::available());
        let spec = match &pw_jack {
            Some(wrapper) => format!("{} {}", wrapper.display(), config.sclang),
            None => config.sclang.clone(),
        };
        let mut cmd = process::command(&spec)?;
        cmd.args(["-i", "uaithne"]);
        if let Some(conf) = sclang_conf() {
            cmd.arg("-l").arg(conf);
        }
        // A config dir of our own keeps the user's startup.scd (which may
        // boot its own SuperDirt) from running.
        let config_home = app.path().app_data_dir()?.join("sclang");
        std::fs::create_dir_all(config_home.join("SuperCollider"))?;
        cmd.env("XDG_CONFIG_HOME", &config_home);
        if pw_jack.is_some() {
            cmd.env("SC_JACK_DEFAULT_OUTPUTS", "").env("SC_JACK_DEFAULT_INPUTS", "");
        }
        cmd.current_dir(root);

        let generation = {
            let mut inner = self.inner.lock().unwrap();
            inner.sclang_gen += 1;
            inner.autolink = pw_jack.is_some();
            inner.sclang_gen
        };
        let handle = app.clone();
        let sclang = Sclang::spawn(cmd, move |event| handle.state::<Tidal>().on_sclang(&handle, generation, event))?;
        log(app, "sclang", "info", format!("Starting SuperCollider ({spec}), server on port {server_port}"));
        sclang.run(&script)?;
        self.inner.lock().unwrap().sclang = Some(sclang);
        Ok(())
    }

    fn on_sclang(&self, app: &AppHandle, generation: u64, event: SclangEvent) {
        if self.inner.lock().unwrap().sclang_gen != generation {
            return;
        }
        match event {
            SclangEvent::Line(text, level) => {
                // sclang carries on when its server dies, but SuperDirt doesn't.
                let server_died = text.starts_with("Server 'uaithne' exited") && self.ready_sclang().is_some();
                let level = match level {
                    Level::Info => "info",
                    Level::Warning => "warning",
                    Level::Error => "error",
                };
                log(app, "sclang", level, text);
                if server_died {
                    let sclang = self.inner.lock().unwrap().sclang.take();
                    let handle = app.clone();
                    std::thread::spawn(move || {
                        if let Some(sclang) = sclang {
                            sclang.stop();
                        }
                        handle.state::<Tidal>().on_exit(&handle, Proc::Sclang, "The SuperCollider server exited");
                    });
                }
            }
            SclangEvent::Ready => {
                log(app, "sclang", "info", format!("SuperDirt is listening on port {}", self.inner.lock().unwrap().config.port));
                self.update(app, |s| {
                    s.sclang = ProcState { status: ProcStatus::Ready, message: None };
                    s.recovering &= s.ghci.status != ProcStatus::Ready;
                });
                let handle = app.clone();
                std::thread::spawn(move || {
                    let tidal = handle.state::<Tidal>();
                    if tidal.inner.lock().unwrap().autolink {
                        if let Err(err) = tidal.relink(&handle) {
                            log(&handle, "sclang", "warning", format!("Audio output: {err}"));
                        }
                    }
                    let gain = tidal.inner.lock().unwrap().gain;
                    if let Some(gain) = gain {
                        tidal.set_volume(gain);
                    }
                    let midi = crate::settings::load(&handle).tidal_midi_output;
                    if !midi.is_empty() {
                        tidal.set_midi(&handle, &midi);
                    }
                });
            }
            SclangEvent::Error(message) => {
                log(app, "sclang", "error", message.clone());
                self.update(app, |s| {
                    s.sclang = ProcState { status: ProcStatus::Error, message: Some(message) };
                    s.recovering = false;
                });
            }
            SclangEvent::Exited => {
                self.inner.lock().unwrap().sclang = None;
                self.on_exit(app, Proc::Sclang, "SuperCollider exited");
            }
        }
    }

    fn spawn_ghci(&self, app: &AppHandle, root: &Path, config: &TidalConfig) -> Result<()> {
        let boot = if config.boot_file.is_empty() {
            BOOT_TIDAL.replace("{{port}}", &config.port.to_string())
        } else {
            let path = expand_home(&config.boot_file);
            std::fs::read_to_string(&path)
                .map_err(|err| Error::Engine(format!("can't read boot_file {}: {err}", path.display())))?
        };
        // A boot file of your own can use the placeholder too.
        let boot = boot.replace("{{highlight_port}}", &self.highlight_port(app)?.to_string());
        let generation = {
            let mut inner = self.inner.lock().unwrap();
            inner.ghci_gen += 1;
            inner.ghci_gen
        };
        let handle = app.clone();
        let ghci = Ghci::spawn(process::command(&config.ghci)?, root, move |event| {
            handle.state::<Tidal>().on_ghci(&handle, generation, event)
        })?;
        log(app, "ghci", "info", format!("Starting GHCi ({})", config.ghci));
        self.inner.lock().unwrap().ghci = Some(ghci.clone());

        let handle = app.clone();
        std::thread::spawn(move || {
            let result = ghci.boot(&ghci::boot_script(&boot), GHCI_BOOT_TIMEOUT);
            handle.state::<Tidal>().on_ghci_booted(&handle, generation, result);
        });
        Ok(())
    }

    fn on_ghci_booted(&self, app: &AppHandle, generation: u64, result: Result<Vec<String>>) {
        if self.inner.lock().unwrap().ghci_gen != generation {
            return;
        }
        let lines = match result {
            Ok(lines) => lines,
            Err(err) => {
                log(app, "ghci", "error", err.to_string());
                return self.update(app, |s| {
                    s.ghci = ProcState { status: ProcStatus::Error, message: Some(err.to_string()) };
                    s.recovering = false;
                });
            }
        };
        let is_error = |l: &str| l.contains(": error") || l.contains("Could not find module");
        for line in lines.iter().filter(|l| !l.trim().is_empty()) {
            log(app, "ghci", if is_error(line) { "error" } else { "info" }, line.clone());
        }
        match lines.iter().position(|l| is_error(l)) {
            Some(i) => {
                // The error's first lines say what went wrong.
                let message = lines[i..].iter().take(3).map(|l| l.trim()).collect::<Vec<_>>().join(" ");
                self.update(app, |s| {
                    s.ghci = ProcState { status: ProcStatus::Error, message: Some(message) };
                    s.recovering = false;
                });
            }
            None => {
                let restarted = std::mem::take(&mut self.inner.lock().unwrap().ghci_restarting);
                self.update(app, |s| {
                    s.ghci = ProcState { status: ProcStatus::Ready, message: None };
                    s.recovering &= s.sclang.status != ProcStatus::Ready;
                });
                if restarted {
                    let _ = app.emit("tidal-recovered", ());
                }
            }
        }
    }

    fn on_ghci(&self, app: &AppHandle, generation: u64, event: GhciEvent) {
        if self.inner.lock().unwrap().ghci_gen != generation {
            return;
        }
        match event {
            // Outside a request this is Tidal itself: connection notices, pattern errors.
            GhciEvent::Line(text) => {
                let level = if text.contains("rror") || text.contains("*** Exception") { "error" } else { "info" };
                log(app, "tidal", level, text);
            }
            GhciEvent::Exited => {
                self.inner.lock().unwrap().ghci = None;
                self.on_exit(app, Proc::Ghci, "GHCi exited");
            }
        }
    }

    /// A process died on its own. One that had come up (or was coming back
    /// from a crash) is restarted after a pause, unless it keeps crashing.
    fn on_exit(&self, app: &AppHandle, proc: Proc, what: &str) {
        log(app, proc.source(), "error", what);
        let (restart, root, generations) = {
            let mut inner = self.inner.lock().unwrap();
            let had_run = proc.state(&mut inner.status).status == ProcStatus::Ready || inner.status.recovering;
            let now = Instant::now();
            inner.crashes.retain(|t| now.duration_since(*t) < RESTART_WINDOW);
            inner.crashes.push(now);
            let delay = RESTART_DELAYS.get(inner.crashes.len() - 1).copied().filter(|_| had_run);
            if delay.is_some() && proc == Proc::Ghci {
                inner.ghci_restarting = true;
            }
            (delay.map(|d| (d, inner.crashes.len())), inner.root.clone(), (inner.sclang_gen, inner.ghci_gen))
        };
        let Some((delay, attempt)) = restart.filter(|_| root.is_some()) else {
            let message = if self.inner.lock().unwrap().crashes.len() > RESTART_DELAYS.len() {
                format!("{what}; it keeps crashing, so it wasn't restarted")
            } else {
                what.to_string()
            };
            return self.update(app, |s| {
                *proc.state(s) = ProcState { status: ProcStatus::Error, message: Some(message) };
                s.recovering = false;
                if proc == Proc::Sclang {
                    s.output = None;
                }
            });
        };
        let message = format!("{what}; restarting ({attempt} of {})", RESTART_DELAYS.len());
        log(app, proc.source(), "warning", format!("Restarting {} in {}s", proc.name(), delay.as_secs()));
        self.update(app, |s| {
            *proc.state(s) = ProcState { status: ProcStatus::Starting, message: Some(message) };
            s.recovering = true;
            if proc == Proc::Sclang {
                s.output = None;
            }
        });
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            let tidal = handle.state::<Tidal>();
            // Stopped or started by hand meanwhile.
            let current = {
                let inner = tidal.inner.lock().unwrap();
                (inner.sclang_gen, inner.ghci_gen)
            };
            if current != generations {
                return;
            }
            let root = root.expect("checked above");
            if let Err(err) = tidal.start(&handle, &root) {
                log(&handle, proc.source(), "error", format!("Couldn't restart {}: {err}", proc.name()));
                tidal.update(&handle, |s| s.recovering = false);
            }
        });
    }

    /// Dev aid: kills a process (`ghci`, `sclang` or `scsynth`) as a crash would.
    pub fn crash_for_test(&self, which: &str) -> Result<()> {
        let inner = self.inner.lock().unwrap();
        let pid = match which {
            "ghci" => inner.ghci.as_ref().map(|g| g.pid()),
            "sclang" | "scsynth" => inner.sclang.as_ref().map(|s| s.pid()),
            _ => None,
        }
        .ok_or_else(|| Error::Engine(format!("no {which} to crash")))?;
        let pid = if which == "scsynth" {
            let out = std::process::Command::new("pgrep").args(["-g", &pid.to_string(), "scsynth"]).output()?;
            String::from_utf8_lossy(&out.stdout)
                .split_whitespace()
                .next()
                .and_then(|p| p.parse().ok())
                .ok_or_else(|| Error::Engine("no scsynth to crash".into()))?
        } else {
            pid
        };
        // SAFETY: only sends a signal.
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
        Ok(())
    }

    fn highlight_port(&self, app: &AppHandle) -> Result<u16> {
        let mut inner = self.inner.lock().unwrap();
        if inner.highlight_port.is_none() {
            inner.highlight_port = Some(highlight::listen(app.clone())?);
        }
        Ok(inner.highlight_port.unwrap())
    }

    fn ready_ghci(&self) -> Result<Arc<Ghci>> {
        let inner = self.inner.lock().unwrap();
        match (&inner.ghci, inner.status.ghci.status) {
            (Some(ghci), ProcStatus::Ready) => Ok(ghci.clone()),
            _ => Err(Error::Engine("Tidal isn't running".into())),
        }
    }

    fn ready_sclang(&self) -> Option<Arc<Sclang>> {
        let inner = self.inner.lock().unwrap();
        inner.sclang.clone().filter(|_| inner.status.sclang.status == ProcStatus::Ready)
    }

    /// Evaluates a block in GHCi. Output of a successful block goes to the log;
    /// an error comes back in the reply.
    pub fn eval(&self, app: &AppHandle, code: &str) -> Result<EvalReply> {
        let ghci = self.ready_ghci()?;
        let highlight = self.inner.lock().unwrap().config.highlight;
        let is_command = code.trim_start().starts_with(':');
        let reply = if highlight && !is_command && code.contains('"') {
            // A block that doesn't compile ran nothing, so retrying the code
            // as written is safe: it reports errors at their real place, and
            // runs anything the rewrite broke (without highlights).
            let reply = ghci.eval(&highlight::rewrite(code), EVAL_TIMEOUT)?;
            if !reply.ok && reply.output.contains(": error") {
                let original = ghci.eval(code, EVAL_TIMEOUT)?;
                if original.ok {
                    log(app, "tidal", "warning", "This block plays without highlighting: it didn't compile with its strings marked");
                }
                original
            } else {
                reply
            }
        } else {
            ghci.eval(code, EVAL_TIMEOUT)?
        };
        if reply.ok && !reply.output.is_empty() {
            log(app, "ghci", "info", reply.output.clone());
        }
        Ok(reply)
    }

    /// Global volume, as linear gain (already tapered).
    pub fn set_volume(&self, gain: f32) {
        self.inner.lock().unwrap().gain = Some(gain);
        let db = if gain > 0.0 { (20.0 * gain.log10()).max(-90.0) } else { -90.0 };
        if let Some(sclang) = self.ready_sclang() {
            let _ = sclang.run(&format!("~uaithneVolume.({db:.2});"));
        }
    }

    /// Links SuperCollider's outputs to the configured sink (again).
    pub fn relink(&self, app: &AppHandle) -> Result<String> {
        let sclang = self.ready_sclang().ok_or_else(|| Error::Engine("SuperCollider isn't running".into()))?;
        if !pipewire::available() {
            return Err(Error::Engine("pw-link isn't installed, so Uaithne can't link SuperCollider's audio".into()));
        }
        let client = sclang.jack_client.lock().unwrap().clone().unwrap_or_else(|| "SuperCollider".into());
        let setting = self.inner.lock().unwrap().config.output.clone();
        let sink = pipewire::sink(&setting)?;
        let output = pipewire::link(&client, &sink, CHANNELS)?;
        log(app, "sclang", "info", format!("Audio: {client} → {output}"));
        self.update(app, |s| s.output = Some(output.clone()));
        Ok(output)
    }

    /// Rewrites the sample list and has SuperDirt reload it.
    pub fn reload_samples(&self) -> Result<()> {
        let Some(sclang) = self.ready_sclang() else { return Ok(()) };
        let root = self.inner.lock().unwrap().root.clone().ok_or(Error::NoWorkspace)?;
        let list = write_sample_list(&root)?;
        sclang.run(&format!("~uaithneLoadSamples.({});", sclang::quote(&list.to_string_lossy())))
    }

    /// Starts SuperCollider recording its output to `path` (a WAV file).
    pub fn record(&self, path: &Path) -> Result<()> {
        let sclang = self.ready_sclang().ok_or_else(|| Error::Engine("SuperCollider isn't running".into()))?;
        sclang.run(&format!("~uaithneRecord.({});", sclang::quote(&path.to_string_lossy())))
    }

    pub fn stop_recording(&self) {
        if let Some(sclang) = self.ready_sclang() {
            let _ = sclang.run("~uaithneStopRecord.();");
        }
    }

    /// Points Tidal's `s "midi"` at a MIDI output (a midir port name; empty turns it off).
    pub fn set_midi(&self, app: &AppHandle, port: &str) {
        let Some(sclang) = self.ready_sclang() else { return };
        let name = sc_port_name(port);
        match sclang.query(&format!("~uaithneMidi.({});", sclang::quote(&name)), "midi", Duration::from_secs(5)) {
            Ok(answer) if answer.starts_with("none") => log(app, "sclang", "warning", format!("Tidal MIDI: no output matches {name}")),
            Ok(answer) if answer == "off" => {}
            Ok(answer) => log(app, "sclang", "info", format!("Tidal MIDI: s \"midi\" plays on {answer}")),
            Err(err) => log(app, "sclang", "warning", format!("Tidal MIDI: {err}")),
        }
    }

    /// Whether SuperCollider is up (so it can record).
    pub fn sclang_ready(&self) -> bool {
        self.ready_sclang().is_some()
    }

    /// Peak output level over `seconds` (dev aid for the self-test).
    pub fn meter(&self, seconds: f32) -> Result<f32> {
        let sclang = self.ready_sclang().ok_or_else(|| Error::Engine("SuperCollider isn't running".into()))?;
        let timeout = Duration::from_secs_f32(seconds + 5.0);
        let answer = sclang.query(&format!("~uaithneMeter.({seconds});"), "meter", timeout)?;
        answer.trim().parse().map_err(|_| Error::Engine(format!("bad meter reading {answer}")))
    }

    /// Stops both processes.
    pub fn stop(&self, app: Option<&AppHandle>) {
        let (sclang, ghci) = {
            let mut inner = self.inner.lock().unwrap();
            inner.sclang_gen += 1;
            inner.ghci_gen += 1;
            inner.crashes.clear();
            inner.ghci_restarting = false;
            (inner.sclang.take(), inner.ghci.take())
        };
        let ghci_stop = ghci.map(|g| std::thread::spawn(move || g.stop()));
        if let Some(sclang) = sclang {
            sclang.stop();
        }
        if let Some(handle) = ghci_stop {
            let _ = handle.join();
        }
        if let Some(app) = app {
            self.update(app, |s| *s = TidalStatus::default());
        }
    }
}

/// Writes `.uaithne/superdirt-samples.tsv`: one `name<TAB>path` line per file of
/// each sound that wins its name, in sample-index order.
fn write_sample_list(root: &Path) -> Result<PathBuf> {
    let library = samples::scan(root)?;
    let mut text = String::new();
    for sound in library.sounds.iter().filter(|s| !s.shadowed) {
        for file in &sound.files {
            let _ = writeln!(text, "{}\t{}", sound.name, root.join(file).display());
        }
    }
    let path = root.join(".uaithne").join("superdirt-samples.tsv");
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, text)?;
    Ok(path)
}

/// midir names ALSA ports "Device:Port 14:0"; SuperCollider knows them as
/// device "Device" and name "Port", so drop the client:port numbers.
fn sc_port_name(port: &str) -> String {
    let trimmed = port.trim();
    match trimmed.rsplit_once(' ') {
        Some((head, tail)) if tail.split(':').all(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit())) => head.to_string(),
        _ => trimmed.to_string(),
    }
}

fn expand_home(path: &str) -> PathBuf {
    match (path.strip_prefix("~/"), std::env::var_os("HOME")) {
        (Some(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => PathBuf::from(path),
    }
}

/// The user's SuperCollider config dir (`~/.config/SuperCollider`).
fn sc_config_dir() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("SuperCollider"))
}

/// The user's library config, which lists installed quarks such as SuperDirt.
fn sclang_conf() -> Option<PathBuf> {
    sc_config_dir().map(|d| d.join("sclang_conf.yaml")).filter(|p| p.is_file())
}

/// Checks for everything Tidal needs, for the setup guide.
pub fn check(root: Option<&Path>) -> Vec<Prereq> {
    let config = root.and_then(|r| workspace::load_config(r).ok()).map(|c| c.tidal).unwrap_or_default();
    let mut checks = Vec::new();

    let run = |spec: &str, args: &[&str], stdin: &str| {
        let mut cmd = process::command(spec).ok()?;
        cmd.args(args);
        process::output(cmd, stdin)
    };
    let ghci = run(&config.ghci, &["--numeric-version"], "").filter(|(ok, _)| *ok);
    checks.push(Prereq {
        id: "ghci",
        name: "GHC (GHCi)",
        ok: ghci.is_some(),
        required: true,
        detail: match &ghci {
            Some((_, version)) => format!("{} {}", config.ghci, version.trim()),
            None => format!("`{}` didn't run", config.ghci),
        },
    });
    let tidal = ghci.as_ref().and_then(|_| {
        run(
            &config.ghci,
            &["-ignore-dot-ghci", "-v0"],
            "import Sound.Tidal.Context\nputStrLn Sound.Tidal.Version.tidal_version\n",
        )
    });
    let tidal_version = tidal
        .as_ref()
        .map(|(_, out)| out.trim())
        .filter(|out| !out.is_empty() && !out.contains("error") && !out.contains('\n'));
    checks.push(Prereq {
        id: "tidal",
        name: "Tidal (Haskell library)",
        ok: tidal_version.is_some(),
        required: true,
        detail: match (tidal_version, &tidal) {
            (Some(version), _) => format!("Tidal {version}"),
            (None, Some((_, out))) => out.lines().find(|l| l.contains("Could not find")).unwrap_or(out).trim().to_string(),
            (None, None) => "needs GHC first".into(),
        },
    });

    let sclang = run(&config.sclang, &["-v"], "").filter(|(_, out)| out.contains("sclang"));
    checks.push(Prereq {
        id: "sclang",
        name: "SuperCollider",
        ok: sclang.is_some(),
        required: true,
        detail: match &sclang {
            Some((_, out)) => out.lines().next().unwrap_or("").trim().to_string(),
            None => format!("`{}` didn't run", config.sclang),
        },
    });
    let superdirt = find_superdirt();
    checks.push(Prereq {
        id: "superdirt",
        name: "SuperDirt (SuperCollider quark)",
        ok: superdirt.is_some(),
        required: true,
        detail: match superdirt {
            Some(path) => path.display().to_string(),
            None => "not installed".into(),
        },
    });

    if cfg!(target_os = "linux") {
        let pw = pipewire::pw_jack().is_some() && pipewire::available();
        checks.push(Prereq {
            id: "pipewire",
            name: "PipeWire JACK tools",
            ok: pw,
            required: false,
            detail: if pw {
                "pw-jack and pw-link: Uaithne links SuperCollider's audio itself".into()
            } else {
                "pw-jack or pw-link missing: SuperCollider's outputs may need connecting by hand".into()
            },
        });
    }
    checks
}

/// SuperDirt as an installed quark (listed in sclang_conf.yaml) or in an Extensions folder.
fn find_superdirt() -> Option<PathBuf> {
    let from_conf = sclang_conf()
        .and_then(|conf| std::fs::read_to_string(conf).ok())
        .and_then(|text| {
            text.lines()
                .filter_map(|l| l.trim().strip_prefix("- "))
                .map(|p| PathBuf::from(p.trim().trim_matches('\'').trim_matches('"')))
                .find(|p| p.file_name().is_some_and(|n| n == "SuperDirt") && p.is_dir())
        });
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
    let extensions = [
        data_home.map(|d| d.join("SuperCollider/Extensions/SuperDirt")),
        Some(PathBuf::from("/usr/share/SuperCollider/Extensions/SuperDirt")),
        Some(PathBuf::from("/usr/local/share/SuperCollider/Extensions/SuperDirt")),
    ];
    from_conf.or_else(|| extensions.into_iter().flatten().find(|p| p.is_dir()))
}
