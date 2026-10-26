//! Highlighting the Tidal code that's playing.
//!
//! Before a block is sent, every string literal becomes
//! `(deltaContext col line "…")`, so mini-notation events carry their place in
//! the block. A second stream target (see BootTidal.hs) then sends one
//! `/editor/highlights` message per event and position, at the moment it plays:
//! the pattern id, its duration in microseconds, its cycle, and
//! `column line endColumn endLine` (columns 0-based, lines 1-based, end
//! exclusive). The listener forwards these as `tidal-highlight` events.

use std::collections::HashMap;
use std::net::UdpSocket;
use std::time::{Duration, Instant};

use rosc::{OscPacket, OscType};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::Result;

const ADDRESS: &str = "/editor/highlights";
/// How long a seen event is remembered; Tidal resends long events every frame.
const REMEMBER: Duration = Duration::from_secs(16);

/// Wraps each string literal in `deltaContext`, skipping comments and
/// character literals. Columns count characters, as GHC and Parsec do.
pub fn rewrite(code: &str) -> String {
    let chars: Vec<char> = code.chars().collect();
    let mut out = String::with_capacity(code.len() + code.len() / 2);
    let (mut i, mut line, mut column) = (0, 0, 0);
    // Copies chars[i..end] unchanged, keeping line and column.
    let copy = |out: &mut String, i: &mut usize, end: usize, line: &mut usize, column: &mut usize| {
        for &c in &chars[*i..end] {
            out.push(c);
            if c == '\n' {
                *line += 1;
                *column = 0;
            } else {
                *column += 1;
            }
        }
        *i = end;
    };
    while i < chars.len() {
        let c = chars[i];
        let prev = i.checked_sub(1).map(|p| chars[p]);
        let end = match c {
            '{' if chars.get(i + 1) == Some(&'-') => block_comment_end(&chars, i),
            '-' if prev.is_none_or(|p| !is_symbol(p)) => {
                let run = chars[i..].iter().take_while(|&&c| c == '-').count();
                let after = chars.get(i + run);
                if run >= 2 && after.is_none_or(|&a| !is_symbol(a)) {
                    chars[i..].iter().position(|&c| c == '\n').map_or(chars.len(), |n| i + n)
                } else {
                    i + run
                }
            }
            '\'' if prev.is_none_or(|p| !is_ident(p)) => char_literal_end(&chars, i).unwrap_or(i + 1),
            '"' => match string_end(&chars, i) {
                Some(end) => {
                    out.push_str(&format!("(deltaContext {column} {line} "));
                    copy(&mut out, &mut i, end, &mut line, &mut column);
                    out.push(')');
                    continue;
                }
                None => chars.len(), // unterminated: leave the rest for GHC to report
            },
            _ if is_ident(c) => i + chars[i..].iter().take_while(|&&c| is_ident(c)).count(),
            _ => i + 1,
        };
        copy(&mut out, &mut i, end, &mut line, &mut column);
    }
    out
}

/// Characters of Haskell operator symbols.
fn is_symbol(c: char) -> bool {
    "!#$%&*+./<=>?@\\^|-~:".contains(c)
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '\''
}

/// End (exclusive) of a nested `{- … -}` comment starting at `start`.
fn block_comment_end(chars: &[char], start: usize) -> usize {
    let (mut depth, mut i) = (0, start);
    while i + 1 < chars.len() {
        match (chars[i], chars[i + 1]) {
            ('{', '-') => {
                depth += 1;
                i += 2;
            }
            ('-', '}') => {
                depth -= 1;
                i += 2;
                if depth == 0 {
                    return i;
                }
            }
            _ => i += 1,
        }
    }
    chars.len()
}

/// End (exclusive) of a character literal like `'x'` or `'\''` at `start`.
fn char_literal_end(chars: &[char], start: usize) -> Option<usize> {
    if chars.get(start + 1) == Some(&'\\') {
        let close = chars[start + 2..].iter().take(10).position(|&c| c == '\'')?;
        Some(start + 2 + close + 1)
    } else {
        (chars.get(start + 2) == Some(&'\'') && chars.get(start + 1) != Some(&'\n')).then_some(start + 3)
    }
}

/// End (exclusive) of the string literal at `start`, if it closes on its line.
fn string_end(chars: &[char], start: usize) -> Option<usize> {
    let mut i = start + 1;
    while i < chars.len() {
        match chars[i] {
            '\\' => i += 2,
            '"' => return Some(i + 1),
            '\n' => return None,
            _ => i += 1,
        }
    }
    None
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    /// Tidal's pattern id: `1` for `d1`, the name for `p "name"`.
    pub id: String,
    /// 1-based line within the evaluated block, and 0-based columns.
    pub line: i32,
    pub column: i32,
    pub end_line: i32,
    pub end_column: i32,
    /// Seconds the event lasts.
    pub duration: f32,
}

/// Listens for Tidal's highlight messages on a free local port, forwarding
/// them as `tidal-highlight` events. Returns the port.
pub fn listen(app: AppHandle) -> Result<u16> {
    let socket = UdpSocket::bind(("127.0.0.1", 0))?;
    let port = socket.local_addr()?.port();
    std::thread::spawn(move || {
        let mut seen: HashMap<(String, u32, [i32; 4]), Instant> = HashMap::new();
        let mut buf = vec![0u8; rosc::decoder::MTU];
        loop {
            let Ok(n) = socket.recv(&mut buf) else { continue };
            let mut batch = Vec::new();
            collect(&buf[..n], &mut seen, &mut batch);
            // Take whatever else has arrived, so one frame's events go together.
            let _ = socket.set_nonblocking(true);
            while let Ok(n) = socket.recv(&mut buf) {
                collect(&buf[..n], &mut seen, &mut batch);
            }
            let _ = socket.set_nonblocking(false);
            if !batch.is_empty() {
                let _ = app.emit("tidal-highlight", batch);
            }
            if seen.len() > 4096 {
                seen.retain(|_, at| at.elapsed() < REMEMBER);
            }
        }
    });
    Ok(port)
}

/// Decodes one packet, adding events not seen before to `batch`.
fn collect(packet: &[u8], seen: &mut HashMap<(String, u32, [i32; 4]), Instant>, batch: &mut Vec<Highlight>) {
    let Ok((_, packet)) = rosc::decoder::decode_udp(packet) else { return };
    let mut stack = vec![packet];
    while let Some(packet) = stack.pop() {
        let message = match packet {
            OscPacket::Bundle(bundle) => {
                stack.extend(bundle.content);
                continue;
            }
            OscPacket::Message(message) => message,
        };
        if message.addr != ADDRESS {
            continue;
        }
        let Some((id, delta, cycle, pos)) = parse(&message.args) else { continue };
        let now = Instant::now();
        let key = (id.clone(), cycle.to_bits(), pos);
        if seen.get(&key).is_some_and(|at| now.duration_since(*at) < REMEMBER) {
            continue;
        }
        seen.insert(key, now);
        let [column, line, end_column, end_line] = pos;
        batch.push(Highlight { id, line, column, end_line, end_column, duration: delta / 1e6 });
    }
}

fn parse(args: &[OscType]) -> Option<(String, f32, f32, [i32; 4])> {
    let [OscType::String(id), OscType::Float(delta), OscType::Float(cycle), rest @ ..] = args else { return None };
    let ints: Vec<i32> = rest.iter().filter_map(|a| if let OscType::Int(i) = a { Some(*i) } else { None }).collect();
    Some((id.clone(), *delta, *cycle, ints.try_into().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_strings_with_their_place() {
        assert_eq!(
            rewrite("d1 $ s \"bd sn\"\n  # n \"<0 1>\""),
            "d1 $ s (deltaContext 7 0 \"bd sn\")\n  # n (deltaContext 6 1 \"<0 1>\")"
        );
        assert_eq!(rewrite("p \"x\" $ s \"a\\\"b\""), "p (deltaContext 2 0 \"x\") $ s (deltaContext 10 0 \"a\\\"b\")");
    }

    #[test]
    fn skips_comments_and_chars() {
        let code = "-- \"no\"\nd1 $ s \"bd\" -- \"no\"\n{- \"no\" {- \"nested\" -} -} s \"a\"";
        assert_eq!(
            rewrite(code),
            "-- \"no\"\nd1 $ s (deltaContext 7 1 \"bd\") -- \"no\"\n{- \"no\" {- \"nested\" -} -} s (deltaContext 28 2 \"a\")"
        );
        assert_eq!(rewrite("f '\"' \"x\""), "f '\"' (deltaContext 6 0 \"x\")");
        assert_eq!(rewrite("f '\\'' \"x\""), "f '\\'' (deltaContext 7 0 \"x\")");
        // Primes in names aren't character literals; `-->` isn't a comment.
        assert_eq!(rewrite("jumpIn' 1 \"a\""), "jumpIn' 1 (deltaContext 10 0 \"a\")");
        assert_eq!(rewrite("x --> \"a\""), "x --> (deltaContext 6 0 \"a\")");
        // An unterminated string is left for GHC to report.
        assert_eq!(rewrite("s \"bd"), "s \"bd");
    }

    #[test]
    fn decodes_messages() {
        let message = rosc::OscMessage {
            addr: ADDRESS.into(),
            args: vec![
                OscType::String("1".into()),
                OscType::Float(500_000.0),
                OscType::Float(0.5),
                OscType::Int(8),
                OscType::Int(1),
                OscType::Int(10),
                OscType::Int(1),
            ],
        };
        let bytes = rosc::encoder::encode(&OscPacket::Message(message)).unwrap();
        let (mut seen, mut batch) = (HashMap::new(), Vec::new());
        collect(&bytes, &mut seen, &mut batch);
        collect(&bytes, &mut seen, &mut batch); // a repeat is dropped
        assert_eq!(batch.len(), 1);
        let h = &batch[0];
        assert_eq!((h.id.as_str(), h.line, h.column, h.end_line, h.end_column), ("1", 1, 8, 1, 10));
        assert_eq!(h.duration, 0.5);
    }
}
