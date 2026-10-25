use dashmap::DashMap;
use napi_derive::napi;
use std::path::{Path, PathBuf};
use std::sync::Arc;

mod compression;
mod error;
mod fulltext;
mod storage;
mod vector;

pub use storage::Store;

use error::OpenDBSError;
use fulltext::FullTextIndex;
use vector::VectorIndex;

const MAX_IDENTIFIER_LEN: usize = 64;
const MAX_DOC_ID_LEN: usize = 256;

fn validate_identifier(name: &str) -> napi::Result<()> {
    if name.is_empty() || name.len() > MAX_IDENTIFIER_LEN {
        return Err(napi::Error::from_reason(format!(
            "invalid identifier (must be 1-{} chars): {}",
            MAX_IDENTIFIER_LEN, name
        )));
    }
    let ok = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !ok {
        return Err(napi::Error::from_reason(format!(
            "invalid identifier (letters, numbers, underscore, hyphen only): {}",
            name
        )));
    }
    Ok(())
}

fn validate_doc_id(doc_id: &str) -> napi::Result<()> {
    if doc_id.is_empty() || doc_id.len() > MAX_DOC_ID_LEN {
        return Err(napi::Error::from_reason("invalid document id length"));
    }
    Ok(())
}

fn to_napi_err(e: OpenDBSError) -> napi::Error {
    napi::Error::from_reason(e.to_string())
}

/// (database, rack, field) -> index. Kept as a tuple key (not a joined
/// string) so there's no risk of two different databases with a
/// same-named rack/field colliding on the same index.
type IndexKey = (String, String, String);

#[napi(object)]
pub struct ScoredId {
    pub id: String,
    pub score: f64,
}

#[napi(object)]
pub struct VectorItem {
    pub doc_id: String,
    pub vector: Vec<f64>,
}

#[napi(object)]
pub struct VectorIndexStats {
    pub logical_count: u32,
    pub physical_count: u32,
    pub needs_rebuild: bool,
}

/// Rust-accelerated search index manager: owns only the full-text (fuzzy)
/// and vector indexes for each (database, rack, field). Documents
/// themselves remain owned by the TypeScript engine; this addon is purely
/// an accelerator that TS can fall back away from if it isn't available on
/// a given platform.
#[napi]
pub struct SearchEngine {
    root_path: PathBuf,
    text_indexes: DashMap<IndexKey, Arc<FullTextIndex>>,
    vector_indexes: DashMap<IndexKey, Arc<VectorIndex>>,
}

fn text_index_path(root: &Path, database: &str, rack: &str, field: &str) -> PathBuf {
    root.join(format!("{}__{}__{}.textidx", database, rack, field))
}

fn vector_index_path(root: &Path, database: &str, rack: &str, field: &str) -> PathBuf {
    root.join(format!("{}__{}__{}.vecidx", database, rack, field))
}

#[napi]
impl SearchEngine {
    #[napi(constructor)]
    pub fn new(path: String) -> napi::Result<Self> {
        let root_path = PathBuf::from(path);
        std::fs::create_dir_all(&root_path)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        Ok(Self {
            root_path,
            text_indexes: DashMap::new(),
            vector_indexes: DashMap::new(),
        })
    }

    fn get_or_load_text_index(
        &self,
        database: &str,
        rack: &str,
        field: &str,
    ) -> napi::Result<Arc<FullTextIndex>> {
        let key = (database.to_string(), rack.to_string(), field.to_string());
        if let Some(existing) = self.text_indexes.get(&key) {
            return Ok(existing.clone());
        }
        let path = text_index_path(&self.root_path, database, rack, field);
        let index = if path.exists() {
            FullTextIndex::load(&path).map_err(to_napi_err)?
        } else {
            FullTextIndex::new()
        };
        let index = Arc::new(index);
        self.text_indexes.insert(key, index.clone());
        Ok(index)
    }

    #[napi]
    pub fn index_text(
        &self,
        database: String,
        rack: String,
        field: String,
        doc_id: String,
        text: String,
    ) -> napi::Result<()> {
        validate_identifier(&database)?;
        validate_identifier(&rack)?;
        validate_identifier(&field)?;
        validate_doc_id(&doc_id)?;
        let index = self.get_or_load_text_index(&database, &rack, &field)?;
        index.index_text(&doc_id, &text).map_err(to_napi_err)
    }

    #[napi]
    pub fn remove_text(
        &self,
        database: String,
        rack: String,
        field: String,
        doc_id: String,
    ) -> napi::Result<()> {
        validate_identifier(&database)?;
        validate_identifier(&rack)?;
        validate_identifier(&field)?;
        validate_doc_id(&doc_id)?;
        let key = (database, rack, field);
        if let Some(index) = self.text_indexes.get(&key) {
            index.remove_text(&doc_id);
        }
        Ok(())
    }

    #[napi]
    pub fn search_text(
        &self,
        database: String,
        rack: String,
        field: String,
        query: String,
        limit: u32,
    ) -> napi::Result<Vec<ScoredId>> {
        validate_identifier(&database)?;
        validate_identifier(&rack)?;
        validate_identifier(&field)?;
        let key = (database.clone(), rack.clone(), field.clone());
        if !self.text_indexes.contains_key(&key)
            && !text_index_path(&self.root_path, &database, &rack, &field).exists()
        {
            return Ok(Vec::new());
        }
        let index = self.get_or_load_text_index(&database, &rack, &field)?;
        let results = index
            .search(&query, limit as usize)
            .map_err(to_napi_err)?;
        Ok(results
            .into_iter()
            .map(|(id, score)| ScoredId {
                id,
                score: score as f64,
            })
            .collect())
    }

    fn get_or_load_vector_index(
        &self,
        database: &str,
        rack: &str,
        field: &str,
        infer_dims: Option<usize>,
    ) -> napi::Result<Arc<VectorIndex>> {
        let key = (database.to_string(), rack.to_string(), field.to_string());
        if let Some(existing) = self.vector_indexes.get(&key) {
            return Ok(existing.clone());
        }
        let path = vector_index_path(&self.root_path, database, rack, field);
        let index = if path.exists() {
            VectorIndex::load(&path).map_err(to_napi_err)?
        } else if let Some(dims) = infer_dims {
            VectorIndex::new(dims, 1000).map_err(to_napi_err)?
        } else {
            return Err(napi::Error::from_reason(format!(
                "no vector index for database '{}' rack '{}' field '{}'",
                database, rack, field
            )));
        };
        let index = Arc::new(index);
        self.vector_indexes.insert(key, index.clone());
        Ok(index)
    }

    #[napi]
    pub fn add_vector(
        &self,
        database: String,
        rack: String,
        field: String,
        doc_id: String,
        vector: Vec<f64>,
    ) -> napi::Result<()> {
        validate_identifier(&database)?;
        validate_identifier(&rack)?;
        validate_identifier(&field)?;
        validate_doc_id(&doc_id)?;
        if vector.is_empty() {
            return Err(napi::Error::from_reason("vector must not be empty"));
        }
        let index =
            self.get_or_load_vector_index(&database, &rack, &field, Some(vector.len()))?;
        let vector_f32: Vec<f32> = vector.iter().map(|v| *v as f32).collect();
        index.add_vector(&doc_id, &vector_f32).map_err(to_napi_err)
    }

    /// Bulk variant of `add_vector` using parallel insertion -- orders of
    /// magnitude faster for backfilling an index (e.g. when a text/vector
    /// index is created on a rack that already has many documents), since
    /// it avoids one NAPI round-trip + one graph write per item.
    #[napi]
    pub fn add_vectors_batch(
        &self,
        database: String,
        rack: String,
        field: String,
        items: Vec<VectorItem>,
    ) -> napi::Result<()> {
        validate_identifier(&database)?;
        validate_identifier(&rack)?;
        validate_identifier(&field)?;
        if items.is_empty() {
            return Ok(());
        }
        for item in &items {
            validate_doc_id(&item.doc_id)?;
            if item.vector.is_empty() {
                return Err(napi::Error::from_reason("vector must not be empty"));
            }
        }
        let dims = items[0].vector.len();
        let index = self.get_or_load_vector_index(&database, &rack, &field, Some(dims))?;
        let converted: Vec<(String, Vec<f32>)> = items
            .into_iter()
            .map(|item| {
                (
                    item.doc_id,
                    item.vector.iter().map(|v| *v as f32).collect(),
                )
            })
            .collect();
        index.add_vectors_batch(&converted).map_err(to_napi_err)
    }

    #[napi]
    pub fn remove_vector(
        &self,
        database: String,
        rack: String,
        field: String,
        doc_id: String,
    ) -> napi::Result<()> {
        validate_identifier(&database)?;
        validate_identifier(&rack)?;
        validate_identifier(&field)?;
        validate_doc_id(&doc_id)?;
        let key = (database, rack, field);
        if let Some(index) = self.vector_indexes.get(&key) {
            index.remove_vector(&doc_id);
        }
        Ok(())
    }

    #[napi]
    pub fn search_vector(
        &self,
        database: String,
        rack: String,
        field: String,
        query: Vec<f64>,
        k: u32,
    ) -> napi::Result<Vec<ScoredId>> {
        validate_identifier(&database)?;
        validate_identifier(&rack)?;
        validate_identifier(&field)?;
        let key = (database.clone(), rack.clone(), field.clone());
        let query_f32: Vec<f32> = query.iter().map(|v| *v as f32).collect();

        let index = if self.vector_indexes.contains_key(&key) {
            self.get_or_load_vector_index(&database, &rack, &field, None)?
        } else {
            let path = vector_index_path(&self.root_path, &database, &rack, &field);
            if !path.exists() {
                return Ok(Vec::new());
            }
            self.get_or_load_vector_index(&database, &rack, &field, None)?
        };

        let results = index.search(&query_f32, k as usize).map_err(to_napi_err)?;
        Ok(results
            .into_iter()
            .map(|(id, score)| ScoredId {
                id,
                score: score as f64,
            })
            .collect())
    }

    #[napi]
    pub fn vector_stats(
        &self,
        database: String,
        rack: String,
        field: String,
    ) -> napi::Result<VectorIndexStats> {
        validate_identifier(&database)?;
        validate_identifier(&rack)?;
        validate_identifier(&field)?;
        let key = (database, rack, field);
        let Some(index) = self.vector_indexes.get(&key) else {
            return Ok(VectorIndexStats {
                logical_count: 0,
                physical_count: 0,
                needs_rebuild: false,
            });
        };
        Ok(VectorIndexStats {
            logical_count: index.logical_count() as u32,
            physical_count: index.physical_count() as u32,
            needs_rebuild: index.needs_rebuild(),
        })
    }

    #[napi]
    pub fn rebuild_vector_index(
        &self,
        database: String,
        rack: String,
        field: String,
    ) -> napi::Result<()> {
        validate_identifier(&database)?;
        validate_identifier(&rack)?;
        validate_identifier(&field)?;
        let key = (database, rack, field);
        if let Some(index) = self.vector_indexes.get(&key) {
            index.rebuild();
        }
        Ok(())
    }

    /// Persists every currently-loaded text and vector index to disk.
    /// Safe to call periodically (e.g. alongside the TS engine's own
    /// rack-save) and on shutdown.
    #[napi]
    pub fn flush(&self) -> napi::Result<()> {
        for entry in self.text_indexes.iter() {
            let (database, rack, field) = entry.key();
            let path = text_index_path(&self.root_path, database, rack, field);
            entry.value().save(&path).map_err(to_napi_err)?;
        }
        for entry in self.vector_indexes.iter() {
            let (database, rack, field) = entry.key();
            let path = vector_index_path(&self.root_path, database, rack, field);
            entry.value().save(&path).map_err(to_napi_err)?;
        }
        Ok(())
    }
}
