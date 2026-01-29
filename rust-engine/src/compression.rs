#![allow(dead_code)]
use crate::error::{OpenDBSError, Result};

/// Compress data using Snappy
pub fn compress(data: &[u8]) -> Result<Vec<u8>> {
    let mut encoder = snap::write::FrameEncoder::new(Vec::new());
    std::io::Write::write_all(&mut encoder, data)
        .map_err(|e| OpenDBSError::CompressionError(e.to_string()))?;
    encoder.into_inner().map_err(|e| OpenDBSError::CompressionError(e.to_string()))
}

/// Decompress data using Snappy
pub fn decompress(data: &[u8]) -> Result<Vec<u8>> {
    let mut decoder = snap::read::FrameDecoder::new(data);
    let mut buffer = Vec::new();
    std::io::Read::read_to_end(&mut decoder, &mut buffer)
        .map_err(|e| OpenDBSError::CompressionError(e.to_string()))?;
    Ok(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compression() {
        let data = b"Hello, OpenDBS! This is a test of compression.";
        let compressed = compress(data).unwrap();
        let decompressed = decompress(&compressed).unwrap();
        
        assert_eq!(data, decompressed.as_slice());
        println!("Original: {} bytes", data.len());
        println!("Compressed: {} bytes", compressed.len());
    }
}
