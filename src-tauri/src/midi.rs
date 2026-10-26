//! MIDI out for Strudel (WebKitGTK has no WebMIDI). The page sends each
//! message with how far ahead it should go out; a scheduler thread holds it
//! until then and writes it to the port through midir (ALSA on Linux).

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use midir::{MidiOutput, MidiOutputConnection};
use serde::Deserialize;

use crate::error::{Error, Result};

const CLIENT: &str = "Uaithne";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timed {
    /// Milliseconds from now.
    pub delay_ms: f64,
    pub bytes: Vec<u8>,
}

struct Job {
    at: Instant,
    seq: u64,
    port: String,
    bytes: Vec<u8>,
}

impl PartialEq for Job {
    fn eq(&self, other: &Self) -> bool {
        (self.at, self.seq) == (other.at, other.seq)
    }
}
impl Eq for Job {}
impl PartialOrd for Job {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Job {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        (self.at, self.seq).cmp(&(other.at, other.seq))
    }
}

/// How long a port listing is reused before asking the system again.
const PORTS_FRESH: Duration = Duration::from_secs(2);

#[derive(Default)]
pub struct Midi {
    queue: Mutex<Option<Sender<Job>>>,
    seq: Mutex<u64>,
    ports: Mutex<Option<(Instant, Vec<String>)>>,
}

/// Output port names, as the system lists them.
pub fn outputs() -> Result<Vec<String>> {
    let out = MidiOutput::new(CLIENT).map_err(|e| Error::Engine(format!("MIDI: {e}")))?;
    Ok(out.ports().iter().filter_map(|p| out.port_name(p).ok()).collect())
}

/// The port `wanted` names: an exact name, else the first containing it
/// (ignoring case). Empty means the first port that isn't MIDI Through, then any.
pub fn resolve(wanted: &str, ports: &[String]) -> Option<String> {
    let wanted = wanted.trim();
    if wanted.is_empty() {
        return ports.iter().find(|p| !p.contains("Midi Through")).or(ports.first()).cloned();
    }
    let lower = wanted.to_lowercase();
    ports.iter().find(|p| *p == wanted).or_else(|| ports.iter().find(|p| p.to_lowercase().contains(&lower))).cloned()
}

impl Midi {
    /// Queues messages for a port (resolved by `resolve`).
    pub fn send(&self, port: &str, messages: Vec<Timed>) -> Result<()> {
        let ports = self.ports()?;
        let name = resolve(port, &ports).ok_or_else(|| {
            Error::Engine(if ports.is_empty() {
                "no MIDI outputs found".into()
            } else {
                format!("no MIDI output matches \"{port}\" (have: {})", ports.join(", "))
            })
        })?;
        let queue = self.queue();
        let now = Instant::now();
        let mut seq = self.seq.lock().unwrap();
        for m in messages {
            *seq += 1;
            let at = now + Duration::from_secs_f64(m.delay_ms.max(0.0) / 1000.0);
            let _ = queue.send(Job { at, seq: *seq, port: name.clone(), bytes: m.bytes });
        }
        Ok(())
    }

    fn ports(&self) -> Result<Vec<String>> {
        let mut cache = self.ports.lock().unwrap();
        if let Some((_, ports)) = cache.as_ref().filter(|(at, _)| at.elapsed() < PORTS_FRESH) {
            return Ok(ports.clone());
        }
        let ports = outputs()?;
        *cache = Some((Instant::now(), ports.clone()));
        Ok(ports)
    }

    fn queue(&self) -> Sender<Job> {
        let mut queue = self.queue.lock().unwrap();
        queue.get_or_insert_with(spawn_scheduler).clone()
    }
}

/// The thread that sends each message at its time, opening ports as needed.
fn spawn_scheduler() -> Sender<Job> {
    let (tx, rx) = mpsc::channel::<Job>();
    std::thread::spawn(move || {
        let mut pending: BinaryHeap<Reverse<Job>> = BinaryHeap::new();
        let mut connections: HashMap<String, MidiOutputConnection> = HashMap::new();
        loop {
            let wait = pending.peek().map(|Reverse(j)| j.at.saturating_duration_since(Instant::now()));
            let job = match wait {
                Some(wait) => rx.recv_timeout(wait),
                None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
            };
            match job {
                Ok(job) => pending.push(Reverse(job)),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            while pending.peek().is_some_and(|Reverse(j)| j.at <= Instant::now()) {
                let Reverse(job) = pending.pop().unwrap();
                if !connections.contains_key(&job.port) {
                    match connect(&job.port) {
                        Ok(conn) => {
                            connections.insert(job.port.clone(), conn);
                        }
                        Err(err) => {
                            eprintln!("[uaithne] MIDI: {err}");
                            continue;
                        }
                    }
                }
                let conn = connections.get_mut(&job.port).unwrap();
                if conn.send(&job.bytes).is_err() {
                    // The device went away; reconnect next time.
                    connections.remove(&job.port);
                }
            }
        }
    });
    tx
}

fn connect(name: &str) -> Result<MidiOutputConnection> {
    let out = MidiOutput::new(CLIENT).map_err(|e| Error::Engine(e.to_string()))?;
    let port = out
        .ports()
        .into_iter()
        .find(|p| out.port_name(p).is_ok_and(|n| n == name))
        .ok_or_else(|| Error::Engine(format!("MIDI output {name} is gone")))?;
    out.connect(&port, "out").map_err(|e| Error::Engine(e.to_string()))
}

/// Dev aid for the self-test: the messages arriving on an input whose name
/// contains `name` (e.g. the other side of Midi Through) during `ms`, as hex.
pub fn capture(name: &str, ms: u64) -> Result<Vec<String>> {
    let input = midir::MidiInput::new("Uaithne self-test").map_err(|e| Error::Engine(e.to_string()))?;
    let port = input
        .ports()
        .into_iter()
        .find(|p| input.port_name(p).is_ok_and(|n| n.to_lowercase().contains(&name.to_lowercase())))
        .ok_or_else(|| Error::Engine(format!("no MIDI input matches {name}")))?;
    let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let connection = input
        .connect(&port, "capture", move |_, bytes, _| {
            sink.lock().unwrap().push(bytes.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" "))
        }, ())
        .map_err(|e| Error::Engine(e.to_string()))?;
    std::thread::sleep(Duration::from_millis(ms));
    connection.close();
    Ok(seen.lock().unwrap().clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_ports() {
        let ports = vec!["Midi Through:Midi Through Port-0 14:0".to_string(), "UM-ONE:UM-ONE MIDI 1 24:0".to_string()];
        assert_eq!(resolve("", &ports).as_deref(), Some("UM-ONE:UM-ONE MIDI 1 24:0"));
        assert_eq!(resolve("through", &ports).as_deref(), Some("Midi Through:Midi Through Port-0 14:0"));
        assert_eq!(resolve("nope", &ports), None);
        assert_eq!(resolve("", &ports[..1]).as_deref(), Some("Midi Through:Midi Through Port-0 14:0"));
    }
}
