use thiserror::Error;

#[derive(Error, Debug)]
#[allow(dead_code)]
pub enum OpenDBSError {
    #[error("Invalid identifier: {0}")]
    InvalidIdentifier(String),

    #[error("Index not found for rack '{0}' field '{1}'")]
    IndexNotFound(String, String),

    #[error("Vector dimension mismatch: index expects {expected}, got {actual}")]
    DimensionMismatch { expected: usize, actual: usize },

    #[error("Invalid input: {0}")]
    InvalidInput(String),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),

    #[error("Persistence error: {0}")]
    PersistenceError(String),

    #[error("Compression error: {0}")]
    CompressionError(String),

    #[error("Internal error: {0}")]
    Internal(String),
}

pub type Result<T> = std::result::Result<T, OpenDBSError>;
