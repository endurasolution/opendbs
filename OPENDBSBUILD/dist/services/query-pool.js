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
exports.QueryPool = void 0;
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const worker_threads_1 = require("worker_threads");
/**
 * Worker threads for parallel scans and aggregations over the disk store.
 * Each worker attaches read-only to the main thread's store; tasks are key
 * ranges of one rack, so N cores scan N ranges at once.
 */
class QueryPool {
    workers = [];
    idle = [];
    queue = [];
    pending = new Map();
    seq = 0;
    closed = false;
    size;
    stats = { tasks: 0, parallelQueries: 0, failures: 0 };
    constructor(storeHandle, size) {
        this.size = size;
        const file = path.join(__dirname, '..', 'workers', 'query-worker.js');
        for (let i = 0; i < size; i++) {
            const w = new worker_threads_1.Worker(file, { workerData: { handle: storeHandle } });
            w.unref();
            w.on('message', (m) => {
                const p = this.pending.get(m.id);
                if (!p)
                    return;
                this.pending.delete(m.id);
                if (m.ok)
                    p.resolve(m.result);
                else {
                    this.stats.failures++;
                    p.reject(new Error(m.error));
                }
                this.release(w);
            });
            w.on('error', (err) => {
                this.stats.failures++;
                for (const [id, p] of this.pending) {
                    if (p.worker === w) {
                        this.pending.delete(id);
                        p.reject(err);
                    }
                }
                this.workers = this.workers.filter((x) => x !== w);
                this.idle = this.idle.filter((x) => x !== w);
            });
            this.workers.push(w);
            this.idle.push(w);
        }
    }
    /**
     * Default worker count: QUERY_WORKERS, else half the logical CPUs (scans
     * stop scaling past the physical/performance cores), 1–8; 0 disables.
     */
    static defaultSize() {
        const env = process.env.QUERY_WORKERS;
        if (env !== undefined && env !== '') {
            const n = parseInt(env, 10);
            return Number.isFinite(n) && n >= 0 ? Math.min(n, 64) : 0;
        }
        const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
        return Math.max(1, Math.min(8, Math.floor(cpus / 2)));
    }
    get alive() {
        return !this.closed && this.workers.length > 0;
    }
    release(w) {
        const next = this.queue.shift();
        if (next)
            this.dispatch(w, next.task, next.resolve, next.reject);
        else
            this.idle.push(w);
    }
    dispatch(w, task, resolve, reject) {
        this.pending.set(task.id, { resolve, reject, worker: w });
        this.stats.tasks++;
        w.postMessage(task);
    }
    run(task) {
        if (!this.alive)
            return Promise.reject(new Error('Query workers are not running'));
        const t = { ...task, id: ++this.seq };
        return new Promise((resolve, reject) => {
            const w = this.idle.pop();
            if (w)
                this.dispatch(w, t, resolve, reject);
            else
                this.queue.push({ task: t, resolve, reject });
        });
    }
    runAll(tasks) {
        this.stats.parallelQueries++;
        return Promise.all(tasks.map((t) => this.run(t)));
    }
    async close() {
        this.closed = true;
        for (const p of this.pending.values())
            p.reject(new Error('Query workers stopped'));
        this.pending.clear();
        await Promise.all(this.workers.map((w) => w.terminate().catch(() => undefined)));
        this.workers = [];
        this.idle = [];
    }
}
exports.QueryPool = QueryPool;
//# sourceMappingURL=query-pool.js.map