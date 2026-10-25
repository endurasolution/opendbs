use crate::error::{OpenDBSError, Result};
use dashmap::DashMap;
use hnsw_rs::prelude::*;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

pub const MAX_VECTOR_DIM: usize = 4096;
pub const MAX_K: usize = 1000;

const HNSW_MAX_NB_CONNECTION: usize = 24;
const HNSW_EF_CONSTRUCTION: usize = 200;
const HNSW_EF_SEARCH: usize = 256;
const HNSW_MAX_LAYER: usize = 16;

/// Cosine distance computed directly on int8-quantized components.
///
/// Cosine similarity is invariant to independently scaling either vector by
/// a positive constant, so per-vector scalar quantization (each vector
/// scaled by its own max-abs value into the i8 range) does not distort the
/// ranking -- it only adds bounded rounding error. This lets the HNSW graph
/// hold 1 byte per dimension instead of 4 (f32) without ever materializing
/// full-precision vectors during search.
#[derive(Clone, Copy, Default)]
pub struct DistCosineI8;

impl Distance<i8> for DistCosineI8 {
    fn eval(&self, va: &[i8], vb: &[i8]) -> f32 {
        let mut dot: i64 = 0;
        let mut norm_a: i64 = 0;
        let mut norm_b: i64 = 0;
        for (a, b) in va.iter().zip(vb.iter()) {
            let (a, b) = (*a as i64, *b as i64);
            dot += a * b;
            norm_a += a * a;
            norm_b += b * b;
        }
        if norm_a == 0 || norm_b == 0 {
            return 1.0;
        }
        let cosine = dot as f32 / ((norm_a as f32).sqrt() * (norm_b as f32).sqrt());
        // Clamp defensively instead of asserting: quantization rounding can
        // occasionally push the computed cosine a hair outside [-1, 1].
        (1.0 - cosine).clamp(0.0, 2.0)
    }
}

/// Quantize an f32 vector to i8 using a per-vector symmetric scale
/// (scale = max(|x|) / 127). ~4x smaller than f32, ~99% recall in practice
/// for typical embedding distributions.
pub fn quantize(vector: &[f32]) -> Vec<i8> {
    let max_abs = vector.iter().fold(0f32, |m, x| m.max(x.abs()));
    if max_abs == 0.0 {
        return vec![0i8; vector.len()];
    }
    let scale = max_abs / 127.0;
    vector
        .iter()
        .map(|x| (x / scale).round().clamp(-127.0, 127.0) as i8)
        .collect()
}

#[derive(Serialize, Deserialize)]
struct VectorSnapshot {
    dims: usize,
    vectors: HashMap<String, Vec<i8>>,
}

/// Approximate-nearest-neighbor vector index for one (rack, field).
///
/// `quantized_vectors` is the compact, authoritative store (what gets
/// persisted); the HNSW graph is a fast-search structure rebuilt from it.
/// HNSW graphs don't support true point deletion, so `remove_vector`
/// tombstones the graph entry while immediately dropping it from
/// `quantized_vectors` -- reloading (or calling `rebuild`) reconstructs the
/// graph from only the live vectors, which doubles as compaction.
pub struct VectorIndex {
    dims: usize,
    hnsw: RwLock<Hnsw<'static, i8, DistCosineI8>>,
    quantized_vectors: DashMap<String, Vec<i8>>,
    doc_to_internal: DashMap<String, usize>,
    internal_to_doc: DashMap<usize, String>,
    tombstones: DashMap<usize, ()>,
    next_internal_id: AtomicUsize,
}

impl VectorIndex {
    pub fn new(dims: usize, max_elements_hint: usize) -> Result<Self> {
        if dims == 0 || dims > MAX_VECTOR_DIM {
            return Err(OpenDBSError::InvalidInput(format!(
                "vector dimension must be between 1 and {}",
                MAX_VECTOR_DIM
            )));
        }
        let hnsw = Hnsw::<i8, DistCosineI8>::new(
            HNSW_MAX_NB_CONNECTION,
            max_elements_hint.max(1000),
            HNSW_MAX_LAYER,
            HNSW_EF_CONSTRUCTION,
            DistCosineI8,
        );
        Ok(Self {
            dims,
            hnsw: RwLock::new(hnsw),
            quantized_vectors: DashMap::new(),
            doc_to_internal: DashMap::new(),
            internal_to_doc: DashMap::new(),
            tombstones: DashMap::new(),
            next_internal_id: AtomicUsize::new(0),
        })
    }

    fn check_dims(&self, actual: usize) -> Result<()> {
        if actual != self.dims {
            return Err(OpenDBSError::DimensionMismatch {
                expected: self.dims,
                actual,
            });
        }
        Ok(())
    }

    pub fn add_vector(&self, doc_id: &str, vector: &[f32]) -> Result<()> {
        self.check_dims(vector.len())?;

        // Re-adding an existing doc: tombstone its old graph entry first.
        if let Some((_, old_internal)) = self.doc_to_internal.remove(doc_id) {
            self.internal_to_doc.remove(&old_internal);
            self.tombstones.insert(old_internal, ());
        }

        let quantized = quantize(vector);
        let internal_id = self.next_internal_id.fetch_add(1, Ordering::SeqCst);

        self.hnsw.read().insert((&quantized, internal_id));
        self.quantized_vectors
            .insert(doc_id.to_string(), quantized);
        self.doc_to_internal.insert(doc_id.to_string(), internal_id);
        self.internal_to_doc.insert(internal_id, doc_id.to_string());

        Ok(())
    }

    /// Bulk insert using the crate's parallel insertion path. Roughly two
    /// orders of magnitude faster than calling `add_vector` once per item
    /// for large batches (backfilling an index on an existing rack, initial
    /// data load, etc.) since it amortizes locking and uses rayon across
    /// the batch instead of one NAPI call + one graph write per vector.
    pub fn add_vectors_batch(&self, items: &[(String, Vec<f32>)]) -> Result<()> {
        for (_, v) in items {
            self.check_dims(v.len())?;
        }

        // Tombstone any pre-existing entries for these doc ids first.
        for (doc_id, _) in items {
            if let Some((_, old_internal)) = self.doc_to_internal.remove(doc_id) {
                self.internal_to_doc.remove(&old_internal);
                self.tombstones.insert(old_internal, ());
            }
        }

        let quantized: Vec<(String, Vec<i8>)> = items
            .iter()
            .map(|(doc_id, v)| (doc_id.clone(), quantize(v)))
            .collect();

        let start_id = self
            .next_internal_id
            .fetch_add(quantized.len(), Ordering::SeqCst);

        let insert_batch: Vec<(&Vec<i8>, usize)> = quantized
            .iter()
            .enumerate()
            .map(|(i, (_, q))| (q, start_id + i))
            .collect();
        self.hnsw.read().parallel_insert(&insert_batch);

        for (i, (doc_id, q)) in quantized.into_iter().enumerate() {
            let internal_id = start_id + i;
            self.quantized_vectors.insert(doc_id.clone(), q);
            self.doc_to_internal.insert(doc_id.clone(), internal_id);
            self.internal_to_doc.insert(internal_id, doc_id);
        }

        Ok(())
    }

    pub fn remove_vector(&self, doc_id: &str) {
        self.quantized_vectors.remove(doc_id);
        if let Some((_, internal_id)) = self.doc_to_internal.remove(doc_id) {
            self.internal_to_doc.remove(&internal_id);
            self.tombstones.insert(internal_id, ());
        }
    }

    /// Returns (doc_id, similarity) pairs, best match first. Similarity is
    /// in [0, 1] (1 = identical direction), matching the convention already
    /// used by the existing brute-force cosine search in engine.ts.
    pub fn search(&self, query: &[f32], k: usize) -> Result<Vec<(String, f32)>> {
        self.check_dims(query.len())?;
        if k == 0 {
            return Ok(Vec::new());
        }
        let k = k.min(MAX_K);
        let quantized_query = quantize(query);

        // Ask for extra candidates since some may be tombstoned.
        let fetch = (k + self.tombstones.len().min(k * 4) + 8).min(MAX_K * 2);
        let neighbours = self
            .hnsw
            .read()
            .search(&quantized_query, fetch, HNSW_EF_SEARCH);

        let mut results = Vec::with_capacity(k);
        for n in neighbours {
            if self.tombstones.contains_key(&n.get_origin_id()) {
                continue;
            }
            let Some(doc_id) = self.internal_to_doc.get(&n.get_origin_id()) else {
                continue;
            };
            let similarity = (1.0 - n.get_distance() / 2.0).clamp(0.0, 1.0);
            results.push((doc_id.clone(), similarity));
            if results.len() >= k {
                break;
            }
        }
        Ok(results)
    }

    pub fn logical_count(&self) -> usize {
        self.doc_to_internal.len()
    }

    pub fn physical_count(&self) -> usize {
        self.next_internal_id.load(Ordering::SeqCst)
    }

    /// True once tombstoned (deleted-but-still-in-graph) points make up a
    /// significant share of the graph -- a signal that `rebuild()` is worth
    /// calling to reclaim memory and keep search latency predictable.
    pub fn needs_rebuild(&self) -> bool {
        let physical = self.physical_count();
        let logical = self.logical_count();
        physical > 1000 && physical > logical * 3 / 2
    }

    /// Reconstructs the HNSW graph from only the currently-live quantized
    /// vectors, discarding tombstoned entries. This is the only way to
    /// actually reclaim memory from deleted vectors, since HNSW has no
    /// in-place delete.
    pub fn rebuild(&self) {
        let live: Vec<(String, Vec<i8>)> = self
            .quantized_vectors
            .iter()
            .map(|e| (e.key().clone(), e.value().clone()))
            .collect();

        let fresh = Hnsw::<i8, DistCosineI8>::new(
            HNSW_MAX_NB_CONNECTION,
            live.len().max(1000),
            HNSW_MAX_LAYER,
            HNSW_EF_CONSTRUCTION,
            DistCosineI8,
        );

        self.doc_to_internal.clear();
        self.internal_to_doc.clear();
        self.tombstones.clear();
        self.next_internal_id.store(0, Ordering::SeqCst);

        let insert_batch: Vec<(&Vec<i8>, usize)> = live
            .iter()
            .enumerate()
            .map(|(i, (_, v))| (v, i))
            .collect();
        fresh.parallel_insert(&insert_batch);

        for (i, (doc_id, _)) in live.iter().enumerate() {
            self.doc_to_internal.insert(doc_id.clone(), i);
            self.internal_to_doc.insert(i, doc_id.clone());
        }
        self.next_internal_id.store(live.len(), Ordering::SeqCst);

        *self.hnsw.write() = fresh;
    }

    fn snapshot(&self) -> VectorSnapshot {
        VectorSnapshot {
            dims: self.dims,
            vectors: self
                .quantized_vectors
                .iter()
                .map(|e| (e.key().clone(), e.value().clone()))
                .collect(),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let snapshot = self.snapshot();
        let encoded = bincode::serialize(&snapshot)
            .map_err(|e| OpenDBSError::PersistenceError(e.to_string()))?;
        let compressed = crate::compression::compress(&encoded)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, compressed)?;
        Ok(())
    }

    /// Loads persisted quantized vectors and rebuilds the HNSW graph from
    /// them -- this also means every load starts fully compacted (no
    /// tombstones carried over from a previous session).
    pub fn load(path: &Path) -> Result<Self> {
        let compressed = fs::read(path)?;
        let encoded = crate::compression::decompress(&compressed)?;
        let snapshot: VectorSnapshot = bincode::deserialize(&encoded)
            .map_err(|e| OpenDBSError::PersistenceError(e.to_string()))?;

        let index = Self::new(snapshot.dims, snapshot.vectors.len())?;
        // Collect into a single ordered Vec first so the internal ids used
        // for insertion and the ones recorded in the doc<->internal maps
        // are guaranteed to match (HashMap iteration order isn't something
        // to rely on across two separate iterations).
        let live: Vec<(String, Vec<i8>)> = snapshot.vectors.into_iter().collect();

        let insert_batch: Vec<(&Vec<i8>, usize)> = live
            .iter()
            .enumerate()
            .map(|(i, (_, v))| (v, i))
            .collect();
        index.hnsw.read().parallel_insert(&insert_batch);

        for (i, (doc_id, quantized)) in live.into_iter().enumerate() {
            index.doc_to_internal.insert(doc_id.clone(), i);
            index.internal_to_doc.insert(i, doc_id.clone());
            index.quantized_vectors.insert(doc_id, quantized);
        }
        index
            .next_internal_id
            .store(index.quantized_vectors.len(), Ordering::SeqCst);

        Ok(index)
    }
}
