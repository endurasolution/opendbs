"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClusterManager = void 0;
const crypto = __importStar(require("crypto"));
const msgpackr_1 = require("msgpackr");
const disk_store_1 = require("../storage/disk-store");
const config_1 = require("../config");
const sql_bridge_service_1 = require("../services/sql-bridge.service");
const packr = new msgpackr_1.Packr({ useRecords: false });
const MAX_SKEW_MS = 5 * 60_000;
const PULL_BATCH = 1000;
/** POST bodies that only read (served by any member). */
const READ_POST = [/\/search(\/[^/]*)?$/, /\/aggregate$/, /\/vector-search$/, /\/fuzzy$/, /^\/api\/shard\/[^/]+\/[^/]+\/(bucket-scan|partial|search)$/];
/** Node-local endpoints (never forwarded). */
const LOCAL_PATHS = [
    /^\/api\/cluster\//, /^\/api\/admin\/(cluster|env-settings|backup-config|flush|benchmark|ui-config|my-ip|backups)/,
    /^\/api\/backup\//, /^\/api\/settings\/env/,
];
class ClusterManager {
    engine;
    hooks;
    opts;
    role = 'follower';
    state = { term: 0, votedFor: null, baseLsn: 0, baseTerm: 0, synced: false };
    leaderId = null;
    leaderUrl = null;
    nodeId;
    url;
    key;
    peers = new Map();
    store;
    lastLeaderContact = Date.now();
    electionDeadline = 0;
    pauseElectionsUntil = 0;
    forced = false;
    running = false;
    timers = [];
    logWaiters = new Set();
    applyWaiters = new Set();
    ackWaiters = [];
    syncing = false;
    stats = { entriesApplied: 0, fullSyncs: 0, elections: 0, forwarded: 0, lastError: null, lastFullSyncAt: null };
    constructor(engine, hooks, opts = config_1.config.cluster) {
        this.engine = engine;
        this.hooks = hooks;
        this.opts = opts;
        const store = engine.replicationStore;
        if (!store)
            throw new Error('Replication needs the disk storage engine (STORAGE_ENGINE=disk)');
        if (!opts.secret || opts.secret.length < 32)
            throw new Error('CLUSTER_SECRET must be set to at least 32 random characters on every member');
        if (opts.peers.length > 0 && !opts.advertiseUrl)
            throw new Error('CLUSTER_ADVERTISE_URL must be set (how the other members reach this node, e.g. http://10.0.0.5:4402)');
        this.store = store;
        this.url = opts.advertiseUrl || `http://127.0.0.1:${config_1.config.port}`;
        this.nodeId = opts.nodeId || this.url.replace(/^https?:\/\//, '');
        this.key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(opts.secret), Buffer.from('opendbs-cluster'), Buffer.from('rpc-v1'), 32));
        for (const p of opts.peers)
            if (p !== this.url)
                this.peers.set(p, { url: p, ackLsn: 0, lastContact: 0 });
    }
    // ───────────────────────────── lifecycle ─────────────────────────────
    start() {
        this.store.flushSync(); // startup writes (default admin, system racks) land before replica mode
        const saved = this.store.getLocal('state');
        if (saved)
            this.state = { ...this.state, ...saved };
        this.store.loadLogState({ lsn: this.state.baseLsn, term: this.state.baseTerm });
        this.running = true;
        this.store.onLogCommitted = () => this.wakeLogWaiters();
        if (this.peers.size === 0) {
            this.becomeLeader('single-member cluster');
        }
        else {
            this.becomeFollower(this.state.term, null, 'starting up');
            this.resetElectionTimer();
            void this.followLoop();
        }
        this.timers.push(setInterval(() => this.tick(), 500));
        this.timers.push(setInterval(() => this.retention(), 30_000));
        for (const t of this.timers)
            t.unref();
        console.log(`🔗 Cluster: node ${this.nodeId}, ${this.peers.size} peer(s), write concern ${this.opts.writeConcern}`);
    }
    stop() {
        this.running = false;
        for (const t of this.timers)
            clearInterval(t);
        this.timers = [];
        this.wakeLogWaiters();
        for (const w of this.ackWaiters) {
            clearTimeout(w.timer);
            w.reject(new Error('Shutting down'));
        }
        this.ackWaiters = [];
    }
    saveState() {
        this.store.setLocal('state', this.state);
    }
    get term() {
        return this.state.term;
    }
    majority() {
        return Math.floor((this.peers.size + 1) / 2) + 1;
    }
    // ───────────────────────────── crypto ─────────────────────────────
    seal(msg) {
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
        const ct = Buffer.concat([c.update(packr.pack({ ts: Date.now(), m: msg })), c.final()]);
        return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
    }
    open(sealed) {
        const buf = Buffer.from(String(sealed), 'base64');
        // authFailure: not from a member (counted by the rpc route's throttle).
        if (buf.length < 29)
            throw Object.assign(new Error('Malformed cluster message'), { authFailure: true });
        const d = crypto.createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12));
        d.setAuthTag(buf.subarray(12, 28));
        let plain;
        try {
            plain = Buffer.concat([d.update(buf.subarray(28)), d.final()]);
        }
        catch {
            throw Object.assign(new Error('Cluster message rejected (wrong CLUSTER_SECRET?)'), { authFailure: true });
        }
        const { ts, m } = packr.unpack(plain);
        if (typeof ts !== 'number' || Math.abs(Date.now() - ts) > MAX_SKEW_MS)
            throw new Error('Cluster message expired (check the clocks of the members)');
        return m;
    }
    async call(url, msg, timeoutMs = 5000) {
        const res = await fetch(`${url}/api/cluster/rpc`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ s: this.seal(msg) }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || typeof body.s !== 'string')
            throw new Error(body.error || `HTTP ${res.status}`);
        return this.open(body.s);
    }
    // ───────────────────────────── roles ─────────────────────────────
    becomeLeader(why) {
        if (!this.state.synced || !this.state.lineage) {
            this.state.synced = true;
            this.state.lineage ||= crypto.randomBytes(12).toString('hex');
            this.saveState();
        }
        this.role = 'leader';
        this.leaderId = this.nodeId;
        this.leaderUrl = this.url;
        this.store.readOnly = null;
        this.store.setLogging(true, this.state.term);
        for (const p of this.peers.values())
            p.lastContact = Date.now(); // grace period for the lease
        console.log(`👑 Cluster: ${this.nodeId} is now PRIMARY (term ${this.state.term}, ${why})`);
    }
    becomeFollower(term, leader, why) {
        const wasLeader = this.role === 'leader';
        if (wasLeader) {
            try {
                this.store.flushSync();
            }
            catch { /* best effort */ }
            for (const w of this.ackWaiters) {
                clearTimeout(w.timer);
                w.reject(new Error('This node stopped being the primary before the write was replicated'));
            }
            this.ackWaiters = [];
        }
        if (term > this.state.term) {
            this.state.term = term;
            this.state.votedFor = null;
            this.saveState();
        }
        this.role = 'follower';
        this.forced = false;
        this.store.setLogging(false, this.state.term);
        this.leaderId = leader?.id ?? null;
        this.leaderUrl = leader?.url ?? null;
        this.store.readOnly = 'This node is a read-only replica — writes go to the primary' + (this.leaderUrl ? ` (${this.leaderUrl})` : ' (none elected yet, retry shortly)');
        if (wasLeader)
            console.log(`↘️  Cluster: ${this.nodeId} stepped down to replica (term ${this.state.term}, ${why})`);
    }
    resetElectionTimer() {
        const base = this.opts.electionTimeoutMs;
        const prio = Math.max(1, this.opts.priority);
        this.electionDeadline = Date.now() + (base * (1 + Math.random())) / prio;
    }
    /** Periodic: follower election timeout, leader lease. */
    tick() {
        if (!this.running)
            return;
        const now = Date.now();
        if (this.role === 'leader') {
            if (this.peers.size === 0 || this.forced)
                return;
            const fresh = Array.from(this.peers.values()).filter((p) => now - p.lastContact < this.opts.electionTimeoutMs * 1.5).length;
            if (1 + fresh < this.majority())
                this.becomeFollower(this.state.term, null, 'lost contact with the majority');
            return;
        }
        if (this.role === 'follower' && !this.syncing && now > this.electionDeadline && now > this.pauseElectionsUntil
            && now - this.lastLeaderContact > this.opts.electionTimeoutMs && this.opts.priority > 0) {
            void this.startElection();
        }
    }
    async startElection() {
        if (this.role !== 'follower')
            return;
        // A node that never joined the cluster's history must not win against members that hold data:
        // first-time setup (one existing server + new empty ones) must keep the existing data.
        if (!this.state.synced) {
            const mine = this.engine.userDocumentCount();
            for (const p of this.peers.values()) {
                try {
                    const s = await this.call(p.url, { type: 'status' }, 2000);
                    if (s.synced || s.dataScore > mine) {
                        this.resetElectionTimer();
                        return;
                    }
                }
                catch { /* unreachable peers don't block */ }
            }
            if (this.role !== 'follower')
                return;
        }
        this.role = 'candidate';
        this.stats.elections++;
        this.state.term++;
        this.state.votedFor = this.nodeId;
        this.saveState();
        const term = this.state.term;
        const req = {
            type: 'vote', term, nodeId: this.nodeId, url: this.url, lastLsn: this.store.lastLsn, lastTerm: this.store.lastTerm, lineage: this.state.lineage ?? null,
            synced: this.state.synced, dataScore: this.state.synced ? 0 : this.engine.userDocumentCount(),
        };
        let votes = 1;
        await Promise.all(Array.from(this.peers.values()).map(async (p) => {
            try {
                const r = await this.call(p.url, req, Math.min(3000, this.opts.electionTimeoutMs));
                p.lastContact = Date.now();
                p.nodeId = r.nodeId;
                if (r.term > this.state.term) {
                    this.becomeFollower(r.term, null, 'saw a newer term');
                    return;
                }
                if (r.granted)
                    votes++;
            }
            catch (e) {
                p.error = e.message;
            }
        }));
        if (this.role !== 'candidate' || this.state.term !== term)
            return;
        if (votes >= this.majority())
            this.becomeLeader(`won election with ${votes}/${this.peers.size + 1} votes`);
        else {
            this.becomeFollower(term, null, 'election lost');
            this.resetElectionTimer();
        }
    }
    // ───────────────────────────── follower ─────────────────────────────
    async discoverLeader() {
        let best = null;
        await Promise.all(Array.from(this.peers.values()).map(async (p) => {
            try {
                const s = await this.call(p.url, { type: 'status' }, 3000);
                p.nodeId = s.nodeId;
                p.role = s.role;
                p.term = s.term;
                p.error = undefined;
                if (s.role === 'leader' && (!best || s.term > best.term))
                    best = { id: s.nodeId, url: s.url, term: s.term };
            }
            catch (e) {
                p.error = e.message;
            }
        }));
        const found = best;
        if (found && found.term >= this.state.term) {
            this.becomeFollower(found.term, { id: found.id, url: found.url }, 'found primary');
            return true;
        }
        return false;
    }
    async followLoop() {
        while (this.running) {
            if (this.role !== 'follower') {
                await sleep(300);
                continue;
            }
            if (!this.leaderUrl && !(await this.discoverLeader())) {
                await sleep(500);
                continue;
            }
            try {
                const r = await this.call(this.leaderUrl, {
                    type: 'pull', term: this.state.term, nodeId: this.nodeId, url: this.url, synced: this.state.synced, lineage: this.state.lineage ?? null,
                    fromLsn: this.store.lastLsn, lastTerm: this.store.lastTerm, ackLsn: this.state.synced ? this.store.lastLsn : 0,
                }, this.opts.electionTimeoutMs + 5000);
                if (this.role !== 'follower')
                    continue;
                if (!r.ok) {
                    if (r.term > this.state.term)
                        this.becomeFollower(r.term, null, 'newer term');
                    this.leaderUrl = r.leaderUrl && r.leaderUrl !== this.url ? r.leaderUrl : null;
                    await sleep(200);
                    continue;
                }
                this.lastLeaderContact = Date.now();
                this.resetElectionTimer();
                if (r.term > this.state.term) {
                    this.state.term = r.term;
                    this.state.votedFor = null;
                    this.saveState();
                }
                if (r.resync) {
                    await this.fullSync();
                    continue;
                }
                const entries = r.entries.map((e) => ({ ...e, ops: Buffer.from(e.ops) }));
                if (entries.length) {
                    this.engine.applyReplicated(entries, config_1.config.walFsync);
                    this.stats.entriesApplied += entries.length;
                    for (const w of this.applyWaiters)
                        w();
                }
            }
            catch (e) {
                this.stats.lastError = `${new Date().toISOString()} ${e.message}`;
                if (/Replication gap/.test(e.message)) {
                    await this.fullSync().catch(() => undefined);
                    continue;
                }
                this.leaderUrl = null;
                await sleep(500);
            }
        }
    }
    /** Copies the primary's whole store, then follows its log from the copy's LSN. */
    async fullSync() {
        if (this.syncing)
            return;
        this.syncing = true;
        const leader = this.leaderUrl;
        try {
            console.log(`🔄 Cluster: full sync from ${leader} …`);
            const start = await this.call(leader, { type: 'sync-start', nodeId: this.nodeId, url: this.url });
            await this.hooks.beforeWipe?.().catch((e) => console.warn('Safety backup before resync failed:', e?.message));
            this.store.asApplier(() => this.store.wipe());
            let copied = 0;
            for (const table of start.tables) {
                let after = null;
                for (;;) {
                    const r = await this.call(leader, { type: 'sync-scan', table, after, limit: 5000 }, 60_000);
                    const entries = r.entries.map((e) => [Buffer.from(e[0]), Buffer.from(e[1])]);
                    this.store.asApplier(() => this.store.writeRaw(table, entries));
                    copied += entries.length;
                    if (entries.length < 5000)
                        break;
                    after = entries[entries.length - 1][0];
                }
            }
            this.state.baseLsn = start.lsn;
            this.state.baseTerm = start.term;
            this.state.synced = true;
            this.state.lineage = start.lineage;
            if (start.term > this.state.term) {
                this.state.term = start.term;
                this.state.votedFor = null;
            }
            this.saveState();
            this.store.loadLogState({ lsn: start.lsn, term: start.term });
            this.engine.reloadFromStore();
            this.hooks.secrets.adopt(start.secrets);
            this.stats.fullSyncs++;
            this.stats.lastFullSyncAt = new Date().toISOString();
            console.log(`✅ Cluster: full sync done (${copied.toLocaleString()} entries, at LSN ${start.lsn})`);
        }
        finally {
            this.syncing = false;
        }
    }
    /** Waits (bounded) until this replica has applied `lsn` — read-your-writes after a forwarded write. */
    async waitApplied(lsn, ms) {
        const deadline = Date.now() + ms;
        while (this.store.lastLsn < lsn && Date.now() < deadline) {
            await new Promise((resolve) => {
                const done = () => { this.applyWaiters.delete(done); clearTimeout(t); resolve(); };
                const t = setTimeout(done, Math.max(1, deadline - Date.now()));
                this.applyWaiters.add(done);
            });
        }
    }
    // ───────────────────────────── leader ─────────────────────────────
    wakeLogWaiters() {
        for (const w of this.logWaiters)
            w();
        this.logWaiters.clear();
    }
    waitForLog(after, ms) {
        if (this.store.committedLsn > after)
            return Promise.resolve();
        return new Promise((resolve) => {
            const done = () => { clearTimeout(t); this.logWaiters.delete(done); resolve(); };
            const t = setTimeout(done, ms);
            this.logWaiters.add(done);
        });
    }
    termAt(lsn) {
        if (lsn === 0)
            return 0;
        if (lsn === this.state.baseLsn)
            return this.state.baseTerm;
        const e = this.store.readLog(lsn - 1, 1)[0];
        return e && e.lsn === lsn ? e.term : undefined;
    }
    extraPeers = new Map();
    /** The configured member a request came from (by advertised URL, else node id). */
    peerFor(url, nodeId) {
        let p = this.peers.get(url) ?? (nodeId ? Array.from(this.peers.values()).find((x) => x.nodeId === nodeId) : undefined);
        if (!p) {
            // Not in CLUSTER_PEERS (check that it matches the member's CLUSTER_ADVERTISE_URL): tracked, but not part of the majority.
            p = this.extraPeers.get(url) ?? { url, ackLsn: 0, lastContact: 0 };
            this.extraPeers.set(url, p);
        }
        if (nodeId)
            p.nodeId = nodeId;
        return p;
    }
    async onPull(m) {
        if (m.term > this.state.term)
            this.becomeFollower(m.term, null, 'a member has a newer term');
        if (this.role !== 'leader')
            return { ok: false, notLeader: true, term: this.state.term, leaderUrl: this.leaderUrl };
        const p = this.peerFor(m.url, m.nodeId);
        p.lastContact = Date.now();
        p.role = 'follower';
        p.term = m.term;
        const from = Number(m.fromLsn) || 0;
        const base = { ok: true, term: this.state.term, leaderId: this.nodeId };
        // Can the replica continue from where it is? Otherwise it needs a full copy: never synced,
        // a different dataset, ahead of us (diverged), behind what our log still holds, or a different history.
        // (Its acknowledgements only count once it holds our data.)
        if (!m.synced || m.lineage !== this.state.lineage || from > this.store.lastLsn)
            return { ...base, resync: true };
        if (typeof m.ackLsn === 'number' && m.ackLsn > p.ackLsn)
            p.ackLsn = m.ackLsn;
        this.checkAckWaiters();
        if (from < this.store.lastLsn) {
            const first = this.store.firstLsn();
            if (first === 0 || first > from + 1)
                return { ...base, resync: true };
        }
        if (this.termAt(from) !== m.lastTerm)
            return { ...base, resync: true };
        let entries = this.store.readLog(from, PULL_BATCH);
        if (entries.length === 0) {
            await this.waitForLog(from, Math.min(15_000, this.opts.electionTimeoutMs / 2));
            if (this.role !== 'leader')
                return { ok: false, notLeader: true, term: this.state.term, leaderUrl: this.leaderUrl };
            entries = this.store.readLog(from, PULL_BATCH);
        }
        return { ...base, entries };
    }
    onVote(m) {
        const now = Date.now();
        const reply = (granted) => ({ term: this.state.term, granted, nodeId: this.nodeId });
        if (m.term < this.state.term)
            return reply(false);
        // Leader stickiness: while a primary is reachable, ignore candidates (a partitioned node can't disrupt it).
        if (this.role === 'leader' && !this.forced) {
            const fresh = Array.from(this.peers.values()).filter((p) => now - p.lastContact < this.opts.electionTimeoutMs).length;
            if (1 + fresh >= this.majority())
                return reply(false);
        }
        if (this.role === 'follower' && this.leaderUrl && now - this.lastLeaderContact < this.opts.electionTimeoutMs)
            return reply(false);
        if (m.term > this.state.term)
            this.becomeFollower(m.term, null, 'vote request with a newer term');
        // Never hand the cluster to a node without its history, or with less data than ours (first-time setup).
        if (!m.synced && (this.state.synced || (Number(m.dataScore) || 0) < this.engine.userDocumentCount()))
            return reply(false);
        // Nor to a node whose data is a different dataset (it would make every member replace its data).
        if (m.synced && this.state.lineage && m.lineage && m.lineage !== this.state.lineage)
            return reply(false);
        const upToDate = m.lastTerm > this.store.lastTerm || (m.lastTerm === this.store.lastTerm && m.lastLsn >= this.store.lastLsn);
        if (upToDate && (this.state.votedFor === null || this.state.votedFor === m.nodeId)) {
            this.state.votedFor = m.nodeId;
            this.saveState();
            this.resetElectionTimer();
            return reply(true);
        }
        return reply(false);
    }
    async onSyncStart(m) {
        if (this.role !== 'leader')
            throw new Error('Not the primary');
        this.store.flushSync();
        const p = this.peerFor(m.url, m.nodeId);
        p.lastContact = Date.now();
        const lsn = this.store.committedLsn;
        p.ackLsn = lsn; // keep the log from here until the replica catches up
        const tables = this.store.native.listTables().filter((t) => t !== disk_store_1.REPL_TABLE && t !== disk_store_1.CLUSTER_TABLE);
        return { lsn, term: this.termAt(lsn) ?? this.state.term, lineage: this.state.lineage, tables, secrets: this.hooks.secrets.get() };
    }
    onSyncScan(m) {
        if (this.role !== 'leader')
            throw new Error('Not the primary');
        const page = this.store.native.scan(String(m.table), m.after ? Buffer.from(m.after) : null, Math.min(10_000, Number(m.limit) || 5000));
        const entries = [];
        let p = 0;
        while (p < page.length) {
            const kl = page.readUInt32LE(p);
            const k = page.subarray(p + 4, p + 4 + kl);
            p += 4 + kl;
            const vl = page.readUInt32LE(p);
            entries.push([k, page.subarray(p + 4, p + 4 + vl)]);
            p += 4 + vl;
        }
        return { entries };
    }
    status() {
        return {
            nodeId: this.nodeId, url: this.url, role: this.role, term: this.state.term,
            leaderId: this.leaderId, leaderUrl: this.leaderUrl, lastLsn: this.store.lastLsn,
            synced: this.state.synced, dataScore: this.state.synced ? 0 : this.engine.userDocumentCount(),
        };
    }
    /** Handles an encrypted member-to-member request. */
    async handleRpc(sealed) {
        const m = this.open(sealed);
        let r;
        switch (m?.type) {
            case 'pull':
                r = await this.onPull(m);
                break;
            case 'vote':
                r = this.onVote(m);
                break;
            case 'status':
                r = this.status();
                break;
            case 'sync-start':
                r = await this.onSyncStart(m);
                break;
            case 'sync-scan':
                r = this.onSyncScan(m);
                break;
            default: throw new Error('Unknown cluster request');
        }
        return this.seal(r);
    }
    // ── write concern ──
    checkAckWaiters() {
        if (!this.ackWaiters.length)
            return;
        const keep = [];
        for (const w of this.ackWaiters) {
            if (this.replicatedTo(w.lsn) >= this.majority()) {
                clearTimeout(w.timer);
                w.resolve();
            }
            else
                keep.push(w);
        }
        this.ackWaiters = keep;
    }
    replicatedTo(lsn) {
        let n = 1;
        for (const p of this.peers.values())
            if (p.ackLsn >= lsn)
                n++;
        return n;
    }
    /** REPLICATION_SYNC=majority: resolves once a majority of members has applied `lsn`. */
    awaitReplication(lsn) {
        if (this.opts.writeConcern !== 'majority' || this.peers.size === 0 || lsn === 0)
            return Promise.resolve();
        if (this.role !== 'leader')
            return Promise.reject(new Error('This node stopped being the primary'));
        if (this.replicatedTo(lsn) >= this.majority())
            return Promise.resolve();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.ackWaiters = this.ackWaiters.filter((w) => w.timer !== timer);
                reject(new Error(`Write saved on the primary but not yet confirmed by a majority within ${this.opts.writeTimeoutMs} ms`));
            }, this.opts.writeTimeoutMs);
            this.ackWaiters.push({ lsn, resolve, reject, timer });
            this.wakeLogWaiters();
        });
    }
    // ── log retention ──
    retention() {
        if (!this.running)
            return;
        const keepWindow = this.store.lastLsn - this.opts.logRetention;
        let below = keepWindow;
        if (this.role === 'leader') {
            // Never trim entries a recently seen member still needs.
            const recent = Array.from(this.peers.values()).filter((p) => Date.now() - p.lastContact < 10 * 60_000);
            for (const p of recent)
                below = Math.min(below, p.ackLsn);
        }
        if (below > 1 && this.store.firstLsn() !== 0 && this.store.firstLsn() < below) {
            try {
                this.store.asApplier(() => this.store.trimLog(below));
            }
            catch (e) {
                this.stats.lastError = e.message;
            }
        }
    }
    // ── admin actions ──
    stepDown() {
        if (this.role !== 'leader')
            throw new Error('This node is not the primary');
        if (this.peers.size === 0)
            throw new Error('Single-member cluster: there is no other member to take over');
        this.becomeFollower(this.state.term, null, 'admin request');
        this.pauseElectionsUntil = Date.now() + this.opts.electionTimeoutMs * 3;
    }
    electNow() {
        if (this.role === 'leader')
            throw new Error('Already the primary');
        this.pauseElectionsUntil = 0;
        this.lastLeaderContact = 0;
        this.electionDeadline = 0;
        void this.startElection();
    }
    /** Last resort when a majority is gone for good (e.g. 2-member cluster, one member lost). */
    forcePrimary() {
        if (this.role === 'leader')
            throw new Error('Already the primary');
        this.state.term++;
        this.state.votedFor = this.nodeId;
        this.saveState();
        this.becomeLeader('forced by an admin — no majority confirmation');
        this.forced = true;
    }
    info() {
        const now = Date.now();
        return {
            enabled: true,
            nodeId: this.nodeId, url: this.url, role: this.role, term: this.state.term,
            leaderId: this.leaderId, leaderUrl: this.leaderUrl, forced: this.forced, syncing: this.syncing, synced: this.state.synced, lineage: this.state.lineage ?? null,
            writeConcern: this.opts.writeConcern, majority: this.majority(), members: this.peers.size + 1,
            lastLsn: this.store.lastLsn, committedLsn: this.store.committedLsn, firstLsn: this.store.firstLsn(),
            peers: Array.from(this.peers.values()).map((p) => ({
                url: p.url, nodeId: p.nodeId ?? null, role: p.role ?? null, term: p.term ?? null,
                ackLsn: p.ackLsn, lag: this.role === 'leader' ? Math.max(0, this.store.lastLsn - p.ackLsn) : null,
                lastContactMsAgo: p.lastContact ? now - p.lastContact : null, error: p.error ?? null,
            })),
            stats: this.stats,
        };
    }
    // ───────────────────────────── HTTP integration ─────────────────────────────
    /** Verified client IP of a request forwarded by another member. */
    adoptForwardedIp(request) {
        const h = request.headers['x-opendbs-forwarded'];
        if (typeof h !== 'string')
            return;
        try {
            const m = this.open(h);
            if (typeof m?.ip === 'string' && m.mth === request.method && m.url === request.url) {
                Object.defineProperty(request, 'ip', { value: m.ip, configurable: true });
            }
        }
        catch { /* not from a member: ignore the header */ }
    }
    isRead(request) {
        const m = request.method;
        if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS')
            return true;
        const url = request.url.split('?')[0];
        if (m === 'POST' && READ_POST.some((re) => re.test(url)))
            return true;
        if (m === 'POST' && /^\/api\/sql\/(query|[^/]+\/execute)$/.test(url)) {
            const q = request.body?.query;
            try {
                return typeof q === 'string' && (0, sql_bridge_service_1.requiredSQLPermission)(q) === 'read' && !/\bBEGIN\b|\bSTART\s+TRANSACTION\b/i.test(q);
            }
            catch {
                return false;
            }
        }
        return false;
    }
    shouldForward(request) {
        if (this.role === 'leader')
            return false;
        const url = request.url.split('?')[0];
        if (LOCAL_PATHS.some((re) => re.test(url)))
            return false;
        if (!url.startsWith('/api/'))
            return false;
        // While copying the primary's data this node has nothing consistent to serve.
        if (this.syncing || !this.state.synced)
            return true;
        return !this.isRead(request);
    }
    async forward(request, reply) {
        if (!this.leaderUrl) {
            return reply.status(503).send({ error: 'No primary is available right now (election in progress). Retry shortly.' });
        }
        const headers = {};
        for (const h of ['authorization', 'content-type', 'x-api-key', 'accept', 'user-agent', 'idempotency-key', 'x-opendbs-shard-request']) {
            const v = request.headers[h];
            if (typeof v === 'string')
                headers[h] = v;
        }
        // Bound to this request: a captured header can't lend its IP to a different request.
        headers['x-opendbs-forwarded'] = this.seal({ ip: request.ip, node: this.nodeId, mth: request.method, url: request.url });
        const body = request.body === undefined || request.body === null ? undefined
            : typeof request.body === 'string' || Buffer.isBuffer(request.body) ? request.body : JSON.stringify(request.body);
        let res;
        try {
            res = await fetch(this.leaderUrl + request.url, { method: request.method, headers, body: body, signal: AbortSignal.timeout(60_000) });
        }
        catch (e) {
            this.leaderUrl = null;
            return reply.status(503).send({ error: `The primary could not be reached (${e.message}). Retry shortly.` });
        }
        this.stats.forwarded++;
        const buf = Buffer.from(await res.arrayBuffer());
        const lsn = Number(res.headers.get('x-opendbs-lsn') || 0);
        if (lsn)
            await this.waitApplied(lsn, 3000); // read-your-writes on this replica
        reply.code(res.status);
        const ct = res.headers.get('content-type');
        if (ct)
            reply.header('content-type', ct);
        reply.header('x-opendbs-primary', this.leaderId ?? '');
        return reply.send(buf);
    }
    /** Routes + hooks. Call before other routes are registered. */
    register(fastify) {
        // Not rate limited (members talk constantly), but senders whose messages fail to decrypt are.
        const failures = new Map();
        fastify.post('/api/cluster/rpc', { config: { rateLimit: false }, bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
            const f = failures.get(request.ip);
            if (f && f.until > Date.now() && f.n >= 20)
                return reply.status(429).send({ error: 'Too many rejected cluster requests' });
            const s = request.body?.s;
            if (typeof s !== 'string')
                return reply.status(400).send({ error: 'Bad cluster request' });
            try {
                return { s: await this.handleRpc(s) };
            }
            catch (e) {
                if (e?.authFailure) {
                    const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + 60_000 };
                    cur.n++;
                    failures.set(request.ip, cur);
                    if (failures.size > 10_000)
                        failures.clear();
                }
                return reply.status(403).send({ error: e.message });
            }
        });
        // Public (load balancers, drivers): only the role. Details are in GET /api/admin/cluster.
        fastify.get('/api/cluster/status', async () => ({ role: this.role, primary: this.role === 'leader', leaderId: this.leaderId }));
        // Replicas forward writes to the primary.
        fastify.addHook('preHandler', async (request, reply) => {
            if (this.shouldForward(request))
                return this.forward(request, reply);
        });
        // Primary: report the LSN of each write (lets the forwarding replica wait for it) and enforce the write concern.
        fastify.addHook('onSend', async (request, reply, payload) => {
            if (this.role !== 'leader' || request.method === 'GET' || request.method === 'HEAD')
                return payload;
            if (reply.statusCode >= 400)
                return payload;
            if (this.store.hasPending())
                await this.store.sync(); // the write's batch is committed (and logged)
            const lsn = this.store.committedLsn;
            reply.header('x-opendbs-lsn', String(lsn));
            if (request.url.startsWith('/api/cluster/'))
                return payload;
            try {
                await this.awaitReplication(lsn);
                return payload;
            }
            catch (e) {
                reply.code(503);
                reply.header('content-type', 'application/json; charset=utf-8');
                return JSON.stringify({ error: e.message, savedOnPrimary: true });
            }
        });
    }
}
exports.ClusterManager = ClusterManager;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
//# sourceMappingURL=cluster.js.map