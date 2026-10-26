//! Recording to WAV in the workspace's `recordings/`.
//!
//! Strudel's audio is tapped in the page (before the volume control) and
//! arrives here in chunks of interleaved 32-bit float stereo, which this
//! writes with hound. SuperCollider records itself (see `Tidal::record`). With
//! both engines going, each gets its own stem: `<time>_strudel.wav` and
//! `<time>_tidal.wav`; with one, the file is just `<time>.wav`.

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use hound::{SampleFormat, WavSpec, WavWriter};

use crate::error::{Error, Result};

#[derive(Default)]
pub struct Recorder {
    session: Mutex<Option<Session>>,
}

struct Session {
    strudel: Option<WavWriter<BufWriter<File>>>,
    /// SuperCollider is recording too, and needs telling to stop.
    tidal: bool,
    files: Vec<PathBuf>,
}

/// A finished recording.
pub struct Finished {
    pub files: Vec<PathBuf>,
    pub tidal: bool,
}

/// File names for a recording started now, by engine.
pub struct Paths {
    pub strudel: Option<PathBuf>,
    pub tidal: Option<PathBuf>,
}

impl Recorder {
    /// Picks the file names (stems when both engines record) and opens
    /// Strudel's file. Any recording still open is finished first.
    pub fn start(&self, root: &Path, strudel_rate: Option<u32>, tidal: bool) -> Result<Paths> {
        if strudel_rate.is_none() && !tidal {
            return Err(Error::Engine("nothing to record: play something in Strudel or start Tidal first".into()));
        }
        let dir = root.join("recordings");
        std::fs::create_dir_all(&dir)?;
        let stamp = timestamp();
        let both = strudel_rate.is_some() && tidal;
        let name = |engine: &str| dir.join(if both { format!("{stamp}_{engine}.wav") } else { format!("{stamp}.wav") });
        let paths = Paths { strudel: strudel_rate.map(|_| name("strudel")), tidal: tidal.then(|| name("tidal")) };

        let strudel = match (&paths.strudel, strudel_rate) {
            (Some(path), Some(sample_rate)) => {
                let spec = WavSpec { channels: 2, sample_rate, bits_per_sample: 32, sample_format: SampleFormat::Float };
                Some(WavWriter::create(path, spec).map_err(|e| Error::Engine(format!("can't write {}: {e}", path.display())))?)
            }
            _ => None,
        };
        let files = paths.strudel.iter().chain(&paths.tidal).cloned().collect();
        *self.session.lock().unwrap() = Some(Session { strudel, tidal, files });
        Ok(paths)
    }

    /// Appends interleaved little-endian f32 stereo samples to Strudel's file.
    pub fn write_strudel(&self, bytes: &[u8]) -> Result<()> {
        let mut session = self.session.lock().unwrap();
        let Some(writer) = session.as_mut().and_then(|s| s.strudel.as_mut()) else { return Ok(()) };
        for sample in bytes.chunks_exact(4) {
            let value = f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]);
            writer.write_sample(value).map_err(|e| Error::Engine(e.to_string()))?;
        }
        Ok(())
    }

    /// Finishes Strudel's file, returning what the recording made.
    pub fn stop(&self) -> Option<Finished> {
        let session = self.session.lock().unwrap().take()?;
        if let Some(writer) = session.strudel {
            let _ = writer.finalize();
        }
        Some(Finished { files: session.files, tidal: session.tidal })
    }
}

/// Local time as `2026-10-26_14-05-09`.
fn timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as libc::time_t)
        .unwrap_or(0);
    // SAFETY: localtime_r fills the zeroed tm we own from a valid time_t.
    let tm = unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&now, &mut tm);
        tm
    };
    format!(
        "{:04}-{:02}-{:02}_{:02}-{:02}-{:02}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_float_stereo_wav() {
        let dir = std::env::temp_dir().join(format!("uaithne-record-test-{}", std::process::id()));
        let recorder = Recorder::default();
        let paths = recorder.start(&dir, Some(48000), false).unwrap();
        let samples: Vec<u8> = [0.5f32, -0.5, 0.25, -0.25].iter().flat_map(|s| s.to_le_bytes()).collect();
        recorder.write_strudel(&samples).unwrap();
        let files = recorder.stop().unwrap().files;
        assert_eq!(files, vec![paths.strudel.clone().unwrap()]);
        assert!(paths.strudel.unwrap().file_name().unwrap().to_str().unwrap().ends_with(".wav"));
        let mut reader = hound::WavReader::open(&files[0]).unwrap();
        assert_eq!(reader.spec().channels, 2);
        assert_eq!(reader.samples::<f32>().map(|s| s.unwrap()).collect::<Vec<_>>(), vec![0.5, -0.5, 0.25, -0.25]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn names_stems_when_both_record() {
        let dir = std::env::temp_dir().join(format!("uaithne-record-stems-{}", std::process::id()));
        let recorder = Recorder::default();
        let paths = recorder.start(&dir, Some(44100), true).unwrap();
        assert!(paths.strudel.unwrap().to_str().unwrap().ends_with("_strudel.wav"));
        assert!(paths.tidal.unwrap().to_str().unwrap().ends_with("_tidal.wav"));
        recorder.stop();
        let _ = std::fs::remove_dir_all(dir);
    }
}
