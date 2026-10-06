/** Selected raw curation: cancellation is not retraction; restoration requires unchanged source proof. */

import { randomUUID } from 'node:crypto';
import { loadSource, rawMatches, documentMatches, rawVersion } from './raw-source.js';

const CURATE = 'curate';
const WRITE = 'write';

/** 有界退避（毫秒）：pending 任务的重试节奏（curate 一直跟踪到有证明为止）。 */
const BACKOFF = [1000, 2000, 4000];

/** revoke 保留的用户默认：已有 active/history 记忆不因撤权而撤回。 */
const REVOKE_KEEP = new Set(['active', 'history_only']);
/** revoke 仅清理这两类 lifecycle（在途/new，未被用户当作“已有记忆”保留）。 */
const REVOKE_RETRACT = new Set(['pending', 'unknown']);

/** 写任务状态：仍需远端操作 / 已经落库。 */
const RUNNING_WRITE = new Set(['pending', 'running', 'submitted', 'deferred', 'unknown', 'cancelled']);
const LANDED_WRITE = new Set(['written', 'reconciled']);

const PENDING_OP = new Set(['pending', 'processing']);

const KINDS = new Set(['forget', 'revoke', 'restore']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CODE = Object.freeze({
    INVALID: 'LEPI_CURATE_INVALID',
    MISMATCH: 'LEPI_CURATE_MISMATCH',
    UNPROVEN: 'LEPI_CURATE_UNPROVEN',
    SOURCE_MISSING: 'LEPI_CURATE_SOURCE_MISSING',
    SNAPSHOT_INVALID: 'LEPI_SNAPSHOT_INVALID',
    UNAVAILABLE: 'LEPI_HINDSIGHT_UNAVAILABLE',
    CONFLICT: 'LEPI_HINDSIGHT_CONFLICT',
    POLICY_CHANGED: 'LEPI_POLICY_CHANGED',
    STOPPED: 'LEPI_WORKER_STOPPED',
});

function isId(value) {
    return typeof value === 'string' && value.length > 0;
}

function uuidOr(value) {
    return typeof value === 'string' && UUID.test(value) ? value : null;
}

function parseJson(text, fallback) {
    if (typeof text !== 'string') return fallback;
    try {
        const value = JSON.parse(text);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
    } catch {
        return fallback;
    }
}

/**
 * @param {object} deps
 * @param {object} deps.store `openStore` 产物（同步事务；本模块是自身唯一 writer）。
 * @param {object} deps.hindsight `HindsightClient`（`document`/`units`/`cancel`/`operation`/`invalidate`/`revert`）。
 * @param {(source:object, task:object, opts:{signal?:AbortSignal, restore?:boolean}) => Promise<{allowed:boolean, epoch:number, code:string|null}>} deps.checkPolicy
 *   父级实现：审阅当前 lifecycle/grant/typed suppression；`restore:true` 仅放行被选中的 restore 任务。
 * @param {() => number} [deps.now]
 * @returns {{ runNext(signal?:AbortSignal):Promise<boolean>, health():object }}
 */
export function createCurateWorker({ store, hindsight, checkPolicy, now = Date.now }) {
    let sql = null;
    let ownerId = null;
    let lastError = null;

    // SQL 一律懒编译：构造器保持纯（不 touch store）。
    function statements() {
        if (sql) return sql;
        const db = store.db;
        sql = {
            claim: db.prepare(`SELECT * FROM tasks WHERE kind='${CURATE}'
                AND status='pending' AND next_at<=? ORDER BY next_at, rowid LIMIT 1`),
            markRunning: db.prepare("UPDATE tasks SET status='running', lease_owner=? WHERE id=?"),
            findTask: db.prepare('SELECT * FROM tasks WHERE id=?'),
            writeTasks: db.prepare(`SELECT id,status,submitted_at,operation_id FROM tasks
                WHERE candidate_id=? AND kind='${WRITE}'`),
            rawLinks: db.prepare('SELECT raw_id,candidate_id,document_id,version_hash,state FROM raw_links WHERE candidate_id=?'),
            insertLink: db.prepare(`INSERT INTO raw_links(raw_id,candidate_id,document_id,version_hash,state,verified_at)
                VALUES (?,?,?,?,?,?)`),
            markLink: db.prepare('UPDATE raw_links SET state=?,version_hash=?,verified_at=? WHERE raw_id=?'),
            setPayload: db.prepare('UPDATE tasks SET payload_json=? WHERE id=?'),
            setLifecycle: db.prepare('UPDATE lifecycle SET status=?,policy_epoch=?,updated_at=? WHERE candidate_id=? AND status=?'),
            counts: db.prepare(`SELECT status, count(*) AS n FROM tasks WHERE kind='${CURATE}' GROUP BY status`),
        };
        return sql;
    }

    function leaseOwner() {
        return (ownerId ??= `${process.pid}-${randomUUID()}`);
    }

    function audit(type, status, identity = {}, data = {}) {
        try {
            store.audit({
                type, status, at: now(),
                session_id: null, turn: null, step: null, call_id: null,
                request_id: identity.request_id ?? null, task_id: identity.task_id ?? null,
                candidate_id: identity.candidate_id ?? null, operation_id: identity.operation_id ?? null,
                data,
            });
        } catch (error) {
            lastError = error?.code ?? CODE.UNAVAILABLE;
            throw error;
        }
    }

    /** 远端/取消失败分类：只有明确 409 冲突才是永久失败；网络/503/超时/abort 都保持 pending。 */
    function mapError(error, signal) {
        if (signal?.aborted || error?.name === 'AbortError' || error?.code === CODE.STOPPED)
            return { state: 'pending', code: CODE.STOPPED };
        if (error?.code === CODE.POLICY_CHANGED) return { state: 'pending', code: CODE.POLICY_CHANGED };
        if (error?.code === CODE.CONFLICT || error?.status === 409) return { state: 'failed', code: CODE.CONFLICT };
        return { state: 'pending', code: CODE.UNAVAILABLE };
    }

    function restoreStatus(candidate, nowMs) {
        const until = candidate?.valid_until ? Date.parse(candidate.valid_until) : NaN;
        return Number.isFinite(until) && until <= nowMs ? 'history_only' : 'active';
    }

    // ── claim（短事务 + lease）────────────────────────────────────────────
    function claim() {
        return store.transaction(() => {
            const row = statements().claim.get(now());
            if (!row) return null;
            statements().markRunning.run(leaseOwner(), row.id);
            return row;
        });
    }

    function persist(task, progress) {
        try {
            store.transaction(() => statements().setPayload.run(JSON.stringify(progress), task.id));
        } catch (error) { lastError = error?.code ?? CODE.UNAVAILABLE; }
    }

    function finalize(task, progress) {
        const attempts = (task.attempts ?? 0) + 1;
        let status; let code; let nextAt;
        if (progress.pending_ids.length) {
            status = 'pending';
            code = progress.error_code ?? CODE.UNPROVEN;
            nextAt = now() + BACKOFF[Math.min(attempts, BACKOFF.length) - 1];
        } else if (progress.failed_ids.length) {
            status = 'failed';
            code = progress.error_code ?? CODE.UNPROVEN;
            nextAt = now();
        } else {
            status = 'reconciled';
            code = null;
            nextAt = now();
        }
        try {
            store.transaction(() => {
                store.db.prepare(`UPDATE tasks SET status=?, error_code=?, lease_owner=NULL, next_at=?,
                    payload_json=?, attempts=? WHERE id=?`)
                    .run(status, code, nextAt, JSON.stringify(progress), attempts, task.id);
                audit('task', status, { request_id: task.request_id, task_id: task.id }, {
                    kind: CURATE, mode: progress.kind,
                    succeeded_ids: progress.succeeded_ids, failed_ids: progress.failed_ids,
                    pending_ids: progress.pending_ids, kept_ids: progress.kept_ids, code,
                });
            });
        } catch (error) { lastError = error?.code ?? CODE.UNAVAILABLE; }
    }

    function finalizeInvalid(task, progress) {
        try {
            store.transaction(() => {
                store.db.prepare(`UPDATE tasks SET status='failed', error_code=?, lease_owner=NULL, next_at=?,
                    payload_json=? WHERE id=?`).run(CODE.INVALID, now(), JSON.stringify(progress), task.id);
                audit('task', 'failed', { request_id: task.request_id, task_id: task.id },
                    { kind: CURATE, code: CODE.INVALID });
            });
        } catch (error) { lastError = error?.code ?? CODE.UNAVAILABLE; }
    }

    function safeRelease(task) {
        try {
            const row = statements().findTask.get(task.id);
            if (!row || row.status !== 'running') return;
            const attempts = (task.attempts ?? 0) + 1;
            store.transaction(() => {
                store.db.prepare(`UPDATE tasks SET status='pending', error_code=?, lease_owner=NULL, next_at=?, attempts=?
                    WHERE id=?`).run(lastError ?? CODE.UNAVAILABLE,
                    now() + BACKOFF[Math.min(attempts, BACKOFF.length) - 1], attempts, task.id);
                audit('task', 'pending', { request_id: task.request_id, task_id: task.id },
                    { kind: CURATE, code: lastError });
            });
        } catch (error) { lastError = error?.code ?? CODE.UNAVAILABLE; }
    }

    // ── 远端读取（全分页）────────────────────────────────────────────────
    function matchedRaws(source, units, state) {
        return (Array.isArray(units) ? units : []).filter(raw => rawMatches(raw, source, state));
    }

    async function cancelOperation(operationId, signal) {
        let op = null;
        try { op = await hindsight.cancel(operationId, { signal }); }
        catch { op = null; }
        if (!op || typeof op.status !== 'string') {
            try { op = await hindsight.operation(operationId, { signal }); }
            catch { op = null; }
        }
        return op?.status ?? 'unknown';
    }

    // ── forget / revoke 共用：撤回远端 raw ───────────────────────────────
    async function retractCandidate(source, ctx) {
        const { signal, requestId, task } = ctx;
        const cid = source.candidate.candidate_id;
        const epoch = store.policyEpoch;
        const stale = () => signal?.aborted || store.policyEpoch !== epoch;
        const changed = () => ({ state: 'pending', code: signal?.aborted ? CODE.STOPPED : CODE.POLICY_CHANGED });
        if (signal?.aborted) return { state: 'pending', code: CODE.STOPPED };

        // 1) 先取消在途写操作（稳定 operation 身份；不 blind retry，不当作已撤回）
        let opPending = false;
        let unresolvedOp = false;
        for (const write of statements().writeTasks.all(cid)) {
            const status = write?.status;
            if (write?.operation_id && LANDED_WRITE.has(status)) continue;
            if (!write?.operation_id || !RUNNING_WRITE.has(status)) continue;
            let opStatus;
            try { opStatus = await cancelOperation(write.operation_id, signal); }
            catch (error) { const m = mapError(error, signal); if (m.state !== 'pending') return m; opPending = true; unresolvedOp = true; continue; }
            if (stale()) return changed();
            if (PENDING_OP.has(opStatus)) { opPending = true; unresolvedOp = true; }
            else if (!['completed', 'failed', 'cancelled'].includes(opStatus)) unresolvedOp = true;
        }

        // 2) doc + units(valid/invalidated) 精确证明
        let document; let validUnits; let invalidUnits;
        try {
            document = await hindsight.document(source.documentId, { signal });
            if (stale()) return changed();
            validUnits = await hindsight.units(source.documentId, { state: 'valid', signal });
            if (stale()) return changed();
            invalidUnits = await hindsight.units(source.documentId, { state: 'invalidated', signal });
        } catch (error) { return mapError(error, signal); }
        if (stale()) return changed();

        if (document && !documentMatches(document, source, hindsight.bank))
            return { state: 'failed', code: CODE.MISMATCH };

        const matchedValid = matchedRaws(source, validUnits, 'valid');
        const matchedInvalid = matchedRaws(source, invalidUnits, 'invalidated');
        const links = statements().rawLinks.all(cid);

        // 3) 远端为空：证明「没有落库」需要 op 已终态；否则保持跟踪
        if (!document && matchedValid.length === 0 && matchedInvalid.length === 0) {
            if (opPending || unresolvedOp || links.length) return { state: 'pending', code: CODE.UNPROVEN };
            return { state: 'succeeded' };
        }

        // 4) 文档匹配但没有任何可核 raw：无法证明
        if (matchedValid.length === 0 && matchedInvalid.length === 0)
            return { state: 'pending', code: opPending ? CODE.UNAVAILABLE : CODE.UNPROVEN };

        let pending = false;
        let failed = false;

        // 5) 撤回当前 valid 的 raw（版本必须与既有 link 一致，绝不覆盖变化版本）
        for (const raw of matchedValid) {
            if (stale()) return changed();
            const version = rawVersion(raw);
            const link = links.find(item => item.raw_id === raw.id);
            if (link && link.version_hash !== version) return { state: 'failed', code: CODE.MISMATCH };
            if (!link) {
                try {
                    store.transaction(() => statements().insertLink.run(raw.id, cid, source.documentId, version, 'valid', now()));
                } catch (error) { return mapError(error, signal); }
            }
            try {
                await hindsight.invalidate(raw.id, { requestId, signal });
            } catch (error) {
                const m = mapError(error, signal);
                if (m.state === 'failed') { failed = true; continue; } // 409 冲突：稍后重读判断
            }
            if (stale()) return changed();

            let afterInvalid; let afterValid;
            try {
                afterInvalid = await hindsight.units(source.documentId, { state: 'invalidated', signal });
                if (stale()) return changed();
                afterValid = await hindsight.units(source.documentId, { state: 'valid', signal });
            } catch (error) { return mapError(error, signal); }
            if (stale()) return changed();

            const okInvalid = (Array.isArray(afterInvalid) ? afterInvalid : [])
                .some(item => item.id === raw.id && rawMatches(item, source, 'invalidated') && rawVersion(item) === version);
            const stillValid = (Array.isArray(afterValid) ? afterValid : []).some(item => item.id === raw.id);
            if (!okInvalid || stillValid) { pending = true; continue; }

            try {
                store.transaction(() => {
                    statements().markLink.run('invalidated', version, now(), raw.id);
                    audit('forget', 'invalidated', { request_id: task.request_id, task_id: task.id, candidate_id: cid },
                        { raw_id: raw.id });
                });
            } catch (error) { return mapError(error, signal); }
        }

        // Already invalidated sources still require the original semantic version.
        for (const raw of matchedInvalid) {
            const version = rawVersion(raw);
            const link = links.find(item => item.raw_id === raw.id);
            if (link && link.version_hash !== version) { failed = true; continue; }
            try {
                store.transaction(() => {
                    if (link) statements().markLink.run('invalidated', version, now(), raw.id);
                    else statements().insertLink.run(raw.id, cid, source.documentId, version, 'invalidated', now());
                });
            } catch (error) { return mapError(error, signal); }
        }

        if (failed) return { state: 'failed', code: CODE.MISMATCH };
        if (pending || opPending || unresolvedOp) return { state: 'pending', code: CODE.UNPROVEN };
        const finalValid = await hindsight.units(source.documentId, { state: 'valid', signal });
        if (stale()) return changed();
        if (matchedRaws(source, finalValid, 'valid').length) return { state: 'pending', code: CODE.UNPROVEN };
        return { state: 'succeeded' };
    }

    // ── restore ──────────────────────────────────────────────────────────
    async function policyGate(source, ctx, restore) {
        if (ctx.signal?.aborted) return { state: 'pending', code: CODE.STOPPED };
        let result;
        try { result = await checkPolicy(source, ctx.task, { signal: ctx.signal, restore }); }
        catch { return { state: 'pending', code: CODE.POLICY_CHANGED }; }
        if (!result || result.allowed !== true) {
            const code = result?.code ?? 'LEPI_MEMORY_SUPPRESSED';
            if (code === CODE.POLICY_CHANGED || code === CODE.STOPPED) return { state: 'pending', code };
            return { state: 'failed', code };
        }
        return { epoch: result.epoch };
    }

    async function restoreCandidate(source, ctx) {
        const { signal, task } = ctx;
        const cid = source.candidate.candidate_id;
        if (source.lifecycle.status !== 'unknown') return { state: 'failed', code: CODE.MISMATCH };
        const links = statements().rawLinks.all(cid);
        if (links.length === 0) return { state: 'failed', code: CODE.SOURCE_MISSING };
        const requestId = uuidOr(task.request_id) ?? task.id;

        // 每个 await/变更/应用前都核验 restore 政策与 epoch（epoch 变更 -> 重新调度，不撤单）
        let epoch = null;
        async function gate() {
            if (signal?.aborted) return { state: 'pending', code: CODE.STOPPED };
            const result = await policyGate(source, ctx, true);
            if (result.state) return result;
            if (epoch === null) epoch = result.epoch;
            if (result.epoch !== epoch || store.policyEpoch !== epoch)
                return { state: 'pending', code: CODE.POLICY_CHANGED };
            return {};
        }

        let g = await gate(); if (g.state) return g;

        let document; let validUnits; let invalidUnits;
        g = await gate(); if (g.state) return g;
        try { document = await hindsight.document(source.documentId, { signal }); }
        catch (error) { return mapError(error, signal); }
        g = await gate(); if (g.state) return g;
        try { validUnits = await hindsight.units(source.documentId, { state: 'valid', signal }); }
        catch (error) { return mapError(error, signal); }
        g = await gate(); if (g.state) return g;
        try { invalidUnits = await hindsight.units(source.documentId, { state: 'invalidated', signal }); }
        catch (error) { return mapError(error, signal); }

        g = await gate(); if (g.state) return g;
        if (!document || !documentMatches(document, source, hindsight.bank)) return { state: 'failed', code: CODE.MISMATCH };

        // 定位既有 link 对应的 raw：必须精确证明且语义版本与 link 一致
        const resolved = [];
        const pool = [...(Array.isArray(validUnits) ? validUnits : []), ...(Array.isArray(invalidUnits) ? invalidUnits : [])];
        for (const link of links) {
            if (!isId(link.raw_id)) return { state: 'failed', code: CODE.MISMATCH };
            const raw = pool.find(item => item.id === link.raw_id);
            if (!raw) return { state: 'pending', code: CODE.UNPROVEN };
            const state = raw.state === 'valid' ? 'valid' : raw.state === 'invalidated' ? 'invalidated' : null;
            if (!state || !rawMatches(raw, source, state)) return { state: 'failed', code: CODE.MISMATCH };
            const version = rawVersion(raw);
            if (version !== link.version_hash) return { state: 'failed', code: CODE.MISMATCH };
            resolved.push({ link, raw, state, version });
        }

        // invalidated -> revert；已 valid -> 直接对账
        for (const entry of resolved) {
            if (entry.state !== 'invalidated') continue;
            g = await gate(); if (g.state) return g;
            try { await hindsight.revert(entry.raw.id, { requestId, signal }); }
            catch (error) { const m = mapError(error, signal); if (m.state === 'failed') return m; /* 冲突/瞬时：重读判定 */ }
            g = await gate(); if (g.state) return g;

            let afterValid;
            try { afterValid = await hindsight.units(source.documentId, { state: 'valid', signal }); }
            catch (error) { return mapError(error, signal); }
            const ok = (Array.isArray(afterValid) ? afterValid : [])
                .some(item => item.id === entry.raw.id && rawMatches(item, source, 'valid') && rawVersion(item) === entry.version);
            if (!ok) return { state: 'pending', code: CODE.UNPROVEN };
            entry.state = 'valid';
        }

        // 全部核实后才应用：lifecycle -> active/history_only，links -> valid
        g = await gate(); if (g.state) return g;

        const target = restoreStatus(source.candidate, now());
        try {
            store.transaction(() => {
                if (store.policyEpoch !== epoch) throw Object.assign(new Error(CODE.POLICY_CHANGED), { code: CODE.POLICY_CHANGED });
                const changed = statements().setLifecycle.run(target, epoch, now(), cid, 'unknown');
                if (Number(changed.changes) !== 1) throw Object.assign(new Error(CODE.MISMATCH), { code: CODE.MISMATCH });
                for (const entry of resolved) statements().markLink.run('valid', entry.version, now(), entry.raw.id);
                audit('forget', 'restored', { request_id: task.request_id, task_id: task.id, candidate_id: cid },
                    { status: target, links: resolved.length });
            });
        } catch (error) {
            if (error?.code === CODE.POLICY_CHANGED) return { state: 'pending', code: CODE.POLICY_CHANGED };
            return mapError(error, signal);
        }
        return { state: 'succeeded' };
    }

    async function processCandidate(id, ctx) {
        let source;
        try { source = loadSource(store, id); }
        catch (error) {
            if (error?.code === CODE.SNAPSHOT_INVALID) return { state: 'failed', code: CODE.SNAPSHOT_INVALID };
            throw error;
        }
        if (!source) return { state: 'failed', code: CODE.SOURCE_MISSING };

        if (ctx.kind === 'restore') return restoreCandidate(source, ctx);
        if (ctx.kind === 'forget') {
            if (source.lifecycle.status !== 'forgotten') return { state: 'failed', code: CODE.MISMATCH };
            return retractCandidate(source, ctx);
        }
        // revoke：保留已有 active/history 记忆；仅清理在途/未落库的 pending/unknown
        if (ctx.kind === 'revoke') {
            if (REVOKE_KEEP.has(source.lifecycle.status) || !REVOKE_RETRACT.has(source.lifecycle.status))
                return { state: 'kept' };
            return retractCandidate(source, ctx);
        }
        return { state: 'failed', code: CODE.INVALID };
    }

    function applyOutcome(progress, id, outcome) {
        switch (outcome?.state) {
            case 'succeeded': progress.succeeded_ids.push(id); break;
            case 'kept': progress.kept_ids.push(id); break;
            case 'failed': progress.failed_ids.push(id); progress.error_code ||= outcome.code ?? CODE.UNPROVEN; break;
            default: progress.pending_ids.push(id); progress.error_code ||= outcome?.code ?? CODE.UNPROVEN; break;
        }
    }

    async function process(task, signal) {
        const payload = parseJson(task.payload_json, {});
        const kind = payload.kind;
        const ids = Array.isArray(payload.candidate_ids)
            ? [...new Set(payload.candidate_ids.filter(isId))] : [];

        // 复用之前持久化的无正文进度：已确认的 id 不重做（幂等）
        const progress = {
            kind, candidate_ids: ids,
            attempted_ids: Array.isArray(payload.attempted_ids) ? [...payload.attempted_ids] : [],
            succeeded_ids: Array.isArray(payload.succeeded_ids) ? [...payload.succeeded_ids] : [],
            failed_ids: [],
            pending_ids: [], kept_ids: Array.isArray(payload.kept_ids) ? [...payload.kept_ids] : [],
            error_code: null,
        };
        if (!KINDS.has(kind) || ids.length === 0) { finalizeInvalid(task, progress); return; }

        const ctx = { task, kind, requestId: uuidOr(task.request_id) ?? task.id, signal };
        for (const id of ids) {
            if (progress.succeeded_ids.includes(id) || progress.kept_ids.includes(id)) continue;
            if (signal?.aborted) { progress.pending_ids.push(id); progress.error_code ||= CODE.STOPPED; continue; }
            if (!progress.attempted_ids.includes(id)) progress.attempted_ids.push(id);
            let outcome;
            try { outcome = await processCandidate(id, ctx); }
            catch (error) { outcome = mapError(error, signal); }
            applyOutcome(progress, id, outcome);
            persist(task, progress);
        }
        finalize(task, progress);
    }

    async function runNext(signal) {
        let task;
        try { task = claim(); }
        catch (error) { lastError = error?.code ?? CODE.UNAVAILABLE; return false; }
        if (!task) return false;
        try { await process(task, signal); }
        catch (error) { lastError = error?.code ?? CODE.UNAVAILABLE; safeRelease(task); }
        return true;
    }

    function health() {
        const tasks = {};
        let total = 0;
        try {
            for (const row of statements().counts.all()) { tasks[row.status] = row.n; total += row.n; }
        } catch (error) { lastError = error?.code ?? CODE.UNAVAILABLE; }
        return { kind: CURATE, tasks, total, last_error: lastError };
    }

    return { runNext, health };
}
