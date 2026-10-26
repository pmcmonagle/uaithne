use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("no workspace is open")]
    NoWorkspace,
    #[error("invalid track path: {0}")]
    InvalidPath(String),
    #[error("track already exists: {0}")]
    AlreadyExists(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("uaithne.toml: {0}")]
    Toml(#[from] toml::de::Error),
    #[error(transparent)]
    Notify(#[from] notify::Error),
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
    #[error("{0}")]
    Pack(String),
    #[error("{0}")]
    Engine(String),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
}

// Commands return errors to the frontend as plain strings.
impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
