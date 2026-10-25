//! Disk storage engine for OpenDBS.
//!
//! Built on `redb` (an ACID, crash-safe, copy-on-write B-tree with a bounded
//! page cache), so data lives on disk and memory use is bounded by the cache
//! size rather than by the data size.
//!
//! Encryption at rest is done *below* redb by `EncryptedFile`: every 4 KiB
//! block of the database file is encrypted with AES-256-XTS (the standard
//! mode for disk/volume encryption), so documents, index keys and metadata
//! are all unreadable without the key.
//!
//! The JavaScript side batches all writes made in one event-loop tick into a
//! single `commit()`, which runs on the libuv thread pool (group commit).
//! Commits are applied strictly in the order they were submitted, whether
//! async or sync, so a later batch can never be overwritten by an earlier one.
//!
//! Data crosses the N-API boundary as packed buffers (one allocation per call
//! instead of one object per entry):
//!   ops:     [u8 kind][u32 table#][u32 klen][key][u32 vlen][value] ...   kind: 0 put, 1 delete, 2 drop table
//!   entries: [u32 klen][key][u32 vlen][value] ...
//!   values:  [u32 len][value] ...          (get_many: len 0xFFFFFFFF = missing)

use aes::cipher::KeyInit;
use aes::Aes256;
use napi::bindgen_prelude::*;
use napi::{Env, Task};
use napi_derive::napi;
use redb::{
    Builder, Database, Durability, ReadTransaction, ReadableTable, ReadableTableMetadata, StorageBackend, TableDefinition, TableHandle,
};
use sha2::{Digest, Sha256, Sha512};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io;
use std::ops::Bound;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use xts_mode::{get_tweak_default, Xts128};

const BLOCK: u64 = 4096;
const HEADER: u64 = BLOCK; // physical block 0 holds our header; logical block i lives at physical block i+1
const MAGIC: &[u8; 8] = b"ODBSXTS1";

// ───────────────────────── positional file I/O ─────────────────────────

#[cfg(windows)]
fn read_at(f: &File, buf: &mut [u8], mut off: u64) -> io::Result<()> {
    use std::os::windows::fs::FileExt;
    let mut done = 0;
    while done < buf.len() {
        let n = f.seek_read(&mut buf[done..], off)?;
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "short read"));
        }
        done += n;
        off += n as u64;
    }
    Ok(())
}

#[cfg(windows)]
fn write_at(f: &File, buf: &[u8], mut off: u64) -> io::Result<()> {
    use std::os::windows::fs::FileExt;
    let mut done = 0;
    while done < buf.len() {
        let n = f.seek_write(&buf[done..], off)?;
        done += n;
        off += n as u64;
    }
    Ok(())
}

#[cfg(unix)]
fn read_at(f: &File, buf: &mut [u8], off: u64) -> io::Result<()> {
    use std::os::unix::fs::FileExt;
    f.read_exact_at(buf, off)
}

#[cfg(unix)]
fn write_at(f: &File, buf: &[u8], off: u64) -> io::Result<()> {
    use std::os::unix::fs::FileExt;
    f.write_all_at(buf, off)
}

// ───────────────────────── encrypted backend ─────────────────────────

pub struct EncryptedFile {
    file: File,
    /// Reads share the lock; writes (which may read-modify-write a block) take it exclusively.
    lock: RwLock<()>,
    xts: Xts128<Aes256>,
    logical_len: AtomicU64,
    /// Size of the file on disk, tracked here to avoid a metadata syscall per read.
    physical_len: AtomicU64,
    check: [u8; 32],
}

impl std::fmt::Debug for EncryptedFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EncryptedFile").field("len", &self.logical_len.load(Ordering::SeqCst)).finish()
    }
}

fn io_err(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::Other, msg.to_string())
}

impl EncryptedFile {
    /// `master` is the 32-byte data key; the 64-byte XTS key is derived from it.
    pub fn open(path: &Path, master: &[u8]) -> io::Result<Self> {
        let mut h = Sha512::new();
        h.update(b"opendbs-storage-xts-v1");
        h.update(master);
        let k = h.finalize();
        let xts = Xts128::new(Aes256::new_from_slice(&k[..32]).unwrap(), Aes256::new_from_slice(&k[32..]).unwrap());
        // Key check value: lets us refuse a wrong key instead of reading garbage.
        let mut c = Sha256::new();
        c.update(b"opendbs-key-check");
        c.update(&k);
        let check: [u8; 32] = c.finalize().into();

        let mut opts = OpenOptions::new();
        opts.read(true).write(true).create(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            opts.share_mode(0x1); // FILE_SHARE_READ only: a second writer process can't open it
        }
        let file = opts.open(path)?;
        let physical = file.metadata()?.len();
        let mut me = Self { file, lock: RwLock::new(()), xts, logical_len: AtomicU64::new(0), physical_len: AtomicU64::new(physical), check };
        if physical == 0 {
            me.write_header(0)?;
            return Ok(me);
        }
        let mut hdr = [0u8; 48];
        read_at(&me.file, &mut hdr, 0)?;
        if &hdr[0..8] != MAGIC {
            return Err(io_err("not an OpenDBS encrypted storage file"));
        }
        if hdr[16..48] != me.check {
            return Err(io_err("wrong encryption key for storage file"));
        }
        me.logical_len = AtomicU64::new(u64::from_le_bytes(hdr[8..16].try_into().unwrap()));
        Ok(me)
    }

    fn write_header(&self, logical: u64) -> io::Result<()> {
        let mut hdr = vec![0u8; BLOCK as usize];
        hdr[0..8].copy_from_slice(MAGIC);
        hdr[8..16].copy_from_slice(&logical.to_le_bytes());
        hdr[16..48].copy_from_slice(&self.check);
        write_at(&self.file, &hdr, 0)?;
        self.physical_len.fetch_max(BLOCK, Ordering::SeqCst);
        Ok(())
    }

    /// Reads and decrypts logical blocks [first, first+count). Never-written
    /// (all-zero) blocks read as zeros, as redb expects for extended space.
    fn read_blocks(&self, first: u64, count: u64) -> io::Result<Vec<u8>> {
        let mut buf = vec![0u8; (count * BLOCK) as usize];
        let physical_len = self.physical_len.load(Ordering::SeqCst);
        let start = HEADER + first * BLOCK;
        let avail = physical_len.saturating_sub(start).min(count * BLOCK);
        if avail > 0 {
            read_at(&self.file, &mut buf[..avail as usize], start)?;
        }
        for i in 0..count {
            let s = (i * BLOCK) as usize;
            let block = &mut buf[s..s + BLOCK as usize];
            if block.iter().any(|&b| b != 0) {
                self.xts.decrypt_sector(block, get_tweak_default((first + i) as u128));
            }
        }
        Ok(buf)
    }
}

impl StorageBackend for EncryptedFile {
    fn len(&self) -> io::Result<u64> {
        Ok(self.logical_len.load(Ordering::SeqCst))
    }

    fn read(&self, offset: u64, len: usize) -> io::Result<Vec<u8>> {
        if offset + len as u64 > self.logical_len.load(Ordering::SeqCst) {
            return Err(io_err("read beyond end of storage"));
        }
        if len == 0 {
            return Ok(Vec::new());
        }
        let first = offset / BLOCK;
        let last = (offset + len as u64 - 1) / BLOCK;
        let _g = self.lock.read().unwrap();
        let mut buf = self.read_blocks(first, last - first + 1)?;
        let s = (offset - first * BLOCK) as usize;
        if s == 0 && buf.len() == len {
            return Ok(buf);
        }
        buf.truncate(s + len);
        Ok(buf.split_off(s))
    }

    fn set_len(&self, len: u64) -> io::Result<()> {
        let _g = self.lock.write().unwrap();
        let old = self.logical_len.load(Ordering::SeqCst);
        if len < old && len % BLOCK != 0 {
            // Zero the tail of the new last block so a later extension reads zeros.
            let b = len / BLOCK;
            let mut block = self.read_blocks(b, 1)?;
            for x in &mut block[(len % BLOCK) as usize..] {
                *x = 0;
            }
            self.xts.encrypt_sector(&mut block, get_tweak_default(b as u128));
            write_at(&self.file, &block, HEADER + b * BLOCK)?;
        }
        let blocks = (len + BLOCK - 1) / BLOCK;
        self.file.set_len(HEADER + blocks * BLOCK)?;
        self.physical_len.store(HEADER + blocks * BLOCK, Ordering::SeqCst);
        self.logical_len.store(len, Ordering::SeqCst);
        self.write_header(len)
    }

    fn sync_data(&self, _eventual: bool) -> io::Result<()> {
        self.file.sync_data()
    }

    fn write(&self, offset: u64, data: &[u8]) -> io::Result<()> {
        if data.is_empty() {
            return Ok(());
        }
        let end = offset + data.len() as u64;
        let first = offset / BLOCK;
        let last = (end - 1) / BLOCK;
        let _g = self.lock.write().unwrap();
        let mut buf = if offset % BLOCK == 0 && end % BLOCK == 0 {
            data.to_vec()
        } else {
            // Partial blocks: read-modify-write.
            let mut b = self.read_blocks(first, last - first + 1)?;
            let s = (offset - first * BLOCK) as usize;
            b[s..s + data.len()].copy_from_slice(data);
            b
        };
        for i in 0..(last - first + 1) {
            let s = (i * BLOCK) as usize;
            self.xts.encrypt_sector(&mut buf[s..s + BLOCK as usize], get_tweak_default((first + i) as u128));
        }
        write_at(&self.file, &buf, HEADER + first * BLOCK)?;
        self.physical_len.fetch_max(HEADER + (last + 1) * BLOCK, Ordering::SeqCst);
        if end > self.logical_len.load(Ordering::SeqCst) {
            self.logical_len.store(end, Ordering::SeqCst);
            self.write_header(end)?;
        }
        Ok(())
    }
}

// ───────────────────────── packed buffers ─────────────────────────

fn napi_err<E: std::fmt::Display>(e: E) -> napi::Error {
    napi::Error::from_reason(e.to_string())
}

fn push_u32(out: &mut Vec<u8>, n: u32) {
    out.extend_from_slice(&n.to_le_bytes());
}

fn push_bytes(out: &mut Vec<u8>, b: &[u8]) {
    push_u32(out, b.len() as u32);
    out.extend_from_slice(b);
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn u8(&mut self) -> std::result::Result<u8, String> {
        let b = *self.buf.get(self.pos).ok_or("truncated op buffer")?;
        self.pos += 1;
        Ok(b)
    }

    fn u32(&mut self) -> std::result::Result<u32, String> {
        let s = self.buf.get(self.pos..self.pos + 4).ok_or("truncated op buffer")?;
        self.pos += 4;
        Ok(u32::from_le_bytes(s.try_into().unwrap()))
    }

    fn bytes(&mut self) -> std::result::Result<(usize, usize), String> {
        let n = self.u32()? as usize;
        let start = self.pos;
        if start + n > self.buf.len() {
            return Err("truncated op buffer".into());
        }
        self.pos += n;
        Ok((start, start + n))
    }
}

/// One parsed op: kind, table index, key range and value range in the batch buffer.
struct Op {
    kind: u8,
    table: usize,
    key: (usize, usize),
    value: (usize, usize),
}

struct Batch {
    tables: Vec<String>,
    data: Vec<u8>,
    ops: Vec<Op>,
}

fn parse_batch(tables: Vec<String>, data: Vec<u8>) -> std::result::Result<Batch, String> {
    let mut ops = Vec::new();
    {
        let mut r = Reader { buf: &data, pos: 0 };
        while r.pos < data.len() {
            let kind = r.u8()?;
            if kind > 3 {
                return Err(format!("unknown op kind {}", kind));
            }
            let table = r.u32()? as usize;
            if table >= tables.len() {
                return Err("op refers to an unknown table".into());
            }
            let key = r.bytes()?;
            let value = r.bytes()?;
            ops.push(Op { kind, table, key, value });
        }
    }
    Ok(Batch { tables, data, ops })
}

/// Applies a batch atomically: all ops commit together or not at all.
fn apply(db: &Database, b: &Batch, durable: bool) -> std::result::Result<(), String> {
    let mut txn = db.begin_write().map_err(|e| e.to_string())?;
    txn.set_durability(if durable { Durability::Immediate } else { Durability::None });
    {
        let mut open: HashMap<usize, redb::Table<&[u8], &[u8]>> = HashMap::new();
        for op in &b.ops {
            let name = &b.tables[op.table];
            if op.kind == 2 {
                // A table must be closed before it can be deleted.
                open.remove(&op.table);
                txn.delete_table(TableDefinition::<&[u8], &[u8]>::new(name)).map_err(|e| e.to_string())?;
                continue;
            }
            if !open.contains_key(&op.table) {
                let t = txn.open_table(TableDefinition::<&[u8], &[u8]>::new(name)).map_err(|e| e.to_string())?;
                open.insert(op.table, t);
            }
            let t = open.get_mut(&op.table).unwrap();
            let key = &b.data[op.key.0..op.key.1];
            if op.kind == 0 {
                t.insert(key, &b.data[op.value.0..op.value.1]).map_err(|e| e.to_string())?;
            } else if op.kind == 1 {
                t.remove(key).map_err(|e| e.to_string())?;
            } else {
                // Range delete: key ≤ k < value (empty value = to the end).
                let hi = &b.data[op.value.0..op.value.1];
                let upper: Bound<&[u8]> = if hi.is_empty() { Bound::Unbounded } else { Bound::Excluded(hi) };
                let doomed: Vec<Vec<u8>> = t
                    .range::<&[u8]>((Bound::Included(key), upper))
                    .map_err(|e| e.to_string())?
                    .map(|item| item.map(|(k, _)| k.value().to_vec()))
                    .collect::<std::result::Result<_, _>>()
                    .map_err(|e| e.to_string())?;
                for k in doomed {
                    t.remove(k.as_slice()).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    txn.commit().map_err(|e| e.to_string())
}

/// Hands out commit tickets in submission order and makes each commit wait
/// for all earlier ones, so async (thread pool) and sync commits interleave safely.
struct Sequencer {
    next: AtomicU64,
    done: Mutex<u64>,
    cv: Condvar,
}

impl Sequencer {
    fn ticket(&self) -> u64 {
        self.next.fetch_add(1, Ordering::SeqCst)
    }

    fn run<T>(&self, ticket: u64, f: impl FnOnce() -> T) -> T {
        let mut done = self.done.lock().unwrap();
        while *done != ticket {
            done = self.cv.wait(done).unwrap();
        }
        let out = f();
        *done += 1;
        self.cv.notify_all();
        out
    }
}

struct Shared {
    db: RwLock<Option<Arc<Database>>>,
    seq: Sequencer,
    /// A read snapshot reused by lookups until the next commit (opening one per call is the main read cost).
    reader: Mutex<Option<Arc<ReadTransaction>>>,
}

impl Shared {
    fn db(&self) -> napi::Result<Arc<Database>> {
        self.db.read().unwrap().clone().ok_or_else(|| napi::Error::from_reason("storage is closed"))
    }

    fn commit(&self, ticket: u64, db: &Database, batch: &Batch, durable: bool) -> std::result::Result<(), String> {
        self.seq.run(ticket, || {
            let r = apply(db, batch, durable);
            // Newer data is visible to new readers only; drop the old snapshot so freed pages can be reused.
            self.reader.lock().unwrap().take();
            r
        })
    }

    fn read_txn(&self) -> napi::Result<Arc<ReadTransaction>> {
        let mut slot = self.reader.lock().unwrap();
        if let Some(t) = slot.as_ref() {
            return Ok(t.clone());
        }
        let t = Arc::new(self.db()?.begin_read().map_err(napi_err)?);
        *slot = Some(t.clone());
        Ok(t)
    }
}

pub struct CommitTask {
    shared: Arc<Shared>,
    db: Arc<Database>,
    ticket: u64,
    batch: Batch,
    durable: bool,
}

impl Task for CommitTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<()> {
        self.shared.commit(self.ticket, &self.db, &self.batch, self.durable).map_err(napi::Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, _output: ()) -> napi::Result<()> {
        Ok(())
    }
}

fn bound(b: &Option<Buffer>, inclusive: bool) -> Bound<&[u8]> {
    match b {
        Some(x) if inclusive => Bound::Included(x.as_ref()),
        Some(x) => Bound::Excluded(x.as_ref()),
        None => Bound::Unbounded,
    }
}

/// redb panics on an inverted range; treat it as empty instead.
fn empty_range(lo: &Option<Buffer>, lo_inclusive: bool, hi: &Option<Buffer>, hi_inclusive: bool) -> bool {
    match (lo, hi) {
        (Some(l), Some(h)) => l.as_ref() > h.as_ref() || (l.as_ref() == h.as_ref() && !(lo_inclusive && hi_inclusive)),
        _ => false,
    }
}

/// Open stores by handle, so worker threads can attach to the same database (read-only).
fn registry() -> &'static Mutex<HashMap<u32, std::sync::Weak<Shared>>> {
    static REG: std::sync::OnceLock<Mutex<HashMap<u32, std::sync::Weak<Shared>>>> = std::sync::OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);

#[napi]
pub struct Store {
    shared: Arc<Shared>,
    path: String,
    /// Attached from another thread: reads only; commits and close are refused.
    attached: bool,
    handle: u32,
}

macro_rules! open_or {
    ($txn:expr, $table:expr, $empty:expr) => {
        match $txn.open_table(TableDefinition::<&[u8], &[u8]>::new($table)) {
            Ok(t) => t,
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok($empty),
            Err(e) => return Err(napi_err(e)),
        }
    };
}

#[napi]
impl Store {
    /// Opens (or creates) a storage file. `key_hex` (64 hex chars) enables
    /// AES-256-XTS encryption of the whole file.
    #[napi(constructor)]
    pub fn new(path: String, key_hex: Option<String>, cache_mb: u32) -> napi::Result<Self> {
        let mut builder = Builder::new();
        builder.set_cache_size((cache_mb.max(16) as usize) * 1024 * 1024);
        let db = match key_hex {
            Some(hex) => {
                if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(napi::Error::from_reason("encryption key must be 64 hex characters"));
                }
                let key: Vec<u8> = (0..32).map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap()).collect();
                let backend = EncryptedFile::open(Path::new(&path), &key).map_err(napi_err)?;
                builder.create_with_backend(backend).map_err(napi_err)?
            }
            None => builder.create(&path).map_err(napi_err)?,
        };
        let shared = Arc::new(Shared {
            db: RwLock::new(Some(Arc::new(db))),
            seq: Sequencer { next: AtomicU64::new(0), done: Mutex::new(0), cv: Condvar::new() },
            reader: Mutex::new(None),
        });
        let handle = NEXT_HANDLE.fetch_add(1, Ordering::SeqCst) as u32;
        let mut reg = registry().lock().unwrap();
        reg.retain(|_, w| w.strong_count() > 0);
        reg.insert(handle, Arc::downgrade(&shared));
        Ok(Self { shared, path, attached: false, handle })
    }

    /// Handle for `Store.attach()` from a worker thread.
    #[napi(getter)]
    pub fn handle(&self) -> u32 {
        self.handle
    }

    /// Read-only view of a store opened elsewhere in this process (worker threads).
    #[napi(factory)]
    pub fn attach(handle: u32) -> napi::Result<Self> {
        let shared = registry()
            .lock()
            .unwrap()
            .get(&handle)
            .and_then(|w| w.upgrade())
            .ok_or_else(|| napi::Error::from_reason("no open store with that handle"))?;
        Ok(Self { shared, path: String::new(), attached: true, handle })
    }

    fn writable(&self) -> napi::Result<()> {
        if self.attached {
            return Err(napi::Error::from_reason("attached stores are read-only"));
        }
        Ok(())
    }

    /// Group commit on the libuv thread pool. Resolves once the batch is
    /// committed (and fsynced when `durable`).
    #[napi(ts_return_type = "Promise<void>")]
    pub fn commit(&self, tables: Vec<String>, ops: Buffer, durable: bool) -> napi::Result<AsyncTask<CommitTask>> {
        self.writable()?;
        let batch = parse_batch(tables, ops.to_vec()).map_err(napi::Error::from_reason)?;
        let db = self.shared.db()?;
        let ticket = self.shared.seq.ticket();
        Ok(AsyncTask::new(CommitTask { shared: self.shared.clone(), db, ticket, batch, durable }))
    }

    /// Synchronous commit (startup, migration, index builds, shutdown). Waits
    /// for any earlier async commit first.
    #[napi]
    pub fn commit_sync(&self, tables: Vec<String>, ops: Buffer, durable: bool) -> napi::Result<()> {
        self.writable()?;
        let batch = parse_batch(tables, ops.to_vec()).map_err(napi::Error::from_reason)?;
        let db = self.shared.db()?;
        let ticket = self.shared.seq.ticket();
        self.shared.commit(ticket, &db, &batch, durable).map_err(napi::Error::from_reason)
    }

    /// Waits for every submitted commit, then releases the file. Further calls fail.
    #[napi]
    pub fn close(&self) -> napi::Result<()> {
        if self.attached {
            return Ok(()); // the owner closes the file
        }
        registry().lock().unwrap().remove(&self.handle);
        let ticket = self.shared.seq.ticket();
        self.shared.seq.run(ticket, || {
            self.shared.reader.lock().unwrap().take();
            self.shared.db.write().unwrap().take();
        });
        Ok(())
    }

    #[napi]
    pub fn get(&self, table: String, key: Buffer) -> napi::Result<Option<Buffer>> {
        let txn = self.shared.read_txn()?;
        let t = open_or!(txn, &table, None);
        Ok(t.get(key.as_ref()).map_err(napi_err)?.map(|v| Buffer::from(v.value().to_vec())))
    }

    /// Point lookups for many keys (packed [u32 len][key]...) in one call; packed values out.
    #[napi]
    pub fn get_many(&self, table: String, keys: Buffer) -> napi::Result<Buffer> {
        let txn = self.shared.read_txn()?;
        let mut out = Vec::new();
        let mut r = Reader { buf: keys.as_ref(), pos: 0 };
        let t = match txn.open_table(TableDefinition::<&[u8], &[u8]>::new(&table)) {
            Ok(t) => Some(t),
            Err(redb::TableError::TableDoesNotExist(_)) => None,
            Err(e) => return Err(napi_err(e)),
        };
        while r.pos < r.buf.len() {
            let (s, e) = r.bytes().map_err(napi::Error::from_reason)?;
            let found = match &t {
                Some(t) => t.get(&keys[s..e]).map_err(napi_err)?,
                None => None,
            };
            match found {
                Some(v) => push_bytes(&mut out, v.value()),
                None => push_u32(&mut out, u32::MAX),
            }
        }
        Ok(Buffer::from(out))
    }

    /// Up to `limit` entries with key > `after` (or from the start), in key order, packed.
    #[napi]
    pub fn scan(&self, table: String, after: Option<Buffer>, limit: u32) -> napi::Result<Buffer> {
        let txn = self.shared.read_txn()?;
        let t = open_or!(txn, &table, Buffer::from(Vec::new()));
        let mut out = Vec::new();
        let mut n = 0u32;
        for item in t.range::<&[u8]>((bound(&after, false), Bound::Unbounded)).map_err(napi_err)? {
            let (k, v) = item.map_err(napi_err)?;
            push_bytes(&mut out, k.value());
            push_bytes(&mut out, v.value());
            n += 1;
            if n >= limit {
                break;
            }
        }
        Ok(Buffer::from(out))
    }

    /// Up to `limit` entries with lo ≤/< key < hi (bounds optional), in key order, packed.
    #[napi]
    pub fn scan_range(&self, table: String, lo: Option<Buffer>, lo_inclusive: bool, hi: Option<Buffer>, limit: u32) -> napi::Result<Buffer> {
        let txn = self.shared.read_txn()?;
        let t = open_or!(txn, &table, Buffer::from(Vec::new()));
        if empty_range(&lo, lo_inclusive, &hi, false) {
            return Ok(Buffer::from(Vec::new()));
        }
        let mut out = Vec::new();
        let mut n = 0u32;
        for item in t.range::<&[u8]>((bound(&lo, lo_inclusive), bound(&hi, false))).map_err(napi_err)? {
            let (k, v) = item.map_err(napi_err)?;
            push_bytes(&mut out, k.value());
            push_bytes(&mut out, v.value());
            n += 1;
            if n >= limit {
                break;
            }
        }
        Ok(Buffer::from(out))
    }

    /// Values of every key in the range (bounds optional, each inclusive or exclusive), packed.
    #[napi]
    pub fn range_values(&self, table: String, lo: Option<Buffer>, lo_inclusive: bool, hi: Option<Buffer>, hi_inclusive: bool, limit: u32) -> napi::Result<Buffer> {
        let txn = self.shared.read_txn()?;
        let t = open_or!(txn, &table, Buffer::from(Vec::new()));
        if empty_range(&lo, lo_inclusive, &hi, hi_inclusive) {
            return Ok(Buffer::from(Vec::new()));
        }
        let mut out = Vec::new();
        let mut n = 0u32;
        for item in t.range::<&[u8]>((bound(&lo, lo_inclusive), bound(&hi, hi_inclusive))).map_err(napi_err)? {
            let (_k, v) = item.map_err(napi_err)?;
            push_bytes(&mut out, v.value());
            n += 1;
            if n >= limit {
                break;
            }
        }
        Ok(Buffer::from(out))
    }

    /// Number of entries in the range, counted up to `limit`.
    #[napi]
    pub fn range_count(&self, table: String, lo: Option<Buffer>, lo_inclusive: bool, hi: Option<Buffer>, hi_inclusive: bool, limit: u32) -> napi::Result<f64> {
        let txn = self.shared.read_txn()?;
        let t = open_or!(txn, &table, 0.0);
        if empty_range(&lo, lo_inclusive, &hi, hi_inclusive) {
            return Ok(0.0);
        }
        let mut n = 0u32;
        for item in t.range::<&[u8]>((bound(&lo, lo_inclusive), bound(&hi, hi_inclusive))).map_err(napi_err)? {
            item.map_err(napi_err)?;
            n += 1;
            if n >= limit {
                break;
            }
        }
        Ok(n as f64)
    }

    /// First or last key of a table (null if empty).
    #[napi]
    pub fn edge_key(&self, table: String, last: bool) -> napi::Result<Option<Buffer>> {
        let txn = self.shared.read_txn()?;
        let t = open_or!(txn, &table, None);
        let e = if last { t.last() } else { t.first() }.map_err(napi_err)?;
        Ok(e.map(|(k, _)| Buffer::from(k.value().to_vec())))
    }

    #[napi]
    pub fn count(&self, table: String) -> napi::Result<f64> {
        let txn = self.shared.read_txn()?;
        let t = open_or!(txn, &table, 0.0);
        Ok(t.len().map_err(napi_err)? as f64)
    }

    #[napi]
    pub fn list_tables(&self) -> napi::Result<Vec<String>> {
        let txn = self.shared.read_txn()?;
        let names: Vec<String> = txn.list_tables().map_err(napi_err)?.map(|h| h.name().to_string()).collect();
        Ok(names)
    }

    #[napi]
    pub fn file_size(&self) -> napi::Result<f64> {
        Ok(std::fs::metadata(&self.path).map_err(napi_err)?.len() as f64)
    }
}
