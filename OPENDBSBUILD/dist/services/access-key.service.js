"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccessKeyService = exports.normalizeIp = void 0;
exports.validateIpList = validateIpList;
const crypto_1 = __importDefault(require("crypto"));
const net_1 = __importDefault(require("net"));
const security_middleware_1 = require("../middleware/security.middleware");
const auth_service_1 = require("./auth.service");
const KEY_PREFIX = 'odbs_';
const MAX_IP_ENTRIES = 100;
const normalizeIp = (ip) => (ip.startsWith('::ffff:') && net_1.default.isIPv4(ip.slice(7)) ? ip.slice(7) : ip);
exports.normalizeIp = normalizeIp;
/** Validates an allow-list. Accepts "*", single IPs and CIDR ranges (v4 and v6). */
function validateIpList(value) {
    if (value === undefined || value === null)
        return ['*'];
    const raw = Array.isArray(value)
        ? value
        : typeof value === 'string' ? value.split(/[\s,]+/) : null;
    if (!raw)
        throw new Error('allowedIps must be an array of IPs/CIDRs, or "*"');
    const list = Array.from(new Set(raw.map((s) => String(s).trim()).filter(Boolean)));
    if (list.length === 0)
        throw new Error('allowedIps must not be empty (use "*" to allow any IP)');
    if (list.includes('*'))
        return ['*'];
    if (list.length > MAX_IP_ENTRIES)
        throw new Error(`At most ${MAX_IP_ENTRIES} IP entries`);
    for (const entry of list) {
        const [addr, bits, extra] = entry.split('/');
        const family = net_1.default.isIP(addr);
        if (!family || extra !== undefined)
            throw new Error(`Invalid IP or CIDR: '${entry}'`);
        if (bits !== undefined) {
            const n = Number(bits);
            if (!/^\d+$/.test(bits) || n < 0 || n > (family === 4 ? 32 : 128))
                throw new Error(`Invalid CIDR prefix: '${entry}'`);
        }
    }
    return list;
}
function buildIpMatcher(list) {
    if (list.includes('*'))
        return () => true;
    const block = new net_1.default.BlockList();
    for (const entry of list) {
        const [addr, bits] = entry.split('/');
        const type = net_1.default.isIPv6(addr) ? 'ipv6' : 'ipv4';
        if (bits !== undefined)
            block.addSubnet(addr, Number(bits), type);
        else
            block.addAddress(addr, type);
    }
    return (ip) => {
        const n = (0, exports.normalizeIp)(ip);
        const family = net_1.default.isIP(n);
        return family !== 0 && block.check(n, family === 6 ? 'ipv6' : 'ipv4');
    };
}
function parseExpiry(value) {
    if (value === undefined || value === null || value === '')
        return null;
    const ms = typeof value === 'number' ? value : Date.parse(String(value));
    if (!Number.isFinite(ms))
        throw new Error('expiresAt must be an ISO date or epoch milliseconds');
    if (ms <= Date.now())
        throw new Error('expiresAt must be in the future');
    return ms;
}
function cleanName(value) {
    const name = typeof value === 'string' ? value.trim() : '';
    const hasControlChars = Array.from(name).some((ch) => ch.charCodeAt(0) < 0x20);
    if (!name || name.length > 64 || hasControlChars)
        throw new Error('name is required (1–64 characters)');
    return name;
}
function cleanDescription(value) {
    if (value === undefined || value === null || value === '')
        return undefined;
    if (typeof value !== 'string' || value.length > 300)
        throw new Error('description must be a string of at most 300 characters');
    return value;
}
class AccessKeyService {
    engine;
    DB = '_opendbs_system';
    RACK = 'api_keys';
    cacheVersion = -1;
    byHash = new Map();
    matchers = new Map();
    // Usage is tracked in memory and flushed periodically, so authenticating
    // a request never costs a disk write.
    usage = new Map();
    constructor(engine) {
        this.engine = engine;
        engine.createDatabase(this.DB);
        engine.createRack(this.DB, this.RACK);
        engine.createIndex(this.DB, this.RACK, 'keyHash', { unique: true });
        setInterval(() => this.flushUsage(), 60_000).unref();
    }
    refresh() {
        const v = this.engine.getRackVersion(this.DB, this.RACK);
        if (v === this.cacheVersion)
            return;
        this.byHash.clear();
        this.matchers.clear();
        for (const raw of this.engine.query(this.DB, this.RACK, {}).results) {
            const k = { ...raw };
            delete k._metadata;
            this.byHash.set(k.keyHash, k);
            this.matchers.set(k.id, buildIpMatcher(k.allowedIps ?? ['*']));
        }
        this.cacheVersion = v;
    }
    static toPublic(k, live) {
        const { keyHash: _omit, ...pub } = k;
        void _omit;
        if (live) {
            pub.lastUsedAt = live.at;
            pub.lastUsedIp = live.ip;
            pub.useCount = (k.useCount ?? 0) + live.count;
        }
        return pub;
    }
    static newSecret() {
        return KEY_PREFIX + crypto_1.default.randomBytes(24).toString('hex');
    }
    save(k) {
        const { id, ...data } = k;
        delete data._metadata;
        this.engine.update(this.DB, this.RACK, id, data);
    }
    require(id) {
        this.refresh();
        for (const k of this.byHash.values())
            if (k.id === String(id))
                return structuredClone(k);
        throw new Error('API key not found');
    }
    list() {
        this.refresh();
        return Array.from(this.byHash.values())
            .map((k) => AccessKeyService.toPublic(k, this.usage.get(k.id)))
            .sort((a, b) => b.createdAt - a.createdAt);
    }
    create(input, createdBy) {
        const secret = AccessKeyService.newSecret();
        const now = Date.now();
        const record = {
            name: cleanName(input.name),
            description: cleanDescription(input.description),
            keyHash: (0, security_middleware_1.sha256Hex)(secret),
            prefix: secret.slice(0, KEY_PREFIX.length + 6),
            permissions: (0, auth_service_1.validatePermissions)(input.permissions) ?? {},
            allowedIps: validateIpList(input.allowedIps),
            enabled: input.enabled === undefined ? true : Boolean(input.enabled),
            expiresAt: parseExpiry(input.expiresAt),
            createdBy,
            createdAt: now,
            updatedAt: now,
            useCount: 0,
        };
        if (Object.keys(record.permissions).length === 0)
            throw new Error('Grant at least one database permission');
        const id = this.engine.insert(this.DB, this.RACK, record);
        return { key: secret, record: AccessKeyService.toPublic({ ...record, id }) };
    }
    update(id, input) {
        const k = this.require(id);
        if (input.name !== undefined)
            k.name = cleanName(input.name);
        if (input.description !== undefined)
            k.description = cleanDescription(input.description);
        if (input.permissions !== undefined) {
            k.permissions = (0, auth_service_1.validatePermissions)(input.permissions) ?? {};
            if (Object.keys(k.permissions).length === 0)
                throw new Error('Grant at least one database permission');
        }
        if (input.allowedIps !== undefined)
            k.allowedIps = validateIpList(input.allowedIps);
        if (input.enabled !== undefined)
            k.enabled = Boolean(input.enabled);
        if (input.expiresAt !== undefined)
            k.expiresAt = parseExpiry(input.expiresAt);
        k.updatedAt = Date.now();
        this.save(k);
        return AccessKeyService.toPublic(k);
    }
    rotate(id) {
        const k = this.require(id);
        const secret = AccessKeyService.newSecret();
        k.keyHash = (0, security_middleware_1.sha256Hex)(secret);
        k.prefix = secret.slice(0, KEY_PREFIX.length + 6);
        k.updatedAt = Date.now();
        this.save(k);
        return { key: secret, record: AccessKeyService.toPublic(k) };
    }
    delete(id) {
        this.require(id);
        this.usage.delete(String(id));
        return this.engine.delete(this.DB, this.RACK, String(id));
    }
    /** Returns null when the key isn't an access key at all. */
    authenticate(rawKey, ip) {
        if (typeof rawKey !== 'string' || !rawKey.startsWith(KEY_PREFIX) || rawKey.length > 128)
            return null;
        this.refresh();
        const k = this.byHash.get((0, security_middleware_1.sha256Hex)(rawKey));
        if (!k)
            return null;
        if (!k.enabled)
            return { ok: false, reason: 'disabled', key: k };
        if (k.expiresAt && Date.now() >= k.expiresAt)
            return { ok: false, reason: 'expired', key: k };
        const matcher = this.matchers.get(k.id);
        if (!matcher || !matcher(ip))
            return { ok: false, reason: 'ip', key: k };
        const u = this.usage.get(k.id) ?? { at: 0, ip: '', count: 0 };
        u.at = Date.now();
        u.ip = (0, exports.normalizeIp)(ip);
        u.count++;
        this.usage.set(k.id, u);
        const user = {
            id: `key_${k.id}`,
            username: `key:${k.name}`,
            passwordHash: '',
            role: 'user',
            permissions: structuredClone(k.permissions),
            accessKeyId: k.id,
            createdAt: k.createdAt,
            updatedAt: k.updatedAt,
        };
        return { ok: true, user, key: k };
    }
    flushUsage() {
        // Read-only replica: usage is recorded where writes happen (the primary).
        if (this.usage.size === 0 || this.engine.isReadOnly())
            return;
        this.refresh();
        const pending = this.usage;
        this.usage = new Map();
        for (const k of this.byHash.values()) {
            const u = pending.get(k.id);
            if (!u)
                continue;
            const next = { ...k, lastUsedAt: u.at, lastUsedIp: u.ip, useCount: (k.useCount ?? 0) + u.count };
            try {
                this.save(next);
            }
            catch { /* key deleted meanwhile */ }
        }
    }
}
exports.AccessKeyService = AccessKeyService;
//# sourceMappingURL=access-key.service.js.map