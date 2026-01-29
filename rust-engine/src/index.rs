use dashmap::DashMap;
use serde_json::Value;
use std::collections::HashSet;

/// Inverted Index structure
/// Maps: Field Name -> Value (String representation) -> Set of Document IDs
#[derive(Debug)]
pub struct Index {
    indices: DashMap<String, DashMap<String, HashSet<String>>>,
}

#[allow(dead_code)]
impl Index {
    pub fn new() -> Self {
        Self {
            indices: DashMap::new(),
        }
    }

    /// Index a document
    pub fn index_document(&self, doc_id: &str, data: &Value) {
        if let Value::Object(map) = data {
            for (key, value) in map {
                // We only index scalar values for now (String, Number, Bool)
                if value.is_string() || value.is_number() || value.is_boolean() {
                    let value_str = match value {
                        Value::String(s) => s.clone(),
                        _ => value.to_string(),
                    };

                    let field_index = self
                        .indices
                        .entry(key.clone())
                        .or_insert_with(DashMap::new);
                    
                    let mut doc_set = field_index
                        .entry(value_str)
                        .or_insert_with(HashSet::new);
                    
                    doc_set.insert(doc_id.to_string());
                }
            }
        }
    }

    /// Remove a document from index
    pub fn remove_document(&self, doc_id: &str, data: &Value) {
        if let Value::Object(map) = data {
            for (key, value) in map {
                if value.is_string() || value.is_number() || value.is_boolean() {
                    let value_str = match value {
                        Value::String(s) => s.clone(),
                        _ => value.to_string(),
                    };

                    if let Some(field_index) = self.indices.get(key) {
                        if let Some(mut doc_set) = field_index.get_mut(&value_str) {
                            doc_set.remove(doc_id);
                        }
                    }
                }
            }
        }
    }

    /// Search for documents with exact field value match
    pub fn search(&self, field: &str, value: &str) -> Option<HashSet<String>> {
        if let Some(field_index) = self.indices.get(field) {
            if let Some(doc_set) = field_index.get(value) {
                return Some(doc_set.clone());
            }
        }
        None
    }

    /// Clear index
    pub fn clear(&self) {
        self.indices.clear();
    }
}
