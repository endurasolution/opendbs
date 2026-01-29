use thiserror::Error;

#[derive(Error, Debug)]
#[allow(dead_code)]
pub enum OpenDBSError {
    #[error("Database not found: {0}")]
    DatabaseNotFound(String),

    #[error("Rack not found: {0}")]
    RackNotFound(String),

    #[error("Document not found: {0}")]
    DocumentNotFound(String),

    #[error("Invalid query: {0}")]
    InvalidQuery(String),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),

    #[error("Compression error: {0}")]
    CompressionError(String),

    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    #[error("Internal error: {0}")]
    Internal(String),
}

pub type Result<T> = std::result::Result<T, OpenDBSError>;
