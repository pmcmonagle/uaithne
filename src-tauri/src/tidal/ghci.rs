//! The GHCi process running Tidal.
//!
//! Every input is answered by exactly one prompt, and the prompt is a sentinel
//! line, so each request is a numbered "turn": the output between the previous
//! prompt and the next one is that request's. Output outside any turn (Tidal's
//! own messages, pattern errors) goes straight to the log.
//!
//! GHCi numbers source lines across everything read from stdin, so counting
//! the lines sent maps `<interactive>:L:C` back to a line of the block.

use std::collections::VecDeque;
use std::io::Write;
use std::path::Path;
use std::process::{Child, ChildStdin, Command};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::process;
use crate::error::{Error, Result};

const PROMPT: &str = "<<uaithne-ghci>>";
/// Finished turns kept for late readers; older ones are dropped.
const KEEP_TURNS: usize = 8;

pub struct Ghci {
    child: Mutex<Child>,
    io: Mutex<Io>,
    /// Number of turns requested so far.
    expected: AtomicU64,
    turns: Mutex<Turns>,
    turn_done: Condvar,
    stopping: AtomicBool,
}

struct Io {
    stdin: ChildStdin,
    /// Lines written to stdin, which is GHCi's line counter.
    lines: usize,
}

#[derive(Default)]
struct Turns {
    done: u64,
    current: Vec<String>,
    finished: VecDeque<(u64, Vec<String>)>,
    dead: bool,
}

/// What GHCi printed for one block.
pub struct Reply {
    pub lines: Vec<String>,
    /// GHCi's line number for the block's first line.
    first_line: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalReply {
    pub ok: bool,
    pub output: String,
    /// 1-based line and column within the evaluated code.
    pub line: Option<usize>,
    pub column: Option<usize>,
}

pub enum GhciEvent {
    /// Output outside a turn.
    Line(String),
    Exited,
}

impl Ghci {
    pub fn spawn(mut cmd: Command, cwd: &Path, on_event: impl Fn(GhciEvent) + Send + 'static) -> Result<Arc<Self>> {
        cmd.arg("-ignore-dot-ghci").current_dir(cwd);
        let (child, stdin, reader) = process::spawn(cmd)?;
        let ghci = Arc::new(Self {
            child: Mutex::new(child),
            io: Mutex::new(Io { stdin, lines: 0 }),
            expected: AtomicU64::new(0),
            turns: Mutex::new(Turns::default()),
            turn_done: Condvar::new(),
            stopping: AtomicBool::new(false),
        });
        let this = ghci.clone();
        std::thread::spawn(move || {
            process::read_lines(reader, |line| this.on_line(line, &on_event));
            this.turns.lock().unwrap().dead = true;
            this.turn_done.notify_all();
            if !this.stopping.load(Ordering::SeqCst) {
                process::reap(&mut this.child.lock().unwrap());
                on_event(GhciEvent::Exited);
            }
        });
        Ok(ghci)
    }

    fn on_line(&self, line: String, on_event: &impl Fn(GhciEvent)) {
        // The startup banner's prompt arrives glued to the first output.
        let line = line.strip_prefix("ghci> ").unwrap_or(&line);
        let (text, prompt) = match line.find(PROMPT) {
            Some(at) => (&line[..at], true),
            None => (line, false),
        };
        let mut turns = self.turns.lock().unwrap();
        let in_turn = self.expected.load(Ordering::SeqCst) > turns.done;
        if !text.is_empty() || !prompt {
            if in_turn {
                turns.current.push(text.to_string());
            } else if !text.trim().is_empty() {
                on_event(GhciEvent::Line(text.to_string()));
            }
        }
        if prompt {
            turns.done += 1;
            let finished = (turns.done, std::mem::take(&mut turns.current));
            turns.finished.push_back(finished);
            while turns.finished.len() > KEEP_TURNS {
                turns.finished.pop_front();
            }
            self.turn_done.notify_all();
        }
    }

    /// Sends the boot script (which must end by setting the sentinel prompt)
    /// and waits for it to finish.
    pub fn boot(&self, script: &str, timeout: Duration) -> Result<Vec<String>> {
        let turn = self.send(script, 0)?;
        Ok(self.wait(turn, timeout)?.lines)
    }

    /// Evaluates a block: a lone `:command` line as-is, anything else as a
    /// multi-line `:{ … :}` block.
    pub fn eval(&self, code: &str, timeout: Duration) -> Result<EvalReply> {
        let code = code.replace("\r\n", "\n");
        let code = code.trim_end();
        let command = !code.contains('\n') && code.trim_start().starts_with(':');
        let (input, skip) = if command { (format!("{code}\n"), 0) } else { (format!(":{{\n{code}\n:}}\n"), 1) };
        let turn = self.send(&input, skip)?;
        Ok(interpret(self.wait(turn, timeout)?))
    }

    /// Writes `input`, returning its turn number. `skip` lines precede the
    /// user's first line (the `:{`).
    fn send(&self, input: &str, skip: usize) -> Result<(u64, usize)> {
        let mut io = self.io.lock().unwrap();
        let first_line = io.lines + 1 + skip;
        let turn = self.expected.fetch_add(1, Ordering::SeqCst) + 1;
        io.stdin.write_all(input.as_bytes())?;
        io.stdin.flush()?;
        io.lines += input.matches('\n').count();
        Ok((turn, first_line))
    }

    fn wait(&self, (turn, first_line): (u64, usize), timeout: Duration) -> Result<Reply> {
        let deadline = Instant::now() + timeout;
        let mut turns = self.turns.lock().unwrap();
        loop {
            if let Some(i) = turns.finished.iter().position(|(n, _)| *n == turn) {
                let (_, lines) = turns.finished.remove(i).unwrap();
                return Ok(Reply { lines, first_line });
            }
            if turns.dead {
                return Err(Error::Engine("GHCi has stopped".into()));
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(Error::Engine(format!("GHCi didn't answer within {}s", timeout.as_secs())));
            }
            turns = self.turn_done.wait_timeout(turns, left).unwrap().0;
        }
    }

    pub fn pid(&self) -> u32 {
        self.child.lock().unwrap().id()
    }

    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Ok(mut io) = self.io.lock() {
            let _ = io.stdin.write_all(b":quit\n");
            let _ = io.stdin.flush();
        }
        process::shut_down(&mut self.child.lock().unwrap(), Duration::from_secs(1));
    }
}

/// Wraps a BootTidal script: quiet prompts while it runs (dropping its own
/// prompt settings), then the sentinel prompt, whose first appearance ends the boot.
pub fn boot_script(boot: &str) -> String {
    let mut script = String::from(":set prompt \"\"\n:set prompt-cont \"\"\n");
    for line in boot.lines().filter(|l| !l.trim_start().starts_with(":set prompt")) {
        script.push_str(line);
        script.push('\n');
    }
    script.push_str(&format!(":set prompt \"{PROMPT}\\n\"\n"));
    script
}

/// Finds GHC's first error (`<interactive>:L:C: error:` or a runtime exception).
fn interpret(reply: Reply) -> EvalReply {
    let output = reply.lines.join("\n").trim().to_string();
    let mut ok = true;
    let (mut line, mut column) = (None, None);
    for text in &reply.lines {
        if let Some((l, c)) = error_location(text) {
            ok = false;
            // Errors in a block's own lines map back; others (e.g. in a
            // definition it uses) keep no position.
            if l >= reply.first_line {
                line = Some(l - reply.first_line + 1);
                column = Some(c);
            }
            break;
        }
        if text.contains("*** Exception:") || text.trim_start().starts_with("error:") {
            ok = false;
            break;
        }
    }
    EvalReply { ok, output, line, column }
}

/// `<interactive>:12:5: error: …` (or `<interactive>:12:5-9: error`) → (12, 5).
fn error_location(text: &str) -> Option<(usize, usize)> {
    let rest = &text[text.find("<interactive>:")? + "<interactive>:".len()..];
    let (location, after) = rest.split_once(": ")?;
    if !after.starts_with("error") {
        return None;
    }
    // Spans look like 12:5-9 or (12,5)-(13,2).
    let location = location.trim_start_matches('(').replace(',', ":");
    let mut parts = location.split(':');
    let line = parts.next()?.parse().ok()?;
    let column = parts.next()?.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()?;
    Some((line, column))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locates_errors() {
        assert_eq!(error_location("<interactive>:6:9: error: Variable not in scope: foo"), Some((6, 9)));
        assert_eq!(error_location("<interactive>:12:5-9: error:"), Some((12, 5)));
        assert_eq!(error_location("<interactive>:(3,1)-(4,7): error: [GHC-88464]"), Some((3, 1)));
        assert_eq!(error_location("<interactive>:6:9: warning: [-Wtype-defaults]"), None);
    }

    #[test]
    fn maps_lines_into_the_block() {
        let reply = Reply { lines: vec!["".into(), "<interactive>:9:1: error: Variable not in scope: x".into()], first_line: 8 };
        let r = interpret(reply);
        assert!(!r.ok);
        assert_eq!((r.line, r.column), (Some(2), Some(1)));
    }
}
