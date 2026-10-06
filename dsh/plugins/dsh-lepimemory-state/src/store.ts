import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { initialState, validateState, type LepiState } from './shared/state.js';
import type { ActionStatus, LifecycleStatus, SourceActor, TaskKind, TaskStatus } from './shared/domain.js';

export const SCHEMA_VERSION = 1;
const HISTORY_KINDS: Record<string, true> = {
    audit: true, recall: true, retain: true, forget: true, action: true, control: true, consent: true, task: true,
};
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

// ── SQLite row shapes owned by this module ───────────────────────────
/** `evidence` row;正文 never lives here (see evidence.ts). */
export interface EvidenceRow {
    id: string;
    session_id: string;
    message_id: string;
    seq: number;
    block_index: number;
    start: number;
    end: number;
    actor: SourceActor;
    at: number;
    kind: string;
}
/** `lifecycle` row. */
export interface LifecycleRow {
    candidate_id: string;
    status: LifecycleStatus;
    purpose: string;
    superseded_by: string | null;
    confirmed_by: string | null;
    grant_id: string | null;
    policy_epoch: number;
    updated_at: number;
}
/** `grants` row. */
export interface GrantRow {
    id: string;
    scope_json: string;
    source_ids_json: string;
    session_id: string | null;
    expires_at: number;
    revoked_at: number | null;
    allow_inference: number;
}
/** `snapshots` row (immutable; enforced by trigger). */
export interface SnapshotRow {
    candidate_id: string;
    json: string;
    payload_hash: string;
    created_at: number;
}
/** `tasks` row. */
export interface TaskRowRecord {
    id: string;
    kind: TaskKind;
    candidate_id: string | null;
    request_id: string | null;
    status: TaskStatus;
    draft_json: string | null;
    payload_json: string | null;
    operation_id: string | null;
    attempts: number;
    next_at: number;
    expires_at: number;
    lease_owner: string | null;
    submitted_at: number | null;
    error_code: string | null;
}
/** `audit` row. */
export interface AuditRow {
    id: number;
    at: number;
    type: string;
    status: string;
    session_id: string | null;
    turn: number | null;
    step: number | null;
    call_id: string | null;
    request_id: string | null;
    task_id: string | null;
    candidate_id: string | null;
    operation_id: string | null;
    data_json: string;
}
/** `actions` row. */
export interface ActionRow {
    action_id: string;
    session_id: string;
    turn: number | null;
    step: number | null;
    call_id: string;
    title: string | null;
    path: string | null;
    temp_path: string | null;
    body_hash: string | null;
    status: ActionStatus;
    error_code: string | null;
    state_applied: number;
}

type SqlParam = string | number | bigint | null;
/** Assertion boundary: `node:sqlite` exposes rows as `Record<string, SQLOutputValue>`. */
function getRow<T>(stmt: StatementSync, ...params: SqlParam[]): T | undefined {
    return stmt.get(...params) as unknown as T | undefined;
}
function getRows<T>(stmt: StatementSync, ...params: SqlParam[]): T[] {
    return stmt.all(...params) as unknown as T[];
}

/** Event accepted by {@link Store.audit}; absent identity fields are bound as NULL. */
export interface AuditEvent {
    type: string;
    status: string;
    at?: number;
    session_id?: string | number | null;
    turn?: number | null;
    step?: number | null;
    call_id?: string | null;
    request_id?: string | null;
    task_id?: string | null;
    candidate_id?: string | null;
    operation_id?: string | null;
    data?: Record<string, unknown>;
}

/** 历史过滤的唯一口径：`history()` 与 `historyGroups()` 共用同一 where/args，避免两处漂移。 */
function historyScope(kind: string): { where: string; args: string[] } {
    if (kind === 'audit') return { where: '', args: [] };
    if (kind === 'task') return { where: 'WHERE type=? OR type LIKE ? OR task_id IS NOT NULL', args: [kind, `${kind}.%`] };
    return { where: 'WHERE type=? OR type LIKE ?', args: [kind, `${kind}.%`] };
}

/** 分组键 SQL 片段：候选 > 任务 > 请求 > 单条（与既有客户端语义一致）。 */
const GROUP_KEY_SQL = "CASE WHEN candidate_id IS NOT NULL THEN 'c:'||candidate_id WHEN task_id IS NOT NULL THEN 't:'||task_id WHEN request_id IS NOT NULL THEN 'r:'||request_id ELSE 'i:'||id END";

export class StoreError extends Error {
    readonly code: string;
    constructor(code = 'LEPI_STORE_UNAVAILABLE') {
        super(code);
        this.code = code;
    }
}

function validState(state: unknown): LepiState {
    if (!validateState(state).ok) throw new StoreError('LEPI_STATE_INVALID');
    return state as LepiState;
}

function ownerAlive(owner: unknown): boolean {
    if (!owner || typeof owner !== 'object') throw new StoreError();
    // Boundary read of the persisted owner record; each field is validated below.
    const { host, pid, nonce } = owner as { host?: unknown; pid?: unknown; nonce?: unknown };
    if (typeof host !== 'string' || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || typeof nonce !== 'string') throw new StoreError();
    if (host !== os.hostname()) return true;
    try { process.kill(pid, 0); return true; }
    catch (error) {
        if (error && typeof error === 'object' && 'code' in error) return error.code !== 'ESRCH';
        return true;
    }
}

interface LegacyRow {
    kind: string;
    data: Record<string, unknown>;
}
interface LegacyData {
    state: LepiState | null;
    files: string[];
    rows: LegacyRow[];
}

function legacyData(dir: string): LegacyData {
    const stateFile = path.join(dir, 'state.json');
    let state: LepiState | null = null;
    const files: string[] = [];
    if (fs.existsSync(stateFile)) {
        try { state = validState(JSON.parse(fs.readFileSync(stateFile, 'utf8'))); }
        catch { throw new StoreError('LEPI_STATE_INVALID'); }
        files.push(stateFile);
    }
    const rows: LegacyRow[] = [];
    for (const name of LEGACY_FILES) {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) continue;
        files.push(file);
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            if (!line.trim()) continue;
            const data: unknown = JSON.parse(line);
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new StoreError();
            rows.push({ kind: name.slice(0, -6), data: data as Record<string, unknown> });
        }
    }
    return { state, files, rows };
}

function archiveLegacy(files: string[], dir: string, now: number): string | null {
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

interface HistoryQuery {
    kind?: string;
    limit?: number;
    offset?: number;
}
interface HistoryGroupsQuery extends HistoryQuery {
    stages?: number;
}
type HistoryItem = AuditRow & { data: unknown };
export interface HistoryPage {
    kind: string;
    total: number;
    limit: number;
    offset: number;
    items: HistoryItem[];
}
export interface HistoryGroupsPage {
    kind: string;
    total: number;
    limit: number;
    offset: number;
    groups: Array<{ key: string; truncated: boolean; items: HistoryItem[] }>;
}

export class Store {
    readonly db: DatabaseSync;
    readonly now: () => number;
    readonly readOnly: boolean;
    #depth = 0;
    #closed = false;
    #owner: string | null = null;
    constructor(db: DatabaseSync, { now, readOnly }: { now: () => number; readOnly: boolean }) {
        this.db = db;
        this.now = now;
        this.readOnly = readOnly;
    }

    transaction<T>(fn: () => T): T {
        if (this.#closed || this.readOnly || typeof fn !== 'function' || fn.constructor.name === 'AsyncFunction') throw new StoreError();
        const depth = this.#depth++;
        const savepoint = `lepi_${depth}`;
        try {
            this.db.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
            const result = fn();
            if (result != null && typeof result === 'object' && 'then' in result && typeof result.then === 'function') throw new StoreError();
            this.db.exec(depth ? `RELEASE ${savepoint}` : 'COMMIT');
            return result;
        } catch (error) {
            try {
                this.db.exec(depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
            } catch { /* A failed BEGIN has no transaction to roll back. Preserve its error. */ }
            throw error;
        } finally { this.#depth -= 1; }
    }

    audit(event: AuditEvent): number {
        if (this.#closed || this.readOnly) throw new StoreError();
        const identity = (key: 'session_id' | 'turn' | 'step' | 'call_id' | 'request_id' | 'task_id' | 'candidate_id' | 'operation_id') => event[key] ?? null;
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

    readState(): LepiState {
        const row = getRow<{ json?: unknown }>(this.db.prepare('SELECT json FROM state WHERE id=1'));
        if (!row || typeof row.json !== 'string') throw new StoreError('LEPI_STATE_INVALID');
        try { return validState(JSON.parse(row.json)); }
        catch { throw new StoreError('LEPI_STATE_INVALID'); }
    }

    commitState(state: LepiState, event: AuditEvent): number {
        validState(state);
        return this.transaction(() => {
            const before = this.readState();
            this.db.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(state));
            return this.audit({ ...event, data: { ...(event.data ?? {}), before, after: state } });
        });
    }

    history({ kind = 'audit', limit = 10, offset = 0 }: HistoryQuery = {}): HistoryPage {
        if (HISTORY_KINDS[kind] !== true || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new StoreError();
        const { where, args } = historyScope(kind);
        const total = getRow<{ n: number }>(this.db.prepare(`SELECT count(*) AS n FROM audit ${where}`), ...args)?.n ?? 0;
        const items = getRows<AuditRow>(this.db.prepare(`SELECT * FROM audit ${where} ORDER BY id DESC LIMIT ? OFFSET ?`), ...args, limit, offset)
            .map(row => ({ ...row, data: JSON.parse(row.data_json) }));
        return { kind, total, limit, offset, items };
    }

    /** 按「主体」分组的分页：以组为单位分页，组内阶段新→旧。 */
    historyGroups({ kind = 'audit', limit = 10, offset = 0, stages = 50 }: HistoryGroupsQuery = {}): HistoryGroupsPage {
        if (HISTORY_KINDS[kind] !== true || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0
            || !Number.isSafeInteger(stages) || stages < 1 || stages > 100) throw new StoreError();
        const { where, args } = historyScope(kind);
        const total = getRow<{ n: number }>(this.db.prepare(`SELECT count(DISTINCT ${GROUP_KEY_SQL}) AS n FROM audit ${where}`), ...args)?.n ?? 0;
        const keys = getRows<{ gkey: string; latest: number }>(this.db.prepare(`SELECT ${GROUP_KEY_SQL} AS gkey, MAX(id) AS latest FROM audit ${where} GROUP BY gkey ORDER BY latest DESC LIMIT ? OFFSET ?`), ...args, limit, offset);
        const stageStmt = this.db.prepare(`SELECT * FROM audit WHERE ${GROUP_KEY_SQL} = ? ORDER BY id DESC LIMIT ?`);
        const groups = keys.map(({ gkey }) => {
            const rows = getRows<AuditRow>(stageStmt, gkey, stages + 1);
            return {
                key: gkey,
                truncated: rows.length > stages,
                items: rows.slice(0, stages).map(row => ({ ...row, data: JSON.parse(row.data_json) })),
            };
        });
        return { kind, total, limit, offset, groups };
    }

    get policyEpoch(): number {
        const row = getRow<{ value: unknown }>(this.db.prepare("SELECT value FROM meta WHERE key='policy_epoch'"));
        if (!row) throw new StoreError('LEPI_STATE_INVALID');
        return Number(row.value);
    }

    bumpPolicyEpoch(): number {
        if (!this.#depth || this.readOnly) throw new StoreError();
        this.db.prepare("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='policy_epoch'").run();
        return this.policyEpoch;
    }

    initialize({ fresh, legacyDir, initialLegacy }: { fresh: boolean; legacyDir: string; initialLegacy: LegacyData | null }): void {
        this.transaction(() => {
            if (fresh) {
                this.db.exec(SCHEMA);
                this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('schema_version', String(SCHEMA_VERSION));
                this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('policy_epoch', '0');
            }
            const prior = getRow<{ value: unknown }>(this.db.prepare("SELECT value FROM meta WHERE key='owner'"));
            if (prior) {
                const owner: unknown = JSON.parse(prior.value as string);
                if (ownerAlive(owner)) throw new StoreError('LEPI_STORE_OWNED');
            }
            this.db.prepare(`UPDATE tasks SET lease_owner=NULL,
                status=CASE WHEN status='running' THEN CASE WHEN submitted_at IS NULL THEN 'pending' ELSE 'submitted' END ELSE status END,
                next_at=CASE WHEN status IN ('running','submitted') THEN ? ELSE next_at END
                WHERE lease_owner IS NOT NULL`).run(this.now());
            this.#owner = JSON.stringify({ host: os.hostname(), pid: process.pid, nonce: randomUUID() });
            this.db.prepare("INSERT INTO meta(key,value) VALUES ('owner',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(this.#owner);
            if (!getRow(this.db.prepare("SELECT value FROM meta WHERE key='legacy_migrated'"))) {
                const legacy = initialLegacy ?? legacyData(legacyDir);
                const archive = archiveLegacy(legacy.files, legacyDir, this.now());
                if (!getRow(this.db.prepare('SELECT id FROM state WHERE id=1'))) {
                    const state = legacy.state ?? initialState(new Date(this.now()).toISOString());
                    this.db.prepare('INSERT INTO state(id,json) VALUES (1,?)').run(JSON.stringify(state));
                }
                for (const { kind, data } of legacy.rows) {
                    const parsedAt = typeof data.at === 'number' ? data.at : Date.parse(data.at as string);
                    this.audit({ type: kind, status: data.ok === false || data.isError === true ? 'failed' : 'unknown',
                        at: Number.isSafeInteger(parsedAt) ? parsedAt : this.now(),
                        session_id: (data.session_id ?? data.session) as string | number | null,
                        turn: (data.turn ?? null) as number | null, step: (data.step ?? null) as number | null,
                        call_id: (data.call_id ?? data.callId ?? null) as string | null,
                        data: { legacy: true, record: data } });
                }
                this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('legacy_migrated', String(this.now()));
                if (archive) this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('legacy_archive', archive);
            }
            this.readState();
        });
    }

    close(): void {
        if (this.#closed) return;
        const owner = this.#owner;
        try {
            if (!this.readOnly && owner) this.transaction(() => {
                this.db.prepare("DELETE FROM meta WHERE key='owner' AND value=?").run(owner);
            });
        } finally {
            this.db.close();
            this.#closed = true;
        }
    }
}

export interface OpenStoreOptions {
    dbFile: string;
    legacyDir?: string;
    now?: () => number;
    readOnly?: boolean;
}

export function openStore({ dbFile, legacyDir = path.dirname(dbFile), now = Date.now, readOnly = false }: OpenStoreOptions): Store {
    let db: DatabaseSync | undefined;
    let createdStat: fs.BigIntStats | undefined;
    try {
        const fresh = !fs.existsSync(dbFile);
        const initialLegacy = fresh && !readOnly ? legacyData(legacyDir) : null;
        if (readOnly && fresh) throw new StoreError();
        if (!readOnly) {
            fs.mkdirSync(path.dirname(dbFile), { recursive: true, mode: 0o700 });
            // Network-shared homes are unsupported. Known Linux network FS types
            // are rejected; a foreign-host owner is never reclaimed either.
            const type = Number(fs.statfsSync(path.dirname(dbFile)).type);
            if ([0x6969, 0xff534d42, 0x517b, 0xfe534d42].includes(type)) throw new StoreError();
            if (fresh) {
                const fd = fs.openSync(dbFile, 'wx', 0o600);
                try { createdStat = fs.fstatSync(fd, { bigint: true }); }
                finally { fs.closeSync(fd); }
            }
        }
        db = new DatabaseSync(dbFile, { readOnly });
        if (!fresh) {
            const version = getRow<{ value?: unknown }>(db.prepare("SELECT value FROM meta WHERE key='schema_version'"))?.value;
            if (version !== String(SCHEMA_VERSION)) throw new StoreError();
            const present = new Set(getRows<{ name: unknown }>(db.prepare("SELECT name FROM sqlite_master WHERE type='table'")).map(row => row.name));
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
