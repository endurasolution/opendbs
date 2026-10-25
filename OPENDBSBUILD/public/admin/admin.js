'use strict';

/*
 * OpenDBS admin panel.
 *
 * Security notes:
 *  - Every value coming from the server is rendered via textContent / DOM
 *    nodes (see h()); nothing user-controlled ever reaches innerHTML, so
 *    stored data can't inject script.
 *  - The token lives in sessionStorage (cleared when the tab closes), not
 *    localStorage, and the page runs under a strict CSP with no inline JS.
 */
(() => {
    const TOKEN_KEY = 'opendbs_admin_token';
    const THEME_KEY = 'opendbs_admin_theme';
    const PG_KEY = 'opendbs_admin_playground';
    const SYSTEM_DB = '_opendbs_system';
    const COLUMN_TYPES = ['string', 'integer', 'number', 'boolean', 'date', 'array', 'object'];
    const PERMS = ['read', 'write', 'delete'];

    const state = {
        token: safeGet(sessionStorage, TOKEN_KEY),
        user: null,
        timer: null,
        databases: [],
        browser: { db: null, rack: null, tab: 'docs', skip: 0, limit: 25, sort: null, order: 'asc', query: '' },
        pg: loadPlayground(),
        pgKey: '',
        expanded: new Set(JSON.parse(safeGet(sessionStorage, 'opendbs_admin_tree') || '[]')),
        uiConfig: { sessionTimeoutMinutes: 30, require2fa: false, sessionMfa: false },
        mfaRequired: false,
        lastActivity: Date.now(),
        idleTimer: null,
        challenge: null,
        sql: { db: null, text: '', history: JSON.parse(safeGet(sessionStorage, 'opendbs_admin_sql_history') || '[]') },
    };

    // ───────────────────────── utilities ─────────────────────────

    function safeGet(store, key) { try { return store.getItem(key); } catch { return null; } }
    function safeSet(store, key, val) { try { val === null ? store.removeItem(key) : store.setItem(key, val); } catch { /* ignore */ } }

    const $ = (sel) => document.querySelector(sel);

    /** Builds DOM safely. Strings become text nodes; on* attrs bind listeners. */
    function h(tag, attrs, ...children) {
        const el = document.createElement(tag);
        if (attrs) {
            for (const [k, v] of Object.entries(attrs)) {
                if (v === null || v === undefined || v === false) continue;
                if (k === 'class') el.className = v;
                else if (k === 'text') el.textContent = v;
                else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
                else if (k === 'value') el.value = v;
                else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'required' || k === 'open') el[k] = Boolean(v);
                else el.setAttribute(k, v === true ? '' : String(v));
            }
        }
        append(el, children);
        return el;
    }
    function append(el, children) {
        for (const c of children) {
            if (c === null || c === undefined || c === false) continue;
            if (Array.isArray(c)) append(el, c);
            else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
        }
    }
    function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

    const fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');
    function fmtBytes(b) {
        if (typeof b !== 'number') return '—';
        const u = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0;
        while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
        return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
    }
    function fmtDuration(sec) {
        const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
        return d ? `${d}d ${hh}h` : hh ? `${hh}h ${m}m` : `${m}m ${sec % 60}s`;
    }
    function fmtDate(v) {
        if (!v) return '—';
        const d = new Date(v);
        return isNaN(d) ? String(v) : d.toLocaleString();
    }
    function preview(v) {
        if (v === null) return 'null';
        if (v === undefined) return '';
        if (typeof v === 'object') return JSON.stringify(v);
        return String(v);
    }
    const toDateInput = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');

    function toast(message, type = 'info') {
        const t = h('div', { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status' }, message);
        $('#toasts').appendChild(t);
        setTimeout(() => t.remove(), type === 'error' ? 6000 : 3500);
    }

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            toast('Copied', 'ok');
        } catch {
            toast('Copy failed: select the text and copy manually', 'error');
        }
    }

    /**
     * Parses a form value into the column's type. '' → undefined (not set).
     * Throws with a readable message on bad input.
     */
    function parseTyped(raw, type, label) {
        const s = String(raw ?? '').trim();
        if (s === '') return undefined;
        switch (type) {
            case 'integer': {
                const n = Number(s);
                if (!Number.isInteger(n)) throw new Error(`${label}: must be a whole number`);
                return n;
            }
            case 'number': {
                const n = Number(s);
                if (!Number.isFinite(n)) throw new Error(`${label}: must be a number`);
                return n;
            }
            case 'boolean':
                if (/^(true|1|yes)$/i.test(s)) return true;
                if (/^(false|0|no)$/i.test(s)) return false;
                throw new Error(`${label}: must be true or false`);
            case 'date':
                if (isNaN(Date.parse(s))) throw new Error(`${label}: must be a date like 2026-01-31 or an ISO timestamp`);
                return s;
            case 'object':
            case 'array': {
                let v;
                try { v = JSON.parse(s); } catch { throw new Error(`${label}: must be valid JSON`); }
                if (type === 'array' ? !Array.isArray(v) : (v === null || typeof v !== 'object' || Array.isArray(v))) {
                    throw new Error(`${label}: must be a JSON ${type}`);
                }
                return v;
            }
            default:
                return String(raw);
        }
    }

    // ───────────────────────── API ─────────────────────────

    async function api(path, { method = 'GET', body, raw = false } = {}) {
        const headers = {};
        if (state.token) headers.Authorization = `Bearer ${state.token}`;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetch(path, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            credentials: 'same-origin',
            cache: 'no-store',
        });
        if (res.status === 401 && state.user) {
            signOut('Your session expired. Please sign in again.');
            throw new Error('Session expired');
        }
        if (raw) {
            if (!res.ok) throw new Error(`Request failed (${res.status})`);
            return res;
        }
        let data = null;
        try { data = await res.json(); } catch { /* empty body */ }
        if (res.status === 403 && data && data.code === 'MFA_REQUIRED') {
            requireMfaSetup();
            throw new Error(data.message);
        }
        if (!res.ok) throw new Error((data && (data.error === 'Forbidden' && data.message ? data.message : (data.error || data.message))) || `Request failed (${res.status})`);
        return data;
    }

    /** ADMIN_REQUIRE_2FA is on and this session hasn't passed 2FA: only Settings is usable. */
    function requireMfaSetup() {
        if (state.mfaRequired) return;
        state.mfaRequired = true;
        if (location.hash !== '#settings') location.hash = '#settings';
        else route();
    }

    const enc = encodeURIComponent;
    const rackPath = (db, rack) => `/api/databases/${enc(db)}/racks/${enc(rack)}`;

    async function download(path, fallbackName) {
        const res = await api(path, { raw: true });
        const cd = res.headers.get('Content-Disposition') || '';
        const m = /filename="([^"]+)"/.exec(cd);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = h('a', { href: url, download: m ? m[1] : fallbackName });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }

    // ───────────────────────── dialogs ─────────────────────────

    /**
     * Opens the shared <dialog>. An action without onClick simply closes the
     * dialog and resolves with its `value`. An onClick may return false (keep
     * open) or throw (message shown in the dialog). Closing via ×, Escape or
     * the backdrop resolves with null.
     */
    function openDialog({ title, body, actions, wide = false }) {
        const dlg = $('#dialog');
        if (dlg.open) dlg.close();
        clear(dlg);
        dlg.classList.toggle('wide', wide);

        return new Promise((resolve) => {
            let done = false;
            const finish = (value) => {
                if (done) return;
                done = true;
                if (dlg.open) dlg.close();
                resolve(value);
            };

            const errorEl = h('p', { class: 'error', role: 'alert' });
            const buttons = actions.map((a) => h('button', {
                type: 'button',
                class: `btn ${a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger' : ''}`,
                onclick: async (ev) => {
                    errorEl.textContent = '';
                    if (!a.onClick) {
                        finish(a.value === undefined ? null : a.value);
                        return;
                    }
                    const btn = ev.currentTarget;
                    btn.disabled = true;
                    try {
                        const result = await a.onClick();
                        if (result === false) return;
                        finish(result === undefined ? (a.value === undefined ? true : a.value) : result);
                    } catch (err) {
                        errorEl.textContent = err.message;
                    } finally {
                        btn.disabled = false;
                    }
                },
            }, a.label));
            const primary = buttons[actions.findIndex((a) => a.kind === 'primary' || a.kind === 'danger')];

            const form = h('form', {
                method: 'dialog',
                novalidate: true,
                onsubmit: (e) => {
                    e.preventDefault();
                    if (primary) primary.click();
                },
            },
                h('div', { class: 'dialog-head' },
                    h('h2', { text: title }),
                    h('button', { type: 'button', class: 'btn btn-ghost btn-icon', 'aria-label': 'Close', title: 'Close', onclick: () => finish(null) }, '×'),
                ),
                h('div', { class: 'dialog-body' }, body, errorEl),
                h('div', { class: 'dialog-foot' }, buttons),
            );
            dlg.appendChild(form);
            dlg.onclose = () => finish(null);                         // Escape key
            dlg.onclick = (e) => { if (e.target === dlg) finish(null); }; // backdrop
            dlg.showModal();
            const first = dlg.querySelector('.dialog-body input:not([type=checkbox]):not([type=radio]), .dialog-body textarea, .dialog-body select');
            if (first) first.focus();
        });
    }

    function confirmDialog(title, message, { confirmText = 'Confirm', danger = false, typeToConfirm = null } = {}) {
        const input = typeToConfirm ? h('input', { placeholder: typeToConfirm, autocomplete: 'off' }) : null;
        const body = h('div', { class: 'stack' },
            h('p', { text: message }),
            typeToConfirm ? h('label', null, `Type "${typeToConfirm}" to confirm`, input) : null,
        );
        return openDialog({
            title,
            body,
            actions: [
                { label: 'Cancel', value: false },
                {
                    label: confirmText, kind: danger ? 'danger' : 'primary', onClick: () => {
                        if (typeToConfirm && input.value !== typeToConfirm) throw new Error('Confirmation text does not match');
                        return true;
                    },
                },
            ],
        }).then(Boolean);
    }

    function jsonDialog(title, initial, onSave, { allowArray = false } = {}) {
        const ta = h('textarea', { rows: '16', spellcheck: 'false', value: JSON.stringify(initial, null, 2) });
        return openDialog({
            title,
            wide: true,
            body: h('div', null, ta, h('p', { class: 'muted small mt', text: 'JSON object. id and _metadata are managed by the server.' })),
            actions: [
                { label: 'Cancel', value: false },
                {
                    label: 'Save', kind: 'primary', onClick: async () => {
                        let parsed;
                        try { parsed = JSON.parse(ta.value); } catch (e) { throw new Error(`Invalid JSON: ${e.message}`); }
                        const isObj = parsed && typeof parsed === 'object' && !Array.isArray(parsed);
                        if (!isObj && !(allowArray && Array.isArray(parsed))) throw new Error(allowArray ? 'Must be a JSON object or an array of objects' : 'Must be a JSON object');
                        await onSave(parsed);
                        return true;
                    },
                },
            ],
        });
    }

    function showSecret(title, label, secret, extra) {
        return openDialog({
            title,
            body: h('div', { class: 'stack' },
                h('p', { text: label }),
                h('pre', { class: 'secret', text: secret }),
                h('p', { class: 'muted small', text: 'This is the only time it is shown. Copy it now and store it somewhere safe.' }),
                extra || null,
            ),
            actions: [
                { label: 'Copy', onClick: async () => { await copyText(secret); return false; } },
                { label: 'Done', kind: 'primary', value: true },
            ],
        });
    }

    // ───────────────────────── auth ─────────────────────────

    function setToken(token) {
        state.token = token;
        safeSet(sessionStorage, TOKEN_KEY, token);
    }

    function signOut(message) {
        setToken(null);
        state.user = null;
        state.mfaRequired = false;
        state.challenge = null;
        stopTimer();
        if (state.idleTimer) { clearInterval(state.idleTimer); state.idleTimer = null; }
        const dlg = $('#dialog');
        if (dlg.open) dlg.close();
        $('#appView').hidden = true;
        $('#loginView').hidden = false;
        showLoginStep('password');
        $('#loginError').textContent = message || '';
        $('#loginPass').value = '';
        $('#loginUser').focus();
    }

    function showLoginStep(step) {
        $('#loginPasswordStep').hidden = step !== 'password';
        $('#loginCodeStep').hidden = step !== 'code';
        if (step === 'code') { $('#loginCode').value = ''; $('#loginCode').focus(); }
    }

    async function postJson(path, body) {
        const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        return data;
    }

    async function onLogin(e) {
        e.preventDefault();
        const err = $('#loginError');
        err.textContent = '';
        const btn = e.submitter || $('#loginForm button[type=submit]:not([hidden])');
        if (btn) btn.disabled = true;
        try {
            let data;
            if (state.challenge) {
                data = await postJson('/api/auth/login/2fa', { challenge: state.challenge, code: $('#loginCode').value.trim() });
            } else {
                data = await postJson('/api/auth/login', { username: $('#loginUser').value.trim(), password: $('#loginPass').value });
                if (data.twoFactorRequired) {
                    state.challenge = data.challenge;
                    showLoginStep('code');
                    return;
                }
            }
            if (!data.user || data.user.role !== 'admin') throw new Error('This panel requires an administrator account.');
            state.challenge = null;
            setToken(data.token);
            if (data.usedRecoveryCode) setTimeout(() => toast('You signed in with a recovery code. Generate new codes in Settings if you are running low.'), 500);
            await enterApp();
        } catch (ex) {
            err.textContent = ex.message;
            if (/expired/i.test(ex.message)) { state.challenge = null; showLoginStep('password'); }
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async function enterApp() {
        const me = await api('/api/auth/me');
        if (me.role !== 'admin') {
            signOut('This panel requires an administrator account.');
            return;
        }
        state.user = me;
        try { state.uiConfig = await api('/api/admin/ui-config'); } catch { /* keep defaults */ }
        state.mfaRequired = state.uiConfig.require2fa && !state.uiConfig.sessionMfa;
        $('#whoami').textContent = `Signed in as ${me.username}${me.twoFactorEnabled ? ' · 2FA' : ''}`;
        $('#appVersion').textContent = state.uiConfig.version ? `OpenDBS v${state.uiConfig.version}` : '';
        $('#loginView').hidden = true;
        $('#appView').hidden = false;
        startIdleTimer();
        if (state.mfaRequired && location.hash !== '#settings') location.hash = '#settings';
        else route();
    }

    /** Signs out after ADMIN_SESSION_TIMEOUT_MINUTES without keyboard/mouse/touch activity. */
    function startIdleTimer() {
        state.lastActivity = Date.now();
        if (state.idleTimer) clearInterval(state.idleTimer);
        state.idleTimer = setInterval(() => {
            const limit = state.uiConfig.sessionTimeoutMinutes * 60_000;
            if (state.user && Date.now() - state.lastActivity > limit) {
                signOut(`Signed out after ${state.uiConfig.sessionTimeoutMinutes} minutes of inactivity.`);
            }
        }, 15_000);
    }

    // ───────────────────────── routing ─────────────────────────

    const views = {
        overview: viewOverview, data: viewData, sql: viewSql, backups: viewBackups, users: viewUsers, keys: viewKeys,
        audit: viewAudit, cluster: viewCluster, sharding: viewSharding, docs: viewDocs, playground: viewPlayground, speed: viewSpeed, settings: viewSettings,
    };

    function stopTimer() {
        if (state.timer) { clearInterval(state.timer); state.timer = null; }
    }

    function setMenu(open) {
        $('#sidebar').classList.toggle('open', open);
        $('#menuBtn').setAttribute('aria-expanded', String(open));
    }

    function route() {
        if (!state.user) return;
        stopTimer();
        setMenu(false);
        const name = (location.hash || '#overview').slice(1).split('/')[0];
        // With ADMIN_REQUIRE_2FA and no verified second factor, only Settings is reachable.
        const view = state.mfaRequired ? 'settings' : (views[name] ? name : 'overview');
        for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('active', a.dataset.view === view);
        const main = clear($('#main'));
        main.appendChild(h('p', { class: 'muted', text: 'Loading…' }));
        views[view](main).catch((err) => {
            clear(main).appendChild(h('div', { class: 'card' }, h('p', { class: 'error', text: err.message })));
        });
    }

    function pageHead(title, ...actions) {
        return h('div', { class: 'page-head' }, h('h1', { text: title }), h('div', { class: 'spacer' }), actions);
    }

    function kv(k, v) { return [h('dt', { text: k }), h('dd', { text: String(v) })]; }

    // ───────────────────────── overview ─────────────────────────

    async function viewOverview(main) {
        const render = async () => {
            const o = await api('/api/admin/overview');
            const e = o.engine;
            const stat = (label, value, sub) => h('div', { class: 'card' },
                h('div', { class: 'stat-label', text: label }),
                h('div', { class: 'stat-value', text: value }),
                sub ? h('div', { class: 'stat-sub', text: sub }) : null);

            const checks = h('ul', { class: 'checks' }, o.security.checks.map((c) => h('li', null,
                h('span', { class: `badge ${c.ok ? 'badge-ok' : 'badge-warn'}`, text: c.ok ? 'OK' : 'Review' }),
                h('div', null, h('div', { text: c.label }), c.ok ? null : h('div', { class: 'muted small', text: c.hint })),
            )));

            const flushBtn = h('button', {
                class: 'btn', type: 'button', onclick: async () => {
                    try {
                        const r = await api('/api/admin/flush', { method: 'POST' });
                        toast(`Flushed in ${r.ms} ms`, 'ok');
                    } catch (err) { toast(err.message, 'error'); }
                },
            }, 'Flush to disk');

            clear(main).append(
                pageHead('Overview', h('span', { class: 'muted small', text: 'Auto-refreshes every 5s' }), flushBtn),
                h('div', { class: 'grid grid-stats' },
                    stat('Databases', fmtNum(e.databases)),
                    stat('Racks', fmtNum(e.racks)),
                    stat('Documents', fmtNum(e.documents)),
                    stat('Indexes', fmtNum(e.indexes)),
                    stat('Users', fmtNum(o.users.total), `${o.users.admins} admin(s)`),
                    stat('Query cache', `${(e.queryCache.hitRate * 100).toFixed(1)}%`, `${fmtNum(e.queryCache.hits)} hits · ${fmtNum(e.queryCache.entries)} entries`),
                    stat('Heap used', fmtBytes(o.server.memory.heapUsed), `RSS ${fmtBytes(o.server.memory.rss)}`),
                    stat('Uptime', fmtDuration(o.server.uptimeSec), o.server.env),
                ),
                h('div', { class: 'grid grid-2' },
                    h('div', { class: 'card' },
                        h('h2', null, 'Security posture ', h('span', { class: `badge ${o.security.score === o.security.of ? 'badge-ok' : 'badge-warn'}`, text: `${o.security.score}/${o.security.of}` })),
                        checks),
                    h('div', { class: 'card' },
                        h('h2', { text: 'Storage engine' }),
                        h('dl', { class: 'kv' },
                            kv('Engine', e.storage && e.storage.engine === 'disk' ? 'Disk (encrypted B-tree + RAM cache)' : 'In-memory (snapshots + WAL)'),
                            kv('Encryption at rest', e.encryption && e.encryption.enabled ? `${e.encryption.algorithm} (key ${e.encryption.keyFingerprint})` : 'OFF'),
                            kv('Write mode', `${e.persistence.mode}${e.persistence.walFsync ? ' + fsync (group commit)' : ' — no fsync'}`),
                            kv('fsyncs / transactions', `${fmtNum(e.fsyncs)} / ${fmtNum(e.transactions)}`),
                            ...(e.storage && e.storage.engine === 'disk' ? [
                                kv('Data on disk', fmtBytes(e.storage.fileBytes)),
                                kv('RAM cache', `${fmtBytes(e.storage.cache.bytes)} of ${fmtBytes(e.storage.cache.budgetBytes)} · ${(e.storage.cache.hitRate * 100).toFixed(1)}% hits`),
                                kv('Commits', fmtNum(e.storage.commits)),
                                kv('Commit failures', e.storage.commitFailures ? `${fmtNum(e.storage.commitFailures)} — ${e.storage.lastError}` : '0'),
                            ] : [
                                kv('Snapshot debounce', `${e.persistence.debounceMs} ms`),
                                kv('Dirty racks', fmtNum(e.persistence.dirtyRacks)),
                                kv('Pending WAL entries', fmtNum(e.persistence.pendingWalEntries)),
                                kv('Snapshots written', fmtNum(e.persistence.snapshots)),
                                kv('Last snapshot', e.persistence.lastSnapshotAt ? `${fmtDate(e.persistence.lastSnapshotAt)} (${e.persistence.lastSnapshotMs} ms)` : '—'),
                                kv('Snapshot failures', fmtNum(e.persistence.snapshotFailures)),
                            ]),
                            kv('Indexed queries', fmtNum(e.planner.indexedQueries)),
                            kv('Full scans', fmtNum(e.planner.fullScans)),
                            kv('Native search', e.nativeSearch ? 'enabled (Rust)' : 'JS fallback'),
                        )),
                    h('div', { class: 'card' },
                        h('h2', { text: 'Server' }),
                        h('dl', { class: 'kv' },
                            kv('OpenDBS', `v${o.server.version}${o.server.commit ? ` (${o.server.commit})` : ''}`),
                            kv('Built', o.server.builtAt ? fmtDate(o.server.builtAt) : '—'),
                            kv('Node.js', o.server.node),
                            kv('Platform', o.server.platform),
                            kv('CPUs', o.server.cpus),
                            kv('Load avg', o.server.load.map((l) => l.toFixed(2)).join(' / ')),
                            kv('PID', o.server.pid),
                            kv('Engine started', fmtDate(e.startedAt)),
                        )),
                ),
            );
        };
        await render();
        state.timer = setInterval(() => { if (!document.hidden) render().catch(() => undefined); }, 5000);
    }

    // ───────────────────────── shared editors ─────────────────────────

    /** Column definition rows for SQL racks (create rack / add column). */
    function columnBuilder(initial = [{}], { single = false } = {}) {
        const rows = [];
        const list = h('div', { class: 'col-builder' },
            h('div', { class: 'col-row col-head-row' }, ['Column', 'Type', '', '', 'Default (optional)', ''].map((t) => h('span', { class: 'col-head', text: t }))));

        function addRow(c = {}) {
            const name = h('input', { placeholder: 'column_name', value: c.name || '', maxlength: '64', class: 'mono', autocomplete: 'off', 'aria-label': 'Column name' });
            const type = h('select', { 'aria-label': 'Column type' }, COLUMN_TYPES.map((t) => h('option', { value: t, selected: t === (c.type || 'string') }, t)));
            const req = h('input', { type: 'checkbox', checked: c.required });
            const uniq = h('input', { type: 'checkbox', checked: c.unique });
            const def = h('input', {
                placeholder: 'default', 'aria-label': 'Default value',
                value: c.defaultValue === undefined ? '' : (typeof c.defaultValue === 'object' ? JSON.stringify(c.defaultValue) : String(c.defaultValue)),
            });
            const syncDefaultInput = () => {
                const isDate = type.value === 'date';
                if (isDate && !/^\d{4}-\d{2}-\d{2}$/.test(def.value)) def.value = '';
                def.type = isDate ? 'date' : 'text';
            };
            type.addEventListener('change', syncDefaultInput);
            syncDefaultInput();
            const entry = { name, type, req, uniq, def, row: null };
            const rm = single ? h('span') : h('button', {
                type: 'button', class: 'btn btn-ghost btn-sm', title: 'Remove column', 'aria-label': 'Remove column',
                onclick: () => { entry.row.remove(); rows.splice(rows.indexOf(entry), 1); },
            }, '✕');
            entry.row = h('div', { class: 'col-row' }, name, type,
                h('label', { class: 'check' }, req, 'required'),
                h('label', { class: 'check' }, uniq, 'unique'),
                def, rm);
            rows.push(entry);
            list.appendChild(entry.row);
            return entry;
        }
        initial.forEach(addRow);

        return {
            el: h('div', { class: 'stack' }, list,
                single ? null : h('div', null, h('button', { type: 'button', class: 'btn btn-sm', onclick: () => addRow().name.focus() }, '+ Add column'))),
            value() {
                const schema = {};
                for (const r of rows) {
                    const n = r.name.value.trim();
                    if (!n) continue;
                    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(n)) throw new Error(`Invalid column name "${n}" (letters, numbers and _, not starting with a digit)`);
                    if (n === 'id') throw new Error('"id" is reserved — every row gets an id automatically');
                    if (schema[n]) throw new Error(`Duplicate column "${n}"`);
                    const col = { type: r.type.value };
                    if (r.req.checked) col.required = true;
                    if (r.uniq.checked) col.unique = true;
                    const d = parseTyped(r.def.value, col.type, `Default for ${n}`);
                    if (d !== undefined) col.defaultValue = d;
                    schema[n] = col;
                }
                return schema;
            },
        };
    }

    /**
     * Native date picker with an optional time ("+ time" switches to a
     * date-and-time picker). dateValue() returns 'YYYY-MM-DD' for plain dates,
     * a UTC ISO timestamp when a time is set, or '' when empty.
     */
    function datePicker(value) {
        const pad = (n) => String(n).padStart(2, '0');
        let withTime = false;
        let initial = '';
        if (value !== undefined && value !== null && value !== '') {
            const s = String(value);
            if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
                initial = s;
            } else {
                const d = new Date(typeof value === 'number' ? value : s);
                if (!isNaN(d)) {
                    withTime = true;
                    initial = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
                }
            }
        }
        const input = h('input', { type: withTime ? 'datetime-local' : 'date', value: initial });
        const toggle = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', title: 'Include a time of day' }, withTime ? '− time' : '+ time');
        const today = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', title: 'Set to now' }, 'Now');
        const setMode = (timeOn) => {
            const cur = input.value;
            withTime = timeOn;
            input.type = timeOn ? 'datetime-local' : 'date';
            input.value = timeOn ? (cur ? `${cur.slice(0, 10)}T00:00` : '') : cur.slice(0, 10);
            toggle.textContent = timeOn ? '− time' : '+ time';
        };
        toggle.addEventListener('click', () => setMode(!withTime));
        today.addEventListener('click', () => {
            const d = new Date();
            const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
            input.value = withTime ? `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
        });
        const wrap = h('div', { class: 'date-field' }, input, today, toggle);
        // rowForm reads values through this method instead of .value
        wrap.dateValue = () => {
            if (!input.value) return '';
            return withTime ? new Date(input.value).toISOString() : input.value;
        };
        return wrap;
    }

    /** Typed form for one SQL row. */
    function rowForm(schema, values = {}) {
        const inputs = {};
        const grid = h('div', { class: 'form-grid' });
        for (const [col, def] of Object.entries(schema)) {
            const v = values[col];
            let input;
            switch (def.type) {
                case 'boolean':
                    input = h('select', null,
                        h('option', { value: '' }, '— (null)'),
                        h('option', { value: 'true', selected: v === true }, 'true'),
                        h('option', { value: 'false', selected: v === false }, 'false'));
                    break;
                case 'integer':
                    input = h('input', { type: 'number', step: '1', value: v ?? '' });
                    break;
                case 'number':
                    input = h('input', { type: 'number', step: 'any', value: v ?? '' });
                    break;
                case 'object':
                case 'array':
                    input = h('textarea', { rows: '3', spellcheck: 'false', placeholder: def.type === 'array' ? '[ ]' : '{ }', value: v !== undefined && v !== null ? JSON.stringify(v, null, 2) : '' });
                    break;
                case 'date':
                    input = datePicker(v);
                    break;
                default:
                    input = h('input', { value: v ?? '' });
            }
            if (def.defaultValue !== undefined && (v === undefined || v === null)) input.placeholder = `default: ${preview(def.defaultValue)}`;
            inputs[col] = input;
            grid.appendChild(h('label', null,
                h('span', null, col, def.required ? h('span', { class: 'req', text: ' *' }) : null,
                    h('span', { class: 'muted', text: ` ${def.type}${def.unique ? ' · unique' : ''}` })),
                input));
        }
        return {
            el: grid,
            value() {
                const out = {};
                for (const [col, def] of Object.entries(schema)) {
                    const raw = def.type === 'date' ? inputs[col].dateValue() : inputs[col].value;
                    const parsed = parseTyped(raw, def.type, col);
                    if (parsed !== undefined) out[col] = parsed;
                    else if (def.required && def.defaultValue === undefined) throw new Error(`${col} is required`);
                }
                return out;
            },
        };
    }

    /** Per-database permission checkboxes; optional "*" row = every database. */
    function permissionEditor(databases, current = {}, { wildcard = true } = {}) {
        const grid = h('div', { class: 'perm-grid' }, h('strong', { class: 'small', text: 'Database' }),
            PERMS.map((p) => h('strong', { class: 'small', text: p })));
        const boxes = [];
        const dbs = (wildcard ? ['*'] : []).concat(databases.filter((d) => d !== SYSTEM_DB));
        for (const db of dbs) {
            grid.appendChild(db === '*'
                ? h('span', null, h('strong', { text: 'All databases ' }), h('span', { class: 'mono muted', text: '(*)' }))
                : h('span', { class: 'mono', text: db }));
            for (const p of PERMS) {
                const cb = h('input', { type: 'checkbox', checked: (current[db] || []).includes(p), 'aria-label': `${p} on ${db}` });
                cb.dataset.db = db;
                cb.dataset.perm = p;
                boxes.push(cb);
                grid.appendChild(cb);
            }
        }
        if (dbs.length === 0) grid.appendChild(h('span', { class: 'muted small', text: 'No databases yet.' }));
        return {
            el: grid,
            value() {
                const out = {};
                for (const cb of boxes) {
                    if (!cb.checked) continue;
                    (out[cb.dataset.db] = out[cb.dataset.db] || []).push(cb.dataset.perm);
                }
                return out;
            },
        };
    }

    function permSummary(perms) {
        const entries = Object.entries(perms || {});
        if (entries.length === 0) return 'none';
        return entries.map(([db, p]) => `${db === '*' ? 'all databases' : db}: ${p.join('/')}`).join(', ');
    }

    // ───────────────────────── data browser ─────────────────────────

    async function loadDatabases() {
        const data = await api('/api/databases?include_racks=true');
        state.databases = (data.databases || []).sort((a, b) =>
            (a.name === SYSTEM_DB) - (b.name === SYSTEM_DB) || a.name.localeCompare(b.name));
        return state.databases;
    }

    function currentRack() {
        const b = state.browser;
        const db = state.databases.find((d) => d.name === b.db);
        return db && db.racks.find((r) => r.name === b.rack);
    }

    async function viewData(main) {
        await loadDatabases();
        const b = state.browser;
        if (b.db && !state.databases.some((d) => d.name === b.db)) { b.db = null; b.rack = null; }
        if (b.rack && !currentRack()) b.rack = null;

        const tree = h('div', { class: 'card tree' });
        const panel = h('div');

        const newDbBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: createDatabase }, '+ Database');
        clear(main).append(pageHead('Databases', newDbBtn), h('div', { class: 'browser' }, tree, panel));

        renderTree(tree, panel);
        renderPanel(panel, tree);
    }

    function renderTree(tree, panel) {
        clear(tree);
        if (state.databases.length === 0) {
            tree.appendChild(h('p', { class: 'muted small', text: 'No databases yet.' }));
            return;
        }
        const b = state.browser;
        if (b.db && b.rack) state.expanded.add(b.db); // keep the open rack visible
        for (const db of state.databases) {
            const open = state.expanded.has(db.name);
            const wrap = h('div', { class: 'tree-db' },
                h('button', {
                    type: 'button',
                    'aria-expanded': String(open),
                    title: open ? 'Collapse' : 'Show racks',
                    class: b.db === db.name && !b.rack ? 'active' : '',
                    onclick: () => {
                        // Clicking the selected database toggles it; clicking another opens and selects it.
                        if (b.db === db.name && !b.rack && open) state.expanded.delete(db.name);
                        else state.expanded.add(db.name);
                        safeSet(sessionStorage, 'opendbs_admin_tree', JSON.stringify(Array.from(state.expanded)));
                        b.db = db.name; b.rack = null;
                        renderTree(tree, panel); renderPanel(panel, tree);
                    },
                }, h('span', { class: 'caret', text: open ? '▾' : '▸' }), db.name,
                    h('span', { class: 'count', text: String(db.racks.length) }),
                    db.name === SYSTEM_DB ? h('span', { class: 'badge', text: 'system' }) : null),
            );
            if (!open) {
                tree.appendChild(wrap);
                continue;
            }
            if (db.racks.length === 0) wrap.appendChild(h('div', { class: 'tree-empty muted small', text: 'No racks yet' }));
            for (const r of db.racks) {
                wrap.appendChild(h('button', {
                    type: 'button',
                    class: `tree-rack${b.db === db.name && b.rack === r.name ? ' active' : ''}`,
                    title: r.type === 'sql' ? 'SQL rack' : 'NoSQL rack',
                    onclick: () => {
                        b.db = db.name; b.rack = r.name; b.skip = 0; b.sort = null; b.query = ''; b.tab = 'docs';
                        renderTree(tree, panel); renderPanel(panel, tree);
                    },
                }, r.type === 'sql' ? '▦ ' : '{ } ', r.name, h('span', { class: 'count', text: fmtNum(r.count) })));
            }
            tree.appendChild(wrap);
        }
    }

    async function refreshBrowser(panel, tree) {
        await loadDatabases();
        renderTree(tree, panel);
        renderPanel(panel, tree);
    }

    function renderPanel(panel, tree) {
        const b = state.browser;
        clear(panel);
        if (!b.db) {
            panel.appendChild(h('div', { class: 'card empty', text: 'Select a database or rack.' }));
            return;
        }
        if (!b.rack) {
            renderDatabasePanel(panel, tree);
            return;
        }
        renderRackPanel(panel, tree);
    }

    function renderDatabasePanel(panel, tree) {
        const b = state.browser;
        const db = state.databases.find((d) => d.name === b.db);
        const isSystem = db.name === SYSTEM_DB;
        const rows = db.racks.map((r) => h('tr', null,
            h('td', null, h('a', { href: '#data', onclick: (e) => { e.preventDefault(); b.rack = r.name; b.skip = 0; b.tab = 'docs'; renderTree(tree, panel); renderPanel(panel, tree); } }, r.name)),
            h('td', null, h('span', { class: `badge ${r.type === 'sql' ? 'badge-accent' : ''}`, text: r.type === 'sql' ? 'SQL table' : 'NoSQL JSON' })),
            h('td', { class: 'small', text: r.type === 'sql' && r.schema ? `${Object.keys(r.schema).length} column(s)` : '—' }),
            h('td', { class: 'num', text: fmtNum(r.count) }),
            h('td', { class: 'small', text: fmtDate(r.createdAt) }),
        ));
        panel.append(
            h('div', { class: 'page-head' },
                h('h2', { text: db.name }),
                h('div', { class: 'spacer' }),
                isSystem ? null : h('button', { class: 'btn btn-primary', type: 'button', onclick: () => createRack(db.name, panel, tree) }, '+ Rack'),
                isSystem ? null : h('button', { class: 'btn', type: 'button', onclick: () => download(`/api/backup/quick?database=${enc(db.name)}`, `${db.name}.zip`).catch((e) => toast(e.message, 'error')) }, 'Export'),
                isSystem ? null : h('button', { class: 'btn btn-danger', type: 'button', onclick: () => deleteDatabase(db.name, panel, tree) }, 'Delete database'),
            ),
            rows.length
                ? h('div', { class: 'table-wrap' }, h('table', null,
                    h('thead', null, h('tr', null, ['Rack', 'Type', 'Columns', 'Documents', 'Created'].map((t) => h('th', { text: t })))),
                    h('tbody', null, rows)))
                : h('div', { class: 'card empty', text: 'No racks in this database yet.' }),
        );
    }

    function renderRackPanel(panel, tree) {
        const b = state.browser;
        const rack = currentRack();
        const isSql = rack && rack.type === 'sql';
        const isSystem = b.db === SYSTEM_DB;
        if (b.tab === 'schema' && !isSql) b.tab = 'docs';
        const tabBtn = (id, label) => h('button', {
            type: 'button', class: b.tab === id ? 'active' : '',
            onclick: () => { b.tab = id; renderPanel(panel, tree); },
        }, label);

        const body = h('div');
        panel.append(
            h('div', { class: 'page-head' },
                h('h2', null, h('span', { class: 'muted', text: `${b.db} / ` }), b.rack, ' ',
                    h('span', { class: `badge ${isSql ? 'badge-accent' : ''}`, text: isSql ? 'SQL' : 'NoSQL' })),
                h('div', { class: 'spacer' }),
                h('button', { class: 'btn', type: 'button', onclick: () => download(`/api/backup/quick?database=${enc(b.db)}&rack=${enc(b.rack)}`, `${b.rack}.json`).catch((e) => toast(e.message, 'error')) }, 'Export JSON'),
                isSystem ? null : h('button', { class: 'btn btn-danger', type: 'button', onclick: () => clearRack(panel, tree) }, 'Clear'),
                isSystem ? null : h('button', { class: 'btn btn-danger', type: 'button', onclick: () => deleteRack(panel, tree) }, 'Delete rack'),
            ),
            h('div', { class: 'tabs' },
                tabBtn('docs', isSql ? 'Rows' : 'Documents'),
                isSql ? tabBtn('schema', 'Columns') : null,
                tabBtn('indexes', 'Indexes')),
            body,
        );
        const render = b.tab === 'indexes' ? renderIndexes : b.tab === 'schema' ? renderSchema : renderDocuments;
        render(body, panel, tree).catch((err) => {
            clear(body).appendChild(h('p', { class: 'error', text: err.message }));
        });
    }

    async function renderDocuments(body, panel, tree) {
        const b = state.browser;
        const rack = currentRack();
        const schema = rack && rack.type === 'sql' ? rack.schema || {} : null;
        const isSystem = b.db === SYSTEM_DB;

        let docs, total;
        if (schema) {
            // SQL racks are filtered with a SQL WHERE clause, run through the SQL engine.
            const where = b.query.trim();
            if (where.includes(';')) throw new Error('The filter is a WHERE clause only — no semicolons. Use the SQL console for full statements.');
            const order = b.sort && b.sort !== 'updatedAt' ? ` ORDER BY \`${b.sort}\` ${b.order.toUpperCase()}` : '';
            const sql = `SELECT * FROM \`${b.rack}\`${where ? ` WHERE ${where}` : ''}${order} LIMIT ${b.limit} OFFSET ${b.skip}`;
            const res = await api(`/api/sql/${enc(b.db)}/execute`, { method: 'POST', body: { query: sql } });
            docs = res.result || [];
            total = res.total ?? docs.length;
        } else {
            let query = {};
            if (b.query.trim()) {
                try { query = JSON.parse(b.query); } catch { throw new Error('Filter must be valid JSON, e.g. {"age": {"$gt": 30}}'); }
            }
            const res = await api(`${rackPath(b.db, b.rack)}/search`, {
                method: 'POST',
                body: { query, skip: b.skip, limit: b.limit, sort: b.sort ? { field: b.sort, order: b.order } : undefined },
            });
            docs = res.results || [];
            total = res.total ?? docs.length;
        }

        // SQL: declared columns in order. NoSQL: union of keys on this page (bounded).
        let cols;
        if (schema) {
            cols = Object.keys(schema);
        } else {
            cols = [];
            for (const d of docs) {
                for (const k of Object.keys(d)) {
                    if (k === 'id' || k === '_metadata' || cols.includes(k)) continue;
                    if (cols.length < 10) cols.push(k);
                }
            }
        }

        const filterInput = h('input', {
            value: b.query, class: 'mono', spellcheck: 'false',
            placeholder: schema ? "age >= 18 AND name LIKE 'A%'" : '{"status": "active", "age": {"$gte": 18}}',
        });
        const limitSel = h('select', { 'aria-label': 'Page size', onchange: (e) => { b.limit = Number(e.target.value); b.skip = 0; renderPanel(panel, tree); } },
            [10, 25, 50, 100, 250].map((n) => h('option', { value: String(n), selected: n === b.limit }, `${n} / page`)));
        const apply = () => { b.query = filterInput.value; b.skip = 0; renderPanel(panel, tree); };
        filterInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });

        const sortHeader = (field, label, typeHint) => h('th', {
            class: 'sortable',
            onclick: () => {
                if (b.sort === field) b.order = b.order === 'asc' ? 'desc' : 'asc';
                else { b.sort = field; b.order = 'asc'; }
                renderPanel(panel, tree);
            },
        }, label, typeHint ? h('span', { class: 'th-type', text: typeHint }) : null, b.sort === field ? (b.order === 'asc' ? ' ▲' : ' ▼') : '');

        const rows = docs.map((d) => h('tr', null,
            h('td', { class: 'mono', text: d.id }),
            cols.map((c) => h('td', { class: 'cell', title: preview(d[c]).slice(0, 500), text: preview(d[c]) })),
            schema ? null : h('td', { class: 'small muted', text: fmtDate(d._metadata && d._metadata.updatedAt) }),
            h('td', { class: 'actions' },
                h('button', { class: 'btn btn-sm', type: 'button', onclick: () => editDocument(d, schema, panel, tree) }, isSystem ? 'View' : 'Edit'),
                isSystem ? null : h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => deleteDocument(d.id, panel, tree) }, 'Delete'),
            ),
        ));

        const page = Math.floor(b.skip / b.limit) + 1;
        const pages = Math.max(1, Math.ceil(total / b.limit));

        clear(body).append(
            h('div', { class: 'toolbar' },
                h('label', { class: 'grow' }, schema ? 'WHERE (SQL condition)' : 'Filter (JSON query)', filterInput),
                h('button', { class: 'btn', type: 'button', onclick: apply }, 'Apply'),
                b.query ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { b.query = ''; b.skip = 0; renderPanel(panel, tree); } }, 'Reset') : null,
                limitSel,
                schema ? h('button', {
                    class: 'btn', type: 'button', title: 'Open this table in the SQL console',
                    onclick: () => openSqlConsole(b.db, `SELECT * FROM \`${b.rack}\`${b.query.trim() ? ` WHERE ${b.query.trim()}` : ''} LIMIT 50;`),
                }, 'SQL') : null,
                isSystem ? null : h('button', { class: 'btn btn-primary', type: 'button', onclick: () => insertDocument(schema, panel, tree) }, schema ? '+ Row' : '+ Document'),
            ),
            schema ? h('p', { class: 'muted small', text: "Examples: age > 30 · name LIKE 'Pa%' · city IN ('Pune', 'Delhi') · email IS NULL · (age < 18 OR vip = true) AND active = true" }) : null,
            docs.length
                ? h('div', { class: 'table-wrap' }, h('table', null,
                    h('thead', null, h('tr', null,
                        sortHeader('id', 'id'),
                        cols.map((c) => sortHeader(c, c, schema ? schema[c].type : null)),
                        schema ? null : sortHeader('updatedAt', 'updated'), h('th'))),
                    h('tbody', null, rows)))
                : h('div', { class: 'card empty', text: b.query ? 'Nothing matches this filter.' : (schema ? 'This table has no rows yet.' : 'This rack is empty.') }),
            h('div', { class: 'pager' },
                h('span', { class: 'muted small', text: `${fmtNum(total)} ${schema ? 'row' : 'document'}(s) · page ${page} of ${pages}` }),
                h('button', { class: 'btn btn-sm', type: 'button', disabled: b.skip === 0, onclick: () => { b.skip = Math.max(0, b.skip - b.limit); renderPanel(panel, tree); } }, '‹ Prev'),
                h('button', { class: 'btn btn-sm', type: 'button', disabled: b.skip + b.limit >= total, onclick: () => { b.skip += b.limit; renderPanel(panel, tree); } }, 'Next ›'),
            ),
        );
    }

    function stripEnvelope(doc) {
        const { id, _metadata, ...data } = doc;
        return data;
    }

    async function editDocument(doc, schema, panel, tree) {
        const b = state.browser;
        if (b.db === SYSTEM_DB) {
            await openDialog({
                title: `Document ${doc.id}`,
                wide: true,
                body: h('pre', { class: 'code', text: JSON.stringify(doc, null, 2) }),
                actions: [{ label: 'Close', kind: 'primary', value: true }],
            });
            return;
        }
        const save = async (data) => {
            await api(`${rackPath(b.db, b.rack)}/documents/${enc(doc.id)}`, { method: 'PUT', body: data });
        };
        let saved;
        if (schema) {
            const form = rowForm(schema, doc);
            saved = await openDialog({
                title: `Edit row ${doc.id}`,
                wide: true,
                body: form.el,
                actions: [{ label: 'Cancel', value: false }, { label: 'Save', kind: 'primary', onClick: async () => { await save(form.value()); return true; } }],
            });
        } else {
            saved = await jsonDialog(`Edit document ${doc.id}`, stripEnvelope(doc), save);
        }
        if (saved) { toast('Saved', 'ok'); renderPanel(panel, tree); }
    }

    async function insertDocument(schema, panel, tree) {
        const b = state.browser;
        const insert = async (data) => {
            await api(`${rackPath(b.db, b.rack)}/documents`, { method: 'POST', body: data });
        };
        let saved;
        if (schema) {
            const form = rowForm(schema);
            saved = await openDialog({
                title: `New row in ${b.rack}`,
                wide: true,
                body: form.el,
                actions: [{ label: 'Cancel', value: false }, { label: 'Insert', kind: 'primary', onClick: async () => { await insert(form.value()); return true; } }],
            });
        } else {
            saved = await jsonDialog('New document (an array inserts many)', {}, insert, { allowArray: true });
        }
        if (saved) { toast('Inserted', 'ok'); await refreshBrowser(panel, tree); }
    }

    async function deleteDocument(id, panel, tree) {
        const b = state.browser;
        if (!await confirmDialog('Delete', `Delete ${id} from ${b.rack}? This cannot be undone.`, { danger: true, confirmText: 'Delete' })) return;
        try {
            await api(`${rackPath(b.db, b.rack)}/documents/${enc(id)}`, { method: 'DELETE' });
            toast('Deleted', 'ok');
            await refreshBrowser(panel, tree);
        } catch (e) { toast(e.message, 'error'); }
    }

    /** Rename a column, change its type (existing values are converted) or its constraints. */
    async function editColumn(name, def, panel, tree) {
        const b = state.browser;
        const builder = columnBuilder([{ name, ...def }], { single: true });
        const ok = await openDialog({
            title: `Edit column ${name}`,
            wide: true,
            body: h('div', { class: 'stack' }, builder.el,
                h('p', { class: 'muted small', text: 'Changing the type converts every existing value (e.g. "42" → 42). If any row can\'t be converted, nothing is changed and the row is named.' })),
            actions: [
                { label: 'Cancel', value: false },
                {
                    label: 'Save column', kind: 'primary', onClick: async () => {
                        const s = builder.value();
                        const [newName] = Object.keys(s);
                        if (!newName) throw new Error('Column name is required');
                        const next = s[newName];
                        const changes = {
                            type: next.type,
                            required: Boolean(next.required),
                            unique: Boolean(next.unique),
                            defaultValue: next.defaultValue === undefined ? null : next.defaultValue,
                        };
                        if (newName !== name) changes.name = newName;
                        await api(`${rackPath(b.db, b.rack)}/columns/${enc(name)}`, { method: 'PATCH', body: changes });
                        return true;
                    },
                },
            ],
        });
        if (ok) { toast('Column updated', 'ok'); await refreshBrowser(panel, tree); }
    }

    async function renderSchema(body, panel, tree) {
        const b = state.browser;
        const { schema } = await api(`${rackPath(b.db, b.rack)}/schema`);
        const cols = Object.entries(schema || {});

        const addBtn = h('button', {
            class: 'btn btn-primary', type: 'button', onclick: async () => {
                const builder = columnBuilder([{}], { single: true });
                const ok = await openDialog({
                    title: `Add column to ${b.rack}`,
                    wide: true,
                    body: h('div', { class: 'stack' }, builder.el,
                        h('p', { class: 'muted small', text: 'Existing rows get the default value. A required column without a default can only be added to an empty table.' })),
                    actions: [
                        { label: 'Cancel', value: false },
                        {
                            label: 'Add column', kind: 'primary', onClick: async () => {
                                const s = builder.value();
                                const [name] = Object.keys(s);
                                if (!name) throw new Error('Column name is required');
                                await api(`${rackPath(b.db, b.rack)}/columns`, { method: 'POST', body: { name, ...s[name] } });
                                return true;
                            },
                        },
                    ],
                });
                if (ok) { toast('Column added', 'ok'); await refreshBrowser(panel, tree); }
            },
        }, '+ Column');

        clear(body).append(
            h('div', { class: 'toolbar' }, h('p', { class: 'muted small grow', text: 'Every write to this table is checked against these columns. Unknown columns are rejected.' }), addBtn),
            h('div', { class: 'table-wrap' }, h('table', null,
                h('thead', null, h('tr', null, ['Column', 'Type', 'Required', 'Unique', 'Default', ''].map((t) => h('th', { text: t })))),
                h('tbody', null,
                    h('tr', null, h('td', { class: 'mono', text: 'id' }), h('td', { text: 'auto' }), h('td', { text: 'yes' }), h('td', { text: 'yes' }), h('td', { class: 'muted', text: 'assigned' }), h('td')),
                    cols.map(([name, def]) => h('tr', null,
                        h('td', { class: 'mono', text: name }),
                        h('td', null, h('span', { class: 'badge', text: def.type })),
                        h('td', { text: def.required ? 'yes' : '' }),
                        h('td', { text: def.unique ? 'yes' : '' }),
                        h('td', { class: 'mono small', text: def.defaultValue === undefined ? '' : preview(def.defaultValue) }),
                        h('td', { class: 'actions' }, h('button', {
                            class: 'btn btn-sm', type: 'button', onclick: () => editColumn(name, def, panel, tree),
                        }, 'Edit'), h('button', {
                            class: 'btn btn-sm btn-danger', type: 'button', disabled: cols.length <= 1, title: cols.length <= 1 ? 'A table needs at least one column' : '',
                            onclick: async () => {
                                if (!await confirmDialog('Drop column', `Drop "${name}"? Its data is removed from every row.`, { danger: true, confirmText: 'Drop', typeToConfirm: name })) return;
                                try {
                                    await api(`${rackPath(b.db, b.rack)}/columns/${enc(name)}`, { method: 'DELETE' });
                                    toast('Column dropped', 'ok');
                                    await refreshBrowser(panel, tree);
                                } catch (e) { toast(e.message, 'error'); }
                            },
                        }, 'Drop')),
                    ))))),
        );
    }

    async function renderIndexes(body, panel, tree) {
        const b = state.browser;
        const isSystem = b.db === SYSTEM_DB;
        const { indexes } = await api(`/api/admin/databases/${enc(b.db)}/racks/${enc(b.rack)}/indexes`);

        const typeBadge = { hash: 'badge-accent', unique: 'badge-ok', text: 'badge-warn', vector: 'badge-warn' };
        const deletePath = (ix) => {
            const base = rackPath(b.db, b.rack);
            if (ix.type === 'text') return `${base}/text-indexes/${enc(ix.field)}`;
            if (ix.type === 'vector') return `${base}/vector-indexes/${enc(ix.field)}`;
            return `${base}/indexes/${enc(ix.field)}`;
        };

        const field = h('input', { placeholder: 'field, nested.field, or city, age for a compound index', class: 'mono', maxlength: '255' });
        const type = h('select', null,
            h('option', { value: 'hash' }, 'Hash / range (exact, $in, $gt…)'),
            h('option', { value: 'unique' }, 'Unique (enforced)'),
            h('option', { value: 'text' }, 'Full-text (fuzzy)'),
            h('option', { value: 'vector' }, 'Vector (ANN)'));

        const create = async () => {
            const fields = field.value.split(',').map((s) => s.trim()).filter(Boolean);
            if (fields.length === 0) return toast('Field is required', 'error');
            const f = fields.join('+');
            const base = rackPath(b.db, b.rack);
            const t = type.value;
            try {
                if ((t === 'text' || t === 'vector') && fields.length > 1) throw new Error('Text and vector indexes cover one field');
                if (t === 'text') await api(`${base}/text-indexes`, { method: 'POST', body: { field: fields[0] } });
                else if (t === 'vector') await api(`${base}/vector-indexes`, { method: 'POST', body: { field: fields[0] } });
                else await api(`${base}/indexes`, { method: 'POST', body: fields.length > 1 ? { fields, unique: t === 'unique' } : { field: fields[0], unique: t === 'unique' } });
                toast(`Index on ${f} created`, 'ok');
                renderPanel(panel, tree);
            } catch (e) { toast(e.message, 'error'); }
        };

        clear(body).append(
            isSystem ? null : h('div', { class: 'toolbar' },
                h('label', { class: 'grow' }, 'Field', field),
                h('label', null, 'Type', type),
                h('button', { class: 'btn btn-primary', type: 'button', onclick: create }, 'Create index')),
            indexes.length
                ? h('div', { class: 'table-wrap' }, h('table', null,
                    h('thead', null, h('tr', null, ['Field', 'Type', indexes.some((ix) => ix.entries !== undefined) ? 'Entries' : 'Distinct keys', ''].map((t) => h('th', { text: t })))),
                    h('tbody', null, indexes.map((ix) => h('tr', null,
                        h('td', { class: 'mono', text: ix.field }),
                        h('td', null, h('span', { class: `badge ${typeBadge[ix.type] || ''}`, text: ix.type }), ix.fields ? h('span', { class: 'badge', text: 'compound' }) : null),
                        h('td', { class: 'num', text: ix.entries !== undefined ? fmtNum(ix.entries) : ix.distinctKeys !== undefined ? fmtNum(ix.distinctKeys) : '—' }),
                        h('td', { class: 'actions' }, isSystem ? null : h('button', {
                            class: 'btn btn-sm btn-danger', type: 'button', onclick: async () => {
                                if (!await confirmDialog('Drop index', `Drop the ${ix.type} index on "${ix.field}"?`, { danger: true, confirmText: 'Drop' })) return;
                                try { await api(deletePath(ix), { method: 'DELETE' }); toast('Index dropped', 'ok'); renderPanel(panel, tree); } catch (e) { toast(e.message, 'error'); }
                            },
                        }, 'Drop')),
                    )))))
                : h('div', { class: 'card empty', text: 'No indexes. Queries on this rack use full scans.' }),
            h('p', { class: 'muted small mt', text: 'Hash indexes serve equality, $in and range ($gt/$gte/$lt/$lte) queries, including on array elements. Unique indexes also reject duplicate values on write. A compound index ("city, age") serves queries with equality on all its fields and can enforce a unique combination.' }),
        );
    }

    async function createDatabase() {
        const name = h('input', { placeholder: 'my_database', maxlength: '64' });
        const ok = await openDialog({
            title: 'New database',
            body: h('label', null, 'Name (letters, numbers, _ or -)', name),
            actions: [
                { label: 'Cancel', value: false },
                { label: 'Create', kind: 'primary', onClick: async () => { await api('/api/databases', { method: 'POST', body: { name: name.value.trim() } }); return true; } },
            ],
        });
        if (ok) {
            toast('Database created', 'ok');
            state.browser.db = name.value.trim();
            state.browser.rack = null;
            route();
        }
    }

    async function deleteDatabase(name, panel, tree) {
        if (!await confirmDialog('Delete database', `This permanently deletes "${name}" and every rack in it.`, { danger: true, confirmText: 'Delete', typeToConfirm: name })) return;
        try {
            await api(`/api/databases/${enc(name)}`, { method: 'DELETE' });
            toast('Database deleted', 'ok');
            state.browser.db = null;
            await refreshBrowser(panel, tree);
        } catch (e) { toast(e.message, 'error'); }
    }

    async function createRack(db, panel, tree) {
        const name = h('input', { placeholder: 'customers', maxlength: '64' });
        const sqlRadio = h('input', { type: 'radio', name: 'rackType', value: 'sql' });
        const nosqlRadio = h('input', { type: 'radio', name: 'rackType', value: 'nosql', checked: true });
        const builder = columnBuilder([
            { name: 'name', type: 'string', required: true },
            { name: 'email', type: 'string', unique: true },
            { name: 'created_at', type: 'date' },
        ]);
        const sqlSection = h('fieldset', { hidden: true }, h('legend', { text: 'Columns' }),
            h('p', { class: 'muted small', text: 'Define the table. "id" is added automatically. Rows are validated against these types and unknown columns are rejected.' }),
            builder.el);
        const nosqlNote = h('p', { class: 'muted small', text: 'NoSQL racks store free-form JSON documents. No schema needed — any fields, nesting and arrays are allowed.' });
        const sync = () => { sqlSection.hidden = !sqlRadio.checked; nosqlNote.hidden = sqlRadio.checked; };
        sqlRadio.addEventListener('change', sync);
        nosqlRadio.addEventListener('change', sync);

        const ok = await openDialog({
            title: `New rack in ${db}`,
            wide: true,
            body: h('div', { class: 'stack' },
                h('label', null, 'Name (letters, numbers, _ or -)', name),
                h('div', { class: 'choice' },
                    h('label', { class: 'check' }, nosqlRadio, h('span', null, h('strong', { text: 'NoSQL' }), ' — JSON documents')),
                    h('label', { class: 'check' }, sqlRadio, h('span', null, h('strong', { text: 'SQL' }), ' — table with typed columns'))),
                nosqlNote,
                sqlSection),
            actions: [
                { label: 'Cancel', value: false },
                {
                    label: 'Create', kind: 'primary', onClick: async () => {
                        const body = { name: name.value.trim(), type: sqlRadio.checked ? 'sql' : 'nosql' };
                        if (sqlRadio.checked) {
                            body.schema = builder.value();
                            if (Object.keys(body.schema).length === 0) throw new Error('Add at least one column');
                        }
                        await api(`/api/databases/${enc(db)}/racks`, { method: 'POST', body });
                        return true;
                    },
                },
            ],
        });
        if (ok) {
            toast('Rack created', 'ok');
            state.browser.rack = name.value.trim();
            state.browser.tab = 'docs';
            await refreshBrowser(panel, tree);
        }
    }

    async function clearRack(panel, tree) {
        const b = state.browser;
        if (!await confirmDialog('Clear rack', `Delete every document in "${b.rack}"? Columns and indexes are kept.`, { danger: true, confirmText: 'Clear', typeToConfirm: b.rack })) return;
        try {
            await api(`${rackPath(b.db, b.rack)}/clear`, { method: 'DELETE' });
            toast('Rack cleared', 'ok');
            await refreshBrowser(panel, tree);
        } catch (e) { toast(e.message, 'error'); }
    }

    async function deleteRack(panel, tree) {
        const b = state.browser;
        if (!await confirmDialog('Delete rack', `Permanently delete "${b.rack}" and all its data and indexes.`, { danger: true, confirmText: 'Delete', typeToConfirm: b.rack })) return;
        try {
            await api(rackPath(b.db, b.rack), { method: 'DELETE' });
            toast('Rack deleted', 'ok');
            b.rack = null;
            await refreshBrowser(panel, tree);
        } catch (e) { toast(e.message, 'error'); }
    }

    // ───────────────────────── SQL console ─────────────────────────

    function openSqlConsole(db, text) {
        state.sql.db = db;
        state.sql.text = text;
        if (location.hash === '#sql') route();
        else location.hash = '#sql';
    }

    function resultTable(rows, columns) {
        if (!Array.isArray(rows)) return h('pre', { class: 'code', text: JSON.stringify(rows, null, 2) });
        if (rows.length === 0) return h('div', { class: 'card empty', text: 'No rows.' });
        const cols = columns && columns.length ? columns : Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
        return h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, cols.map((c) => h('th', { text: c })))),
            h('tbody', null, rows.map((r) => h('tr', null, cols.map((c) => h('td', { class: 'cell', title: preview(r[c]).slice(0, 500), text: preview(r[c]) })))))));
    }

    async function viewSql(main) {
        const dbs = (await loadDatabases()).map((d) => d.name);
        const sql = state.sql;
        if (!sql.db || !dbs.includes(sql.db)) sql.db = dbs.find((d) => d !== SYSTEM_DB) || dbs[0] || null;

        const dbSel = h('select', { 'aria-label': 'Database' }, dbs.map((d) => h('option', { value: d, selected: d === sql.db }, d)));
        const editor = h('textarea', {
            rows: '10', spellcheck: 'false', class: 'sql-editor', 'aria-label': 'SQL',
            placeholder: 'SELECT * FROM customers WHERE age >= 18 ORDER BY name LIMIT 20;',
            value: sql.text || 'SHOW TABLES;',
        });
        const runBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Run  (Ctrl+Enter)');
        const out = h('div', { class: 'stack' });
        const historyBox = h('div', { class: 'stack' });

        const renderHistory = () => {
            clear(historyBox);
            if (sql.history.length === 0) { historyBox.appendChild(h('p', { class: 'muted small', text: 'Queries you run appear here.' })); return; }
            for (const item of sql.history) {
                historyBox.appendChild(h('button', {
                    type: 'button', class: 'history-item mono', title: `${item.db}: ${item.text}`,
                    onclick: () => { editor.value = item.text; dbSel.value = item.db; editor.focus(); },
                }, h('span', { class: 'muted', text: `${item.db} › ` }), item.text.replace(/\s+/g, ' ').slice(0, 90)));
            }
        };

        const run = async () => {
            const text = editor.value.trim();
            if (!text) return;
            sql.db = dbSel.value;
            sql.text = text;
            runBtn.disabled = true;
            const started = performance.now();
            try {
                const res = await api(`/api/sql/${enc(sql.db)}/execute`, { method: 'POST', body: { query: text } });
                const ms = Math.round(performance.now() - started);
                clear(out);
                for (const [i, r] of res.results.entries()) {
                    const isRows = Array.isArray(r.result);
                    out.appendChild(h('div', { class: 'card stack' },
                        h('div', { class: 'status-line' },
                            h('span', { class: 'badge badge-accent', text: r.statement.replace('_', ' ').toUpperCase() }),
                            res.results.length > 1 ? h('span', { class: 'muted small', text: `#${i + 1}` }) : null,
                            h('span', { class: 'muted small', text: isRows ? `${fmtNum(r.rowCount)} row(s)${r.total !== undefined && r.total !== r.rowCount ? ` of ${fmtNum(r.total)}` : ''}` : `${fmtNum(r.rowCount)} affected` }),
                            h('span', { class: 'muted small', text: `${r.ms} ms` }),
                            r.truncated ? h('span', { class: 'badge badge-warn', text: 'truncated — add LIMIT' }) : null,
                            h('div', { class: 'spacer' }),
                            isRows && r.result.length ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyText(JSON.stringify(r.result, null, 2)) }, 'Copy JSON') : null),
                        isRows ? resultTable(r.result, r.columns) : h('pre', { class: 'code', text: JSON.stringify(r.result, null, 2) })));
                }
                out.appendChild(h('p', { class: 'muted small', text: `Completed in ${ms} ms (round trip).` }));
                sql.history = [{ db: sql.db, text }, ...sql.history.filter((x) => x.text !== text || x.db !== sql.db)].slice(0, 25);
                safeSet(sessionStorage, 'opendbs_admin_sql_history', JSON.stringify(sql.history));
                renderHistory();
                // Schema-changing statements: refresh the cached rack list.
                if (/\b(create|drop|alter|truncate)\b/i.test(text)) loadDatabases().catch(() => undefined);
            } catch (e) {
                clear(out).appendChild(h('div', { class: 'card' }, h('p', { class: 'error', text: e.message })));
            } finally {
                runBtn.disabled = false;
            }
        };
        runBtn.addEventListener('click', run);
        editor.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
        });
        editor.addEventListener('input', () => { sql.text = editor.value; });

        const examples = [
            ['Tables', 'SHOW TABLES;'],
            ['Describe', 'DESCRIBE customers;'],
            ['Select', "SELECT id, name, email FROM customers\nWHERE age BETWEEN 18 AND 60 AND name LIKE 'A%'\nORDER BY name ASC\nLIMIT 20;"],
            ['Count', "SELECT COUNT(*) FROM customers WHERE active = true;"],
            ['Join', "SELECT c.name, o.total, o.status\nFROM customers c\nJOIN orders o ON o.customer_id = c.id\nWHERE o.total > 20\nORDER BY o.total DESC\nLIMIT 50;"],
            ['Group by', "SELECT c.name, COUNT(*) AS orders, SUM(o.total) AS spent\nFROM customers c\nLEFT JOIN orders o ON o.customer_id = c.id\nGROUP BY c.name\nHAVING COUNT(*) > 1\nORDER BY spent DESC;"],
            ['Transaction', "BEGIN;\nINSERT INTO orders (customer_id, total) VALUES ('1', 40);\nUPDATE customers SET active = true WHERE id = 1;\nCOMMIT;"],
            ['Create', "CREATE TABLE customers (\n  name VARCHAR(100) NOT NULL,\n  email VARCHAR(200) NOT NULL UNIQUE,\n  age INT,\n  active BOOLEAN DEFAULT true,\n  joined DATE\n);"],
            ['Insert', "INSERT INTO customers (name, email, age, joined) VALUES\n  ('Asha', 'asha@example.com', 31, '2026-01-15'),\n  ('Ravi', 'ravi@example.com', 27, '2026-02-01');"],
            ['Update', "UPDATE customers SET active = false WHERE age < 18;"],
            ['Alter', "ALTER TABLE customers ADD COLUMN city VARCHAR(80) DEFAULT 'Pune';\nALTER TABLE customers RENAME COLUMN city TO town;\nALTER TABLE customers MODIFY COLUMN age DECIMAL(5,1);"],
            ['Delete', "DELETE FROM customers WHERE email IS NULL;"],
        ];

        clear(main).append(
            pageHead('SQL console', h('label', { class: 'row gap-s' }, h('span', { class: 'muted small', text: 'Database' }), dbSel)),
            h('div', { class: 'sql-grid' },
                h('div', { class: 'stack' },
                    h('div', { class: 'card stack' },
                        editor,
                        h('div', { class: 'row gap wrap' }, runBtn,
                            h('span', { class: 'muted small', text: 'Examples:' }),
                            examples.map(([label, text]) => h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { editor.value = text; sql.text = text; editor.focus(); } }, label))),
                        h('p', { class: 'muted small', text: 'Separate statements with ;. JOIN (INNER/LEFT), GROUP BY, HAVING, COUNT/SUM/AVG/MIN/MAX and DISTINCT work on SQL and NoSQL racks. BEGIN … COMMIT makes statements all-or-nothing; each INSERT/UPDATE/DELETE is atomic on its own anyway. UPDATE and DELETE need a WHERE clause.' })),
                    out),
                h('div', { class: 'card stack' }, h('h3', { text: 'History' }), historyBox)),
        );
        renderHistory();
        editor.focus();
    }

    // ───────────────────────── users ─────────────────────────

    async function viewUsers(main) {
        const [{ users }, dbs] = await Promise.all([api('/api/auth/users'), loadDatabases()]);
        const dbNames = dbs.map((d) => d.name);

        const rows = users.map((u) => h('tr', null,
            h('td', { class: 'mono', text: u.id }),
            h('td', null, u.username, u.id === state.user.id ? h('span', { class: 'badge', text: 'you' }) : null),
            h('td', null, h('span', { class: `badge ${u.role === 'admin' ? 'badge-accent' : ''}`, text: u.role })),
            h('td', { class: 'small', text: u.role === 'admin' ? 'all databases' : permSummary(u.permissions) }),
            h('td', null, h('span', { class: `badge ${u.twoFactorEnabled ? 'badge-ok' : (u.role === 'admin' ? 'badge-warn' : '')}`, text: u.twoFactorEnabled ? 'on' : 'off' })),
            h('td', { class: 'small muted', text: fmtDate(u.lastLoginAt) }),
            h('td', { class: 'actions' },
                h('button', { class: 'btn btn-sm', type: 'button', onclick: () => editUser(u, dbNames) }, 'Edit'),
                u.id === state.user.id ? null : h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => deleteUser(u) }, 'Delete'),
            ),
        ));

        clear(main).append(
            pageHead('Users', h('button', { class: 'btn btn-primary', type: 'button', onclick: () => createUser(dbNames) }, '+ User')),
            h('div', { class: 'table-wrap' }, h('table', null,
                h('thead', null, h('tr', null, ['ID', 'Username', 'Role', 'Permissions', '2FA', 'Last login', ''].map((t) => h('th', { text: t })))),
                h('tbody', null, rows))),
        );
    }

    async function createUser(dbNames) {
        const username = h('input', { maxlength: '32', autocomplete: 'off' });
        const password = h('input', { type: 'password', autocomplete: 'new-password', maxlength: '72' });
        const role = h('select', null, h('option', { value: 'user' }, 'user'), h('option', { value: 'admin' }, 'admin'));
        const perms = permissionEditor(dbNames);
        let created = null;
        const ok = await openDialog({
            title: 'New user',
            wide: true,
            body: h('div', { class: 'stack' },
                h('div', { class: 'form-grid' },
                    h('label', null, 'Username (3–32: letters, numbers, _)', username),
                    h('label', null, 'Password (8+ chars, a letter and a digit)', password),
                    h('label', null, 'Role', role)),
                h('fieldset', null, h('legend', { text: 'Database permissions (ignored for admins)' }), perms.el)),
            actions: [
                { label: 'Cancel', value: false },
                {
                    label: 'Create', kind: 'primary', onClick: async () => {
                        created = await api('/api/auth/register', {
                            method: 'POST',
                            body: { username: username.value.trim(), password: password.value, role: role.value, permissions: perms.value() },
                        });
                        return true;
                    },
                },
            ],
        });
        if (ok && created) {
            await showSecret('User created', `Personal API key for ${created.user.username}:`, created.user.apiKey);
            route();
        }
    }

    async function editUser(u, dbNames) {
        const role = h('select', null,
            h('option', { value: 'user', selected: u.role === 'user' }, 'user'),
            h('option', { value: 'admin', selected: u.role === 'admin' }, 'admin'));
        const password = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'leave blank to keep current', maxlength: '72' });
        const perms = permissionEditor(dbNames, u.permissions || {});
        const reset2fa = u.twoFactorEnabled && u.id !== state.user.id ? h('div', { class: 'row gap' },
            h('span', { class: 'badge badge-ok', text: '2FA on' }),
            h('button', {
                type: 'button', class: 'btn btn-sm btn-danger', onclick: async (e) => {
                    const btn = e.currentTarget;
                    try {
                        await api(`/api/auth/users/${enc(u.id)}`, { method: 'PATCH', body: { resetTwoFactor: true } });
                        btn.replaceWith(h('span', { class: 'muted small', text: '2FA reset — the user is signed out and can set it up again.' }));
                    } catch (err) { toast(err.message, 'error'); }
                },
            }, 'Reset 2FA (lost device)')) : null;
        const ok = await openDialog({
            title: `Edit ${u.username}`,
            wide: true,
            body: h('div', { class: 'stack' },
                h('div', { class: 'form-grid' },
                    h('label', null, 'Role', role),
                    h('label', null, 'New password (signs the user out everywhere)', password)),
                reset2fa,
                h('fieldset', null, h('legend', { text: 'Database permissions (ignored for admins)' }), perms.el)),
            actions: [
                { label: 'Cancel', value: false },
                {
                    label: 'Save', kind: 'primary', onClick: async () => {
                        const body = { role: role.value, permissions: perms.value() };
                        if (password.value) body.password = password.value;
                        await api(`/api/auth/users/${enc(u.id)}`, { method: 'PATCH', body });
                        return true;
                    },
                },
            ],
        });
        if (ok) { toast('User updated', 'ok'); route(); }
    }

    async function deleteUser(u) {
        if (!await confirmDialog('Delete user', `Delete "${u.username}"? Their API key and sessions stop working immediately.`, { danger: true, confirmText: 'Delete', typeToConfirm: u.username })) return;
        try {
            await api(`/api/auth/users/${enc(u.id)}`, { method: 'DELETE' });
            toast('User deleted', 'ok');
            route();
        } catch (e) { toast(e.message, 'error'); }
    }

    // ───────────────────────── API access keys ─────────────────────────

    function keyStatus(k) {
        if (!k.enabled) return ['disabled', 'badge-danger'];
        if (k.expiresAt && k.expiresAt <= Date.now()) return ['expired', 'badge-danger'];
        return ['active', 'badge-ok'];
    }

    async function viewKeys(main) {
        const [{ keys }, dbs] = await Promise.all([api('/api/admin/access-keys'), loadDatabases()]);
        const dbNames = dbs.map((d) => d.name);

        const rows = keys.map((k) => {
            const [status, cls] = keyStatus(k);
            const anywhere = k.allowedIps.includes('*');
            return h('tr', null,
                h('td', null, h('strong', { text: k.name }), k.description ? h('div', { class: 'muted small', text: k.description }) : null),
                h('td', { class: 'mono small', text: `${k.prefix}…` }),
                h('td', { class: 'small', text: permSummary(k.permissions) }),
                h('td', null, anywhere
                    ? h('span', { class: 'badge badge-warn', text: 'anywhere (*)' })
                    : k.allowedIps.slice(0, 4).map((ip) => h('span', { class: 'badge mono', text: ip })),
                    !anywhere && k.allowedIps.length > 4 ? h('span', { class: 'muted small', text: `+${k.allowedIps.length - 4}` }) : null),
                h('td', null, h('span', { class: `badge ${cls}`, text: status }),
                    k.expiresAt ? h('div', { class: 'muted small', text: `expires ${toDateInput(k.expiresAt)}` }) : null),
                h('td', { class: 'small' }, k.lastUsedAt ? [fmtDate(k.lastUsedAt), h('div', { class: 'muted mono', text: `${k.lastUsedIp || ''} · ${fmtNum(k.useCount || 0)} req` })] : h('span', { class: 'muted', text: 'never' })),
                h('td', { class: 'actions' },
                    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => editKey(k, dbNames) }, 'Edit'),
                    h('button', {
                        class: 'btn btn-sm', type: 'button', onclick: async () => {
                            try {
                                await api(`/api/admin/access-keys/${enc(k.id)}`, { method: 'PATCH', body: { enabled: !k.enabled } });
                                toast(k.enabled ? 'Key disabled' : 'Key enabled', 'ok');
                                route();
                            } catch (e) { toast(e.message, 'error'); }
                        },
                    }, k.enabled ? 'Disable' : 'Enable'),
                    h('button', {
                        class: 'btn btn-sm', type: 'button', onclick: async () => {
                            if (!await confirmDialog('Rotate key', `Issue a new secret for "${k.name}"? The current key stops working immediately.`, { confirmText: 'Rotate' })) return;
                            try {
                                const r = await api(`/api/admin/access-keys/${enc(k.id)}/rotate`, { method: 'POST' });
                                await showSecret('Key rotated', `New key for ${k.name}:`, r.key, usageSnippet(r.key));
                                route();
                            } catch (e) { toast(e.message, 'error'); }
                        },
                    }, 'Rotate'),
                    h('button', {
                        class: 'btn btn-sm btn-danger', type: 'button', onclick: async () => {
                            if (!await confirmDialog('Delete key', `Delete "${k.name}"? Apps using it lose access immediately.`, { danger: true, confirmText: 'Delete', typeToConfirm: k.name })) return;
                            try { await api(`/api/admin/access-keys/${enc(k.id)}`, { method: 'DELETE' }); toast('Key deleted', 'ok'); route(); } catch (e) { toast(e.message, 'error'); }
                        },
                    }, 'Delete')),
            );
        });

        clear(main).append(
            pageHead('API keys', h('button', { class: 'btn btn-primary', type: 'button', onclick: () => editKey(null, dbNames) }, '+ API key')),
            h('p', { class: 'muted' }, 'Access keys give apps and services API access without a user account. Each key has its own database permissions and an IP allow-list. Send it as the ',
                h('code', { class: 'mono', text: 'X-Api-Key' }), ' header.'),
            rows.length
                ? h('div', { class: 'table-wrap' }, h('table', null,
                    h('thead', null, h('tr', null, ['Name', 'Key', 'Database access', 'Allowed IPs', 'Status', 'Last used', ''].map((t) => h('th', { text: t })))),
                    h('tbody', null, rows)))
                : h('div', { class: 'card empty', text: 'No API keys yet. Create one to give an app scoped access.' }),
        );
    }

    function usageSnippet(key) {
        const curl = `curl ${location.origin}/api/databases \\\n  -H "X-Api-Key: ${key}"`;
        return h('div', null, h('p', { class: 'small muted', text: 'Example:' }), h('pre', { class: 'code', text: curl }));
    }

    async function editKey(k, dbNames) {
        const isNew = !k;
        const name = h('input', { value: k ? k.name : '', maxlength: '64', placeholder: 'mobile-app' });
        const description = h('input', { value: (k && k.description) || '', maxlength: '300', placeholder: 'What uses this key (optional)' });
        const perms = permissionEditor(dbNames, k ? k.permissions : {});

        const anywhereNow = !k || k.allowedIps.includes('*');
        const anyRadio = h('input', { type: 'radio', name: 'ipMode', checked: anywhereNow });
        const listRadio = h('input', { type: 'radio', name: 'ipMode', checked: !anywhereNow });
        const ips = h('textarea', { rows: '4', class: 'mono', placeholder: '203.0.113.10\n10.0.0.0/8\n2001:db8::/32', value: anywhereNow ? '' : k.allowedIps.join('\n') });
        const myIpBtn = h('button', {
            type: 'button', class: 'btn btn-sm', onclick: async () => {
                try {
                    const { ip, trustProxy } = await api('/api/admin/my-ip');
                    listRadio.checked = true;
                    syncIp();
                    const lines = ips.value.split('\n').map((s) => s.trim()).filter(Boolean);
                    if (!lines.includes(ip)) lines.push(ip);
                    ips.value = lines.join('\n');
                    if (!trustProxy) toast('Tip: behind a reverse proxy, set TRUST_PROXY=true so real client IPs are seen');
                } catch (e) { toast(e.message, 'error'); }
            },
        }, '+ Add my IP');
        const syncIp = () => { ips.disabled = anyRadio.checked; };
        anyRadio.addEventListener('change', syncIp);
        listRadio.addEventListener('change', syncIp);
        syncIp();

        const expires = h('input', { type: 'date', value: k ? toDateInput(k.expiresAt) : '', min: toDateInput(Date.now() + 86_400_000) });
        const enabled = h('input', { type: 'checkbox', checked: k ? k.enabled : true });

        let result = null;
        const ok = await openDialog({
            title: isNew ? 'New API key' : `Edit ${k.name}`,
            wide: true,
            body: h('div', { class: 'stack' },
                h('div', { class: 'form-grid' },
                    h('label', null, 'Name', name),
                    h('label', null, 'Description', description)),
                h('fieldset', null, h('legend', { text: 'Database access' }),
                    h('p', { class: 'muted small', text: '"All databases (*)" also covers databases created later. A key with write on * may create databases.' }),
                    perms.el),
                h('fieldset', null, h('legend', { text: 'IP access' }),
                    h('div', { class: 'stack' },
                        h('label', { class: 'check' }, anyRadio, h('span', null, h('strong', { text: 'Allow from anywhere (*)' }), ' — public; anyone holding the key can use it')),
                        h('label', { class: 'check' }, listRadio, h('strong', { text: 'Only from these IPs / CIDR ranges' })),
                        ips,
                        h('div', { class: 'row gap' }, myIpBtn, h('span', { class: 'muted small', text: 'One per line. IPv4, IPv6 and CIDR (10.0.0.0/8) supported.' })))),
                h('div', { class: 'form-grid' },
                    h('label', null, 'Expires on (optional)', expires),
                    isNew ? null : h('label', { class: 'check' }, enabled, 'Enabled')),
            ),
            actions: [
                { label: 'Cancel', value: false },
                {
                    label: isNew ? 'Create key' : 'Save', kind: 'primary', onClick: async () => {
                        const allowedIps = anyRadio.checked ? ['*'] : ips.value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
                        if (!anyRadio.checked && allowedIps.length === 0) throw new Error('Add at least one IP, or choose "Allow from anywhere"');
                        const body = { name: name.value.trim(), description: description.value.trim(), permissions: perms.value(), allowedIps };
                        if (Object.keys(body.permissions).length === 0) throw new Error('Grant at least one permission');
                        const expVal = expires.value ? `${expires.value}T23:59:59` : null;
                        if (isNew || expires.value !== toDateInput(k.expiresAt)) body.expiresAt = expVal;
                        if (isNew) {
                            result = await api('/api/admin/access-keys', { method: 'POST', body });
                        } else {
                            body.enabled = enabled.checked;
                            await api(`/api/admin/access-keys/${enc(k.id)}`, { method: 'PATCH', body });
                        }
                        return true;
                    },
                },
            ],
        });
        if (!ok) return;
        if (result) await showSecret('API key created', `Key for ${result.record.name}:`, result.key, usageSnippet(result.key));
        else toast('API key updated', 'ok');
        route();
    }

    // ───────────────────────── backups ─────────────────────────

    const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    /** Friendly schedule editor that produces a cron expression. */
    function schedulePicker(cronExpr) {
        const pad = (n) => String(n).padStart(2, '0');
        let mode = 'custom', time = '02:00', day = '0';
        let m;
        if (cronExpr === '0 * * * *') mode = 'hourly';
        else if (cronExpr === '0 */6 * * *') mode = 'every6';
        else if (cronExpr === '0 */12 * * *') mode = 'every12';
        else if ((m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cronExpr))) { mode = 'daily'; time = `${pad(m[2])}:${pad(m[1])}`; }
        else if ((m = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/.exec(cronExpr))) { mode = 'weekly'; time = `${pad(m[2])}:${pad(m[1])}`; day = m[3]; }

        const modeSel = h('select', { 'aria-label': 'Frequency' },
            [['hourly', 'Every hour'], ['every6', 'Every 6 hours'], ['every12', 'Every 12 hours'], ['daily', 'Every day at…'], ['weekly', 'Every week on…'], ['custom', 'Custom (cron)']]
                .map(([v, l]) => h('option', { value: v, selected: v === mode }, l)));
        const timeIn = h('input', { type: 'time', value: time, 'aria-label': 'Time' });
        const daySel = h('select', { 'aria-label': 'Day' }, DAYS.map((d, i) => h('option', { value: String(i), selected: String(i) === day }, d)));
        const cronIn = h('input', { class: 'mono', value: cronExpr, placeholder: '0 2 * * *', 'aria-label': 'Cron expression' });
        const hint = h('span', { class: 'muted small' });

        const compute = () => {
            const [hh, mm] = (timeIn.value || '02:00').split(':').map(Number);
            switch (modeSel.value) {
                case 'hourly': return '0 * * * *';
                case 'every6': return '0 */6 * * *';
                case 'every12': return '0 */12 * * *';
                case 'daily': return `${mm} ${hh} * * *`;
                case 'weekly': return `${mm} ${hh} * * ${daySel.value}`;
                default: return cronIn.value.trim();
            }
        };
        const sync = () => {
            const v = modeSel.value;
            timeIn.hidden = !(v === 'daily' || v === 'weekly');
            daySel.hidden = v !== 'weekly';
            cronIn.hidden = v !== 'custom';
            hint.textContent = v === 'custom' ? 'minute hour day-of-month month day-of-week — e.g. 30 1 * * 1-5 = weekdays 01:30' : `cron: ${compute()} (server time)`;
        };
        [modeSel, timeIn, daySel, cronIn].forEach((el) => { el.addEventListener('change', sync); el.addEventListener('input', sync); });
        sync();
        return { el: h('div', { class: 'stack' }, h('div', { class: 'row gap wrap' }, modeSel, daySel, timeIn, cronIn), hint), value: compute };
    }

    async function viewBackups(main) {
        const [{ backups }, bc] = await Promise.all([api('/api/backup/list'), api('/api/admin/backup-config')]);
        const cfg = bc.config;
        const status = bc.status;

        const runBtn = h('button', {
            class: 'btn btn-primary', type: 'button', onclick: async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                btn.textContent = 'Backing up…';
                try {
                    const r = await api('/api/admin/backup/run', { method: 'POST' });
                    toast(`Backup ${r.backupName} created${cfg.type !== 'local' ? ` and uploaded to ${cfg.type.toUpperCase()}` : ''}`, 'ok');
                    route();
                } catch (err) { toast(err.message, 'error'); btn.disabled = false; btn.textContent = 'Back up now'; }
            },
        }, 'Back up now');

        // ── settings form ──
        const enabled = h('input', { type: 'checkbox', checked: cfg.enabled });
        const schedule = schedulePicker(cfg.schedule);
        const retention = h('input', { type: 'number', min: '1', max: '3650', step: '1', value: cfg.retentionDays });
        const typeRadios = ['local', 's3', 'ftp'].map((t) => h('input', { type: 'radio', name: 'bkType', value: t, checked: cfg.type === t }));
        const s3 = cfg.s3 || {};
        const ftp = cfg.ftp || {};
        const f = {
            bucket: h('input', { value: s3.bucket || '', placeholder: 'my-backups' }),
            region: h('input', { value: s3.region || 'us-east-1' }),
            accessKey: h('input', { value: s3.accessKey || '', autocomplete: 'off' }),
            secretKey: h('input', { type: 'password', value: s3.secretKey || '', autocomplete: 'new-password', placeholder: s3.secretKey ? 'saved — leave as is' : '' }),
            endpoint: h('input', { value: s3.endpoint || '', placeholder: 'optional — https://<account>.r2.cloudflarestorage.com' }),
            prefix: h('input', { value: s3.prefix || 'backups' }),
            pathStyle: h('input', { type: 'checkbox', checked: s3.forcePathStyle }),
            host: h('input', { value: ftp.host || '', placeholder: 'ftp.example.com' }),
            port: h('input', { type: 'number', value: ftp.port || 21, min: '1', max: '65535' }),
            user: h('input', { value: ftp.user || '', autocomplete: 'off' }),
            password: h('input', { type: 'password', value: ftp.password || '', autocomplete: 'new-password', placeholder: ftp.password ? 'saved — leave as is' : '' }),
            secure: h('input', { type: 'checkbox', checked: ftp.secure }),
            dir: h('input', { value: ftp.dir || '/backups' }),
        };
        const s3Box = h('fieldset', null, h('legend', { text: 'Amazon S3 or S3-compatible (R2, MinIO, Backblaze, Spaces…)' }),
            h('div', { class: 'form-grid' },
                h('label', null, 'Bucket', f.bucket), h('label', null, 'Region', f.region),
                h('label', null, 'Access key ID', f.accessKey), h('label', null, 'Secret access key', f.secretKey),
                h('label', null, 'Endpoint URL', f.endpoint), h('label', null, 'Folder (prefix)', f.prefix)),
            h('label', { class: 'check mt' }, f.pathStyle, 'Path-style URLs (needed by MinIO and some providers)'));
        const ftpBox = h('fieldset', null, h('legend', { text: 'FTP / FTPS server' }),
            h('div', { class: 'form-grid' },
                h('label', null, 'Host', f.host), h('label', null, 'Port', f.port),
                h('label', null, 'Username', f.user), h('label', null, 'Password', f.password),
                h('label', null, 'Remote folder', f.dir)),
            h('label', { class: 'check mt' }, f.secure, 'Use FTPS (TLS encryption) — recommended'));
        const syncType = () => {
            const t = typeRadios.find((r) => r.checked).value;
            s3Box.hidden = t !== 's3';
            ftpBox.hidden = t !== 'ftp';
        };
        typeRadios.forEach((r) => r.addEventListener('change', syncType));
        syncType();

        const collect = () => {
            const type = typeRadios.find((r) => r.checked).value;
            const body = { enabled: enabled.checked, schedule: schedule.value(), retentionDays: Number(retention.value), type };
            if (type === 's3' || cfg.s3) {
                body.s3 = { bucket: f.bucket.value, region: f.region.value, accessKey: f.accessKey.value, secretKey: f.secretKey.value, endpoint: f.endpoint.value, prefix: f.prefix.value, forcePathStyle: f.pathStyle.checked };
            }
            if (type === 'ftp' || cfg.ftp) {
                body.ftp = { host: f.host.value, port: f.port.value, user: f.user.value, password: f.password.value, secure: f.secure.checked, dir: f.dir.value };
            }
            return body;
        };
        const testResult = h('span', { class: 'small' });
        const testBtn = h('button', {
            class: 'btn', type: 'button', onclick: async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                testResult.textContent = 'Testing…';
                testResult.className = 'small muted';
                try {
                    const r = await api('/api/admin/backup-config/test', { method: 'POST', body: collect() });
                    testResult.textContent = `✓ ${r.message}`;
                    testResult.className = 'small ok-text';
                } catch (err) {
                    testResult.textContent = `✗ ${err.message}`;
                    testResult.className = 'small error';
                } finally { btn.disabled = false; }
            },
        }, 'Test destination');
        const saveBtn = h('button', {
            class: 'btn btn-primary', type: 'button', onclick: async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                try {
                    await api('/api/admin/backup-config', { method: 'PUT', body: collect() });
                    toast('Backup settings saved and applied', 'ok');
                    route();
                } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
            },
        }, 'Save settings');

        const last = status.lastRun;
        const settingsCard = h('div', { class: 'card stack' },
            h('h2', { text: 'Automatic backups' }),
            h('div', { class: 'row gap wrap' },
                h('span', { class: `badge ${cfg.enabled ? 'badge-ok' : 'badge-warn'}`, text: cfg.enabled ? 'on' : 'off' }),
                h('span', { class: 'small muted', text: status.nextRun ? `Next run: ${fmtDate(status.nextRun)}` : 'Not scheduled' }),
                last ? h('span', { class: `small ${last.ok ? 'muted' : 'error'}`, text: `Last run: ${fmtDate(last.at)} — ${last.ok ? last.backupName : `failed: ${last.error}`}` }) : null),
            h('label', { class: 'check' }, enabled, h('strong', { text: 'Run backups automatically' })),
            h('div', { class: 'form-grid' },
                h('div', null, h('div', { class: 'small muted', text: 'Schedule' }), schedule.el),
                h('label', null, 'Keep local backups for (days)', retention)),
            h('div', null, h('div', { class: 'small muted', text: 'Destination' }),
                h('div', { class: 'choice' },
                    h('label', { class: 'check' }, typeRadios[0], 'This server only (local folder)'),
                    h('label', { class: 'check' }, typeRadios[1], 'S3 bucket'),
                    h('label', { class: 'check' }, typeRadios[2], 'FTP server'))),
            s3Box, ftpBox,
            h('p', { class: 'muted small', text: `Backups are always written to ${cfg.path} on the server first; S3/FTP get a copy. Credentials are stored encrypted. The local folder can only be changed in .env (BACKUP_PATH).` }),
            h('div', { class: 'row gap wrap' }, saveBtn, testBtn, testResult));

        const kindBadge = { full: ['full', 'badge-accent'], prerestore: ['safety copy', 'badge-warn'], upload: ['uploaded', ''], user: ['user', ''] };
        const rows = backups.map((bk) => {
            const [label, cls] = kindBadge[bk.kind] || [bk.kind, ''];
            return h('tr', null,
                h('td', { class: 'mono small', text: bk.name }),
                h('td', null, h('span', { class: `badge ${cls}`, text: label })),
                h('td', { class: 'num', text: fmtBytes(bk.size) }),
                h('td', { text: fmtDate(bk.created) }),
                h('td', { class: 'actions' },
                    h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => restoreDialog(bk.name) }, 'Restore…'),
                    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => download(`/api/backup/${enc(bk.name)}/download`, bk.name).catch((e) => toast(e.message, 'error')) }, 'Download'),
                    h('button', {
                        class: 'btn btn-sm btn-danger', type: 'button', onclick: async () => {
                            if (!await confirmDialog('Delete backup', `Delete ${bk.name} from this server? This cannot be undone.`, { danger: true, confirmText: 'Delete' })) return;
                            try { await api(`/api/backup/${enc(bk.name)}`, { method: 'DELETE' }); toast('Backup deleted', 'ok'); route(); } catch (e) { toast(e.message, 'error'); }
                        },
                    }, 'Delete'),
                ),
            );
        });

        // Upload a backup file (e.g. downloaded from another server) to restore it here.
        const fileInput = h('input', { type: 'file', accept: '.gz,.tar.gz,application/gzip', hidden: true });
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files && fileInput.files[0];
            fileInput.value = '';
            if (!file) return;
            if (file.size > 1024 * 1024 * 1024) return toast('Backup files are limited to 1 GB', 'error');
            try {
                toast(`Uploading ${file.name} (${fmtBytes(file.size)})…`);
                const res = await fetch('/api/backup/upload', {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/gzip' },
                    body: file,
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
                toast('Backup uploaded and verified', 'ok');
                await route();
                restoreDialog(data.backupName);
            } catch (e) { toast(e.message, 'error'); }
        });
        const uploadBtn = h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, 'Upload backup…');
        const remoteBtn = cfg.type !== 'local' ? h('button', { class: 'btn', type: 'button', onclick: remoteBackupsDialog }, `Backups on ${cfg.type.toUpperCase()}…`) : null;

        clear(main).append(
            pageHead('Backups', remoteBtn, uploadBtn, runBtn, fileInput),
            settingsCard,
            h('h2', { class: 'mt', text: `Backup files (${backups.length})` }),
            h('p', { class: 'muted small', text: 'Each backup is a point-in-time version of your data. Restore… lets you see what is inside and pick which databases to bring back. A safety copy of the current data is taken first, so a restore can be undone.' }),
            rows.length
                ? h('div', { class: 'table-wrap' }, h('table', null,
                    h('thead', null, h('tr', null, ['Name', 'Type', 'Size', 'Created', ''].map((t) => h('th', { text: t })))),
                    h('tbody', null, rows)))
                : h('div', { class: 'card empty', text: 'No backups yet.' }),
        );
    }

    /** Shows what's inside a backup and restores the chosen databases. */
    async function restoreDialog(backupName) {
        let contents;
        try {
            contents = await api(`/api/backup/${enc(backupName)}/contents`);
        } catch (e) { return toast(e.message, 'error'); }

        const m = contents.manifest;
        const picks = contents.databases.map((d) => {
            const cb = h('input', { type: 'checkbox', checked: d.name !== SYSTEM_DB });
            cb.dataset.db = d.name;
            const totalBytes = d.racks.reduce((n, r) => n + r.bytes, 0);
            return {
                cb,
                el: h('label', { class: 'check' }, cb, h('span', null,
                    h('strong', { class: 'mono', text: d.name }),
                    d.name === SYSTEM_DB ? h('span', { class: 'badge badge-warn', text: 'users & API keys' }) : null,
                    h('div', { class: 'muted small', text: `${d.racks.length} rack(s) · ${fmtBytes(totalBytes)}${d.racks.length ? ` — ${d.racks.map((r) => r.name).slice(0, 8).join(', ')}${d.racks.length > 8 ? '…' : ''}` : ''}` }))),
            };
        });
        const replace = h('input', { type: 'checkbox', checked: true });
        const safety = h('input', { type: 'checkbox', checked: true });
        const confirmIn = h('input', { placeholder: 'RESTORE', autocomplete: 'off' });

        let result = null;
        const ok = await openDialog({
            title: 'Restore backup',
            wide: true,
            body: h('div', { class: 'stack' },
                h('dl', { class: 'kv' },
                    kv('Backup', backupName),
                    kv('Created', fmtDate(m.timestamp || contents.created)),
                    kv('OpenDBS version', m.appVersion ? `v${m.appVersion}` : 'unknown (older backup)'),
                    kv('Size', fmtBytes(contents.size))),
                h('fieldset', null, h('legend', { text: 'Databases to restore' }),
                    picks.length ? h('div', { class: 'db-pick' }, picks.map((p) => p.el)) : h('p', { class: 'muted', text: 'This backup is empty.' }),
                    picks.some((p) => p.cb.dataset.db === SYSTEM_DB)
                        ? h('p', { class: 'muted small mt', text: 'Restoring _opendbs_system brings back users, passwords and API keys as they were — you may need to sign in with the old password.' }) : null),
                h('label', { class: 'check' }, replace, h('span', null, h('strong', { text: 'Replace' }), ' — remove racks that were created after this backup (unchecked = merge: keep them)')),
                h('label', { class: 'check' }, safety, h('span', null, h('strong', { text: 'Safety copy first' }), ' — back up the current data before restoring, so you can undo')),
                h('label', null, 'Type RESTORE to confirm', confirmIn)),
            actions: [
                { label: 'Cancel', value: false },
                {
                    label: 'Restore', kind: 'danger', onClick: async () => {
                        const databases = picks.filter((p) => p.cb.checked).map((p) => p.cb.dataset.db);
                        if (databases.length === 0) throw new Error('Choose at least one database');
                        if (confirmIn.value !== 'RESTORE') throw new Error('Type RESTORE to confirm');
                        result = await api('/api/backup/restore', {
                            method: 'POST',
                            body: { backupName, databases, replace: replace.checked, safetyBackup: safety.checked },
                        });
                        return true;
                    },
                },
            ],
        });
        if (!ok || !result) return;
        toast(`Restored ${result.databases.join(', ')} (${result.count} rack file(s)${result.removedRacks ? `, ${result.removedRacks} removed` : ''})`, 'ok');
        if (result.safetyBackup) setTimeout(() => toast(`Safety copy saved as ${result.safetyBackup}`), 400);
        // Restoring the system database can change who we are; re-check the session.
        if (result.databases.includes(SYSTEM_DB)) {
            try { await api('/api/auth/me'); } catch { return; }
        }
        loadDatabases().catch(() => undefined);
        route();
    }

    /** Lists backups at the S3/FTP destination and copies one back to this server. */
    async function remoteBackupsDialog() {
        const box = h('div', { class: 'stack' }, h('p', { class: 'muted', text: 'Loading…' }));
        const render = async () => {
            try {
                const { backups } = await api('/api/admin/backup/remote');
                clear(box).appendChild(backups.length
                    ? h('div', { class: 'table-wrap' }, h('table', null,
                        h('thead', null, h('tr', null, ['Name', 'Size', 'Modified', ''].map((t) => h('th', { text: t })))),
                        h('tbody', null, backups.map((b) => h('tr', null,
                            h('td', { class: 'mono small', text: b.name }),
                            h('td', { class: 'num', text: fmtBytes(b.size) }),
                            h('td', { class: 'small', text: fmtDate(b.created) }),
                            h('td', { class: 'actions' }, b.local
                                ? h('span', { class: 'badge badge-ok', text: 'on this server' })
                                : h('button', {
                                    class: 'btn btn-sm', type: 'button', onclick: async (e) => {
                                        const btn = e.currentTarget;
                                        btn.disabled = true;
                                        btn.textContent = 'Copying…';
                                        try {
                                            await api('/api/admin/backup/remote/fetch', { method: 'POST', body: { backupName: b.name } });
                                            toast('Copied to this server — it is now in the backup list', 'ok');
                                            await render();
                                        } catch (err) { toast(err.message, 'error'); btn.disabled = false; btn.textContent = 'Copy here'; }
                                    },
                                }, 'Copy here')))))))
                    : h('p', { class: 'muted', text: 'No backups found at the destination.' }));
            } catch (e) {
                clear(box).appendChild(h('p', { class: 'error', text: e.message }));
            }
        };
        render();
        await openDialog({ title: 'Remote backups', wide: true, body: box, actions: [{ label: 'Close', kind: 'primary', value: true }] });
        route();
    }

    // ───────────────────────── audit ─────────────────────────

    async function viewAudit(main) {
        const filter = h('input', { placeholder: 'Filter by action, user or target', maxlength: '100' });
        const tableBox = h('div');
        const load = async () => {
            const { events } = await api(`/api/admin/audit?limit=500&filter=${enc(filter.value.trim())}`);
            clear(tableBox).appendChild(events.length
                ? h('div', { class: 'table-wrap' }, h('table', null,
                    h('thead', null, h('tr', null, ['Time', 'Action', 'Result', 'Actor', 'IP', 'Target', 'Detail'].map((t) => h('th', { text: t })))),
                    h('tbody', null, events.map((ev) => h('tr', null,
                        h('td', { class: 'small', text: fmtDate(ev.ts) }),
                        h('td', { class: 'mono', text: ev.action }),
                        h('td', null, h('span', { class: `badge ${ev.ok ? 'badge-ok' : 'badge-danger'}`, text: ev.ok ? 'ok' : 'failed' })),
                        h('td', { text: ev.actor || '—' }),
                        h('td', { class: 'mono small', text: ev.ip || '—' }),
                        h('td', { class: 'cell', text: ev.target || '' }),
                        h('td', { class: 'cell small muted', title: ev.detail || '', text: ev.detail || '' }),
                    )))))
                : h('div', { class: 'card empty', text: 'No audit events.' }));
        };
        filter.addEventListener('keydown', (e) => { if (e.key === 'Enter') load().catch((err) => toast(err.message, 'error')); });
        clear(main).append(
            pageHead('Audit log', filter, h('button', { class: 'btn', type: 'button', onclick: () => load().catch((err) => toast(err.message, 'error')) }, 'Search')),
            tableBox,
        );
        await load();
    }

    // ───────────────────────── cluster ─────────────────────────

    async function viewCluster(main) {
        const roleBadge = (r) => h('span', { class: `badge ${r === 'leader' ? 'badge-ok' : r === 'candidate' ? 'badge-warn' : r ? 'badge-accent' : ''}`, text: r === 'leader' ? 'primary' : r === 'follower' ? 'replica' : r || 'unknown' });
        const act = async (name, title, message, opts = {}) => {
            if (!await confirmDialog(title, message, opts)) return;
            try {
                await api(`/api/admin/cluster/${name}`, { method: 'POST', body: name === 'force-primary' ? { confirm: 'FORCE' } : {} });
                toast('Done', 'ok');
                render().catch(() => undefined);
            } catch (e) { toast(e.message, 'error'); }
        };
        const render = async () => {
            const c = await api('/api/admin/cluster');
            if (!c.enabled) {
                clear(main).append(
                    pageHead('Cluster'),
                    h('div', { class: 'card' },
                        h('h2', { text: 'Replication is off' }),
                        h('p', { text: 'Run 3 or more OpenDBS servers as one cluster: one primary takes writes, the replicas keep identical copies and serve reads, and if the primary fails the others elect a new one within seconds.' }),
                        h('p', { class: 'muted', text: c.hint }),
                        c.storageEngine !== 'disk' ? h('p', { class: 'error', text: 'Replication needs STORAGE_ENGINE=disk.' }) : null,
                        h('a', { class: 'btn', href: '#settings' }, 'Open Settings → Cluster')));
                return;
            }
            const stat = (label, value, sub) => h('div', { class: 'card' },
                h('div', { class: 'stat-label', text: label }), h('div', { class: 'stat-value' }, value), sub ? h('div', { class: 'stat-sub', text: sub }) : null);
            const leader = c.role === 'leader';
            clear(main).append(
                pageHead('Cluster',
                    leader ? h('button', { class: 'btn', type: 'button', onclick: () => act('step-down', 'Step down', 'This node stops being the primary; another member is elected. Writes pause for a few seconds.') }, 'Step down') : null,
                    !leader ? h('button', { class: 'btn', type: 'button', onclick: () => act('elect', 'Start election', 'Ask the members to elect this node now (it only wins with a majority and an up-to-date copy).') }, 'Elect this node') : null,
                    !leader ? h('button', { class: 'btn btn-danger', type: 'button', onclick: () => act('force-primary', 'Force primary', 'Makes this node primary WITHOUT a majority. Only use it when the other members are gone for good — if they come back, their newer writes may be discarded.', { danger: true, confirmText: 'Force', typeToConfirm: 'FORCE' }) }, 'Force primary') : null),
                h('div', { class: 'grid grid-stats' },
                    stat('This node', roleBadge(c.role), c.nodeId),
                    stat('Primary', c.leaderId || '— (electing)', c.leaderUrl || ''),
                    stat('Term', fmtNum(c.term), c.forced ? 'forced primary' : `majority ${c.majority} of ${c.members}`),
                    stat('Log position', fmtNum(c.lastLsn), `kept from ${fmtNum(c.firstLsn)} · write concern ${c.writeConcern}`)),
                h('div', { class: 'card' },
                    h('h2', { text: 'Members' }),
                    h('div', { class: 'table-wrap' }, h('table', null,
                        h('thead', null, h('tr', null, ['Node', 'Address', 'Role', 'Applied LSN', 'Behind', 'Last contact', 'Status'].map((t) => h('th', { text: t })))),
                        h('tbody', null,
                            h('tr', null, h('td', { text: `${c.nodeId} (this node)` }), h('td', { class: 'mono small', text: c.url }), h('td', null, roleBadge(c.role)),
                                h('td', { class: 'num', text: fmtNum(c.lastLsn) }), h('td', { class: 'num', text: '—' }), h('td', { text: '—' }), h('td', { text: c.syncing ? 'copying data…' : 'ok' })),
                            c.peers.map((p) => h('tr', null,
                                h('td', { text: p.nodeId || '—' }),
                                h('td', { class: 'mono small', text: p.url }),
                                h('td', null, roleBadge(p.role)),
                                h('td', { class: 'num', text: leader ? fmtNum(p.ackLsn) : '—' }),
                                h('td', { class: 'num', text: p.lag === null ? '—' : fmtNum(p.lag) }),
                                h('td', { text: p.lastContactMsAgo === null ? 'never' : `${(p.lastContactMsAgo / 1000).toFixed(1)} s ago` }),
                                h('td', { class: p.error && (p.lastContactMsAgo === null || p.lastContactMsAgo > 10000) ? 'error small' : 'small muted', text: p.error && (p.lastContactMsAgo === null || p.lastContactMsAgo > 10000) ? p.error : 'ok' }))))))),
                h('div', { class: 'card' },
                    h('h2', { text: 'Activity' }),
                    h('dl', { class: 'kv' },
                        kv('Entries applied (as replica)', fmtNum(c.stats.entriesApplied)),
                        kv('Full copies received', `${fmtNum(c.stats.fullSyncs)}${c.stats.lastFullSyncAt ? ` (last ${fmtDate(c.stats.lastFullSyncAt)})` : ''}`),
                        kv('Elections started here', fmtNum(c.stats.elections)),
                        kv('Writes forwarded to the primary', fmtNum(c.stats.forwarded)),
                        kv('Last error', c.stats.lastError || '—'))),
            );
        };
        await render();
        state.timer = setInterval(() => { if (!document.hidden) render().catch(() => undefined); }, 3000);
    }

    // ───────────────────────── sharding ─────────────────────────

    async function viewSharding(main) {
        const shardChecks = (shards, selected) => shards.map((s) => {
            const box = h('input', { type: 'checkbox', value: s.name, checked: selected.includes(s.name) });
            return { box, el: h('label', { class: 'check' }, box, h('span', null, h('strong', { text: s.name }), s.local ? ' (this server)' : ` — ${s.urls.join(', ')}`)) };
        });

        const addShard = async () => {
            const name = h('input', { placeholder: 'shard2', maxlength: '64', class: 'mono', autocomplete: 'off' });
            const urls = h('input', { placeholder: 'http://10.0.0.12:4402, http://10.0.0.13:4402', class: 'mono', autocomplete: 'off' });
            const key = h('input', { type: 'password', placeholder: 'API key on that server', autocomplete: 'off' });
            const ok = await openDialog({
                title: 'Add shard',
                wide: true,
                body: h('div', { class: 'stack' },
                    h('p', { class: 'muted small', text: 'A shard is another OpenDBS server (or a replicated cluster of them: list every member, comma-separated). This server routes requests for sharded racks to it.' }),
                    h('div', { class: 'form-grid' },
                        h('label', null, 'Name', name),
                        h('label', null, 'URL(s)', urls)),
                    h('label', null, 'API key', key),
                    h('p', { class: 'muted small', text: 'Use an API key created on the shard server: an admin\'s key, or an access key with read, write and delete on the sharded databases. It is stored encrypted.' })),
                actions: [
                    { label: 'Cancel', value: false },
                    { label: 'Add shard', kind: 'primary', onClick: async () => { await api('/api/admin/sharding/shards', { method: 'POST', body: { name: name.value.trim(), urls: urls.value, apiKey: key.value } }); return true; } },
                ],
            });
            if (ok) { toast('Shard added', 'ok'); render().catch(() => undefined); }
        };

        const shardRack = async (info) => {
            const database = h('input', { placeholder: 'shop', class: 'mono', autocomplete: 'off' });
            const rack = h('input', { placeholder: 'orders', class: 'mono', autocomplete: 'off' });
            const type = h('select', null, h('option', { value: 'nosql' }, 'NoSQL (documents)'), h('option', { value: 'sql' }, 'SQL (columns)'));
            const key = h('input', { placeholder: 'id', value: 'id', class: 'mono', autocomplete: 'off' });
            const checks = shardChecks(info.shards, info.shards.map((s) => s.name));
            const cols = columnBuilder([{ name: '', type: 'string' }]);
            const colsBox = h('fieldset', { hidden: true }, h('legend', { text: 'Columns' }), cols.el);
            type.addEventListener('change', () => { colsBox.hidden = type.value !== 'sql'; });
            const ok = await openDialog({
                title: 'New sharded rack',
                wide: true,
                body: h('div', { class: 'stack' },
                    h('div', { class: 'form-grid' },
                        h('label', null, 'Database', database),
                        h('label', null, 'Rack / table', rack),
                        h('label', null, 'Type', type),
                        h('label', null, 'Shard key', key)),
                    h('p', { class: 'muted small', text: 'The shard key decides where each document lives. "id" spreads documents evenly; a field such as customer_id keeps each customer\'s documents together, and queries on that field go to one shard only. It can\'t be changed later.' }),
                    colsBox,
                    h('fieldset', null, h('legend', { text: 'Spread over' }), h('div', { class: 'stack' }, checks.map((c) => c.el)))),
                actions: [
                    { label: 'Cancel', value: false },
                    {
                        label: 'Create', kind: 'primary', onClick: async () => {
                            const shards = checks.filter((c) => c.box.checked).map((c) => c.box.value);
                            if (!shards.length) throw new Error('Choose at least one shard');
                            const body = { database: database.value.trim(), rack: rack.value.trim(), type: type.value, key: key.value.trim() || 'id', shards };
                            if (type.value === 'sql') body.schema = cols.value();
                            const r = await api('/api/admin/sharding/racks', { method: 'POST', body });
                            (r.warnings || []).forEach((w) => toast(w, 'info'));
                            return true;
                        },
                    },
                ],
            });
            if (ok) { toast('Sharded rack created', 'ok'); render().catch(() => undefined); }
        };

        const rebalance = async (info, r) => {
            const checks = shardChecks(info.shards, r.shards);
            const ok = await openDialog({
                title: `Rebalance ${r.database}/${r.rack}`,
                wide: true,
                body: h('div', { class: 'stack' },
                    h('p', { class: 'small', text: 'Choose the shards this rack should use. Buckets move so every chosen shard holds an equal share; unchecked shards are emptied. Writes to the rack pause (HTTP 503, retried by the drivers) while documents are copied; reads keep working.' }),
                    h('div', { class: 'stack' }, checks.map((c) => c.el))),
                actions: [
                    { label: 'Cancel', value: false },
                    {
                        label: 'Rebalance', kind: 'primary', onClick: async () => {
                            const shards = checks.filter((c) => c.box.checked).map((c) => c.box.value);
                            if (!shards.length) throw new Error('Choose at least one shard');
                            const res = await api(`/api/admin/sharding/racks/${enc(r.database)}/${enc(r.rack)}/rebalance`, { method: 'POST', body: { shards } });
                            toast(`Moved ${fmtNum(res.moved)} document(s)`, 'ok');
                            return true;
                        },
                    },
                ],
            });
            if (ok) render().catch(() => undefined);
        };

        const showStats = async (r) => {
            try {
                const s = await api(`/api/admin/sharding/racks/${enc(r.database)}/${enc(r.rack)}`);
                await openDialog({
                    title: `${r.database}/${r.rack}`,
                    body: h('div', { class: 'table-wrap' }, h('table', null,
                        h('thead', null, h('tr', null, ['Shard', 'Buckets', 'Documents'].map((t) => h('th', { text: t })))),
                        h('tbody', null, s.shards.map((p) => h('tr', null,
                            h('td', { text: p.shard }), h('td', { class: 'num', text: fmtNum(p.buckets) }),
                            h('td', { class: p.error ? 'error small' : 'num', text: p.error ? p.error : fmtNum(p.documents) })))))),
                    actions: [{ label: 'Close', value: true }],
                });
            } catch (e) { toast(e.message, 'error'); }
        };

        const testShard = async (name) => {
            try {
                const t = await api(`/api/admin/sharding/shards/${enc(name)}/test`, { method: 'POST', body: {} });
                toast(`${name}: reachable in ${t.ms} ms${t.version ? ` (v${t.version})` : ''}`, 'ok');
            } catch (e) { toast(e.message, 'error'); }
        };
        const removeShard = async (name) => {
            if (!await confirmDialog('Remove shard', `Stop using '${name}'? Racks still stored on it must be rebalanced off it first.`, { danger: true, confirmText: 'Remove' })) return;
            try { await api(`/api/admin/sharding/shards/${enc(name)}`, { method: 'DELETE' }); toast('Shard removed', 'ok'); render().catch(() => undefined); } catch (e) { toast(e.message, 'error'); }
        };

        const stateBadge = (s) => h('span', { class: `badge ${s === 'active' ? 'badge-ok' : 'badge-warn'}`, text: s === 'cleaning' ? 'finishing move' : s });
        const render = async () => {
            const info = await api('/api/admin/sharding');
            clear(main).append(
                pageHead('Sharding',
                    h('button', { class: 'btn', type: 'button', onclick: addShard }, 'Add shard'),
                    h('button', { class: 'btn btn-primary', type: 'button', onclick: () => shardRack(info) }, 'New sharded rack')),
                h('div', { class: 'card' },
                    h('p', { class: 'small', text: 'Sharding spreads one rack over several OpenDBS servers so it can hold more data and take more load than one server. This server is the router: clients keep using its normal API and SQL, and it sends each document to its shard, runs queries on all shards in parallel and merges the results (GROUP BY is computed on every shard and combined here).' })),
                h('div', { class: 'card' },
                    h('h2', { text: 'Shards' }),
                    h('div', { class: 'table-wrap' }, h('table', null,
                        h('thead', null, h('tr', null, ['Name', 'Address', ''].map((t) => h('th', { text: t })))),
                        h('tbody', null, info.shards.map((s) => h('tr', null,
                            h('td', null, h('strong', { text: s.name })),
                            h('td', { class: 'mono small', text: s.urls.join(', ') }),
                            h('td', { class: 'row gap-s' }, s.local ? h('span', { class: 'muted small', text: 'always available' }) : [
                                h('button', { class: 'btn btn-sm', type: 'button', onclick: () => testShard(s.name) }, 'Test'),
                                h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => removeShard(s.name) }, 'Remove'),
                            ]))))))),
                h('div', { class: 'card' },
                    h('h2', { text: 'Sharded racks' }),
                    info.racks.length === 0 ? h('p', { class: 'muted', text: 'None yet. Add shards, then create a sharded rack.' }) :
                        h('div', { class: 'table-wrap' }, h('table', null,
                            h('thead', null, h('tr', null, ['Rack', 'Type', 'Shard key', 'Buckets per shard', 'State', ''].map((t) => h('th', { text: t })))),
                            h('tbody', null, info.racks.map((r) => h('tr', null,
                                h('td', { class: 'mono', text: `${r.database}/${r.rack}` }),
                                h('td', { text: r.type }),
                                h('td', { class: 'mono', text: r.key }),
                                h('td', { class: 'small', text: Object.entries(r.buckets).map(([n, c]) => `${n}: ${c}`).join(' · ') }),
                                h('td', null, stateBadge(r.state)),
                                h('td', { class: 'row gap-s' },
                                    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => showStats(r) }, 'Documents'),
                                    h('button', { class: 'btn btn-sm', type: 'button', disabled: r.state !== 'active', onclick: () => rebalance(info, r) }, 'Rebalance')))))))),
                h('div', { class: 'card' },
                    h('h2', { text: 'Activity' }),
                    h('dl', { class: 'kv' },
                        kv('Routed writes', fmtNum(info.stats.routed)),
                        kv('Scatter queries', fmtNum(info.stats.scattered)),
                        kv('Rebalances', fmtNum(info.stats.rebalances)))),
            );
        };
        await render();
    }

    // ───────────────────────── API docs ─────────────────────────

    async function viewDocs(main) {
        const docs = window.OPENDBS_API_DOCS;
        if (!docs) throw new Error('API reference failed to load (api-docs.js)');

        const search = h('input', { placeholder: 'Search endpoints…', 'aria-label': 'Search endpoints' });
        const listBox = h('div');

        const authBadge = (a) => a === 'none'
            ? h('span', { class: 'badge', text: 'public' })
            : a === 'admin' ? h('span', { class: 'badge badge-accent', text: 'admin' }) : h('span', { class: 'badge', text: 'auth' });

        const render = () => {
            const q = search.value.trim().toLowerCase();
            clear(listBox);
            for (const g of docs.groups) {
                const eps = g.endpoints.filter((ep) => !q || `${ep.method} ${ep.path} ${ep.summary}`.toLowerCase().includes(q));
                if (eps.length === 0) continue;
                listBox.appendChild(h('h2', { class: 'mt', text: g.name }));
                for (const ep of eps) {
                    listBox.appendChild(h('details', { class: 'endpoint' },
                        h('summary', { class: 'endpoint-head' },
                            h('span', { class: `method m-${ep.method}`, text: ep.method }),
                            h('span', { class: 'endpoint-path', text: ep.path }),
                            authBadge(ep.auth),
                            h('span', { class: 'muted small', text: ep.summary })),
                        h('div', { class: 'endpoint-body' },
                            h('p', { class: 'small' },
                                h('strong', { text: 'Auth: ' }), ep.auth === 'none' ? 'none' : ep.auth === 'admin' ? 'admin JWT' : 'JWT or X-Api-Key',
                                ep.perm ? [' · ', h('strong', { text: 'Permission: ' }), ep.perm] : null),
                            ep.body ? [h('div', { class: 'small muted', text: 'Request body' }), h('pre', { class: 'code', text: JSON.stringify(ep.body, null, 2) })] : null,
                            h('div', { class: 'row gap mt' },
                                h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => tryInPlayground(ep) }, 'Try in playground'),
                                h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyText(curlFor(ep.method, ep.path, ep.body ? JSON.stringify(ep.body, null, 2) : '', ep.auth === 'none' ? 'none' : 'session')) }, 'Copy cURL')),
                        )));
                }
            }
            if (!listBox.firstChild) listBox.appendChild(h('div', { class: 'card empty', text: 'No endpoints match.' }));
        };
        search.addEventListener('input', render);

        clear(main).append(
            pageHead('API docs', search),
            h('div', { class: 'card' }, h('h2', { text: 'Getting started' }), h('dl', { class: 'kv' }, docs.intro.map(([k, v]) => kv(k, v)))),
            listBox,
        );
        render();
    }

    function tryInPlayground(ep) {
        state.pg = {
            method: ep.method,
            path: ep.path,
            auth: ep.auth === 'none' ? 'none' : 'session',
            body: ep.body ? JSON.stringify(ep.body, null, 2) : '',
        };
        savePlayground();
        location.hash = '#playground';
    }

    // ───────────────────────── playground ─────────────────────────

    function loadPlayground() {
        try {
            const v = JSON.parse(safeGet(sessionStorage, PG_KEY) || 'null');
            if (v && typeof v === 'object') return v;
        } catch { /* ignore */ }
        return { method: 'GET', path: '/api/databases?include_racks=true', auth: 'session', body: '' };
    }
    function savePlayground() {
        // The API key is deliberately kept in memory only.
        safeSet(sessionStorage, PG_KEY, JSON.stringify(state.pg));
    }

    const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    function curlFor(method, path, body, auth) {
        const lines = [`curl -X ${method} ${shq(location.origin + path)}`];
        if (auth === 'session') lines.push(`  -H 'Authorization: Bearer $TOKEN'`);
        if (auth === 'apikey') lines.push(`  -H 'X-Api-Key: $API_KEY'`);
        if (body && method !== 'GET') {
            lines.push(`  -H 'Content-Type: application/json'`);
            lines.push(`  -d ${shq(body)}`);
        }
        return lines.join(' \\\n');
    }

    async function viewPlayground(main) {
        const pg = state.pg;
        const method = h('select', { 'aria-label': 'Method' }, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => h('option', { value: m, selected: m === pg.method }, m)));
        const path = h('input', { value: pg.path, class: 'mono', spellcheck: 'false', 'aria-label': 'Path' });
        const auth = h('select', { 'aria-label': 'Authentication' },
            h('option', { value: 'session', selected: pg.auth === 'session' }, 'My admin session (JWT)'),
            h('option', { value: 'apikey', selected: pg.auth === 'apikey' }, 'API key'),
            h('option', { value: 'none', selected: pg.auth === 'none' }, 'No auth'));
        const apiKey = h('input', { type: 'password', class: 'mono', placeholder: 'odbs_… or opendbs_…', value: state.pgKey, autocomplete: 'off' });
        const keyLabel = h('label', null, 'API key (kept in memory only)', apiKey);
        const body = h('textarea', { rows: '14', spellcheck: 'false', value: pg.body, placeholder: '{ }' });
        const sendBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Send');

        const out = h('div', { class: 'card' }, h('p', { class: 'muted', text: 'Send a request to see the response here.' }));

        const sync = () => {
            keyLabel.hidden = auth.value !== 'apikey';
            body.disabled = method.value === 'GET';
            state.pg = { method: method.value, path: path.value, auth: auth.value, body: body.value };
            state.pgKey = apiKey.value;
            savePlayground();
        };
        [method, auth].forEach((el) => el.addEventListener('change', sync));
        [path, body, apiKey].forEach((el) => el.addEventListener('input', sync));
        path.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

        async function send() {
            sync();
            const p = path.value.trim();
            if (!p.startsWith('/')) return toast('Path must start with /', 'error');
            const unresolved = p.match(/\/:([a-zA-Z]+)/);
            if (unresolved) return toast(`Replace :${unresolved[1]} in the path with a real value`, 'error');

            const headers = {};
            if (auth.value === 'session' && state.token) headers.Authorization = `Bearer ${state.token}`;
            if (auth.value === 'apikey') {
                if (!apiKey.value.trim()) return toast('Enter an API key', 'error');
                headers['X-Api-Key'] = apiKey.value.trim();
            }
            let payload;
            if (method.value !== 'GET' && body.value.trim()) {
                try { JSON.parse(body.value); } catch (e) { return toast(`Body is not valid JSON: ${e.message}`, 'error'); }
                headers['Content-Type'] = 'application/json';
                payload = body.value;
            }

            sendBtn.disabled = true;
            const started = performance.now();
            try {
                const res = await fetch(p, { method: method.value, headers, body: payload, cache: 'no-store', credentials: 'omit' });
                const ms = Math.round(performance.now() - started);
                const ctype = res.headers.get('content-type') || '';
                let text;
                if (/json|text/.test(ctype)) {
                    text = await res.text();
                    try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON */ }
                } else {
                    const blob = await res.blob();
                    text = `[${ctype || 'binary'} · ${fmtBytes(blob.size)}]`;
                }
                const okCls = res.status < 300 ? 'badge-ok' : res.status < 500 ? 'badge-warn' : 'badge-danger';
                const shownHeaders = ['content-type', 'content-length', 'x-ratelimit-remaining', 'retry-after']
                    .filter((k) => res.headers.get(k)).map((k) => `${k}: ${res.headers.get(k)}`).join('\n');
                clear(out).append(
                    h('div', { class: 'status-line' },
                        h('span', { class: `badge ${okCls}`, text: `${res.status} ${res.statusText}` }),
                        h('span', { class: 'muted small', text: `${ms} ms` }),
                        h('span', { class: 'muted small', text: fmtBytes(new Blob([text]).size) }),
                        h('div', { class: 'spacer' }),
                        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyText(text) }, 'Copy body')),
                    shownHeaders ? h('pre', { class: 'code small', text: shownHeaders }) : null,
                    h('pre', { class: 'code', text: text || '(empty body)' }),
                );
            } catch (e) {
                clear(out).append(h('p', { class: 'error', text: `Network error: ${e.message}` }));
            } finally {
                sendBtn.disabled = false;
            }
        }
        sendBtn.addEventListener('click', send);

        const quick = [
            ['List databases', 'GET', '/api/databases?include_racks=true', ''],
            ['Who am I', 'GET', '/api/auth/me', ''],
            ['Search', 'POST', '/api/databases/:database/racks/:rack/search', JSON.stringify({ query: {}, limit: 10 }, null, 2)],
            ['SQL', 'POST', '/api/sql/:database/execute', JSON.stringify({ query: 'SELECT * FROM my_table LIMIT 10' }, null, 2)],
        ];

        sync();
        clear(main).append(
            pageHead('Playground', h('a', { href: '#docs', class: 'btn' }, 'Browse API docs')),
            h('div', { class: 'pg-grid' },
                h('div', { class: 'card stack' },
                    h('div', { class: 'pg-line' }, method, path, sendBtn),
                    h('div', { class: 'form-grid' }, h('label', null, 'Authentication', auth), keyLabel),
                    h('label', null, 'JSON body', body),
                    h('div', { class: 'row gap wrap' },
                        h('button', {
                            class: 'btn btn-sm', type: 'button', onclick: () => {
                                try { body.value = JSON.stringify(JSON.parse(body.value), null, 2); sync(); } catch (e) { toast(`Invalid JSON: ${e.message}`, 'error'); }
                            },
                        }, 'Format JSON'),
                        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyText(curlFor(method.value, path.value, body.value, auth.value)) }, 'Copy as cURL'),
                        h('span', { class: 'muted small', text: 'Quick:' }),
                        quick.map(([label, m, p, b]) => h('button', {
                            class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => {
                                method.value = m; path.value = p; body.value = b; sync(); path.focus();
                            },
                        }, label))),
                    h('p', { class: 'muted small', text: 'Requests run against this server with real data. Test API keys here to check their permissions and IP rules.' }),
                ),
                out,
            ),
        );
    }

    // ───────────────────────── settings ─────────────────────────

    // ── speed test ──

    async function viewSpeed(main) {
        const size = h('select', { 'aria-label': 'Data size' },
            [[1000, '1,000 documents (quick)'], [10000, '10,000 documents'], [50000, '50,000 documents'], [100000, '100,000 documents (thorough)']]
                .map(([v, l]) => h('option', { value: String(v), selected: v === 10000 }, l)));
        const out = h('div', { class: 'stack' });
        const runBtn = h('button', {
            class: 'btn btn-primary', type: 'button', onclick: async () => {
                runBtn.disabled = true;
                runBtn.textContent = 'Running…';
                clear(out).appendChild(h('div', { class: 'card empty', text: 'Measuring write, read and disk speed… this takes a few seconds.' }));
                try {
                    const r = await api('/api/admin/benchmark', { method: 'POST', body: { size: Number(size.value) } });
                    const maxOps = Math.max(...r.results.map((x) => x.opsPerSec));
                    clear(out).append(
                        h('div', { class: 'card' },
                            h('div', { class: 'status-line' },
                                h('strong', { text: `Finished in ${(r.totalMs / 1000).toFixed(1)} s` }),
                                h('span', { class: 'muted small', text: `WAL fsync: ${r.settings.walFsync ? 'on' : 'off'} · snapshot delay ${r.settings.persistDebounceMs} ms` })),
                            h('div', { class: 'table-wrap mt' }, h('table', null,
                                h('thead', null, h('tr', null, ['Test', 'What it does', 'Operations/sec', 'Avg latency', 'Throughput', ''].map((t) => h('th', { text: t })))),
                                h('tbody', null, r.results.map((x) => h('tr', null,
                                    h('td', null, h('strong', { text: x.name })),
                                    h('td', { class: 'small muted', text: x.detail }),
                                    h('td', { class: 'num', text: fmtNum(x.opsPerSec) }),
                                    h('td', { class: 'num', text: x.avgMs < 1 ? `${(x.avgMs * 1000).toFixed(1)} µs` : `${x.avgMs.toFixed(2)} ms` }),
                                    h('td', { class: 'num', text: x.mbPerSec !== undefined && x.mbPerSec !== null ? `${x.mbPerSec} MB/s` : '' }),
                                    h('td', { class: 'bar-cell' }, h('div', { class: 'bar' })))))))),
                        h('p', { class: 'muted small', text: 'Runs in a temporary database on the same disk as your data, then deletes it — your databases are not touched. "Durable inserts" show what WAL_FSYNC=true would cost per write.' }));
                    // Bars are sized after insertion (log scale) via the CSSOM, which the strict CSP allows.
                    out.querySelectorAll('.bar').forEach((bar, i) => {
                        const v = r.results[i].opsPerSec;
                        bar.style.width = `${Math.max(2, Math.round(Math.log10(v + 1) / Math.log10(maxOps + 1) * 100))}%`;
                    });
                } catch (e) {
                    clear(out).appendChild(h('div', { class: 'card' }, h('p', { class: 'error', text: e.message })));
                } finally {
                    runBtn.disabled = false;
                    runBtn.textContent = 'Run speed test';
                }
            },
        }, 'Run speed test');

        clear(main).append(
            pageHead('Speed test', size, runBtn),
            h('p', { class: 'muted', text: 'Measures how fast this server writes and reads data: bulk and single inserts, updates, lookups, indexed and unindexed queries, snapshot writes, fsync latency and raw disk throughput.' }),
            out,
        );
    }

    // ── settings ──

    async function twoFactorCard() {
        const card = h('div', { class: 'card stack' }, h('h2', { text: 'Two-factor authentication' }));
        const st = await api('/api/auth/2fa');

        const showCodes = (codes) => openDialog({
            title: 'Save your recovery codes',
            body: h('div', { class: 'stack' },
                h('p', { text: 'Each code works once if you lose your phone. Store them somewhere safe (a password manager). They will not be shown again.' }),
                h('div', { class: 'codes' }, codes.map((c) => h('span', { text: c }))),
            ),
            actions: [
                { label: 'Copy', onClick: async () => { await copyText(codes.join('\n')); return false; } },
                { label: 'Download', onClick: () => { const a = h('a', { href: URL.createObjectURL(new Blob([`OpenDBS recovery codes for ${state.user.username}\n\n${codes.join('\n')}\n`], { type: 'text/plain' })), download: 'opendbs-recovery-codes.txt' }); document.body.appendChild(a); a.click(); a.remove(); return false; } },
                { label: 'I saved them', kind: 'primary', value: true },
            ],
        });

        if (!st.enabled) {
            card.append(
                h('p', null, h('span', { class: 'badge badge-warn', text: 'off' }), 'Protect your account with a code from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password…).'),
                h('div', null, h('button', {
                    class: 'btn btn-primary', type: 'button', onclick: async () => {
                        try {
                            const setup = await api('/api/auth/2fa/setup', { method: 'POST' });
                            const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '123456', class: 'mono' });
                            let result = null;
                            const ok = await openDialog({
                                title: 'Set up two-factor authentication',
                                body: h('div', { class: 'stack' },
                                    h('p', { text: '1. Scan this QR code with your authenticator app.' }),
                                    h('img', { src: setup.qrDataUrl, alt: 'QR code for your authenticator app', class: 'qr' }),
                                    h('p', { class: 'small muted' }, 'Can’t scan? Enter this key manually: ', h('span', { class: 'mono', text: setup.secret.replace(/(.{4})/g, '$1 ').trim() })),
                                    h('label', null, '2. Enter the 6-digit code the app shows', code)),
                                actions: [
                                    { label: 'Cancel', value: false },
                                    { label: 'Verify & enable', kind: 'primary', onClick: async () => { result = await api('/api/auth/2fa/enable', { method: 'POST', body: { code: code.value.trim() } }); return true; } },
                                ],
                            });
                            if (ok && result) {
                                setToken(result.token); // this session is now 2FA-verified
                                await showCodes(result.recoveryCodes);
                                toast('Two-factor authentication is on', 'ok');
                                await enterApp();
                            }
                        } catch (e) { toast(e.message, 'error'); }
                    },
                }, 'Enable 2FA')));
            return card;
        }

        card.append(
            h('p', null, h('span', { class: 'badge badge-ok', text: 'on' }), `Enabled ${fmtDate(st.enabledAt)} · ${st.recoveryCodesLeft} recovery code(s) left`),
            st.recoveryCodesLeft <= 3 ? h('p', { class: 'error small', text: 'You are running low on recovery codes — generate new ones.' }) : null,
            h('div', { class: 'row gap wrap' },
                h('button', {
                    class: 'btn', type: 'button', onclick: async () => {
                        const code = h('input', { inputmode: 'numeric', maxlength: '6', class: 'mono', placeholder: '123456' });
                        let codes = null;
                        const ok = await openDialog({
                            title: 'New recovery codes',
                            body: h('div', { class: 'stack' }, h('p', { text: 'Your old recovery codes stop working.' }), h('label', null, 'Current code from your app', code)),
                            actions: [{ label: 'Cancel', value: false }, { label: 'Generate', kind: 'primary', onClick: async () => { codes = (await api('/api/auth/2fa/recovery-codes', { method: 'POST', body: { code: code.value.trim() } })).recoveryCodes; return true; } }],
                        });
                        if (ok && codes) { await showCodes(codes); route(); }
                    },
                }, 'New recovery codes'),
                h('button', {
                    class: 'btn btn-danger', type: 'button', onclick: async () => {
                        const password = h('input', { type: 'password', autocomplete: 'current-password' });
                        const code = h('input', { maxlength: '20', class: 'mono', placeholder: '123456 or recovery code' });
                        const ok = await openDialog({
                            title: 'Turn off two-factor authentication',
                            body: h('div', { class: 'stack' },
                                state.uiConfig.require2fa ? h('p', { class: 'error', text: 'This server requires 2FA for admins — you will be locked out of the admin panel until you enable it again.' }) : null,
                                h('label', null, 'Password', password), h('label', null, 'Authentication code', code)),
                            actions: [{ label: 'Cancel', value: false }, { label: 'Turn off', kind: 'danger', onClick: async () => { await api('/api/auth/2fa/disable', { method: 'POST', body: { password: password.value, code: code.value.trim() } }); return true; } }],
                        });
                        if (ok) signOut('Two-factor authentication turned off. Sign in again.');
                    },
                }, 'Turn off 2FA')));
        return card;
    }

    function passwordCard() {
        const cur = h('input', { type: 'password', autocomplete: 'current-password', maxlength: '256' });
        const pw = h('input', { type: 'password', autocomplete: 'new-password', maxlength: '72' });
        const pw2 = h('input', { type: 'password', autocomplete: 'new-password', maxlength: '72' });
        return h('div', { class: 'card' },
            h('h2', { text: 'Change my password' }),
            h('div', { class: 'grid' },
                h('label', null, 'Current password', cur),
                h('label', null, 'New password (8+ chars, a letter and a digit)', pw),
                h('label', null, 'Repeat new password', pw2),
                h('div', null, h('button', {
                    class: 'btn btn-primary', type: 'button', onclick: async () => {
                        if (pw.value !== pw2.value) return toast('Passwords do not match', 'error');
                        try {
                            const r = await api('/api/auth/me/password', { method: 'PUT', body: { currentPassword: cur.value, password: pw.value } });
                            if (r.token) setToken(r.token);
                            cur.value = pw.value = pw2.value = '';
                            toast('Password changed. Other sessions were signed out.', 'ok');
                        } catch (e) { toast(e.message, 'error'); }
                    },
                }, 'Update password'))));
    }

    async function serverSettingsCard() {
        const card = h('div', { class: 'card stack' }, h('h2', { text: 'Server settings' }));
        const { settings } = await api('/api/admin/env-settings');
        const inputs = {};
        const groups = {};
        for (const s of settings) {
            let input;
            if (s.type === 'bool') input = h('select', null, h('option', { value: 'true', selected: s.value === 'true' }, 'On'), h('option', { value: 'false', selected: s.value !== 'true' }, 'Off'));
            else if (s.type === 'enum') input = h('select', null, s.options.map((o) => h('option', { value: o, selected: o === s.value }, o)));
            else if (s.type === 'int') input = h('input', { type: 'number', step: '1', min: s.min, max: s.max, value: s.value });
            else if (s.type === 'secret') input = h('input', { type: 'password', autocomplete: 'new-password', placeholder: s.isSet ? '•••••• set — leave blank to keep' : 'not set', value: '' });
            else input = h('input', { value: s.value, class: s.type === 'list' ? 'mono' : '' });
            inputs[s.key] = { input, original: s.type === 'secret' ? '' : s.value };
            (groups[s.group] = groups[s.group] || []).push(h('label', null,
                h('span', null, h('strong', { text: s.label }), h('span', { class: 'muted mono small', text: `  ${s.key}` })),
                input,
                h('span', { class: 'muted small', text: s.help })));
        }
        for (const [g, items] of Object.entries(groups)) card.append(h('fieldset', null, h('legend', { text: g }), h('div', { class: 'form-grid' }, items)));
        card.append(
            h('p', { class: 'muted small', text: 'Saved to .env. Changes take effect after you restart the server. Admin-panel access settings (ADMIN_PANEL_*, ADMIN_ALLOWED_IPS, ADMIN_REQUIRE_2FA) can only be changed in .env on the server.' }),
            h('div', null, h('button', {
                class: 'btn btn-primary', type: 'button', onclick: async () => {
                    const changed = {};
                    for (const [k, { input, original }] of Object.entries(inputs)) if (input.value !== original) changed[k] = input.value;
                    if (Object.keys(changed).length === 0) return toast('No changes');
                    const warn = changed.JWT_SECRET ? ' Changing JWT_SECRET signs everyone out.' : '';
                    if (!await confirmDialog('Save server settings', `Update ${Object.keys(changed).join(', ')}? Restart the server to apply.${warn}`, { confirmText: 'Save' })) return;
                    try {
                        await api('/api/admin/env-settings', { method: 'PUT', body: changed });
                        toast('Saved. Restart the server to apply the changes.', 'ok');
                        route();
                    } catch (e) { toast(e.message, 'error'); }
                },
            }, 'Save settings')));
        return card;
    }

    async function viewSettings(main) {
        const banner = state.mfaRequired
            ? h('div', { class: 'banner' }, h('strong', { text: 'Two-factor authentication is required. ' }),
                'This server requires admins to use 2FA. Enable it below — the rest of the panel unlocks once it is on.')
            : null;
        const [tf, srv] = await Promise.all([
            twoFactorCard(),
            state.mfaRequired ? Promise.resolve(null) : serverSettingsCard().catch((e) => h('div', { class: 'card' }, h('p', { class: 'error', text: e.message }))),
        ]);
        clear(main).append(
            pageHead('Settings'),
            banner,
            h('div', { class: 'grid grid-2' }, tf, passwordCard()),
            srv ? h('div', { class: 'mt' }, srv) : null,
        );
    }

    // ───────────────────────── boot ─────────────────────────

    function applyTheme(theme) {
        if (theme) document.documentElement.setAttribute('data-theme', theme);
        else document.documentElement.removeAttribute('data-theme');
    }

    function init() {
        applyTheme(safeGet(localStorage, THEME_KEY));
        $('#themeBtn').addEventListener('click', () => {
            const current = document.documentElement.getAttribute('data-theme')
                || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
            const next = current === 'dark' ? 'light' : 'dark';
            safeSet(localStorage, THEME_KEY, next);
            applyTheme(next);
        });
        $('#menuBtn').addEventListener('click', () => setMenu(!$('#sidebar').classList.contains('open')));
        $('#loginForm').addEventListener('submit', onLogin);
        $('#loginBack').addEventListener('click', () => { state.challenge = null; $('#loginError').textContent = ''; showLoginStep('password'); });
        for (const ev of ['mousemove', 'keydown', 'click', 'touchstart', 'scroll']) {
            window.addEventListener(ev, () => { state.lastActivity = Date.now(); }, { passive: true });
        }
        $('#logoutBtn').addEventListener('click', () => signOut());
        window.addEventListener('hashchange', route);

        // Version on the login screen (only when the server exposes it publicly).
        fetch('/api/version', { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .then((v) => { if (v && v.version) $('#loginVersion').textContent = `OpenDBS v${v.version}`; })
            .catch(() => undefined);

        if (state.token) {
            enterApp().catch(() => signOut());
        } else {
            signOut();
        }
    }

    init();
})();
