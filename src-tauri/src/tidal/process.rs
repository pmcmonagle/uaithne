//! Spawning the engine processes: one merged, ordered output stream per
//! process, and a process group so helpers they start (scsynth) die with them.

use std::io::{BufRead, BufReader, PipeReader};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

use crate::error::{Error, Result};

/// A command from a config string such as `stack exec -- ghci`, with the
/// usual per-user tool folders on PATH (a desktop launch often lacks them).
pub fn command(spec: &str) -> Result<Command> {
    let mut words = spec.split_whitespace();
    let program = words.next().ok_or_else(|| Error::Engine("empty command in uaithne.toml".into()))?;
    let mut cmd = Command::new(program);
    cmd.args(words);
    cmd.env("PATH", search_path());
    if std::env::var_os("LANG").is_none() {
        cmd.env("LANG", "C.UTF-8");
    }
    Ok(cmd)
}

fn search_path() -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for extra in [".ghcup/bin", ".cabal/bin", ".local/bin"] {
            let dir = home.join(extra);
            if dir.is_dir() {
                dirs.push(dir);
            }
        }
    }
    dirs.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()));
    dirs.dedup();
    std::env::join_paths(dirs).unwrap_or_default()
}

/// Finds `program` on the same PATH the engines get.
pub fn which(program: &str) -> Option<PathBuf> {
    std::env::split_paths(&search_path())
        .map(|dir| dir.join(program))
        .find(|path| path.is_file())
}

/// Spawns with stdout and stderr on one pipe, so errors and prompts arrive in order.
pub fn spawn(mut cmd: Command) -> Result<(Child, ChildStdin, PipeReader)> {
    let (reader, writer) = std::io::pipe()?;
    cmd.stdin(Stdio::piped()).stdout(writer.try_clone()?).stderr(writer).process_group(0);
    let mut child = cmd.spawn()?;
    // The command holds the pipe's write end; drop it so EOF arrives when the child exits.
    drop(cmd);
    let stdin = child.stdin.take().expect("stdin is piped");
    Ok((child, stdin, reader))
}

/// Calls `on_line` for each output line (lossy UTF-8, without the newline) until EOF.
pub fn read_lines(reader: PipeReader, mut on_line: impl FnMut(String)) {
    let mut reader = BufReader::new(reader);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf);
                on_line(line.trim_end_matches(['\n', '\r']).to_string());
            }
        }
    }
}

/// Waits up to `grace` for the child to exit on its own, then terminates its
/// whole process group, escalating to SIGKILL.
pub fn shut_down(child: &mut Child, grace: Duration) {
    let pgid = child.id() as libc::pid_t;
    let exited = |child: &mut Child, within: Duration| {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    };
    let quit = exited(child, grace);
    // SAFETY: killpg only sends a signal; the group is the one spawn() created.
    unsafe { libc::killpg(pgid, libc::SIGTERM) };
    if !quit && !exited(child, Duration::from_secs(2)) {
        unsafe { libc::killpg(pgid, libc::SIGKILL) };
        let _ = child.wait();
    }
}

/// Cleans up after a child that died on its own: kills what's left of its
/// process group (scsynth outlives a crashed sclang) and reaps it.
pub fn reap(child: &mut Child) {
    // SAFETY: as in shut_down.
    unsafe { libc::killpg(child.id() as libc::pid_t, libc::SIGKILL) };
    let _ = child.wait();
}

/// Runs a short command and returns its combined output, or None if it couldn't run.
pub fn output(cmd: Command, stdin: &str) -> Option<(bool, String)> {
    use std::io::Write;
    let (mut child, mut input, reader) = spawn(cmd).ok()?;
    let _ = input.write_all(stdin.as_bytes());
    drop(input);
    let mut text = String::new();
    read_lines(reader, |line| {
        text.push_str(&line);
        text.push('\n');
    });
    let ok = child.wait().is_ok_and(|s| s.success());
    Some((ok, text))
}
