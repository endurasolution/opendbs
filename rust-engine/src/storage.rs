use crate::error::{OpenDBSError, Result};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[allow(dead_code)]
const MAGIC_NUMBER: &[u8; 5] = b"ODBDS";
#[allow(dead_code)]
const VERSION: u16 = 1;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Document {
    pub id: String,
    pub data: Value,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug)]
pub struct Database {
    #[allow(dead_code)]
    pub name: String,
    pub path: PathBuf,
    pub racks: DashMap<String, Rack>,
}

#[derive(Debug)]
pub struct Rack {
    #[allow(dead_code)]
    pub name: String,
    pub path: PathBuf,
    pub documents: DashMap<String, Document>,
    pub next_id: AtomicU64,
    pub index: crate::index::Index,
}

#[derive(Debug)]
pub struct StorageEngine {
    pub root_path: PathBuf,
    pub databases: DashMap<String, Database>,
}

impl StorageEngine {
    /// Create a new storage engine
    pub fn new(path: &str) -> Result<Self> {
        let root_path = PathBuf::from(path);
        fs::create_dir_all(&root_path)?;

        let engine = Self {
            root_path,
            databases: DashMap::new(),
        };

        // Load existing databases
        engine.load_databases()?;

        Ok(engine)
    }

    /// Load existing databases from disk
    fn load_databases(&self) -> Result<()> {
        if !self.root_path.exists() {
            return Ok(());
        }

        for entry in fs::read_dir(&self.root_path)? {
            let entry = entry?;
            let path = entry.path();

            if path.is_dir() {
                let db_name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .ok_or_else(|| OpenDBSError::Internal("Invalid database name".into()))?
                    .to_string();

                let database = Database::load(&path, &db_name)?;
                self.databases.insert(db_name, database);
            }
        }

        Ok(())
    }

    /// Create a new database
    pub fn create_database(&mut self, name: &str) -> Result<bool> {
        if self.databases.contains_key(name) {
            return Ok(false);
        }

        let db_path = self.root_path.join(name);
        fs::create_dir_all(&db_path)?;

        let database = Database {
            name: name.to_string(),
            path: db_path,
            racks: DashMap::new(),
        };

        self.databases.insert(name.to_string(), database);
        Ok(true)
    }

    /// Create a new rack in a database
    pub fn create_rack(&mut self, database: &str, rack: &str) -> Result<bool> {
        let db = self
            .databases
            .get(database)
            .ok_or_else(|| OpenDBSError::DatabaseNotFound(database.to_string()))?;

        if db.racks.contains_key(rack) {
            return Ok(false);
        }

        let rack_path = db.path.join(rack);
        fs::create_dir_all(&rack_path)?;

        let new_rack = Rack {
            name: rack.to_string(),
            path: rack_path,
            documents: DashMap::new(),
            next_id: AtomicU64::new(1),
            index: crate::index::Index::new(),
        };

        db.racks.insert(rack.to_string(), new_rack);
        Ok(true)
    }

    /// Insert a document into a rack
    pub fn insert(&mut self, database: &str, rack: &str, data: &str) -> Result<String> {
        let db = self
            .databases
            .get(database)
            .ok_or_else(|| OpenDBSError::DatabaseNotFound(database.to_string()))?;

        let rack_ref = db
            .racks
            .get(rack)
            .ok_or_else(|| OpenDBSError::RackNotFound(rack.to_string()))?;

        let json_data: Value = serde_json::from_str(data)?;
        let id = rack_ref.next_id.fetch_add(1, Ordering::SeqCst).to_string();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let document = Document {
            id: id.clone(),
            data: json_data,
            created_at: now,
            updated_at: now,
        };

        // Save to disk
        rack_ref.save_document(&document)?;

        // Update index
        rack_ref.index.index_document(&id, &document.data);

        // Store in memory
        rack_ref.documents.insert(id.clone(), document);

        Ok(id)
    }

    /// Find documents matching a query
    pub fn find(&self, database: &str, rack: &str, query: &str) -> Result<Vec<String>> {
        let db = self
            .databases
            .get(database)
            .ok_or_else(|| OpenDBSError::DatabaseNotFound(database.to_string()))?;

        let rack_ref = db
            .racks
            .get(rack)
            .ok_or_else(|| OpenDBSError::RackNotFound(rack.to_string()))?;

        let query_obj: Value = serde_json::from_str(query)?;
        let mut results = Vec::new();
        let query_engine = crate::query::QueryEngine::new();

        for entry in rack_ref.documents.iter() {
            if query_engine.matches(&entry.value().data, &query_obj) {
                results.push(serde_json::to_string(&entry.value())?);
            }
        }

        Ok(results)
    }

    /// Update a document
    pub fn update(&mut self, database: &str, rack: &str, id: &str, data: &str) -> Result<bool> {
        let db = self
            .databases
            .get(database)
            .ok_or_else(|| OpenDBSError::DatabaseNotFound(database.to_string()))?;

        let rack_ref = db
            .racks
            .get(rack)
            .ok_or_else(|| OpenDBSError::RackNotFound(rack.to_string()))?;

        let doc_to_save = if let Some(mut doc) = rack_ref.documents.get_mut(id) {
            let json_data: Value = serde_json::from_str(data)?;
            
            // Remove old index
            rack_ref.index.remove_document(id, &doc.data);

            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();

            doc.data = json_data.clone(); // Update data
            doc.updated_at = now;

            // Add new index
            rack_ref.index.index_document(id, &doc.data);

            Some(doc.clone())
        } else {
            None
        };

        if let Some(doc) = doc_to_save {
            rack_ref.save_document(&doc)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Delete a document
    pub fn delete(&mut self, database: &str, rack: &str, id: &str) -> Result<bool> {
        let db = self
            .databases
            .get(database)
            .ok_or_else(|| OpenDBSError::DatabaseNotFound(database.to_string()))?;

        let rack_ref = db
            .racks
            .get(rack)
            .ok_or_else(|| OpenDBSError::RackNotFound(rack.to_string()))?;

        if let Some((_, doc)) = rack_ref.documents.remove(id) {
            rack_ref.index.remove_document(id, &doc.data);
            rack_ref.delete_document(id)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Fuzzy search
    pub fn fuzzy_search(
        &self,
        database: &str,
        rack: &str,
        field: &str,
        query: &str,
        threshold: f64,
    ) -> Result<Vec<String>> {
        let db = self
            .databases
            .get(database)
            .ok_or_else(|| OpenDBSError::DatabaseNotFound(database.to_string()))?;

        let rack_ref = db
            .racks
            .get(rack)
            .ok_or_else(|| OpenDBSError::RackNotFound(rack.to_string()))?;

        let mut results = Vec::new();

        for entry in rack_ref.documents.iter() {
            if let Some(value) = entry.value().data.get(field) {
                if let Some(text) = value.as_str() {
                    let similarity = strsim::jaro_winkler(query, text);
                    if similarity >= threshold {
                        results.push(serde_json::to_string(&entry.value())?);
                    }
                }
            }
        }

        Ok(results)
    }

    /// Get storage statistics
    pub fn get_stats(&self) -> Result<String> {
        let mut stats = HashMap::new();
        stats.insert("databases", self.databases.len());

        let mut total_racks = 0;
        let mut total_docs = 0;

        for db in self.databases.iter() {
            total_racks += db.racks.len();
            for rack in db.racks.iter() {
                total_docs += rack.documents.len();
            }
        }

        stats.insert("racks", total_racks);
        stats.insert("documents", total_docs);

        Ok(serde_json::to_string(&stats)?)
    }
}

impl Database {
    fn load(path: &Path, name: &str) -> Result<Self> {
        let racks = DashMap::new();

        // Load racks
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let rack_path = entry.path();

            if rack_path.is_dir() {
                let rack_name = rack_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .ok_or_else(|| OpenDBSError::Internal("Invalid rack name".into()))?
                    .to_string();

                let rack = Rack::load(&rack_path, &rack_name)?;
                racks.insert(rack_name, rack);
            }
        }

        Ok(Self {
            name: name.to_string(),
            path: path.to_path_buf(),
            racks,
        })
    }
}

impl Rack {
    fn load(path: &Path, name: &str) -> Result<Self> {
        let documents = DashMap::new();
        let index = crate::index::Index::new();
        let mut max_id = 0u64;

        // Load documents
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let doc_path = entry.path();

            if doc_path.is_file() && doc_path.extension().and_then(|s| s.to_str()) == Some("dbs") {
                let file = File::open(&doc_path)?;
                let reader = BufReader::new(file);
                let document: Document = serde_json::from_reader(reader)?;

                if let Ok(id_num) = document.id.parse::<u64>() {
                    max_id = max_id.max(id_num);
                }

                index.index_document(&document.id, &document.data);
                documents.insert(document.id.clone(), document);
            }
        }


        Ok(Self {
            name: name.to_string(),
            path: path.to_path_buf(),
            documents,
            next_id: AtomicU64::new(max_id + 1),
            index,
        })
    }

    fn save_document(&self, doc: &Document) -> Result<()> {
        let doc_path = self.path.join(format!("{}.dbs", doc.id));
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(doc_path)?;

        let writer = BufWriter::new(file);
        serde_json::to_writer(writer, doc)?;

        Ok(())
    }

    fn delete_document(&self, id: &str) -> Result<()> {
        let doc_path = self.path.join(format!("{}.dbs", id));
        if doc_path.exists() {
            fs::remove_file(doc_path)?;
        }
        Ok(())
    }
}

