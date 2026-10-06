/** Stable async retention identities; a receipt requires live document and raw-source proof. */

import type { StatementSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { loadSource, retainItem, documentMatches, rawMatches, rawVersion } from './raw-source.js';
import type { SourceSnapshot } from './raw-source.js';
import type { HindsightClient } from './hindsight.js';
import type { Store, TaskRowRecord } from './store.js';

const WRITE = 'write';
/** 非提交任务的有界网络退避（毫秒）：最多三次 1s/2s/4s，仍失败才 deferred。 */
const BACKOFF = [1000, 2000, 4000];
/** 已提交/清理任务的轮询间隔：PLAN 固定 2s。 */
const POLL_MS = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_OPERATION = new Set(['completed', 'cancelled', 'failed']);
const GENERIC_CODE = 'LEPI_HINDSIGHT_UNAVAILABLE';
const STOP_CODE = 'LEPI_WORKER_STOPPED';
const CHANGED_CODE = 'LEPI_POLICY_CHANGED';
const DENY_CODES = new Set(['LEPI_MEMORY_SUPPRESSED', 'LEPI_GRANT_INVALID', 'LEPI_SNAPSHOT_INVALID']);
const RAW_FACT_TYPES = new Set(['world', 'experience']);

interface RawLinkRow {
    raw_id: string;
    candidate_id: string;
    document_id: string;
    version_hash: string;
    state: string;
}
interface CountRow {
    status: string;
    n: number;
}
interface OperationView {
    status?: unknown;
}
interface AckView {
    operation_id?: unknown;
}
interface Statements {
    claim: StatementSync;
    markRunning: StatementSync;
    find: StatementSync;
    upsertRaw: StatementSync;
    promoteLifecycle: StatementSync;
    auditOnly: StatementSync;
    lifecycleUnknown: StatementSync;
    counts: StatementSync;
}
interface GateOutcome {
    outcome: string;
    code?: string;
    epoch?: number;
}

function parseJson<T>(text: unknown, fallback: T): T {
    if (typeof text !== 'string') return fallback;
    try {
        const value: unknown = JSON.parse(text);
        return value && typeof value === 'object' && !Array.isArray(value) ? value as T : fallback;
    } catch { return fallback; }
}

function isUuid(value: unknown): value is string { return typeof value === 'string' && UUID_RE.test(value); }

/** 时间限定：valid_until 已过 → history_only（当前不适用，但保留历史）。 */
function timeExpired(candidate: SourceSnapshot['candidate'] | null | undefined, at: number): boolean {
    const t = Date.parse(candidate?.valid_until ?? '');
    return Number.isFinite(t) && t < at;
}

/**
 * @param deps.store `openStore` 产物（同步事务）。
 * @param deps.hindsight `HindsightClient`（`retainAsync`/`operation`/`document`/`units`/`cancel`/`invalidate`）。
 */
export function createWriteWorker({ store, hindsight, checkPolicy, now = Date.now }: {
    store: Store;
    hindsight: HindsightClient;
    checkPolicy(source: SourceSnapshot, task: TaskRowRecord, options: { signal?: AbortSignal; restore?: boolean }): Promise<{ allowed: boolean; epoch: number; code: string | null }>;
    now?: () => number;
}) {
    const db = store.db;
    const bank = hindsight?.bank;
    let ownerId: string | null = null;
    let lastError: string | null = null;
    let sql: Statements | null = null;

    // 构造器保持纯：所有 prepare 延迟到首次使用。
    function statements(): Statements {
        return (sql ??= {
            claim: db.prepare(`SELECT * FROM tasks WHERE kind='${WRITE}' AND (
          (status IN ('pending','submitted') AND next_at<=? AND (submitted_at IS NOT NULL OR expires_at>?))
          OR (status='cancelled' AND submitted_at IS NOT NULL
              AND json_extract(payload_json,'$.cleanup')='required' AND next_at<=?)
        ) ORDER BY next_at, rowid LIMIT 1`),
            markRunning: db.prepare("UPDATE tasks SET status='running', lease_owner=? WHERE id=?"),
            find: db.prepare('SELECT * FROM tasks WHERE id=?'),
            upsertRaw: db.prepare(`INSERT INTO raw_links(raw_id,candidate_id,document_id,version_hash,state,verified_at)
          VALUES (?,?,?,?,?,?)
          ON CONFLICT(raw_id) DO UPDATE SET state=excluded.state,verified_at=excluded.verified_at
          WHERE raw_links.candidate_id=excluded.candidate_id AND raw_links.document_id=excluded.document_id
            AND raw_links.version_hash=excluded.version_hash`),
            promoteLifecycle: db.prepare(`UPDATE lifecycle SET status=?, policy_epoch=?, updated_at=?
          WHERE candidate_id=? AND status IN ('pending','unknown')`),
            auditOnly: db.prepare("UPDATE lifecycle SET status='audit_only', updated_at=? WHERE candidate_id=? AND status='pending'"),
            lifecycleUnknown: db.prepare("UPDATE lifecycle SET status='unknown', updated_at=? WHERE candidate_id=? AND status IN ('pending','active','history_only')"),
            counts: db.prepare("SELECT status,count(*) AS n FROM tasks WHERE kind=? GROUP BY status"),
        });
    }

    function leaseOwner(): string { return (ownerId ??= `write-${process.pid}-${randomUUID()}`); }

    function audit(type: string, status: string, task: TaskRowRecord | null | undefined, data: Record<string, unknown> = {}): void {
        const payload = parseJson<Record<string, unknown>>(task?.payload_json, {});
        store.audit({
            type, status, at: now(), call_id: null,
            session_id: (payload.session_id as string | undefined) ?? null,
            turn: Number.isSafeInteger(payload.turn) ? (payload.turn as number) : null, step: null,
            request_id: task?.request_id ?? (payload.request_id as string | undefined) ?? null,
            task_id: task?.id ?? null,
            candidate_id: task?.candidate_id ?? null,
            operation_id: task?.operation_id ?? null,
            data,
        });
    }

    /** 稳定 invalidate reason：有真实用户 request ID 用它，否则用 task UUID（远端要求 UUID）。 */
    function cleanupRequestId(task: TaskRowRecord): string {
        const payload = parseJson<Record<string, unknown>>(task.payload_json, {});
        if (isUuid(payload.invalidate_request_id)) return payload.invalidate_request_id;
        return isUuid(task.request_id) ? task.request_id : task.id;
    }

    function claim(): TaskRowRecord | null {
        try {
            return store.transaction(() => {
                const t = now();
                const row = statements().claim.get(t, t, t) as unknown as TaskRowRecord | undefined;
                if (!row) return null;
                statements().markRunning.run(leaseOwner(), row.id);
                return row;
            });
        } catch (error) { lastError = errorCodeOf(error) ?? GENERIC_CODE; return null; }
    }

    // ── 状态落盘（都在短事务内）────────────────────────────────────────
    /** 释放 lease 并保留可恢复状态：pending→pending，submitted/清理→submitted|cancelled，2s 后再取。 */
    function preserve(task: TaskRowRecord): void {
        try {
            store.transaction(() => {
                const row = statements().find.get(task.id) as unknown as TaskRowRecord | undefined;
                if (!row) return;
                const cleanup = parseJson<Record<string, unknown>>(row.payload_json, {}).cleanup === 'required';
                const status = cleanup ? 'cancelled' : row.submitted_at != null ? 'submitted' : 'pending';
                db.prepare("UPDATE tasks SET status=?, lease_owner=NULL, next_at=? WHERE id=?").run(status, now() + POLL_MS, task.id);
            });
        } catch (error) { lastError = errorCodeOf(error) ?? GENERIC_CODE; }
    }

    /** 有界网络重试：提交/清理任务保留 submitted/cancelled 身份轮询；未提交任务 1s/2s/4s 后退避为 deferred。 */
    function scheduleRetry(task: TaskRowRecord, code = GENERIC_CODE): void {
        let row: TaskRowRecord | undefined;
        try { row = statements().find.get(task.id) as unknown as TaskRowRecord | undefined; } catch (error) { lastError = errorCodeOf(error) ?? GENERIC_CODE; return; }
        if (!row || !['running', 'pending', 'submitted', 'cancelled'].includes(row.status)) return;
        try {
            store.transaction(() => {
                const cleanup = parseJson<Record<string, unknown>>(row!.payload_json, {}).cleanup === 'required';
                const attempts = (row!.attempts ?? 0) + 1;
                const at = now();
                if (cleanup) {
                    db.prepare("UPDATE tasks SET status='cancelled', attempts=?, error_code=?, lease_owner=NULL, next_at=? WHERE id=?")
                        .run(attempts, code, at + POLL_MS, task.id);
                    audit('task', 'cleaning', task, { code, attempt: attempts });
                } else if (row!.submitted_at != null) {
                    const status = attempts > BACKOFF.length ? 'deferred' : 'submitted';
                    db.prepare('UPDATE tasks SET status=?, attempts=?, error_code=?, lease_owner=NULL, next_at=? WHERE id=?')
                        .run(status, attempts, code, at + (BACKOFF[attempts - 1] ?? POLL_MS), task.id);
                    audit('task', status === 'deferred' ? 'deferred' : 'retrying', task, { code, attempt: attempts });
                } else if (attempts > BACKOFF.length) {
                    db.prepare("UPDATE tasks SET attempts=?, status='deferred', error_code=?, lease_owner=NULL, next_at=? WHERE id=?")
                        .run(attempts, code, at + POLL_MS, task.id);
                    audit('task', 'deferred', task, { code });
                } else {
                    db.prepare("UPDATE tasks SET attempts=?, status='pending', error_code=?, lease_owner=NULL, next_at=? WHERE id=?")
                        .run(attempts, code, at + BACKOFF[attempts - 1]!, task.id);
                    audit('task', 'retrying', task, { code, attempt: attempts });
                }
            });
        } catch (error) { lastError = errorCodeOf(error) ?? GENERIC_CODE; }
    }

    /** 未提交任务：不成功也不取消，回到 pending 由下一次 claim 重新读政策（LEPI_POLICY_CHANGED 语义）。 */
    function rescheduleRead(task: TaskRowRecord): void {
        try {
            store.transaction(() => {
                const row = statements().find.get(task.id) as unknown as TaskRowRecord | undefined;
                if (!row) return;
                if (row.submitted_at != null) {
                    db.prepare("UPDATE tasks SET status='submitted', lease_owner=NULL, next_at=? WHERE id=?").run(now() + POLL_MS, task.id);
                } else {
                    db.prepare("UPDATE tasks SET status='pending', lease_owner=NULL, next_at=? WHERE id=?").run(now(), task.id);
                }
            });
        } catch (error) { lastError = errorCodeOf(error) ?? GENERIC_CODE; }
    }

    /** A live pre-POST policy change can undo the submission marker, never the allocated UUID. */
    function revertUnsent(task: TaskRowRecord, status: string, code: string | null, { auditOnly = false }: { auditOnly?: boolean } = {}): void {
        try {
            store.transaction(() => {
                const row = statements().find.get(task.id) as unknown as TaskRowRecord | undefined;
                if (!row) return;
                db.prepare('UPDATE tasks SET status=?, submitted_at=NULL, error_code=?, lease_owner=NULL, next_at=? WHERE id=?')
                    .run(status, code, now() + (status === 'pending' ? 0 : POLL_MS), task.id);
                if (auditOnly && task.candidate_id) statements().auditOnly.run(now(), task.candidate_id);
                audit('retain', status, task, { phase: 'presubmit', code });
            });
        } catch (error) { lastError = errorCodeOf(error) ?? GENERIC_CODE; }
    }

    /** 终态（未写成功）；按需把 pending 快照转 audit_only 或 unknown。 */
    function terminal(task: TaskRowRecord, status: string, code: string | null, { auditOnly = false, lifecycleUnknown = false }: { auditOnly?: boolean; lifecycleUnknown?: boolean } = {}): void {
        try {
            store.transaction(() => {
                const row = statements().find.get(task.id) as unknown as TaskRowRecord | undefined;
                if (!row) return;
                db.prepare("UPDATE tasks SET status=?, error_code=?, lease_owner=NULL, next_at=? WHERE id=?").run(status, code, now(), task.id);
                if (task.candidate_id) {
                    if (auditOnly) statements().auditOnly.run(now(), task.candidate_id);
                    else if (lifecycleUnknown) statements().lifecycleUnknown.run(now(), task.candidate_id);
                }
                audit('retain', status, task, { code });
            });
        } catch (error) { lastError = errorCodeOf(error) ?? GENERIC_CODE; }
    }

    /** 政策评估：把 parent checkPolicy 的 {allowed,epoch,code} 收敛成可判定的 outcome。 */
    async function evaluatePolicy(source: SourceSnapshot, task: TaskRowRecord, signal?: AbortSignal): Promise<GateOutcome> {
        let policy: { allowed: boolean; epoch: number; code: string | null };
        try { policy = await checkPolicy(source, task, { signal }); }
        catch (error) { return { outcome: 'transient', code: errorCodeOf(error) ?? GENERIC_CODE }; }
        if (signal?.aborted || policy?.code === STOP_CODE) return { outcome: 'stop' };
        if (policy?.allowed) return { outcome: 'allow', epoch: policy.epoch };
        if (policy?.code === CHANGED_CODE) return { outcome: 'changed', code: CHANGED_CODE };
        return { outcome: 'deny', code: DENY_CODES.has(policy?.code ?? '') ? policy.code! : 'LEPI_MEMORY_SUPPRESSED' };
    }

    function markCleanup(task: TaskRowRecord): void {
        const payload = parseJson<Record<string, unknown>>(task.payload_json, {});
        if (payload.cleanup === 'required') return;
        const next = { ...payload, cleanup: 'required', invalidate_request_id: cleanupRequestId(task) };
        try {
            store.transaction(() => db.prepare('UPDATE tasks SET payload_json=? WHERE id=?').run(JSON.stringify(next), task.id));
            task.payload_json = JSON.stringify(next);
        } catch (error) { lastError = errorCodeOf(error) ?? GENERIC_CODE; }
    }

    // ── 主入口 ─────────────────────────────────────────────────────────
    async function runNext(signal?: AbortSignal): Promise<boolean> {
        const task = claim();
        if (!task) return false;
        try { await execute(task, signal); }
        catch (error) { lastError = errorCodeOf(error) ?? GENERIC_CODE; scheduleRetry(task, errorCodeOf(error) ?? GENERIC_CODE); }
        return true;
    }

    async function execute(task: TaskRowRecord, signal?: AbortSignal): Promise<void> {
        const payload = parseJson<Record<string, unknown>>(task.payload_json, {});
        if (payload.bank != null && payload.bank !== bank) {
            terminal(task, 'unknown', 'LEPI_WRITE_TARGET_CHANGED', { lifecycleUnknown: true }); return;
        }
        if (payload.cleanup === 'required' || (task.status === 'cancelled' && task.submitted_at != null)) {
            // 清理路径不需要（也不应）改回 active；按 payload 标志无重启歧义地继续。
            await withSource(task, signal, (source) => runForbiddenCleanup(task, source, signal));
            return;
        }

        await withSource(task, signal, async (source) => {
            if (signal?.aborted) { preserve(task); return; }
            const gate = await evaluatePolicy(source, task, signal);

            if (gate.outcome === 'stop') { preserve(task); return; }
            if (gate.outcome === 'transient') { scheduleRetry(task, gate.code); return; }
            if (gate.outcome === 'changed') { rescheduleRead(task); return; }
            if (gate.outcome === 'deny') {
                if (task.submitted_at == null) terminal(task, 'cancelled', gate.code ?? GENERIC_CODE, { auditOnly: true });
                else { markCleanup(task); await runForbiddenCleanup(task, source, signal); }
                return;
            }
            // gate.outcome === 'allow'
            if (task.submitted_at == null) { await submitFresh(task, source, signal, gate); return; }
            await pollSubmitted(task, source, signal);
        });
    }

    /** 加载不可变获准快照；缺失/校验失败 → unknown/lifecycle=unknown（绝不假装成功）。 */
    async function withSource(task: TaskRowRecord, _signal: AbortSignal | undefined, fn: (source: SourceSnapshot) => Promise<void>): Promise<void> {
        let source: SourceSnapshot | null;
        try { source = loadSource(store, task.candidate_id ?? null); }
        catch (error) { lastError = errorCodeOf(error) ?? GENERIC_CODE; terminal(task, 'unknown', errorCodeOf(error) ?? 'LEPI_SNAPSHOT_INVALID', { lifecycleUnknown: true }); return; }
        if (!source) { terminal(task, 'unknown', 'LEPI_SNAPSHOT_INVALID', { lifecycleUnknown: true }); return; }
        await fn(source);
    }

    // ── 提交新快照 ─────────────────────────────────────────────────────
    async function submitFresh(task: TaskRowRecord, source: SourceSnapshot, signal: AbortSignal | undefined, gate: GateOutcome): Promise<void> {
        const epochBefore = store.policyEpoch;
        if (Number.isSafeInteger(gate.epoch) && gate.epoch !== epochBefore) { rescheduleRead(task); return; }

        const opId = isUuid(task.operation_id) ? task.operation_id : randomUUID();
        const payload = { ...parseJson<Record<string, unknown>>(task.payload_json, {}), bank, document_id: source.documentId,
            payload_hash: source.payloadHash, policy_epoch: epochBefore };
        try {
            store.transaction(() => {
                if (store.policyEpoch !== epochBefore) throw Object.assign(new Error(CHANGED_CODE), { code: CHANGED_CODE });
                const res = db.prepare(`UPDATE tasks SET status='submitted', operation_id=?, submitted_at=?, lease_owner=NULL, next_at=?, payload_json=?
            WHERE id=? AND submitted_at IS NULL`).run(opId, now(), now(), JSON.stringify(payload), task.id);
                if (res.changes !== 1) throw Object.assign(new Error(GENERIC_CODE), { code: GENERIC_CODE });
                audit('retain', 'submitted', { ...task, operation_id: opId }, { phase: 'allocate', document_id: source.documentId, payload_hash: source.payloadHash });
            });
            task.operation_id = opId;
            task.submitted_at = (statements().find.get(task.id) as unknown as TaskRowRecord | undefined)?.submitted_at ?? now();
            task.payload_json = JSON.stringify(payload);
        } catch (error) {
            if (errorCodeOf(error) === CHANGED_CODE) { rescheduleRead(task); return; }
            lastError = errorCodeOf(error) ?? GENERIC_CODE;
            scheduleRetry(task, errorCodeOf(error) ?? GENERIC_CODE); // 未发送；释放 lease 由有界重试处理
            return;
        }

        // 立即在 POST 前重核 policy/epoch（绝不把另一 epoch 的决定用于提交）。
        const regate = await evaluatePolicy(source, task, signal);
        if (regate.outcome === 'stop') { preserve(task); return; }
        if (regate.outcome === 'transient') { scheduleRetry(task, regate.code); return; }
        if (regate.outcome === 'changed' || (Number.isSafeInteger(regate.epoch) && regate.epoch !== epochBefore)) {
            revertUnsent(task, 'pending', CHANGED_CODE);
            return;
        }
        if (regate.outcome === 'deny') { revertUnsent(task, 'cancelled', regate.code ?? GENERIC_CODE, { auditOnly: true }); return; }

        let item;
        try { item = retainItem(source); }
        catch (error) { lastError = errorCodeOf(error) ?? GENERIC_CODE; terminal(task, 'unknown', errorCodeOf(error) ?? 'LEPI_SNAPSHOT_INVALID', { lifecycleUnknown: true }); return; }

        let ack: AckView | null;
        try { ack = await hindsight.retainAsync(item, { operationId: opId, signal }) as AckView | null; }
        catch (error) {
            lastError = errorCodeOf(error) ?? GENERIC_CODE;
            if (errorCodeOf(error) === 'LEPI_HINDSIGHT_CONFLICT') { terminal(task, 'failed', 'LEPI_HINDSIGHT_CONFLICT', { auditOnly: true }); return; }
            scheduleRetry(task, errorCodeOf(error) ?? GENERIC_CODE); // 丢失 ack：保留同一 op 身份，下一次只查询
            return;
        }
        if (signal?.aborted) { preserve(task); return; }
        if (ack && ack.operation_id != null && ack.operation_id !== opId) {
            terminal(task, 'failed', 'LEPI_HINDSIGHT_CONFLICT', { auditOnly: true });
            return;
        }
        if (ack?.operation_id !== opId) { scheduleRetry(task, GENERIC_CODE); return; }
        const after = await evaluatePolicy(source, task, signal);
        if (after.outcome === 'stop') { preserve(task); return; }
        if (after.outcome === 'changed') { rescheduleRead(task); return; }
        if (after.outcome === 'transient') { scheduleRetry(task, after.code); return; }
        if (after.outcome === 'deny') { markCleanup(task); await runForbiddenCleanup(task, source, signal); return; }
        keepSubmitted(task);
    }

    function keepSubmitted(task: TaskRowRecord): void {
        try {
            store.transaction(() => {
                db.prepare("UPDATE tasks SET status='submitted', attempts=0, error_code=NULL, lease_owner=NULL, next_at=? WHERE id=?")
                    .run(now() + POLL_MS, task.id);
                audit('retain', 'submitted', task, { phase: 'poll_scheduled' });
            });
        } catch (error) { lastError = errorCodeOf(error) ?? GENERIC_CODE; }
    }

    // ── 已提交：查询/核验 ──────────────────────────────────────────────
    async function pollSubmitted(task: TaskRowRecord, source: SourceSnapshot, signal?: AbortSignal): Promise<void> {
        const opId = task.operation_id;
        if (!isUuid(opId)) { terminal(task, 'unknown', 'LEPI_RETAIN_EMPTY', { lifecycleUnknown: true }); return; }
        let op: OperationView | null;
        try { op = await hindsight.operation(opId, { signal }) as OperationView | null; }
        catch (error) {
            if (errorStatusOf(error) === 404) { await reconcileOrUnknown(task, source, signal); return; }
            scheduleRetry(task, errorCodeOf(error) ?? GENERIC_CODE);
            return;
        }
        if (signal?.aborted) { preserve(task); return; }
        const gate = await evaluatePolicy(source, task, signal);
        if (gate.outcome === 'stop') { preserve(task); return; }
        if (gate.outcome === 'transient') { scheduleRetry(task, gate.code); return; }
        if (gate.outcome === 'changed') { rescheduleRead(task); return; }
        if (gate.outcome === 'deny') { markCleanup(task); await runForbiddenCleanup(task, source, signal); return; }
        switch (op?.status) {
            case 'pending':
            case 'processing': keepSubmitted(task); return;
            case 'not_found': await reconcileOrUnknown(task, source, signal); return;
            case 'completed': await verifyCompleted(task, source, signal); return;
            case 'cancelled':
                // 远端取消了 operation：本地保持 cancelled，但仍清理任何已产生的 raw。
                markCleanup(task); await runForbiddenCleanup(task, source, signal); return;
            case 'failed': terminal(task, 'failed', GENERIC_CODE, { auditOnly: true }); return;
            default: scheduleRetry(task, GENERIC_CODE); return;
        }
    }

    /** 远端 not_found：先核 document+valid units；两项都证明 payload 在库才 reconciled。 */
    async function reconcileOrUnknown(task: TaskRowRecord, source: SourceSnapshot, signal?: AbortSignal): Promise<void> {
        const docId = source.documentId;
        let doc: unknown;
        let raws: Array<Record<string, unknown>> = [];
        try {
            doc = await hindsight.document(docId, { signal });
            if (doc) raws = await hindsight.units(docId, { state: 'valid', signal });
        } catch (error) { scheduleRetry(task, errorCodeOf(error) ?? GENERIC_CODE); return; }
        if (signal?.aborted) { preserve(task); return; }

        // 升当前真相前重核政策（另一 epoch 的旧决定不可用）。
        const gate = await evaluatePolicy(source, task, signal);
        if (gate.outcome === 'stop') { preserve(task); return; }
        if (gate.outcome === 'transient') { scheduleRetry(task, gate.code); return; }
        if (gate.outcome === 'changed') { rescheduleRead(task); return; }
        if (gate.outcome === 'deny') { markCleanup(task); await runForbiddenCleanup(task, source, signal); return; }

        const matched = (raws ?? []).filter(raw => rawMatches(raw as unknown as Parameters<typeof rawMatches>[0], source, 'valid') && RAW_FACT_TYPES.has(raw.fact_type as string));
        if (documentMatches(doc as unknown as Parameters<typeof documentMatches>[0], source, bank) && matched.length > 0) {
            commitProof(task, source, matched, 'reconciled', gate.epoch!);
            return;
        }
        // doc 原文缺失/不匹配或 raw 不可用：结果不明。
        terminal(task, 'unknown', null, { lifecycleUnknown: true });
    }

    /** completed：精确 document + 可用 world/experience raw → 写 raw_links + active/history_only + written。 */
    async function verifyCompleted(task: TaskRowRecord, source: SourceSnapshot, signal?: AbortSignal): Promise<void> {
        const docId = source.documentId;
        let doc: unknown;
        let raws: Array<Record<string, unknown>> = [];
        try {
            doc = await hindsight.document(docId, { signal });
            if (doc) raws = await hindsight.units(docId, { state: 'valid', signal });
        } catch (error) { scheduleRetry(task, errorCodeOf(error) ?? GENERIC_CODE); return; }
        if (signal?.aborted) { preserve(task); return; }

        const gate = await evaluatePolicy(source, task, signal);
        if (gate.outcome === 'stop') { preserve(task); return; }
        if (gate.outcome === 'transient') { scheduleRetry(task, gate.code); return; }
        if (gate.outcome === 'changed') { rescheduleRead(task); return; }
        if (gate.outcome === 'deny') { markCleanup(task); await runForbiddenCleanup(task, source, signal); return; }

        if (!documentMatches(doc as unknown as Parameters<typeof documentMatches>[0], source, bank)) {
            terminal(task, 'unknown', null, { lifecycleUnknown: true });
            return;
        }
        const matched = (raws ?? []).filter(raw => rawMatches(raw as unknown as Parameters<typeof rawMatches>[0], source, 'valid') && RAW_FACT_TYPES.has(raw.fact_type as string));
        if (matched.length === 0) {
            // completed 却没有可用 raw 不是成功。
            terminal(task, 'failed', 'LEPI_RETAIN_EMPTY', { auditOnly: true });
            return;
        }
        commitProof(task, source, matched, 'written', gate.epoch!);
    }

    function commitProof(task: TaskRowRecord, source: SourceSnapshot, matched: Array<Record<string, unknown>>, status: string, epoch: number): void {
        const nextStatus = timeExpired(source.candidate, now()) ? 'history_only' : 'active';
        try {
            store.transaction(() => {
                if (store.policyEpoch !== epoch) throw Object.assign(new Error(CHANGED_CODE), { code: CHANGED_CODE });
                for (const raw of matched) {
                    const linked = statements().upsertRaw.run(raw.id as string, task.candidate_id, source.documentId, rawVersion(raw), raw.state as string, now());
                    if (linked.changes !== 1) throw Object.assign(new Error('LEPI_SOURCE_CHANGED'), { code: 'LEPI_SOURCE_CHANGED' });
                }
                if (statements().promoteLifecycle.run(nextStatus, epoch, now(), task.candidate_id).changes !== 1)
                    throw Object.assign(new Error(CHANGED_CODE), { code: CHANGED_CODE });
                db.prepare('UPDATE tasks SET status=?, error_code=NULL, lease_owner=NULL, next_at=? WHERE id=?').run(status, now(), task.id);
                audit('retain', status, task, { raw_ids: matched.map(raw => raw.id), lifecycle: nextStatus,
                    operation_record: status === 'reconciled' ? 'unavailable' : 'completed' });
            });
        } catch (error) {
            const code = errorCodeOf(error);
            if (code === CHANGED_CODE) rescheduleRead(task);
            else if (code === 'LEPI_SOURCE_CHANGED') terminal(task, 'unknown', code, { lifecycleUnknown: true });
            else throw error;
        }
    }

    // ── 被禁提交工作的远端清理 ─────────────────────────────────────────
    /**
     * cancel op → 查 op 终态 → 发现 doc/raw → 逐条 invalidate → 再扫一遍。
     * 只有「operation 终态且无剩余 valid raw」才把 task 定为 cancelled；否则保持 cancelled 2s 后继续。
     * 绝不 promote active；shutdown/abort 时保留证据，不用 aborted signal 清理。
     */
    async function runForbiddenCleanup(task: TaskRowRecord, source: SourceSnapshot, signal?: AbortSignal): Promise<void> {
        markCleanup(task);
        const epoch = store.policyEpoch;
        const requestId = cleanupRequestId(task);
        const payload = parseJson<Record<string, unknown>>(task.payload_json, {});
        const invalidated: string[] = [];
        function guard(): boolean {
            if (signal?.aborted) { preserve(task); return false; }
            if (store.policyEpoch !== epoch) { preserve(task); return false; }
            return true;
        }
        if (!guard()) return;
        // A later verified restore supersedes this cleanup; it must not re-invalidate restored sources.
        const live = loadSource(store, task.candidate_id);
        if (['active', 'history_only'].includes(live?.lifecycle.status as string)) {
            store.transaction(() => {
                db.prepare("UPDATE tasks SET status='cancelled',lease_owner=NULL,payload_json=? WHERE id=?")
                    .run(JSON.stringify({ ...payload, cleanup: 'superseded' }), task.id);
                audit('retain', 'cancelled', task, { phase: 'cleanup_superseded' });
            });
            return;
        }
        let opStatus = 'not_found';
        try {
            if (isUuid(task.operation_id)) {
                try { await hindsight.cancel(task.operation_id, { signal }); }
                catch (error) { if (errorStatusOf(error) !== 404 && errorStatusOf(error) !== 409) throw error; }
                if (!guard()) return;
                try { opStatus = ((await hindsight.operation(task.operation_id, { signal })) as OperationView).status as string; }
                catch (error) { if (errorStatusOf(error) !== 404) throw error; }
                if (!guard()) return;
            }
            const document = await hindsight.document(source.documentId, { signal });
            if (!guard()) return;
            if (document && !documentMatches(document as unknown as Parameters<typeof documentMatches>[0], source, bank)) {
                scheduleRetry(task, 'LEPI_SOURCE_CHANGED'); return;
            }
            const raws = document ? await hindsight.units(source.documentId, { state: 'valid', signal }) : [];
            if (!guard()) return;
            for (const raw of raws.filter(raw => rawMatches(raw as unknown as Parameters<typeof rawMatches>[0], source))) {
                const version = rawVersion(raw);
                const link = db.prepare('SELECT * FROM raw_links WHERE raw_id=?').get(raw.id as string) as unknown as RawLinkRow | undefined;
                if (link && (link.candidate_id !== task.candidate_id || link.document_id !== source.documentId || link.version_hash !== version)) {
                    scheduleRetry(task, 'LEPI_SOURCE_CHANGED'); return;
                }
                try { await hindsight.invalidate(raw.id as string, { requestId, signal }); }
                catch (error) { if (errorStatusOf(error) !== 404 && errorStatusOf(error) !== 409) throw error; }
                if (!guard()) return;
                const invalid = await hindsight.units(source.documentId, { state: 'invalidated', signal });
                if (!guard()) return;
                if (!invalid.some(item => item.id === raw.id && rawMatches(item as unknown as Parameters<typeof rawMatches>[0], source, 'invalidated') && rawVersion(item) === version)) {
                    scheduleRetry(task, GENERIC_CODE); return;
                }
                store.transaction(() => {
                    if (statements().upsertRaw.run(raw.id as string, task.candidate_id, source.documentId, version, 'invalidated', now()).changes !== 1)
                        throw Object.assign(new Error('LEPI_SOURCE_CHANGED'), { code: 'LEPI_SOURCE_CHANGED' });
                });
                invalidated.push(raw.id as string);
            }
            const finalDocument = await hindsight.document(source.documentId, { signal });
            if (!guard()) return;
            if (finalDocument && !documentMatches(finalDocument as unknown as Parameters<typeof documentMatches>[0], source, bank)) {
                scheduleRetry(task, 'LEPI_SOURCE_CHANGED'); return;
            }
            const remaining = finalDocument ? await hindsight.units(source.documentId, { state: 'valid', signal }) : [];
            if (!guard()) return;
            const open = remaining.filter(raw => rawMatches(raw as unknown as Parameters<typeof rawMatches>[0], source));
            // not_found is uncertainty, not terminal proof that a lost request cannot arrive later.
            const done = TERMINAL_OPERATION.has(opStatus) && open.length === 0;
            store.transaction(() => {
                db.prepare("UPDATE tasks SET status='cancelled',error_code=NULL,lease_owner=NULL,next_at=?,payload_json=? WHERE id=?")
                    .run(now() + (done ? 0 : POLL_MS), JSON.stringify({ ...payload, cleanup: done ? 'done' : 'required' }), task.id);
                audit(done ? 'retain' : 'task', done ? 'cancelled' : 'cleaning', task,
                    { phase: done ? 'cleanup_done' : 'cleanup_pending', operation_status: opStatus, remaining: open.map(raw => raw.id), invalidated });
            });
        } catch (error) { scheduleRetry(task, errorCodeOf(error) ?? GENERIC_CODE); }
    }

    function health(): { kind: string; tasks: Record<string, number>; total: number; last_error: string | null } {
        const tasks: Record<string, number> = {};
        let total = 0;
        try {
            for (const row of statements().counts.all(WRITE) as unknown as CountRow[]) { tasks[row.status] = row.n; total += row.n; }
        } catch (error) { lastError = errorCodeOf(error) ?? GENERIC_CODE; }
        return { kind: WRITE, tasks, total, last_error: lastError };
    }

    return { runNext, health };
}

function errorCodeOf(error: unknown): string | null {
    return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
}
function errorStatusOf(error: unknown): number | null {
    return error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : null;
}
