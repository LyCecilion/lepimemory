import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { initialState, validateState } from './shared/state.js';

export const SCHEMA_VERSION = 1;
const HISTORY_KINDS = new Map(['audit', 'recall', 'retain', 'forget', 'action', 'control', 'consent', 'task'].map(kind => [kind, kind]));
const LEGACY_FILES = ['audit.jsonl', 'recall.jsonl', 'retain.jsonl', 'forget.jsonl', 'action.jsonl'];
const TABLES = ['meta', 'state', 'evidence', 'requests', 'snapshots', 'lifecycle', 'grants', 'tasks', 'raw_links', 'forget_scopes', 'history_work', 'actions', 'settled_turns', 'audit'];
const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL CHECK(json_valid(json)));
CREATE TABLE evidence (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
    seq INTEGER NOT NULL, block_index INTEGER NOT NULL CHECK(block_index>=0),
    start INTEGER NOT NULL CHECK(start>=0), end INTEGER NOT NULL CHECK(end>=start),
    actor TEXT NOT NULL CHECK(actor IN ('user','assistant','action','context')),
    at INTEGER NOT NULL, kind TEXT NOT NULL,
    UNIQUE(session_id,message_id,seq,block_index,start,end)
);
CREATE TABLE requests (
    id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, session_id TEXT, turn INTEGER, step INTEGER,
    kind TEXT NOT NULL, status TEXT NOT NULL,
    source_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_ids_json)),
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error_code TEXT
);
CREATE TABLE snapshots (
    candidate_id TEXT PRIMARY KEY, json TEXT NOT NULL CHECK(json_valid(json)),
    payload_hash TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TRIGGER snapshots_immutable BEFORE UPDATE ON snapshots BEGIN
    SELECT RAISE(ABORT, 'LEPI_SNAPSHOT_IMMUTABLE');
END;
CREATE TABLE grants (
    id TEXT PRIMARY KEY, scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
    source_ids_json TEXT NOT NULL CHECK(json_valid(source_ids_json)), session_id TEXT,
    expires_at INTEGER NOT NULL, revoked_at INTEGER,
    allow_inference INTEGER NOT NULL DEFAULT 0 CHECK(allow_inference IN (0,1))
);
CREATE TABLE lifecycle (
    candidate_id TEXT PRIMARY KEY REFERENCES snapshots(candidate_id),
    status TEXT NOT NULL CHECK(status IN ('pending','active','history_only','superseded','forgotten','audit_only','unknown')),
    purpose TEXT NOT NULL, superseded_by TEXT, confirmed_by TEXT, grant_id TEXT,
    policy_epoch INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE tasks (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('normalize','admit','write','curate','history')),
    candidate_id TEXT, request_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending','running','submitted','deferred','written','reconciled','unknown','failed','cancelled','expired')),
    draft_json TEXT CHECK(draft_json IS NULL OR json_valid(draft_json)),
    payload_json TEXT CHECK(payload_json IS NULL OR json_valid(payload_json)),
    operation_id TEXT UNIQUE, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
    next_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, lease_owner TEXT, submitted_at INTEGER, error_code TEXT
);
CREATE INDEX tasks_ready ON tasks(status,next_at);
CREATE TABLE raw_links (
    raw_id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES snapshots(candidate_id),
    document_id TEXT NOT NULL, version_hash TEXT NOT NULL, state TEXT NOT NULL, verified_at INTEGER NOT NULL
);
CREATE TABLE forget_scopes (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL,
    candidate_ids_json TEXT NOT NULL CHECK(json_valid(candidate_ids_json)),
    selector_json TEXT NOT NULL CHECK(json_valid(selector_json)),
    active INTEGER NOT NULL CHECK(active IN (0,1)), epoch INTEGER NOT NULL
);
CREATE TABLE history_work (
    session_id TEXT NOT NULL, epoch INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','applied','blocked')),
    captured_seq INTEGER, plan_json TEXT CHECK(plan_json IS NULL OR json_valid(plan_json)), error_code TEXT,
    PRIMARY KEY(session_id,epoch)
);
CREATE TABLE actions (
    action_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn INTEGER, step INTEGER,
    call_id TEXT NOT NULL, title TEXT, path TEXT, temp_path TEXT, body_hash TEXT,
    status TEXT NOT NULL CHECK(status IN ('prepared','executed','rejected','cancelled','unavailable','failed','unknown')),
    error_code TEXT, state_applied INTEGER NOT NULL DEFAULT 0 CHECK(state_applied IN (0,1)),
    UNIQUE(session_id,call_id)
);
CREATE TABLE settled_turns (
    session_id TEXT NOT NULL, turn INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(session_id,turn)
);
CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL,
    session_id TEXT, turn INTEGER, step INTEGER, call_id TEXT, request_id TEXT, task_id TEXT,
    candidate_id TEXT, operation_id TEXT, data_json TEXT NOT NULL CHECK(json_valid(data_json))
);
CREATE INDEX audit_kind ON audit(type,id DESC);
`;

/** 历史过滤的唯一口径：`history()` 与 `historyGroups()` 共用同一 where/args，避免两处漂移。 */
function historyScope(kind) {
    if (kind === 'audit') return { where: '', args: [] };
    if (kind === 'task') return { where: 'WHERE type=? OR type LIKE ? OR task_id IS NOT NULL', args: [kind, `${kind}.%`] };
    return { where: 'WHERE type=? OR type LIKE ?', args: [kind, `${kind}.%`] };
}

/** 分组键 SQL 片段：候选 > 任务 > 请求 > 单条（与既有客户端语义一致）。 */
const GROUP_KEY_SQL = "CASE WHEN candidate_id IS NOT NULL THEN 'c:'||candidate_id WHEN task_id IS NOT NULL THEN 't:'||task_id WHEN request_id IS NOT NULL THEN 'r:'||request_id ELSE 'i:'||id END";

export class StoreError extends Error {
    constructor(code = 'LEPI_STORE_UNAVAILABLE') {
        super(code);
        this.code = code;
    }
}

function validState(state) {
    if (!validateState(state).ok) throw new StoreError('LEPI_STATE_INVALID');
    return state;
}

function ownerAlive(owner) {
    if (!owner || typeof owner.host !== 'string' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.nonce !== 'string') throw new StoreError();
    if (owner.host !== os.hostname()) return true;
    try { process.kill(owner.pid, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
}

function legacyData(dir) {
    const stateFile = path.join(dir, 'state.json');
    let state = null;
    const files = [];
    if (fs.existsSync(stateFile)) {
        try { state = validState(JSON.parse(fs.readFileSync(stateFile, 'utf8'))); }
        catch { throw new StoreError('LEPI_STATE_INVALID'); }
        files.push(stateFile);
    }
    const rows = [];
    for (const name of LEGACY_FILES) {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) continue;
        files.push(file);
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            if (!line.trim()) continue;
            const data = JSON.parse(line);
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new StoreError();
            rows.push({ kind: name.slice(0, -6), data });
        }
    }
    return { state, files, rows };
}

function archiveLegacy(files, dir, now) {
    if (!files.length) return null;
    const archive = path.join(dir, `legacy-${now}-${randomUUID()}`);
    fs.mkdirSync(archive, { mode: 0o700 });
    for (const file of files) {
        const copy = path.join(archive, path.basename(file));
        fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(copy, 0o600);
        const fd = fs.openSync(copy, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    return archive;
}

export class Store {
    #depth = 0;
    #closed = false;
    #owner = null;
    constructor(db, { now, readOnly }) {
        this.db = db;
        this.now = now;
        this.readOnly = readOnly;
    }

    transaction(fn) {
        if (this.#closed || this.readOnly || typeof fn !== 'function' || fn.constructor.name === 'AsyncFunction') throw new StoreError();
        const depth = this.#depth++;
        const savepoint = `lepi_${depth}`;
        try {
            this.db.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
            const result = fn();
            if (result && typeof result.then === 'function') throw new StoreError();
            this.db.exec(depth ? `RELEASE ${savepoint}` : 'COMMIT');
            return result;
        } catch (error) {
            try {
                this.db.exec(depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
            } catch { /* A failed BEGIN has no transaction to roll back. Preserve its error. */ }
            throw error;
        } finally { this.#depth -= 1; }
    }

    audit(event) {
        if (this.#closed || this.readOnly) throw new StoreError();
        const identity = key => event[key] ?? null;
        const result = this.db.prepare(`INSERT INTO audit
            (at,type,status,session_id,turn,step,call_id,request_id,task_id,candidate_id,operation_id,data_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            event.at ?? this.now(), event.type, event.status,
            identity('session_id'), identity('turn'), identity('step'), identity('call_id'),
            identity('request_id'), identity('task_id'), identity('candidate_id'), identity('operation_id'),
            JSON.stringify(event.data ?? {}),
        );
        return Number(result.lastInsertRowid);
    }

    readState() {
        const row = this.db.prepare('SELECT json FROM state WHERE id=1').get();
        if (!row) throw new StoreError('LEPI_STATE_INVALID');
        try { return validState(JSON.parse(row.json)); }
        catch { throw new StoreError('LEPI_STATE_INVALID'); }
    }

    commitState(state, event) {
        validState(state);
        return this.transaction(() => {
            const before = this.readState();
            this.db.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(state));
            return this.audit({ ...event, data: { ...(event.data ?? {}), before, after: state } });
        });
    }

    history({ kind = 'audit', limit = 10, offset = 0 } = {}) {
        if (!HISTORY_KINDS.has(kind) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new StoreError();
        const { where, args } = historyScope(kind);
        const total = this.db.prepare(`SELECT count(*) AS n FROM audit ${where}`).get(...args).n;
        const items = this.db.prepare(`SELECT * FROM audit ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset)
            .map(row => ({ ...row, data: JSON.parse(row.data_json) }));
        return { kind, total, limit, offset, items };
    }

    /** 按「主体」分组的分页：以组为单位分页，组内阶段新→旧。 */
    historyGroups({ kind = 'audit', limit = 10, offset = 0, stages = 50 } = {}) {
        if (!HISTORY_KINDS.has(kind) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0
            || !Number.isSafeInteger(stages) || stages < 1 || stages > 100) throw new StoreError();
        const { where, args } = historyScope(kind);
        const total = this.db.prepare(`SELECT count(DISTINCT ${GROUP_KEY_SQL}) AS n FROM audit ${where}`).get(...args).n;
        const keys = this.db.prepare(`SELECT ${GROUP_KEY_SQL} AS gkey, MAX(id) AS latest FROM audit ${where} GROUP BY gkey ORDER BY latest DESC LIMIT ? OFFSET ?`)
            .all(...args, limit, offset);
        const stageStmt = this.db.prepare(`SELECT * FROM audit WHERE ${GROUP_KEY_SQL} = ? ORDER BY id DESC LIMIT ?`);
        const groups = keys.map(({ gkey }) => {
            const rows = stageStmt.all(gkey, stages + 1);
            return {
                key: gkey,
                truncated: rows.length > stages,
                items: rows.slice(0, stages).map(row => ({ ...row, data: JSON.parse(row.data_json) })),
            };
        });
        return { kind, total, limit, offset, groups };
    }

    get policyEpoch() {
        return Number(this.db.prepare("SELECT value FROM meta WHERE key='policy_epoch'").get().value);
    }

    bumpPolicyEpoch() {
        if (!this.#depth || this.readOnly) throw new StoreError();
        this.db.prepare("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='policy_epoch'").run();
        return this.policyEpoch;
    }

    initialize({ fresh, legacyDir, initialLegacy }) {
        this.transaction(() => {
            if (fresh) {
                this.db.exec(SCHEMA);
                this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('schema_version', String(SCHEMA_VERSION));
                this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('policy_epoch', '0');
            }
            const prior = this.db.prepare("SELECT value FROM meta WHERE key='owner'").get();
            if (prior) {
                const owner = JSON.parse(prior.value);
                if (ownerAlive(owner)) throw new StoreError('LEPI_STORE_OWNED');
            }
            this.db.prepare(`UPDATE tasks SET lease_owner=NULL,
                status=CASE WHEN status='running' THEN CASE WHEN submitted_at IS NULL THEN 'pending' ELSE 'submitted' END ELSE status END,
                next_at=CASE WHEN status IN ('running','submitted') THEN ? ELSE next_at END
                WHERE lease_owner IS NOT NULL`).run(this.now());
            this.#owner = JSON.stringify({ host: os.hostname(), pid: process.pid, nonce: randomUUID() });
            this.db.prepare("INSERT INTO meta(key,value) VALUES ('owner',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(this.#owner);
            if (!this.db.prepare("SELECT value FROM meta WHERE key='legacy_migrated'").get()) {
                const legacy = initialLegacy ?? legacyData(legacyDir);
                const archive = archiveLegacy(legacy.files, legacyDir, this.now());
                if (!this.db.prepare('SELECT id FROM state WHERE id=1').get()) {
                    const state = legacy.state ?? initialState(new Date(this.now()).toISOString());
                    this.db.prepare('INSERT INTO state(id,json) VALUES (1,?)').run(JSON.stringify(state));
                }
                for (const { kind, data } of legacy.rows) {
                    const parsedAt = typeof data.at === 'number' ? data.at : Date.parse(data.at);
                    this.audit({ type: kind, status: data.ok === false || data.isError === true ? 'failed' : 'unknown',
                        at: Number.isSafeInteger(parsedAt) ? parsedAt : this.now(),
                        session_id: data.session_id ?? data.session ?? null,
                        turn: data.turn ?? null, step: data.step ?? null, call_id: data.call_id ?? data.callId ?? null,
                        data: { legacy: true, record: data } });
                }
                this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('legacy_migrated', String(this.now()));
                if (archive) this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('legacy_archive', archive);
            }
            this.readState();
        });
    }

    close() {
        if (this.#closed) return;
        try {
            if (!this.readOnly && this.#owner) this.transaction(() => {
                this.db.prepare("DELETE FROM meta WHERE key='owner' AND value=?").run(this.#owner);
            });
        } finally {
            this.db.close();
            this.#closed = true;
        }
    }
}

export function openStore({ dbFile, legacyDir = path.dirname(dbFile), now = Date.now, readOnly = false }) {
    let db;
    let createdStat;
    try {
        const fresh = !fs.existsSync(dbFile);
        const initialLegacy = fresh && !readOnly ? legacyData(legacyDir) : null;
        if (readOnly && fresh) throw new StoreError();
        if (!readOnly) {
            fs.mkdirSync(path.dirname(dbFile), { recursive: true, mode: 0o700 });
            // Network-shared homes are unsupported. Known Linux network FS types
            // are rejected; a foreign-host owner is never reclaimed either.
            const type = fs.statfsSync(path.dirname(dbFile)).type;
            if ([0x6969, 0xff534d42, 0x517b, 0xfe534d42].includes(type)) throw new StoreError();
            if (fresh) {
                const fd = fs.openSync(dbFile, 'wx', 0o600);
                try { createdStat = fs.fstatSync(fd, { bigint: true }); }
                finally { fs.closeSync(fd); }
            }
        }
        db = new DatabaseSync(dbFile, { readOnly });
        if (!fresh) {
            const version = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value;
            if (version !== String(SCHEMA_VERSION)) throw new StoreError();
            const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
            if (TABLES.some(name => !present.has(name))) throw new StoreError();
        }
        db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;');
        if (readOnly) db.exec('PRAGMA query_only=ON;');
        else {
            db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
            fs.chmodSync(dbFile, 0o600);
        }
        const store = new Store(db, { now, readOnly });
        if (!readOnly) store.initialize({ fresh, legacyDir, initialLegacy });
        else store.readState();
        return store;
    } catch (error) {
        if (db) try { db.close(); } catch { /* Preserve the opening error. */ }
        if (createdStat && fs.existsSync(dbFile)) {
            const current = fs.statSync(dbFile, { bigint: true });
            if (current.dev === createdStat.dev && current.ino === createdStat.ino) fs.unlinkSync(dbFile);
        }
        if (error instanceof StoreError) throw error;
        throw new StoreError();
    }
}
