//! Wiring SuperCollider's outputs to a PipeWire sink.
//!
//! scsynth's JACK auto-connect doesn't find PipeWire's sinks (they aren't
//! named `system:playback_*`), so after boot Uaithne links `<client>:out_N` to
//! the sink's playback ports itself with `pw-link`, dropping any other links.

use std::process::Command;

use super::process;
use crate::error::{Error, Result};

pub fn available() -> bool {
    process::which("pw-link").is_some()
}

/// `pw-jack`, which runs a JACK program against PipeWire, if installed.
pub fn pw_jack() -> Option<std::path::PathBuf> {
    process::which("pw-jack")
}

fn run(args: &[&str]) -> Result<String> {
    let out = Command::new("pw-link").args(args).output()?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The sink named in uaithne.toml, or the system default for "default".
pub fn sink(setting: &str) -> Result<String> {
    if setting != "default" && !setting.is_empty() {
        return Ok(setting.to_string());
    }
    let out = Command::new("pactl").arg("get-default-sink").output()?;
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if name.is_empty() {
        return Err(Error::Engine("couldn't find the default audio output (pactl get-default-sink)".into()));
    }
    Ok(name)
}

/// The sink's playback ports in PipeWire's order (FL, FR, …).
fn playback_ports(sink: &str) -> Result<Vec<String>> {
    let prefix = format!("{sink}:playback_");
    Ok(run(&["-i"])?.lines().map(str::trim).filter(|p| p.starts_with(&prefix)).map(String::from).collect())
}

/// Current links from each of `ports`, from `pw-link -l -o` output:
/// a port line followed by `  |-> target` lines.
fn links_from(ports: &[String]) -> Result<Vec<(String, String)>> {
    let mut links = Vec::new();
    let mut current: Option<&String> = None;
    for line in run(&["-l", "-o"])?.lines() {
        if let Some(target) = line.trim_start().strip_prefix("|-> ") {
            if let Some(port) = current {
                links.push((port.clone(), target.trim().to_string()));
            }
        } else if !line.starts_with(' ') {
            current = ports.iter().find(|p| p.as_str() == line.trim());
        }
    }
    Ok(links)
}

/// Links `client`'s outputs to `sink` (output N to playback port N, wrapping
/// for mono) and unlinks them from anything else. Returns a description.
pub fn link(client: &str, sink: &str, channels: usize) -> Result<String> {
    let targets = playback_ports(sink)?;
    if targets.is_empty() {
        return Err(Error::Engine(format!("audio output {sink} has no playback ports")));
    }
    let outs: Vec<String> = (1..=channels).map(|n| format!("{client}:out_{n}")).collect();
    let wanted: Vec<(String, String)> =
        outs.iter().enumerate().map(|(i, out)| (out.clone(), targets[i % targets.len()].clone())).collect();
    for (out, target) in links_from(&outs)? {
        if !wanted.contains(&(out.clone(), target.clone())) {
            let _ = Command::new("pw-link").args(["-d", &out, &target]).output();
        }
    }
    for (out, target) in &wanted {
        // Fails harmlessly with "File exists" when the link is already there.
        let _ = Command::new("pw-link").args([out, target]).output()?;
    }
    let linked = links_from(&outs)?;
    let missing: Vec<&String> = wanted.iter().filter(|w| !linked.contains(w)).map(|(out, _)| out).collect();
    if !missing.is_empty() {
        return Err(Error::Engine(format!(
            "couldn't link {} to {sink}; is SuperCollider's JACK client named {client}?",
            missing.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
        )));
    }
    Ok(sink.to_string())
}
