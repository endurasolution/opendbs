use napi_derive::napi;
use std::sync::Arc;
use parking_lot::RwLock;

mod storage;
mod index;
mod query;
mod compression;
mod error;

use storage::StorageEngine;

/// Main OpenDBS engine instance
#[napi]
pub struct OpenDBSEngine {
    engine: Arc<RwLock<StorageEngine>>,
}

#[napi]
impl OpenDBSEngine {
    /// Create a new OpenDBS engine instance
    #[napi(constructor)]
    pub fn new(path: String) -> napi::Result<Self> {
        let engine = StorageEngine::new(&path)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        
        Ok(Self {
            engine: Arc::new(RwLock::new(engine)),
        })
    }

    /// Create a new database
    #[napi]
    pub fn create_database(&self, name: String) -> napi::Result<bool> {
        self.engine
            .write()
            .create_database(&name)
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Create a new rack (collection/table)
    #[napi]
    pub fn create_rack(&self, database: String, rack: String) -> napi::Result<bool> {
        self.engine
            .write()
            .create_rack(&database, &rack)
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Insert a document into a rack
    #[napi]
    pub fn insert(&self, database: String, rack: String, data: String) -> napi::Result<String> {
        self.engine
            .write()
            .insert(&database, &rack, &data)
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Find documents matching a query
    #[napi]
    pub fn find(&self, database: String, rack: String, query: String) -> napi::Result<Vec<String>> {
        self.engine
            .read()
            .find(&database, &rack, &query)
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Update a document
    #[napi]
    pub fn update(&self, database: String, rack: String, id: String, data: String) -> napi::Result<bool> {
        self.engine
            .write()
            .update(&database, &rack, &id, &data)
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Delete a document
    #[napi]
    pub fn delete(&self, database: String, rack: String, id: String) -> napi::Result<bool> {
        self.engine
            .write()
            .delete(&database, &rack, &id)
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Perform fuzzy search
    #[napi]
    pub fn fuzzy_search(
        &self,
        database: String,
        rack: String,
        field: String,
        query: String,
        threshold: f64,
    ) -> napi::Result<Vec<String>> {
        self.engine
            .read()
            .fuzzy_search(&database, &rack, &field, &query, threshold)
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// Get storage statistics
    #[napi]
    pub fn get_stats(&self) -> napi::Result<String> {
        self.engine
            .read()
            .get_stats()
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_operations() {
        // Tests will be added here
    }
}
