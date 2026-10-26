//! The sclang process running SuperDirt.
//!
//! sclang reads code from stdin when started without a script: each chunk ends
//! with ESC (run without echoing the result). The startup script and Uaithne's
//! helpers post `UAITHNE:<what> …` lines, which this turns into events.

use std::io::Write;
use std::process::{Child, ChildStdin, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::process;
use crate::error::{Error, Result};

const RUN: u8 = 0x1b;

pub struct Sclang {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    stopping: AtomicBool,
    /// The JACK client name scsynth reported, usually `SuperCollider`.
    pub jack_client: Mutex<Option<String>>,
    /// Waiters for a `UAITHNE:<marker> …` line.
    queries: Mutex<Vec<(String, Sender<String>)>>,
}

pub enum SclangEvent {
    Ready,
    Error(String),
    Line(String, Level),
    Exited,
}

#[derive(Clone, Copy)]
pub enum Level {
    Info,
    Warning,
    Error,
}

impl Sclang {
    pub fn spawn(cmd: Command, on_event: impl Fn(SclangEvent) + Send + 'static) -> Result<Arc<Self>> {
        let (child, stdin, reader) = process::spawn(cmd)?;
        let sclang = Arc::new(Self {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            stopping: AtomicBool::new(false),
            jack_client: Mutex::new(None),
            queries: Mutex::new(Vec::new()),
        });
        let this = sclang.clone();
        std::thread::spawn(move || {
            process::read_lines(reader, |line| {
                if !this.stopping.load(Ordering::SeqCst) {
                    this.on_line(line, &on_event);
                }
            });
            if !this.stopping.load(Ordering::SeqCst) {
                process::reap(&mut this.child.lock().unwrap());
                on_event(SclangEvent::Exited);
            }
        });
        // scsynth shares the output pipe, so if sclang dies alone the pipe
        // stays open. Watch for that and take the server down too, which
        // closes the pipe and reports the exit.
        let this = sclang.clone();
        std::thread::spawn(move || {
            while !this.stopping.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(500));
                let mut child = this.child.lock().unwrap();
                if matches!(child.try_wait(), Ok(Some(_))) {
                    // SAFETY: only sends a signal, to the group spawn() created.
                    unsafe { libc::killpg(child.id() as libc::pid_t, libc::SIGKILL) };
                    break;
                }
            }
        });
        Ok(sclang)
    }

    fn on_line(&self, line: String, on_event: &impl Fn(SclangEvent)) {
        if let Some(marker) = line.strip_prefix("UAITHNE:") {
            let (what, rest) = marker.split_once(' ').unwrap_or((marker, ""));
            match what {
                "ready" => on_event(SclangEvent::Ready),
                "error" => on_event(SclangEvent::Error(rest.to_string())),
                _ => {
                    let mut queries = self.queries.lock().unwrap();
                    if let Some(i) = queries.iter().position(|(m, _)| m == what) {
                        let _ = queries.remove(i).1.send(rest.to_string());
                    } else {
                        on_event(SclangEvent::Line(rest.to_string(), Level::Info));
                    }
                }
            }
            return;
        }
        if let Some(name) = line.strip_prefix("JackDriver: client name is '") {
            *self.jack_client.lock().unwrap() = Some(name.trim_end_matches('\'').to_string());
        }
        if line.trim().is_empty() {
            return;
        }
        let level = if line.starts_with("ERROR") || line.starts_with("FAILURE") || line.starts_with("exception in") {
            Level::Error
        } else if line.starts_with("WARNING") {
            Level::Warning
        } else {
            Level::Info
        };
        on_event(SclangEvent::Line(line, level));
    }

    /// Runs code without waiting for it.
    pub fn run(&self, code: &str) -> Result<()> {
        let mut stdin = self.stdin.lock().unwrap();
        stdin.write_all(code.as_bytes())?;
        stdin.write_all(&[RUN])?;
        stdin.flush()?;
        Ok(())
    }

    /// Runs code that posts `UAITHNE:<marker> <answer>`, and waits for the answer.
    pub fn query(&self, code: &str, marker: &str, timeout: Duration) -> Result<String> {
        let (tx, rx) = mpsc::channel();
        self.queries.lock().unwrap().push((marker.to_string(), tx));
        self.run(code)?;
        rx.recv_timeout(timeout).map_err(|_| Error::Engine(format!("SuperCollider didn't answer {marker}")))
    }

    /// The process id, which is also its process group's.
    pub fn pid(&self) -> u32 {
        self.child.lock().unwrap().id()
    }

    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        // The group kill catches a server that ignores /quit.
        let _ = self.run("Server.default.quit; 0.exit;");
        process::shut_down(&mut self.child.lock().unwrap(), Duration::from_secs(2));
    }
}

/// A string literal for sclang code.
pub fn quote(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}
