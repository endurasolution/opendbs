use crate::error::{OpenDBSError, Result};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

/// Hard caps to prevent a single request from allocating unbounded memory / CPU.
const MAX_INDEXED_TEXT_LEN: usize = 20_000;
const MAX_QUERY_LEN: usize = 500;
const MIN_TRIGRAM_OVERLAP_RATIO: f32 = 0.15;

fn normalize(text: &str) -> String {
    text.to_lowercase()
}

fn word_trigrams(word: &str, out: &mut HashSet<String>) {
    // Pad so short words (1-2 chars) still produce at least one gram, and so
    // word boundaries participate in matching (same trick as Postgres pg_trgm).
    let padded: Vec<char> = format!("  {}  ", word).chars().collect();
    if padded.len() < 3 {
        out.insert(padded.iter().collect());
        return;
    }
    for w in padded.windows(3) {
        out.insert(w.iter().collect());
    }
}

fn text_trigrams(text: &str) -> HashSet<String> {
    let normalized = normalize(text);
    let mut grams = HashSet::new();
    for word in normalized.split_whitespace() {
        word_trigrams(word, &mut grams);
    }
    if grams.is_empty() && !normalized.is_empty() {
        word_trigrams(&normalized, &mut grams);
    }
    grams
}

/// Full-text index for a single (rack, field). Trigram postings narrow the
/// candidate set for fast lookups; the original normalized text is kept so
/// candidates can be re-ranked with a real similarity score instead of
/// "first match wins".
pub struct FullTextIndex {
    /// trigram -> doc ids containing that trigram
    postings: DashMap<String, HashSet<String>>,
    /// doc_id -> trigrams that were indexed for it (needed to clean up
    /// postings precisely on removal instead of leaking empty entries)
    doc_trigrams: DashMap<String, HashSet<String>>,
    /// doc_id -> normalized text, used for similarity re-ranking
    doc_text: DashMap<String, String>,
}

#[derive(Serialize, Deserialize)]
struct FullTextSnapshot {
    postings: HashMap<String, HashSet<String>>,
    doc_trigrams: HashMap<String, HashSet<String>>,
    doc_text: HashMap<String, String>,
}

impl FullTextIndex {
    pub fn new() -> Self {
        Self {
            postings: DashMap::new(),
            doc_trigrams: DashMap::new(),
            doc_text: DashMap::new(),
        }
    }

    pub fn index_text(&self, doc_id: &str, text: &str) -> Result<()> {
        if text.len() > MAX_INDEXED_TEXT_LEN {
            return Err(OpenDBSError::InvalidInput(format!(
                "indexed text exceeds max length of {} chars",
                MAX_INDEXED_TEXT_LEN
            )));
        }

        // Re-indexing an existing doc: clear its old postings first so
        // stale trigrams don't linger.
        self.remove_text(doc_id);

        let normalized = normalize(text);
        let grams = text_trigrams(&normalized);

        for gram in &grams {
            self.postings
                .entry(gram.clone())
                .or_insert_with(HashSet::new)
                .insert(doc_id.to_string());
        }

        self.doc_trigrams.insert(doc_id.to_string(), grams);
        self.doc_text.insert(doc_id.to_string(), normalized);

        Ok(())
    }

    /// Removes a document from the index, cleaning up any postings entries
    /// that become empty as a result (the old Rust index never did this and
    /// leaked memory indefinitely).
    pub fn remove_text(&self, doc_id: &str) {
        let Some((_, grams)) = self.doc_trigrams.remove(doc_id) else {
            return;
        };
        self.doc_text.remove(doc_id);

        for gram in &grams {
            let mut now_empty = false;
            if let Some(mut doc_set) = self.postings.get_mut(gram) {
                doc_set.remove(doc_id);
                now_empty = doc_set.is_empty();
            }
            if now_empty {
                self.postings.remove(gram);
            }
        }
    }

    /// Ranked, typo-tolerant search: trigrams narrow the candidate set
    /// (avoids scanning every document), then candidates are scored by a
    /// blend of trigram overlap and edit-distance similarity so results
    /// come back best-match-first instead of in insertion order.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<(String, f32)>> {
        if query.len() > MAX_QUERY_LEN {
            return Err(OpenDBSError::InvalidInput(format!(
                "query exceeds max length of {} chars",
                MAX_QUERY_LEN
            )));
        }

        let normalized_query = normalize(query);
        let query_grams = text_trigrams(&normalized_query);
        if query_grams.is_empty() {
            return Ok(Vec::new());
        }

        let mut overlap_counts: HashMap<String, usize> = HashMap::new();
        for gram in &query_grams {
            if let Some(doc_set) = self.postings.get(gram) {
                for doc_id in doc_set.iter() {
                    *overlap_counts.entry(doc_id.clone()).or_insert(0) += 1;
                }
            }
        }

        let min_overlap =
            ((query_grams.len() as f32) * MIN_TRIGRAM_OVERLAP_RATIO).max(1.0) as usize;

        let mut scored: Vec<(String, f32)> = overlap_counts
            .into_iter()
            .filter(|(_, count)| *count >= min_overlap)
            .filter_map(|(doc_id, count)| {
                let doc_text = self.doc_text.get(&doc_id)?;
                let trigram_ratio = count as f32 / query_grams.len() as f32;
                let edit_similarity = strsim::jaro_winkler(&normalized_query, &doc_text) as f32;
                // Blend: edit-distance similarity dominates (typo tolerance),
                // trigram overlap acts as a tiebreaker / relevance boost.
                let score = edit_similarity * 0.7 + trigram_ratio * 0.3;
                Some((doc_id, score))
            })
            .collect();

        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit);
        Ok(scored)
    }

    fn snapshot(&self) -> FullTextSnapshot {
        FullTextSnapshot {
            postings: self
                .postings
                .iter()
                .map(|e| (e.key().clone(), e.value().clone()))
                .collect(),
            doc_trigrams: self
                .doc_trigrams
                .iter()
                .map(|e| (e.key().clone(), e.value().clone()))
                .collect(),
            doc_text: self
                .doc_text
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

    pub fn load(path: &Path) -> Result<Self> {
        let compressed = fs::read(path)?;
        let encoded = crate::compression::decompress(&compressed)?;
        let snapshot: FullTextSnapshot = bincode::deserialize(&encoded)
            .map_err(|e| OpenDBSError::PersistenceError(e.to_string()))?;

        let postings = DashMap::new();
        for (gram, docs) in snapshot.postings {
            postings.insert(gram, docs);
        }
        let doc_trigrams = DashMap::new();
        for (k, v) in snapshot.doc_trigrams {
            doc_trigrams.insert(k, v);
        }
        let doc_text = DashMap::new();
        for (k, v) in snapshot.doc_text {
            doc_text.insert(k, v);
        }

        Ok(Self {
            postings,
            doc_trigrams,
            doc_text,
        })
    }
}
