//! OSC out for Strudel's `.osc()`, standing in for the Node bridge strudel.cc
//! uses. Each message goes out at once in a bundle timestamped with when it
//! should play, which SuperDirt (the default target) schedules by.

use std::net::{ToSocketAddrs, UdpSocket};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use rosc::{OscBundle, OscMessage, OscPacket, OscTime, OscType};
use serde::Deserialize;

use crate::error::{Error, Result};

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum Arg {
    Str(String),
    Num(f64),
    Bool(bool),
}

impl From<Arg> for OscType {
    fn from(arg: Arg) -> Self {
        match arg {
            Arg::Str(s) => OscType::String(s),
            Arg::Num(n) => OscType::Float(n as f32),
            Arg::Bool(b) => OscType::Int(b as i32),
        }
    }
}

#[derive(Default)]
pub struct Osc {
    socket: Mutex<Option<UdpSocket>>,
}

impl Osc {
    /// Sends `address args…` to `target` ("host:port"), timestamped `delay_ms` from now.
    pub fn send(&self, target: &str, address: &str, args: Vec<Arg>, delay_ms: f64) -> Result<()> {
        let addr = target
            .to_socket_addrs()
            .ok()
            .and_then(|mut a| a.next())
            .ok_or_else(|| Error::Engine(format!("OSC target \"{target}\" isn't host:port")))?;
        let at = SystemTime::now() + Duration::from_secs_f64(delay_ms.max(0.0) / 1000.0);
        let message = OscMessage { addr: address.to_string(), args: args.into_iter().map(OscType::from).collect() };
        let bundle = OscBundle { timetag: OscTime::try_from(at).map_err(|e| Error::Engine(e.to_string()))?, content: vec![OscPacket::Message(message)] };
        let bytes = rosc::encoder::encode(&OscPacket::Bundle(bundle)).map_err(|e| Error::Engine(e.to_string()))?;
        let mut socket = self.socket.lock().unwrap();
        if socket.is_none() {
            *socket = Some(UdpSocket::bind(("0.0.0.0", 0))?);
        }
        socket.as_ref().unwrap().send_to(&bytes, addr)?;
        Ok(())
    }
}
