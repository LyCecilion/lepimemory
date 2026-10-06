/** Approved candidate scheduling and verifiable remote work share one supervisor. */

import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { StatementSync } from 'node:sqlite';
import { createWriteWorker } from './write-worker.js';
import { createCurateWorker } from './curate-worker.js';
import { loadSource } from './raw-source.js';
import type { SourceSnapshot } from './raw-source.js';
import { createRecaller } from './recall.js';
import type { RecallInput } from './recall.js';
import type { HindsightClient } from './hindsight.js';
import type { EvidenceIndex, ExcludedEvidence, ResolvedEvidence } from './evidence.js';
import type { GrantRow, LifecycleRow, Store, TaskRowRecord } from './store.js';

/** node:sqlite 边界：绑定参数与「按调用处已知行形状读取」的断言出口。 */
type SqlParam = string | number | bigint | null;
/** `get()` 返回 `Record<string, SQLOutputValue>`；调用处已读 SQL 行形状，故集中断言。 */
function firstRow<T>(stmt: StatementSync, ...params: SqlParam[]): T | undefined {
    return stmt.get(...params) as unknown as T | undefined;
}
/** `all()` 同 {@link firstRow}，用于已知行形状的集合读取。 */
function allRows<T>(stmt: StatementSync, ...params: SqlParam[]): T[] {
    return stmt.all(...params) as unknown as T[];
}

const NORMALIZE = 'normalize';
const ADMIT = 'admit';
const WRITE = 'write';

/** 有界网络退避（毫秒）：最多三次重试 1s/2s/4s，仍失败才 deferred。 */
const BACKOFF = [1000, 2000, 4000] as const;

/** supervisor 固定 tick（PLAN：唯一 supervisor 2s tick）。 */
const TICK_MS = 2000;

/** 只处理这些 turn/end reason（rc2 `TurnEndReasonMap`）；其余不算「已交付」的结束。 */
const DELIVERED_REASONS = new Set<string>(['completed', 'interrupted', 'aborted']);

/** 可被 operator retry 唤醒的终态/停顿态（不复活 cancelled/expired 的政策性终止）。 */
const RETRYABLE_STATUS = new Set<string>(['deferred', 'unknown', 'failed']);

const GENERIC_CODE = 'LEPI_CONTROL_UNAVAILABLE';
const RESUBMIT_CODE = 'LEPI_INPUT_RESUBMIT_REQUIRED';

// ── 内部行形状 / 依赖面 ─────────────────────────────────────────────

/** `forget_scopes` 行（只读其 selector / candidate_ids / epoch）。 */
interface ForgetScopeRow {
    id: string;
    selector_json: string;
    candidate_ids_json?: string | null;
    epoch?: number;
}
/** 请求行的只读投影（policy 检查需要 kind/payload）。 */
interface RequestRow {
    kind: string;
    payload_json: string | null;
}
/** normalize 源窗口行（evidence 只读投影）。 */
interface WindowRow {
    id: string;
    actor: string;
}
/** 任务审计身份（缺省字段入库为 NULL）。 */
interface AuditIdentity {
    session_id?: string | null;
    turn?: number | null;
    step?: number | null;
    request_id?: string | null;
    task_id?: string | null;
    candidate_id?: string | null;
    operation_id?: string | null;
}
/** candidate 在本模块内消费的结构面（处理器绑定 + 系统赋值身份）。 */
interface MemoryCandidate {
    candidate_id: string;
    request_id: string | null;
    formed_at: string;
    explicit: boolean;
    text: string;
    content_kind: string;
    origin: string;
    sensitivity: string;
    subject_key: string;
    facet_key: string;
    source_ids: string[];
    valid_from: string | null;
    valid_until: string | null;
    occurred_start: string | null;
    occurred_end: string | null;
    occurrence: string;
}
/** 一次 normalize/admit 的政策作用域（authorizeAndCommit 会推进 epoch）。 */
interface Scope {
    agent: MemoryAgent;
    signal: AbortSignal | undefined;
    sessionId: string;
    explicit: boolean;
    requestId: string | null;
    requestKind: string | null;
    turn: number | null;
    epoch: number;
    fence: number;
}
/** 会话/事件的最小读取面（真实 Session/evidence ID）。 */
interface MemoryAgent {
    id: string;
}
interface TurnStart {
    turn: unknown;
    seq: number;
}
/** 会话事件边界读取：`session/event` 的真实事件先按 unknown 收窄，只读本模块用到的字段。 */
function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}
interface EnqueueInput {
    request_id?: string | null;
    session_id?: string | null;
    source_ids?: readonly unknown[];
    kind?: string | null;
    explicit?: boolean;
    turn?: number | null;
}
interface MemoryContext {
    agents?: { get(id: string): MemoryAgent | undefined; roots?(): MemoryAgent[] };
}
/** supervisor 作业槽 / recall 作业。 */
interface RecallWork {
    controller: AbortController;
    promise: Promise<unknown> | null;
}
type Outcome = 'approved' | 'rejected' | 'cancelled' | 'suppressed' | 'failed' | 'deferred';

/** `extract` 的输入面：处理器只按已读字段取用；`request_id` 允许显式 null（同原调用）。 */
interface ExtractInput {
    agent?: unknown;
    source_ids?: readonly string[];
    explicit?: boolean;
    request_id?: string | null;
    [key: string]: unknown;
}
/** admission.evaluate 的返回值面（只读这些判定/元数据字段）。 */
interface AdmissionResult {
    verdict?: string;
    reason_code?: string;
    score?: number | null;
    backend?: string;
    model?: string | null;
    revision?: string | null;
    truncated?: boolean;
}
/** 已构造 processor 的消费面（extract / matchGrant）。 */
interface MemoryProcessor {
    extract(input: ExtractInput, options?: { signal?: AbortSignal }): Promise<{ candidates: MemoryCandidate[] }>;
    matchGrant(candidate: unknown, grant: unknown, options?: { purpose?: string; agent?: unknown; sources?: readonly unknown[]; signal?: AbortSignal }): Promise<object | null>;
}
/** 已构造 admission 的消费面（evaluate / health）。 */
interface MemoryAdmission {
    evaluate(candidate: unknown, options?: { signal?: AbortSignal; agent?: unknown }): Promise<AdmissionResult>;
    health?(): Record<string, unknown>;
}
/** recall.ts 消费的观察核验面（该模块未导出 ProcessorLike；此处按已读成员重建窄面）。 */
interface VerifiableProcessor {
    verifyObservation(input: unknown, options?: { signal?: AbortSignal }):
        Promise<{ safe?: boolean; used_source_ids?: string[] } | null> | { safe?: boolean; used_source_ids?: string[] } | null;
}
/** evidence.read 的结果面。 */
interface EvidenceRead {
    sources: ResolvedEvidence[];
    excluded: ExcludedEvidence[];
}
/** 任务级 prepared SQL 缓存。 */
interface Statements {
    findTask: StatementSync;
    claim: StatementSync;
    markRunning: StatementSync;
    byRequest: StatementSync;
    turnTasks: StatementSync;
    windowIds: StatementSync;
    fence: StatementSync;
    blocked: StatementSync;
    activeScopes: StatementSync;
    liveGrants: StatementSync;
    grantById: StatementSync;
    insertSnapshot: StatementSync;
    insertLifecycle: StatementSync;
    insertTask: StatementSync;
    expire: StatementSync;
    expireOne: StatementSync;
    orphanWrites: StatementSync;
    markAuditOnly: StatementSync;
    counts: StatementSync;
}
interface MemoryHealth {
    started: boolean;
    disposed: boolean;
    running: string | null;
    tasks: Record<string, Record<string, number>>;
    total: number;
    writeExecutor: true;
    remoteRunning: boolean;
    admission: Record<string, unknown> | null;
    last_error: string | null;
}
interface MemoryRetryReceipt {
    task_id: string;
    kind: string;
    status: string;
    code: string | null;
    retryable: boolean;
}
/** 召回结果的最小可命名面（recall.ts 的 RecallProjection 未导出）。 */
interface MemoryRecall {
    picked: readonly unknown[];
    excluded: readonly unknown[];
    sources: readonly unknown[];
    text: string;
    audit_id: number;
    code: string | null;
}

/** 稳定错误码读取（第三方/自有错误都可能带 code）。 */
function errorCodeOf(error: unknown): string | null {
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
    return null;
}

function parseJson<T>(text: unknown, fallback: T): T {
    if (typeof text !== 'string') return fallback;
    try {
        const value: unknown = JSON.parse(text);
        return Array.isArray(fallback) ? (Array.isArray(value) ? value as T : fallback)
            : value && typeof value === 'object' && !Array.isArray(value) ? value as T : fallback;
    } catch {
        return fallback;
    }
}

function arrayEq(a: unknown, b: unknown): boolean {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

function hashText(text: string): string {
    return createHash('sha256').update(text).digest('hex');
}

/** processor.matchGrant 返回未类型化 object；本模块只读其 `match` 判别字段。 */
function matchKind(value: object | null | undefined): string | undefined {
    if (!value || !('match' in value)) return undefined;
    return typeof value.match === 'string' ? value.match : undefined;
}

/**
 * @param deps.ctx cordis 上下文（只读 `agents.get/roots`）。
 * @param deps.config `resolveConfig` 产物（只读 timeouts.taskTtlMs）。
 * @param deps.store `openStore` 产物（同步事务；本模块是唯一 writer）。
 * @param deps.processor `createProcessor` 产物（`extract`/`matchGrant`）。
 * @param deps.admission `createAdmission` 产物（`evaluate`/`health`）。
 * @param deps.hindsight Hindsight REST client.
 * @param deps.evidence `createEvidenceIndex` 产物（`read`）。
 * @param deps.askPrivate 单项私密授权询问（control 门面）。
 * @param deps.now 可注入时钟。
 */
export function createMemoryRuntime({
    ctx,
    config,
    store,
    processor,
    admission,
    hindsight,
    evidence,
    askPrivate,
    now = Date.now,
}: {
    ctx: MemoryContext;
    config?: { timeouts?: { taskTtlMs?: number } } | null;
    store: Store;
    processor: MemoryProcessor;
    admission: MemoryAdmission;
    hindsight: HindsightClient;
    evidence: EvidenceIndex;
    askPrivate(candidate: MemoryCandidate, agent: MemoryAgent, options: { signal?: AbortSignal }): Promise<{ outcome: string; grant_id: string | null }>;
    now?: () => number;
}) {
    const db = store.db;
    const taskTtlMs = config?.timeouts?.taskTtlMs ?? 604800000;

    // 运行期堆状态（构造器不做任何工作；不注册、不起 timer、不写库）。
    const turnStarts = new Map<string, TurnStart>(); // sessionId -> { turn, seq }
    const controllers = new Map<string, AbortController>(); // taskId -> AbortController
    let started = false;
    let disposed = false;
    let tickTimer: NodeJS.Timeout | null = null;
    let wakeTimer: NodeJS.Timeout | null = null;
    let job: Promise<void> | null = null; // 当前 normalize/admit 作业的 promise
    let remoteJob: Promise<void> | null = null;
    let remoteController: AbortController | null = null;
    let preferCurate = true;
    const recallJobs = new Set<RecallWork>();
    let currentTaskId: string | null = null;
    let ownerId: string | null = null; // 懒生成：lease owner 标识
    let sql: Statements | null = null;
    let lastError: string | null = null;

    function statements(): Statements {
        return (sql ??= {
            findTask: db.prepare('SELECT * FROM tasks WHERE id=?'),
            claim: db.prepare(`SELECT * FROM tasks WHERE kind IN ('${NORMALIZE}','${ADMIT}')
          AND status='pending' AND next_at<=? AND expires_at>? ORDER BY next_at, rowid LIMIT 1`),
            markRunning: db.prepare("UPDATE tasks SET status='running', lease_owner=? WHERE id=?"),
            byRequest: db.prepare(`SELECT id FROM tasks WHERE kind='${NORMALIZE}' AND request_id=? LIMIT 1`),
            turnTasks: db.prepare(`SELECT id, payload_json FROM tasks WHERE kind='${NORMALIZE}'`),
            windowIds: db.prepare(`SELECT id, actor FROM evidence WHERE session_id=? AND kind<>'splice'
          AND actor IN ('user','assistant','action') AND seq>? AND seq<=? ORDER BY seq, block_index`),
            fence: db.prepare('SELECT max(epoch) AS epoch FROM forget_scopes'),
            blocked: db.prepare("SELECT 1 FROM history_work WHERE session_id=? AND status!='applied' LIMIT 1"),
            activeScopes: db.prepare('SELECT id, selector_json FROM forget_scopes WHERE active=1'),
            liveGrants: db.prepare('SELECT * FROM grants WHERE revoked_at IS NULL AND expires_at>?'),
            grantById: db.prepare('SELECT * FROM grants WHERE id=?'),
            insertSnapshot: db.prepare('INSERT INTO snapshots(candidate_id,json,payload_hash,created_at) VALUES (?,?,?,?)'),
            insertLifecycle: db.prepare(`INSERT INTO lifecycle
          (candidate_id,status,purpose,superseded_by,confirmed_by,grant_id,policy_epoch,updated_at)
          VALUES (?,?,?,?,?,?,?,?)`),
            insertTask: db.prepare(`INSERT INTO tasks
          (id,kind,candidate_id,request_id,status,draft_json,payload_json,next_at,expires_at)
          VALUES (?,?,?,?,?,?,?,?,?)`),
            expire: db.prepare(`SELECT id,kind,payload_json FROM tasks WHERE kind<>'curate' AND submitted_at IS NULL
          AND status IN ('pending','deferred','running') AND expires_at<=?`),
            expireOne: db.prepare("UPDATE tasks SET status='expired', lease_owner=NULL, draft_json=NULL, payload_json=? WHERE id=?"),
            orphanWrites: db.prepare(`SELECT candidate_id FROM lifecycle WHERE status='pending'
          AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.candidate_id=lifecycle.candidate_id
          AND t.kind='${WRITE}' AND t.status IN ('pending','running','submitted','deferred'))`),
            markAuditOnly: db.prepare("UPDATE lifecycle SET status='audit_only', updated_at=? WHERE candidate_id=? AND status='pending'"),
            counts: db.prepare('SELECT kind, status, count(*) AS n FROM tasks GROUP BY kind, status'),
        });
    }

    async function checkWritePolicy(source: SourceSnapshot | null, task: TaskRowRecord,
        { signal, restore = false }: { signal?: AbortSignal; restore?: boolean } = {}): Promise<{ allowed: boolean; epoch: number; code: string | null }> {
        const epoch = store.policyEpoch;
        const denied = (code: string): { allowed: boolean; epoch: number; code: string | null } => ({ allowed: false, epoch, code });
        if (disposed || signal?.aborted) return denied('LEPI_WORKER_STOPPED');
        if (!source) return denied('LEPI_SNAPSHOT_INVALID');
        source = loadSource(store, source.candidate.candidate_id);
        if (!source) return denied('LEPI_SNAPSHOT_INVALID');
        const candidate = source.candidate;
        const lifecycle = source.lifecycle as unknown as LifecycleRow;
        const payload = parseJson<Record<string, unknown>>(task.payload_json, {});
        const restoring = restore && task.kind === 'curate' && payload.kind === 'restore'
            && Array.isArray(payload.candidate_ids) && payload.candidate_ids.includes(candidate.candidate_id);
        if (restoring ? lifecycle.status !== 'unknown'
            : !['pending', ...(task.submitted_at != null ? ['unknown'] : [])].includes(lifecycle.status))
            return denied('LEPI_MEMORY_SUPPRESSED');
        if (candidate.sensitivity === 'excluded') return denied('LEPI_MEMORY_SUPPRESSED');
        if (candidate.sensitivity === 'private') {
            const grant = lifecycle.grant_id ? firstRow<GrantRow>(statements().grantById, lifecycle.grant_id) : undefined;
            if (!grant || grant.revoked_at != null || grant.expires_at <= now()) return denied('LEPI_GRANT_INVALID');
            const scope = parseJson<Record<string, unknown>>(grant.scope_json, {});
            if (!(typeof scope.kind === 'string' && ['item', 'topic', 'continuous'].includes(scope.kind))
                || (candidate.origin === 'inference' && !grant.allow_inference)) return denied('LEPI_GRANT_INVALID');
            if (scope.kind === 'item' && (scope.candidate_id !== candidate.candidate_id
                || !arrayEq(parseJson(grant.source_ids_json, []), candidate.source_ids))) return denied('LEPI_GRANT_INVALID');
            const sessionId = payload.session_id ?? firstRow<{ session_id: string }>(db.prepare('SELECT session_id FROM evidence WHERE id=?'), candidate.source_ids[0] ?? null)?.session_id;
            if (scope.session_id != null && scope.session_id !== sessionId) return denied('LEPI_GRANT_INVALID');
        }
        const request = task.request_id ? firstRow<RequestRow>(db.prepare('SELECT kind,payload_json FROM requests WHERE id=?'), task.request_id) : undefined;
        const exceptions = new Set<string>(request?.kind === 're_remember'
            ? parseJson<string[]>(request.payload_json, []) : []);
        for (const row of allRows<ForgetScopeRow>(db.prepare('SELECT * FROM forget_scopes WHERE active=1'))) {
            if (parseJson<string[]>(row.candidate_ids_json, []).includes(candidate.candidate_id)) return denied('LEPI_MEMORY_SUPPRESSED');
            if (exceptions.has(row.id) || (row.epoch ?? 0) <= Number(lifecycle.policy_epoch)) continue;
            const selector = parseJson<Record<string, unknown>>(row.selector_json, {});
            if (!selector.subject_key || !selector.facet_key) return denied('LEPI_MEMORY_SUPPRESSED');
            // Classify typed scope only: never re-send an old potentially forgotten value to a model.
            const typed = { subject_key: candidate.subject_key, facet_key: candidate.facet_key,
                origin: candidate.origin, source_ids: [] as string[], text: '' };
            const match = await processor.matchGrant(typed, { id: row.id, scope: {
                kind: 'topic', subject_key: selector.subject_key, topic: selector.facet_key,
                session_id: null, allow_inference: false,
            } }, { purpose: 'forget', signal, sources: [] });
            if (disposed || signal?.aborted || store.policyEpoch !== epoch) return denied('LEPI_POLICY_CHANGED');
            if (matchKind(match) !== 'not_covered') return denied('LEPI_MEMORY_SUPPRESSED');
        }
        if (store.policyEpoch !== epoch) return denied('LEPI_POLICY_CHANGED');
        return { allowed: true, epoch, code: null };
    }

    const writeWorker = createWriteWorker({ store, hindsight, checkPolicy: checkWritePolicy, now });
    const curateWorker = createCurateWorker({ store, hindsight, checkPolicy: checkWritePolicy, now });
    // recall.ts 只消费 verifyObservation；其 ProcessorLike 未导出，按已读成员做窄断言。
    const recaller = createRecaller({ store, hindsight, processor: processor as unknown as VerifiableProcessor, now });

    function runRecall(input: RecallInput, auxiliary = false): Promise<MemoryRecall> {
        if (disposed) throw Object.assign(new Error('LEPI_WORKER_STOPPED'), { code: 'LEPI_WORKER_STOPPED' });
        const controller = new AbortController();
        const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
        const work: RecallWork = { controller, promise: null };
        recallJobs.add(work);
        const promise = (auxiliary ? recaller.readMemory : recaller.recall)({ ...input, signal });
        work.promise = promise;
        return promise.finally(() => recallJobs.delete(work));
    }

    function leaseOwner(): string {
        return (ownerId ??= `${process.pid}-${randomUUID()}`);
    }

    function latestFence(): number {
        const row = firstRow<{ epoch: number | null }>(statements().fence);
        return row?.epoch ?? 0;
    }

    function fenced(sessionId: string | null | undefined): boolean {
        if (!sessionId) return false;
        try { return Boolean(firstRow<Record<string, unknown>>(statements().blocked, sessionId)); } catch { return true; }
    }

    function liveRoot(agent: MemoryAgent | undefined): boolean {
        if (disposed || !agent) return false;
        const get = ctx?.agents?.get;
        if (typeof get !== 'function' || get.call(ctx.agents, agent.id) !== agent) return false;
        const roots = ctx?.agents?.roots;
        if (typeof roots === 'function' && !roots.call(ctx.agents).includes(agent)) return false;
        return true;
    }

    function current(scope: Scope): boolean {
        return liveRoot(scope.agent) && !scope.signal?.aborted && !fenced(scope.sessionId)
            && store.policyEpoch === scope.epoch && latestFence() === scope.fence;
    }

    async function sourcesCurrent(candidate: MemoryCandidate, scope: Scope): Promise<boolean> {
        if (!current(scope)) return false;
        try {
            const read = await evidence.read(candidate.source_ids, { agent: scope.agent, signal: scope.signal, request_id: scope.requestId ?? undefined });
            return current(scope) && candidate.source_ids.every(id => read.sources.some(source => source.id === id));
        } catch { return false; }
    }

    /** 后台审计：真实 session/turn/step/IDs；背景动作没有 tool/call，call_id 恒为 NULL。 */
    function audit(type: string, status: string, identity: AuditIdentity = {}, data: Record<string, unknown> = {}): void {
        try {
            store.audit({
                type, status, at: now(),
                session_id: identity.session_id ?? null, turn: identity.turn ?? null, step: identity.step ?? null,
                call_id: null,
                request_id: identity.request_id ?? null, task_id: identity.task_id ?? null,
                candidate_id: identity.candidate_id ?? null, operation_id: identity.operation_id ?? null,
                data,
            });
        } catch (error) {
            lastError = errorCodeOf(error) ?? GENERIC_CODE;
            throw error;
        }
    }

    function identityOf(task: TaskRowRecord): AuditIdentity {
        const payload = parseJson<Record<string, unknown>>(task.payload_json, {});
        return {
            session_id: (payload.session_id as string | undefined) ?? null,
            request_id: task.request_id ?? (payload.request_id as string | undefined) ?? null,
            candidate_id: task.candidate_id ?? null,
            turn: (payload.turn as number | undefined) ?? null,
        };
    }

    // ── 任务终态/重试 ──────────────────────────────────────────────────
    function finish(task: TaskRowRecord, status: string, code: string | null = null, { clearDraft = false }: { clearDraft?: boolean } = {}): void {
        const row = firstRow<TaskRowRecord>(statements().findTask, task.id);
        if (!row || !['running', 'pending'].includes(row.status)) return;
        try {
            store.transaction(() => {
                db.prepare('UPDATE tasks SET status=?, error_code=?, lease_owner=NULL, next_at=?, draft_json=? WHERE id=?')
                    .run(status, code, now(), clearDraft ? null : task.draft_json, task.id);
                audit('task', status, { ...identityOf(task), task_id: task.id }, { kind: task.kind, code });
            });
        } catch (error) {
            lastError = errorCodeOf(error) ?? GENERIC_CODE;
        }
    }

    /** 有界网络退避：最多三次（1s/2s/4s）置回 pending；到顶转 deferred。绝不复活已终态任务。 */
    function scheduleRetry(task: TaskRowRecord, code: string = GENERIC_CODE): void {
        try {
            const row = firstRow<TaskRowRecord>(statements().findTask, task.id);
            if (!row || !['running', 'pending'].includes(row.status)) return;
            store.transaction(() => {
                const retries = (task.attempts ?? 0) + 1;
                if (retries > BACKOFF.length) {
                    db.prepare("UPDATE tasks SET attempts=?, status='deferred', error_code=?, lease_owner=NULL, next_at=? WHERE id=?")
                        .run(retries, code, now(), task.id);
                    audit('task', 'deferred', { ...identityOf(task), task_id: task.id }, { kind: task.kind, code });
                } else {
                    db.prepare("UPDATE tasks SET attempts=?, status='pending', error_code=?, lease_owner=NULL, next_at=? WHERE id=?")
                        .run(retries, code, now() + (BACKOFF[retries - 1] ?? 0), task.id);
                    audit('task', 'retrying', { ...identityOf(task), task_id: task.id }, { kind: task.kind, code, attempt: retries });
                }
            });
        } catch (error) {
            lastError = errorCodeOf(error) ?? GENERIC_CODE;
        }
    }

    function patchPayload(task: TaskRowRecord, patch: Record<string, unknown>): Record<string, unknown> {
        try {
            const next = { ...parseJson<Record<string, unknown>>(task.payload_json, {}), ...patch };
            store.transaction(() => db.prepare('UPDATE tasks SET payload_json=? WHERE id=?').run(JSON.stringify(next), task.id));
            task.payload_json = JSON.stringify(next);
            return next;
        } catch (error) {
            lastError = errorCodeOf(error) ?? GENERIC_CODE;
            return parseJson<Record<string, unknown>>(task.payload_json, {});
        }
    }

    // ── enqueue / afterTurn（只入 refs；去重按真实 request/turn 元数据）─────
    function enqueue(input: EnqueueInput): { task_id: string } {
        if (disposed) throw new Error(GENERIC_CODE);
        const requestId = typeof input?.request_id === 'string' && input.request_id ? input.request_id : null;
        const sessionId = typeof input?.session_id === 'string' ? input.session_id : null;
        const sourceIds = Array.isArray(input?.source_ids) ? [...new Set(input.source_ids.filter((id): id is string => typeof id === 'string' && id !== ''))] : [];
        if (!sessionId || sourceIds.length === 0) throw new Error(GENERIC_CODE);

        if (requestId) {
            const existing = firstRow<{ id: string }>(statements().byRequest, requestId);
            if (existing) return { task_id: existing.id };
        }

        const id = randomUUID();
        const payload = {
            session_id: sessionId,
            source_ids: sourceIds,
            kind: input.kind ?? null,
            explicit: input.explicit === true,
            request_id: requestId,
            turn: Number.isSafeInteger(input.turn) ? input.turn : null,
        };
        store.transaction(() => {
            statements().insertTask.run(id, NORMALIZE, null, requestId, 'pending', null, JSON.stringify(payload), now(), now() + taskTtlMs);
            audit('task', 'pending', { session_id: sessionId, request_id: requestId, task_id: id }, { kind: NORMALIZE, source_count: sourceIds.length, explicit: payload.explicit });
        });
        wake();
        return { task_id: id };
    }

    function evidenceForTurn(sessionId: string, fromSeq: number, toSeq: number): WindowRow[] {
        try {
            return allRows<WindowRow>(statements().windowIds, sessionId, fromSeq, toSeq);
        } catch (error) {
            lastError = errorCodeOf(error) ?? GENERIC_CODE;
            return [];
        }
    }

    function turnAlreadyQueued(sessionId: string, turn: unknown): boolean {
        for (const row of allRows<{ id: string; payload_json: string | null }>(statements().turnTasks)) {
            const payload = parseJson<Record<string, unknown>>(row.payload_json, {});
            if (payload.session_id === sessionId && payload.turn === turn) return true;
        }
        return false;
    }

    /**
     * 只观测当前 turn/end 已交付的公共证据（真实 Session/evidence IDs），不做工具非 error 成功；
     * 未在当前 live 进程见证 turn/start 的结束（含冷 resume 的 interrupted closer）不重建。
     */
    function afterTurn(session: { id?: unknown } | null | undefined, event: unknown): void {
        if (disposed) return;
        const record = asRecord(event);
        if (!record) return;
        const type = record.type;
        if (typeof type !== 'string' || !type) return;
        const sessionId = String(session?.id ?? '');
        if (!sessionId) return;
        const data = asRecord(record.data);
        if (type === 'turn/start') {
            turnStarts.set(sessionId, { turn: data?.turn, seq: Number(record.seq) });
            return;
        }
        if (type !== 'turn/end') return;
        const start = turnStarts.get(sessionId);
        turnStarts.delete(sessionId);
        const reason = asRecord(data?.reason)?.kind;
        if (typeof reason !== 'string' || !DELIVERED_REASONS.has(reason)) return;
        if (!start) return; // 冷 resume：无本进程见证，不偷读/不重建
        const turn = typeof data?.turn === 'number' ? data.turn : undefined;
        const rows = evidenceForTurn(sessionId, start.seq, Number(record.seq));
        if (reason !== 'completed' && !rows.some(row => row.actor === 'assistant' || row.actor === 'action')) return;
        const sourceIds = rows.map(row => row.id);
        if (sourceIds.length === 0) return;
        if (turnAlreadyQueued(sessionId, turn)) return;
        const id = randomUUID();
        const payload = { session_id: sessionId, source_ids: sourceIds, kind: null, explicit: false, request_id: null, turn: turn ?? null };
        store.transaction(() => {
            statements().insertTask.run(id, NORMALIZE, null, null, 'pending', null, JSON.stringify(payload), now(), now() + taskTtlMs);
            audit('task', 'pending', { session_id: sessionId, turn: turn ?? null, task_id: id }, { kind: NORMALIZE, source_count: sourceIds.length, reason });
        });
        wake();
    }

    // ── 授权与落库 ─────────────────────────────────────────────────────
    function exceptionScopeIds(requestId: string | null): string[] {
        if (!requestId) return [];
        try {
            const row = firstRow<{ payload_json: string | null }>(db.prepare('SELECT payload_json FROM requests WHERE id=?'), requestId);
            const payload = parseJson<Record<string, unknown>>(row?.payload_json, {});
            return Array.isArray(payload.exception_scope_ids) ? payload.exception_scope_ids as string[] : [];
        } catch {
            return [];
        }
    }

    /** active forget scopes：仅用 typed selector 比对，绝不把旧正文喂给 checker。 */
    async function suppressionMatch(candidate: MemoryCandidate, scope: Scope): Promise<boolean> {
        const { agent, signal, requestId, requestKind } = scope;
        let scopes: ForgetScopeRow[];
        try { scopes = allRows<ForgetScopeRow>(statements().activeScopes); } catch { return true; } // 读取失败：保守抑制
        if (!scopes.length) return false;
        const exceptions = new Set<string>(requestKind === 're_remember' ? exceptionScopeIds(requestId) : []);
        for (const row of scopes) {
            if (exceptions.has(row.id)) continue;
            const selector = parseJson<Record<string, unknown>>(row.selector_json, {});
            if (!selector.subject_key || !selector.facet_key) return true; // 无法核验：保守抑制
            const grant = { scope: { kind: 'topic', subject_key: selector.subject_key, topic: selector.facet_key, session_id: null, allow_inference: false }, id: row.id };
            let match: object | null | undefined;
            try { match = await processor.matchGrant(candidate, grant, { purpose: 'forget', agent, signal }); }
            catch { return true; }
            if (!current(scope)) return true;
            const kind = matchKind(match);
            if (kind === 'covered' || kind === 'uncertain') return true;
        }
        return false;
    }

    /** 既有授权覆盖：item 精确绑定候选/source；topic/continuous 语义覆盖 + allow_inference。 */
    async function matchActiveGrant(candidate: MemoryCandidate, scope: Scope): Promise<string | null> {
        const { agent, signal, sessionId } = scope;
        let grants: GrantRow[];
        try { grants = allRows<GrantRow>(statements().liveGrants, now()); } catch { return null; }
        for (const row of grants) {
            const grantScope = parseJson<Record<string, unknown>>(row.scope_json, {});
            if (!grantScope || (grantScope.kind !== 'item' && grantScope.kind !== 'topic' && grantScope.kind !== 'continuous')) continue;
            if (candidate.origin === 'inference' && !Number(grantScope.allow_inference)) continue;
            if (grantScope.kind === 'item') {
                if (grantScope.candidate_id !== candidate.candidate_id) continue;
                if (row.session_id !== sessionId) continue;
                if (!arrayEq(parseJson(row.source_ids_json, []), candidate.source_ids)) continue;
            } else if (grantScope.kind === 'topic') {
                if (grantScope.session_id != null && grantScope.session_id !== sessionId) continue;
            } else if (grantScope.kind === 'continuous') {
                if (grantScope.session_id != null) continue;
            }
            let match: object | null | undefined;
            try { match = await processor.matchGrant(candidate, { scope: grantScope, id: row.id }, { agent, signal }); }
            catch { return null; }
            if (!current(scope)) return null;
            if (matchKind(match) === 'covered') return row.id;
        }
        return null;
    }

    /** 核验自身 per-item 授权：候选/source 精确、live、未撤销/未过期、恰 +1 epoch、fence 未变。 */
    function validateOwnGrant(grantId: string, candidate: MemoryCandidate,
        { agent, sessionId, epochBefore, fenceBefore }: { agent: MemoryAgent; sessionId: string; epochBefore: number; fenceBefore: number }): boolean {
        let row: GrantRow | undefined;
        try { row = firstRow<GrantRow>(statements().grantById, grantId); } catch { return false; }
        if (!row) return false;
        if (row.revoked_at != null || Number(row.expires_at) <= now()) return false;
        if (row.session_id !== sessionId) return false;
        const scope = parseJson<Record<string, unknown>>(row.scope_json, {});
        if (scope.kind !== 'item' || scope.candidate_id !== candidate.candidate_id) return false;
        if (!arrayEq(parseJson(row.source_ids_json, []), candidate.source_ids)) return false;
        if (Number(scope.allow_inference) !== (candidate.origin === 'inference' ? 1 : 0)) return false;
        if (!liveRoot(agent)) return false;
        if (store.policyEpoch !== epochBefore + 1) return false;
        if (latestFence() !== fenceBefore) return false;
        return true;
    }

    /** INSERT 快照 + lifecycle pending + pending write 任务，同一事务；正文只在获准后落库。 */
    function commitApproved(candidate: MemoryCandidate, scope: Scope, grantId: string | null, reasonCode: string,
        expectedEpoch: number, expectedFence: number): boolean {
        const snapshotJson = JSON.stringify(candidate);
        const payloadHash = hashText(snapshotJson);
        const writeId = randomUUID();
        try {
            store.transaction(() => {
                if (store.policyEpoch !== expectedEpoch) throw Object.assign(new Error(RESUBMIT_CODE), { code: RESUBMIT_CODE });
                if (latestFence() !== expectedFence) throw Object.assign(new Error(RESUBMIT_CODE), { code: RESUBMIT_CODE });
                statements().insertSnapshot.run(candidate.candidate_id, snapshotJson, payloadHash, now());
                statements().insertLifecycle.run(
                    candidate.candidate_id, 'pending', 'current', null,
                    grantId ?? (scope.explicit ? 'explicit_request' : 'auto'), grantId, store.policyEpoch, now(),
                );
                statements().insertTask.run(
                    writeId, WRITE, candidate.candidate_id, scope.requestId ?? null, 'pending', null,
                    JSON.stringify({ session_id: scope.sessionId, request_id: scope.requestId ?? null }),
                    now(), now() + taskTtlMs,
                );
                audit('retain', 'pending', {
                    session_id: scope.sessionId, turn: scope.turn, request_id: scope.requestId,
                    candidate_id: candidate.candidate_id, task_id: writeId,
                }, { content_kind: candidate.content_kind, origin: candidate.origin, sensitivity: candidate.sensitivity, reason_code: reasonCode, grant_id: grantId });
            });
            return true;
        } catch (error) {
            if (errorCodeOf(error) === RESUBMIT_CODE) return false;
            lastError = errorCodeOf(error) ?? GENERIC_CODE;
            throw error;
        }
    }

    async function authorizeAndCommit(candidate: MemoryCandidate, scope: Scope, reasonCode: string): Promise<Exclude<Outcome, 'deferred'>> {
        const { agent, signal, sessionId } = scope;
        if (!current(scope)) return 'cancelled';
        const epochNow = scope.epoch;
        const fenceNow = scope.fence;

        const suppressed = await suppressionMatch(candidate, scope);
        if (!current(scope)) return 'cancelled';
        if (suppressed) {
            audit('forget', 'suppressed', { session_id: sessionId, turn: scope.turn, request_id: scope.requestId, candidate_id: candidate.candidate_id }, { reason_code: 'forget_scope' });
            return scope.explicit ? 'suppressed' : 'rejected';
        }
        if (store.policyEpoch !== epochNow || latestFence() !== fenceNow) return 'cancelled';
        if (!await sourcesCurrent(candidate, scope)) return 'cancelled';

        let grantId: string | null = null;
        let expectedEpoch = epochNow;
        let expectedFence = fenceNow;
        if (candidate.sensitivity === 'private') {
            const matched = await matchActiveGrant(candidate, scope);
            if (!current(scope)) return 'cancelled';
            if (matched) {
                grantId = matched;
            } else {
                const epochBefore = store.policyEpoch;
                const fenceBefore = latestFence();
                let consent: { outcome: string; grant_id: string | null };
                try { consent = await askPrivate(candidate, agent, { signal }); }
                catch { consent = { outcome: 'unavailable', grant_id: null }; }
                if (!liveRoot(agent) || signal?.aborted) { audit('consent', 'cancelled', { session_id: sessionId, request_id: scope.requestId, candidate_id: candidate.candidate_id }); return 'cancelled'; }
                if (consent?.outcome !== 'allowed' || !consent.grant_id) {
                    audit('consent', consent?.outcome ?? 'unavailable', { session_id: sessionId, request_id: scope.requestId, candidate_id: candidate.candidate_id });
                    return consent?.outcome === 'rejected' ? 'rejected' : 'cancelled';
                }
                if (!validateOwnGrant(consent.grant_id, candidate, { agent, sessionId, epochBefore, fenceBefore })) {
                    audit('consent', 'cancelled', { session_id: sessionId, request_id: scope.requestId, candidate_id: candidate.candidate_id }, { reason_code: 'grant_invalid' });
                    return 'cancelled';
                }
                grantId = consent.grant_id;
                expectedEpoch = epochBefore + 1;
                expectedFence = fenceBefore;
                scope.epoch = expectedEpoch;
            }
        }

        if (!await sourcesCurrent(candidate, scope)) return 'cancelled';
        try {
            const committed = commitApproved(candidate, scope, grantId, reasonCode, expectedEpoch, expectedFence);
            return committed ? 'approved' : 'cancelled';
        } catch {
            return 'failed';
        }
    }

    // ── 候选处理 ───────────────────────────────────────────────────────
    function createAdmitTask(candidate: MemoryCandidate, scope: Scope, status: string): void {
        const id = randomUUID();
        const payload = { session_id: scope.sessionId, request_id: scope.requestId ?? null, kind: scope.requestKind ?? null, reason_code: null };
        store.transaction(() => {
            statements().insertTask.run(id, ADMIT, candidate.candidate_id ?? null, scope.requestId ?? null, status, JSON.stringify(candidate), JSON.stringify(payload), now(), now() + taskTtlMs);
            audit('retain', status, { session_id: scope.sessionId, turn: scope.turn, request_id: scope.requestId, candidate_id: candidate.candidate_id, task_id: id }, { content_kind: candidate.content_kind, origin: candidate.origin });
        });
        if (status === 'pending') wake();
    }

    async function evaluateAdmissionBounded(candidate: MemoryCandidate, scope: Scope): Promise<AdmissionResult | null> {
        const { agent, signal } = scope;
        for (let attempt = 0; ; attempt += 1) {
            if (!current(scope)) return null;
            let result: AdmissionResult | undefined;
            let transient: boolean;
            try { result = await admission.evaluate(candidate, { signal, agent }); transient = false; }
            catch (error) {
                if (error instanceof Error && error.name === 'AdmissionError') return { verdict: 'reject', reason_code: 'value_reject' };
                transient = true;
            }
            if (!current(scope)) return null;
            const deferredBackend = result?.verdict === 'defer' && result.reason_code === 'backend_unavailable';
            if (!transient && !deferredBackend) return result ?? null;
            if (attempt >= BACKOFF.length) return null;
            await delay(BACKOFF[attempt], undefined, { signal }).catch(() => {});
        }
    }

    async function processCandidate(candidate: MemoryCandidate, scope: Scope): Promise<Outcome> {
        const identity = { session_id: scope.sessionId, turn: scope.turn, request_id: scope.requestId, candidate_id: candidate.candidate_id };
        if (!current(scope)) return 'cancelled';
        if (candidate.sensitivity === 'excluded') {
            audit('retain', 'rejected', identity, { reason_code: 'excluded_source' });
            return 'rejected';
        }
        if (candidate.sensitivity === 'private') {
            // private 价值判断先在内存堆做；正文绝不进 queue/draft。
            let verdict = 'accept';
            let reasonCode = 'explicit_request';
            if (!scope.explicit) {
                const result = await evaluateAdmissionBounded(candidate, scope);
                if (!current(scope)) return 'cancelled';
                if (!result) { audit('retain', 'deferred', identity, { reason_code: 'backend_unavailable' }); return 'deferred'; }
                verdict = result.verdict ?? 'accept';
                reasonCode = result.reason_code ?? 'value_uncertain';
                audit('retain', 'admission', identity, { verdict, reason_code: reasonCode, score: result.score ?? null,
                    backend: result.backend ?? null, model: result.model ?? null, revision: result.revision ?? null, truncated: result.truncated === true });
            }
            if (verdict === 'reject') return 'rejected';
            if (verdict === 'defer') { audit('retain', 'deferred', identity, { reason_code: reasonCode }); return 'deferred'; }
            return authorizeAndCommit(candidate, scope, reasonCode);
        }
        // ordinary：明确请求直接处理；其余进 durable admit 任务由准入槽评估（允许持久 draft）。
        if (scope.explicit) return authorizeAndCommit(candidate, scope, 'explicit_request');
        createAdmitTask(candidate, scope, 'pending');
        return 'deferred';
    }

    // ── normalize 作业 ─────────────────────────────────────────────────
    async function runNormalize(task: TaskRowRecord, signal: AbortSignal): Promise<void> {
        const payload = parseJson<Record<string, unknown>>(task.payload_json, {});
        const sessionId = payload.session_id as string | undefined;
        const explicit = payload.explicit === true;
        const sourceIds = Array.isArray(payload.source_ids) ? payload.source_ids as string[] : [];
        if (!sessionId || sourceIds.length === 0) { finish(task, 'cancelled', null, { clearDraft: true }); return; }
        const epoch0 = store.policyEpoch;
        const fence0 = latestFence();
        const agent = ctx?.agents?.get?.(sessionId);
        if (!agent || !liveRoot(agent)) { finish(task, 'unknown', null, { clearDraft: true }); return; }
        if (fenced(sessionId)) { finish(task, explicit ? 'unknown' : 'cancelled', explicit ? RESUBMIT_CODE : null, { clearDraft: true }); return; }

        // 先只读一次以区分「政策/来源不可用」与普通失败分类。
        let read: EvidenceRead;
        try { read = await evidence.read(sourceIds, { agent, signal, request_id: payload.request_id as string | undefined }); }
        catch { scheduleRetry(task); return; }
        if (store.policyEpoch !== epoch0 || latestFence() !== fence0 || !liveRoot(agent)) {
            finish(task, 'unknown', RESUBMIT_CODE, { clearDraft: true }); return;
        }
        if (signal?.aborted) { finish(task, 'cancelled', null, { clearDraft: true }); return; }
        if (read.excluded.length > 0) {
            const resubmit = read.excluded.some((item) => item.code === RESUBMIT_CODE);
            finish(task, 'unknown', resubmit ? RESUBMIT_CODE : GENERIC_CODE, { clearDraft: true });
            return;
        }

        let extraction: { candidates: MemoryCandidate[] };
        try {
            extraction = await processor.extract({
                agent, source_ids: sourceIds, explicit,
                request_id: (payload.request_id as string | undefined) ?? null,
            }, { signal });
        } catch (error) {
            const code = errorCodeOf(error) ?? GENERIC_CODE;
            if (error instanceof Error && error.name === 'ContractError') {
                if (!payload.schema_retry) {
                    patchPayload(task, { schema_retry: true });
                    try {
                        store.transaction(() => db.prepare("UPDATE tasks SET status='pending', error_code=?, next_at=?, lease_owner=NULL WHERE id=?").run(code, now() + BACKOFF[0], task.id));
                    } catch (writeError) { lastError = errorCodeOf(writeError) ?? GENERIC_CODE; }
                    audit('task', 'retrying', { ...identityOf(task), task_id: task.id }, { kind: NORMALIZE, code, reason: 'schema' });
                } else {
                    finish(task, 'unknown', code, { clearDraft: true });
                }
                return;
            }
            // 确定性失败（重发无意义）不重试；其余按有界退避。
            if (code === RESUBMIT_CODE || code === 'LEPI_EVIDENCE_BUDGET') {
                finish(task, 'unknown', code, { clearDraft: true });
                return;
            }
            scheduleRetry(task, code);
            return;
        }
        if (signal?.aborted) { finish(task, 'cancelled', null, { clearDraft: true }); return; }
        if (store.policyEpoch !== epoch0 || latestFence() !== fence0 || !liveRoot(agent)) {
            finish(task, 'unknown', RESUBMIT_CODE, { clearDraft: true });
            return;
        }

        const baseScope: Scope = {
            agent, signal, sessionId, explicit,
            requestId: (payload.request_id as string | undefined) ?? null,
            requestKind: (payload.kind as string | undefined) ?? null,
            turn: (payload.turn as number | undefined) ?? null,
            epoch: epoch0, fence: fence0,
        };
        const outcomes: Outcome[] = [];
        for (const candidate of extraction.candidates ?? []) {
            if (signal?.aborted) { outcomes.push('cancelled'); break; }
            if (!liveRoot(agent)) { outcomes.push('cancelled'); break; }
            if (!current(baseScope)) { outcomes.push('cancelled'); break; }
            try { outcomes.push(await processCandidate(candidate, baseScope)); }
            catch (error) { lastError = errorCodeOf(error) ?? GENERIC_CODE; outcomes.push('failed'); }
        }

        if (outcomes.includes('failed')) finish(task, 'unknown', GENERIC_CODE);
        else if (explicit && outcomes.includes('suppressed')) finish(task, 'unknown', RESUBMIT_CODE);
        else finish(task, 'reconciled');
    }

    // ── admit 作业 ─────────────────────────────────────────────────────
    async function runAdmit(task: TaskRowRecord, signal: AbortSignal): Promise<void> {
        const draft = parseJson<Record<string, unknown> | null>(task.draft_json, null);
        const payload = parseJson<Record<string, unknown>>(task.payload_json, {});
        const sessionId = payload.session_id as string | undefined;
        const candidate = draft ? {
            ...draft,
            candidate_id: task.candidate_id ?? (draft.candidate_id as string),
            explicit: false,
            request_id: (payload.request_id as string | undefined) ?? (draft.request_id as string | undefined) ?? null,
        } as unknown as MemoryCandidate : null;
        if (!candidate || !sessionId) { finish(task, 'cancelled', null, { clearDraft: true }); return; }
        const agent = ctx?.agents?.get?.(sessionId);
        if (!agent || !liveRoot(agent)) { finish(task, 'unknown', null, { clearDraft: false }); return; }
        if (fenced(sessionId)) { finish(task, 'cancelled', null, { clearDraft: true }); return; }

        const epoch0 = store.policyEpoch;
        const scope: Scope = { agent, signal, sessionId, explicit: false, requestId: (payload.request_id as string | undefined) ?? null,
            requestKind: (payload.kind as string | undefined) ?? null, turn: null, epoch: epoch0, fence: latestFence() };
        if (!await sourcesCurrent(candidate, scope)) {
            finish(task, 'unknown', RESUBMIT_CODE, { clearDraft: true }); return;
        }
        let result: AdmissionResult | undefined;
        try { result = await admission.evaluate(candidate, { signal, agent }); }
        catch (error) {
            if (error instanceof Error && error.name === 'AdmissionError') { finish(task, 'cancelled', null, { clearDraft: true }); return; }
            const code = errorCodeOf(error);
            if (code === RESUBMIT_CODE || code === 'LEPI_EVIDENCE_BUDGET') { finish(task, 'unknown', code, { clearDraft: true }); return; }
            scheduleRetry(task);
            return;
        }
        if (signal?.aborted) { finish(task, 'cancelled', null, { clearDraft: false }); return; }
        if (!liveRoot(agent)) { finish(task, 'cancelled', null, { clearDraft: false }); return; }
        if (store.policyEpoch !== epoch0) { finish(task, 'unknown', RESUBMIT_CODE, { clearDraft: true }); return; }

        const verdict = result?.verdict;
        const reasonCode = result?.reason_code ?? 'value_uncertain';
        audit('retain', 'admission', { session_id: sessionId, request_id: (payload.request_id as string | undefined) ?? null, candidate_id: candidate.candidate_id, task_id: task.id },
            { verdict, reason_code: reasonCode, score: result?.score ?? null, backend: result?.backend ?? null,
                model: result?.model ?? null, revision: result?.revision ?? null, truncated: result?.truncated === true });

        if (verdict === 'reject') { finish(task, 'cancelled', null, { clearDraft: true }); return; }
        if (verdict === 'defer') {
            if (reasonCode === 'backend_unavailable') scheduleRetry(task);
            else finish(task, 'deferred', null, { clearDraft: false });
            return;
        }
        const outcome = await authorizeAndCommit(candidate, scope, reasonCode);
        if (outcome === 'approved') finish(task, 'reconciled', null, { clearDraft: true });
        else if (outcome === 'failed') finish(task, 'unknown', null, { clearDraft: false });
        else finish(task, 'cancelled', null, { clearDraft: true });
    }

    // ── supervisor：2s tick、单作业、短事务 claim/lease ──────────────────
    function claimReady(): TaskRowRecord | null {
        try {
            return store.transaction(() => {
                const row = firstRow<TaskRowRecord>(statements().claim, now(), now());
                if (!row) return null;
                statements().markRunning.run(leaseOwner(), row.id);
                return row;
            });
        } catch (error) {
            lastError = errorCodeOf(error) ?? GENERIC_CODE;
            return null;
        }
    }

    function expireSweep(): void {
        try {
            store.transaction(() => {
                for (const row of allRows<{ id: string; kind: string; payload_json: string | null }>(statements().expire, now())) {
                    // 未获准/重试中的任务清正文相关 payload；已获准的 pending write 仅清 draft，保留非正文操作信息。
                    statements().expireOne.run(row.kind === WRITE ? row.payload_json ?? null : null, row.id);
                    audit('task', 'expired', { task_id: row.id }, { kind: row.kind });
                }
            });
        } catch (error) { lastError = errorCodeOf(error) ?? GENERIC_CODE; }
    }

    function reconcileAuditOnly(): void {
        try {
            store.transaction(() => {
                for (const row of allRows<{ candidate_id: string }>(statements().orphanWrites)) {
                    statements().markAuditOnly.run(now(), row.candidate_id);
                    audit('retain', 'audit_only', { candidate_id: row.candidate_id }, { reason_code: 'unwritten_terminal' });
                }
            });
        } catch (error) { lastError = errorCodeOf(error) ?? GENERIC_CODE; }
    }

    async function runJob(): Promise<void> {
        const task = claimReady();
        if (!task) { expireSweep(); reconcileAuditOnly(); return; }
        const controller = new AbortController();
        controllers.set(task.id, controller);
        currentTaskId = task.id;
        try {
            if (task.kind === NORMALIZE) await runNormalize(task, controller.signal);
            else await runAdmit(task, controller.signal);
        } catch (error) {
            lastError = errorCodeOf(error) ?? GENERIC_CODE;
            // 作业级异常按有界重试；绝不伪造成功。
            scheduleRetry(task);
        } finally {
            if (task.kind === NORMALIZE && task.request_id && firstRow<TaskRowRecord>(statements().findTask, task.id)?.status !== 'pending')
                evidence.releaseRequest(task.request_id);
            controllers.delete(task.id);
            currentTaskId = null;
        }
        wake(); // 顺序排空：仍有 ready 任务则不等到下一个 2s tick
    }

    async function tick(): Promise<void> {
        if (!started || disposed) return;
        if (!job) job = runJob().catch(error => { lastError = errorCodeOf(error) ?? GENERIC_CODE; })
            .finally(() => { job = null; });
        if (!remoteJob) {
            const remote = new AbortController();
            remoteController = remote;
            remoteJob = (async () => {
                const signal = remote.signal;
                const first = preferCurate ? curateWorker : writeWorker;
                const second = preferCurate ? writeWorker : curateWorker;
                const claimed = await first.runNext(signal) || await second.runNext(signal);
                if (claimed) { preferCurate = !preferCurate; wake(); }
            })().catch(error => { lastError = errorCodeOf(error) ?? 'LEPI_HINDSIGHT_UNAVAILABLE'; })
                .finally(() => { remoteJob = null; remoteController = null; });
        }
        await Promise.all([job, remoteJob].filter((work): work is Promise<void> => work != null));
    }

    function wake(): void {
        if (disposed || !started) return;
        if (wakeTimer) return;
        wakeTimer = setTimeout(() => { wakeTimer = null; tick().catch(() => {}); }, 0);
        if (typeof wakeTimer.unref === 'function') wakeTimer.unref();
    }

    function start(): void {
        if (started || disposed) return;
        started = true;
        tickTimer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
        if (typeof tickTimer.unref === 'function') tickTimer.unref();
        tick().catch(() => {});
    }

    /** operator retry：只唤醒已存在的身份；终态不换新 operation、不复活政策终止。 */
    function retry(taskId: string): MemoryRetryReceipt | null {
        if (disposed || typeof taskId !== 'string' || !taskId) return null;
        let row: TaskRowRecord | undefined;
        try { row = firstRow<TaskRowRecord>(statements().findTask, taskId); } catch { return null; }
        if (!row) return null;
        const retryable = RETRYABLE_STATUS.has(row.status);
        if (retryable) {
            try {
                store.transaction(() => {
                    db.prepare('UPDATE tasks SET status=?, attempts=0, next_at=?, lease_owner=NULL, error_code=NULL WHERE id=?')
                        .run(row.submitted_at != null && row.kind === WRITE ? 'submitted' : 'pending', now(), taskId);
                    audit('task', 'retry_requested', { ...identityOf(row), task_id: taskId }, { kind: row.kind });
                });
                wake();
            } catch (error) { lastError = errorCodeOf(error) ?? GENERIC_CODE; }
        }
        const updated = firstRow<TaskRowRecord>(statements().findTask, taskId) ?? row;
        return { task_id: updated.id, kind: updated.kind, status: updated.status, code: updated.error_code ?? null, retryable };
    }

    function health(): MemoryHealth {
        const tasks: Record<string, Record<string, number>> = {};
        let total = 0;
        try {
            for (const row of allRows<{ kind: string; status: string; n: number }>(statements().counts)) {
                const bucket = tasks[row.kind] ?? (tasks[row.kind] = {});
                bucket[row.status] = row.n;
                total += row.n;
            }
        } catch (error) { lastError = errorCodeOf(error) ?? GENERIC_CODE; }
        let admissionHealth: Record<string, unknown> | null;
        try { admissionHealth = typeof admission?.health === 'function' ? admission.health() : null; } catch { admissionHealth = null; }
        return {
            started,
            disposed,
            running: currentTaskId,
            tasks,
            total,
            writeExecutor: true,
            remoteRunning: remoteJob !== null,
            admission: admissionHealth,
            last_error: lastError,
        };
    }

    async function dispose(): Promise<void> {
        if (disposed) return;
        disposed = true;
        if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
        if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = null; }
        for (const controller of controllers.values()) controller.abort();
        for (const work of recallJobs) work.controller.abort();
        remoteController?.abort();
        controllers.clear();
        turnStarts.clear();
        await Promise.allSettled([job, remoteJob, ...[...recallJobs].map(work => work.promise)].filter((work): work is Promise<unknown> => work != null));
    }

    return { enqueue, afterTurn, start, wake, retry, health, dispose,
        recall: (input: RecallInput) => runRecall(input), readMemory: (input: RecallInput) => runRecall(input, true) };
}
