import { createHash, randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools';
import { CONTROL_KINDS } from './contracts.js';
import { resolveConfig } from './config.js';
import type { LepiConfig } from './config.js';
import type { EvidenceIndex } from './evidence.js';
import type { Store } from './store.js';
import type { ControlKind, ScopeKind } from './shared/domain.js';

declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'lepimemory-control': { kind: 'lepimemory-control' } & ContextFormed;
    }
}
import type { ContextFormed } from '@deepseek-ai/dsh-llm';

const PARAMETERS: JsonSchemaNode = {
    type: 'object', additionalProperties: false,
    properties: {
        kind: { type: 'string', enum: [...CONTROL_KINDS] },
        source_ids: { type: 'array', items: { type: 'string' } },
        candidate_ids: { type: 'array', items: { type: 'string' } },
    },
    required: ['kind', 'source_ids', 'candidate_ids'],
};
const RECEIPT_SCHEMA: JsonSchemaNode = {
    type: 'object', additionalProperties: false,
    properties: {
        request_id: { oneOf: [{ type: 'null' }, { type: 'string' }] },
        status: { type: 'string' }, code: { oneOf: [{ type: 'null' }, { type: 'string' }] },
    },
    required: ['request_id', 'status', 'code'],
};
const UNAVAILABLE = 'LEPI_CONTROL_UNAVAILABLE';
const RESUBMIT = 'LEPI_INPUT_RESUBMIT_REQUIRED';

/** 边界读取：只取 id 与 session id。 */
interface AgentLike {
    id: string;
    session?: { id?: string } | null;
    steer(message: unknown): unknown;
}
interface FrameMessage {
    id: string;
    source?: { kind?: string } | null;
}
interface SessionSourceLike {
    id: string;
    actor: string;
    kind: string;
    at: string | null;
    text: string;
}
interface RequestRow {
    id: string;
    source_key: string;
    session_id: string;
    turn: number | null;
    step: number | null;
    kind: string;
    status: string;
    source_ids_json: string;
    payload_json: string;
    error_code: string | null;
}
interface EvidenceRow {
    id: string;
    session_id: string;
    message_id: string;
}
interface SnapshotRow {
    candidate_id: string;
    json: string;
    status: string;
}
interface GrantRow {
    id: string;
    scope_json: string;
    source_ids_json: string;
    session_id: string | null;
    expires_at: number;
    revoked_at: number | null;
    allow_inference: number;
}
interface LifecycleRow {
    candidate_id: string;
    grant_id: string | null;
}
interface TaskRowLike {
    id: string;
    candidate_id: string | null;
}
interface ForgetScopeRow {
    id: string;
    session_id: string | null;
    candidate_id?: string;
    candidate_ids_json: string;
    selector_json: string;
}
interface ParsedScope {
    kind: ScopeKind;
    facet_key?: string;
    subject_key?: string;
    topic?: string | null;
    session_id?: string | null;
    expires_at?: string | null;
    allow_inference?: boolean;
    candidate_id?: string;
}
interface ScopeLike {
    kind: ScopeKind;
    candidate_id?: string;
    subject_key: string;
    topic: string | null;
    session_id: string | null;
    expires_at: string;
    allow_inference: boolean;
}

interface ControlRequest {
    kind: ControlKind;
    source_ids: string[];
    candidate_ids: string[];
    scope?: ParsedScope | null;
}
interface ContextGuard {
    source_ids: string[];
    subject_key?: string;
    facet_key?: string;
}
interface ControlResult {
    requests: ControlRequest[];
    context_guards: ContextGuard[];
}
interface ProcessorLike {
    checkControl(input: unknown, options?: { signal?: AbortSignal }): Promise<ControlResult>;
    matchGrant(candidate: unknown, grant: unknown, options?: { purpose?: string; agent?: unknown; signal?: AbortSignal; sources?: readonly unknown[] }): Promise<{ match: string }>;
}
interface HistoryLike {
    plan(requestId: string, candidateIds: string[]): Promise<unknown>;
}
interface RejectDecision {
    kind: string;
    messages?: readonly unknown[];
}
type NextFn = () => Promise<RejectDecision>;
interface HookFrame {
    agent: AgentLike;
    messages?: readonly FrameMessage[];
    turn?: number;
    step?: number;
    signal?: AbortSignal;
    call_id?: string | null;
}
interface ControlContext {
    agents?: {
        get(id: string): AgentLike | undefined;
        roots(): AgentLike[];
    };
    userQuestions?: {
        ask(request: { agent: AgentLike; signal: AbortSignal; questions: ReadonlyArray<Record<string, unknown>> }): Promise<AskAnswers>;
    };
}
interface AskAnswers {
    answers?: Array<{ id?: unknown; custom?: unknown; selected?: unknown }>;
}
interface ToolArgs {
    kind: ControlKind;
    source_ids: string[];
    candidate_ids: string[];
}
interface ExecLike {
    agent: AgentLike;
    signal?: AbortSignal;
    callId?: string | null;
    concludeTurn(): void;
}
interface RenderedReceipt {
    request_id: string | null;
    status: string;
    code: string | null;
}
interface PendingEntry {
    token: string;
    candidateId: string | null;
    agent: AgentLike;
    epoch: number;
    controller: AbortController;
    detail: string | null;
    expiresAt: number;
}
interface ContextEntry {
    epoch: number;
    source_ids: string[];
    turn?: number;
    step?: number;
    result: ControlResult;
}
interface CandidateLike {
    candidate_id?: string;
    request_id?: string;
    text?: unknown;
    sensitivity?: string;
    source_ids?: string[];
    subject_key?: string;
    facet_key?: string;
    origin?: string;
}

const sessionId = (agent?: AgentLike | null): string | undefined => agent?.session?.id ?? agent?.id;
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
const negativeFirst = (request: ControlRequest): number => request.kind === 'forget' || request.kind === 'revoke' ? 0 : 1;

// Question details are display-only, never Markdown links, images, HTML, or code.
function displayText(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/([\\`*_{}[\]()!#|~])/g, '\\$1');
}
function notice(text: string): unknown {
    return createUserMessage({ content: [{ type: 'text', text }],
        source: { kind: 'lepimemory-control', form: 'notice', summary: text } });
}
function receipt(row: RequestRow | undefined): RenderedReceipt {
    return { request_id: row?.id ?? null, status: row?.status ?? 'unavailable', code: row?.error_code ?? null };
}

/** Construction has no registration, timers, network calls, or worker startup. */
export function createControl({ ctx, store, processor, evidence, history, enqueue, now = Date.now, config = resolveConfig() }: {
    ctx: ControlContext;
    store: Store;
    processor: ProcessorLike;
    evidence: EvidenceIndex;
    history: HistoryLike;
    enqueue(input: { request_id: string; session_id: string; source_ids: string[]; kind: string; explicit: boolean }): Promise<unknown>;
    now?: () => number;
    config?: LepiConfig;
}) {
    const pending = new Map<string, PendingEntry>();
    const contexts = new Map<string, ContextEntry>();
    const inflight = new Map<string, Promise<RequestRow>>();
    const owned = new Set<Promise<unknown>>();
    function own<T>(work: Promise<T>): Promise<T> {
        owned.add(work);
        work.then(() => owned.delete(work), () => owned.delete(work));
        return work;
    }
    const lifetime = new AbortController();
    let disposed = false;
    const db = store.db;
    const consentTimeoutMs = config.timeouts.consentTimeoutMs;
    const grantTtlMs = config.timeouts.grantTtlMs;
    const findRequest = db.prepare('SELECT * FROM requests WHERE id=?');
    const findKey = db.prepare('SELECT * FROM requests WHERE source_key=?');
    const findEvidence = db.prepare('SELECT * FROM evidence WHERE id=?');
    const getSnapshot = db.prepare(`SELECT s.json,l.* FROM snapshots s JOIN lifecycle l ON l.candidate_id=s.candidate_id WHERE s.candidate_id=?`);

    function liveRoot(agent: AgentLike | undefined): boolean {
        const agents = ctx.agents;
        return !disposed && Boolean(agent) && agents?.get(agent!.id) === agent && Boolean(agents?.roots().includes(agent!));
    }
    function blocked(agent: AgentLike | undefined): boolean {
        return !!db.prepare("SELECT 1 FROM history_work WHERE session_id=? AND status!='applied' LIMIT 1").get(sessionId(agent) ?? null);
    }
    function audit(type: string, status: string, identity: {
        session_id?: string | number | null; agent?: AgentLike | undefined; turn?: number | null; step?: number | null;
        call_id?: string | null; request_id?: string | null; candidate_id?: string | null;
    } = {}, data: Record<string, unknown> = {}): void {
        store.audit({ type, status, session_id: identity.session_id ?? sessionId(identity.agent),
            turn: identity.turn, step: identity.step, call_id: identity.call_id,
            request_id: identity.request_id, candidate_id: identity.candidate_id, data });
    }
    function update(row: RequestRow, status: string, code: string | null = null, extra?: Record<string, unknown>): RequestRow {
        store.transaction(() => {
            const current = findRequest.get(row.id) as unknown as RequestRow;
            const payload = extra ? { ...(JSON.parse(current.payload_json) as Record<string, unknown>), ...extra } : JSON.parse(current.payload_json);
            db.prepare('UPDATE requests SET status=?,error_code=?,payload_json=?,updated_at=? WHERE id=?')
                .run(status, code, JSON.stringify(payload), now(), row.id);
            audit('control', status, { ...row, request_id: row.id }, { code });
        });
        return findRequest.get(row.id) as unknown as RequestRow;
    }
    function register(kind: string, ids: string[], frame: HookFrame, candidateIds: string[] = []): RequestRow {
        const rows = ids.map(id => findEvidence.get(id) as unknown as EvidenceRow | undefined);
        if (rows.some(row => !row || row.session_id !== sessionId(frame.agent)) || (!rows.length && kind !== 'check')) throw new Error(UNAVAILABLE);
        const messageIds = unique(rows.length ? rows.map(row => row!.message_id)
            : frame.messages!.filter(message => message.source?.kind === 'user').map(message => message.id)).sort();
        if (!messageIds.length) throw new Error(UNAVAILABLE);
        const key = createHash('sha256').update(JSON.stringify([sessionId(frame.agent), messageIds, kind])).digest('hex');
        const row = findKey.get(key) as unknown as RequestRow | undefined;
        if (row) return row;
        const id = randomUUID();
        store.transaction(() => {
            db.prepare(`INSERT INTO requests (id,source_key,session_id,turn,step,kind,status,source_ids_json,payload_json,created_at,updated_at)
                VALUES (?,?,?,?,?,?,'received',?,?,?,?)`).run(id, key, sessionId(frame.agent) ?? null, frame.turn ?? null, frame.step ?? null,
                kind, JSON.stringify(unique(ids)), JSON.stringify({ message_ids: messageIds, candidate_ids: unique(candidateIds),
                    agent_id: frame.agent.id, epoch: store.policyEpoch }), now(), now());
            audit('control', 'received', { ...frame, request_id: id }, { kind, source_ids: unique(ids) });
        });
        return findRequest.get(id) as unknown as RequestRow;
    }

    async function question({ agent, candidateId = null, sourceIds = [], requestId = null, title, detail, labels, negativeLabel, multi = false, signal }: {
        agent: AgentLike; candidateId?: string | null; sourceIds?: string[]; requestId?: string | null;
        title: string; detail: string | null; labels: string[]; negativeLabel?: string; multi?: boolean; signal?: AbortSignal;
    }): Promise<{ outcome: string; selected: string[]; token: string | null; epoch?: number }> {
        if (!liveRoot(agent) || typeof ctx.userQuestions?.ask !== 'function') return { outcome: 'unavailable', selected: [], token: null };
        const token = randomUUID();
        const controller = new AbortController();
        const epoch = store.policyEpoch;
        const entry: PendingEntry = { token, candidateId, agent, epoch, controller, detail, expiresAt: now() + consentTimeoutMs };
        pending.set(token, entry);
        const fused = AbortSignal.any([controller.signal, lifetime.signal, ...(signal ? [signal] : [])]);
        let abortListener: (() => void) | undefined;
        let timeout: NodeJS.Timeout | undefined;
        let outcome = 'unavailable';
        let selected: string[] = [];
        try {
            const aborted = new Promise<null>(resolve => {
                abortListener = () => resolve(null);
                fused.addEventListener('abort', abortListener, { once: true });
                if (fused.aborted) resolve(null);
            });
            timeout = setTimeout(() => controller.abort('expired'), consentTimeoutMs);
            const answer = await Promise.race([ctx.userQuestions.ask({ agent, signal: fused, questions: [{
                id: token, question: title, detail: entry.detail,
                options: labels.map(label => ({ label })), multiSelect: multi,
            }] }), aborted]);
            const validToken = pending.get(token) === entry && entry.token === token && entry.candidateId === candidateId;
            if (controller.signal.reason === 'expired' || now() >= entry.expiresAt) outcome = 'expired';
            else if (fused.aborted || !validToken || !liveRoot(agent)) outcome = 'cancelled';
            else if (store.policyEpoch !== epoch || blocked(agent)) outcome = 'cancelled';
            else if (answer?.answers?.length === 1 && answer.answers[0]!.id === token && answer.answers[0]!.custom === undefined) {
                const chosen = answer.answers[0]!.selected;
                if (Array.isArray(chosen) && chosen.length > 0 && (multi || chosen.length === 1)
                    && new Set(chosen).size === chosen.length && chosen.every(label => labels.includes(label))) {
                    outcome = chosen.length === 1 && chosen[0] === negativeLabel ? 'rejected' : 'allowed';
                    selected = chosen;
                }
            }
        } catch (error) {
            const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
            outcome = controller.signal.reason === 'expired' || now() >= entry.expiresAt ? 'expired'
                : fused.aborted || code === 'ASK_ABORTED' ? 'cancelled' : 'unavailable';
        } finally {
            clearTimeout(timeout);
            if (abortListener) fused.removeEventListener('abort', abortListener);
            controller.abort();
            entry.detail = null;
            pending.delete(token);
        }
        audit('consent', outcome, { agent, request_id: requestId, candidate_id: candidateId },
            { question_id: token, source_ids: sourceIds });
        return { outcome, selected, token, epoch };
    }

    function insertGrant(scope: ScopeLike, ids: string[], agent: AgentLike, questionId: string, candidateId: string | null, expectedEpoch: number): string | null {
        if (!liveRoot(agent) || blocked(agent) || expectedEpoch !== store.policyEpoch) return null;
        const id = randomUUID();
        store.transaction(() => {
            db.prepare(`INSERT INTO grants(id,scope_json,source_ids_json,session_id,expires_at,allow_inference) VALUES (?,?,?,?,?,?)`)
                .run(id, JSON.stringify(scope), JSON.stringify(ids), scope.session_id, Date.parse(scope.expires_at!), Number(scope.allow_inference));
            store.bumpPolicyEpoch();
            audit('grant', 'allowed', { agent, candidate_id: candidateId }, { grant_id: id, question_id: questionId, source_ids: ids });
        });
        return id;
    }
    async function askPrivate(candidate: CandidateLike, agent: AgentLike, { signal }: { signal?: AbortSignal } = {}): Promise<{ outcome: string; grant_id: string | null }> {
        if (candidate.sensitivity === 'excluded' || typeof candidate.text !== 'string' || !candidate.candidate_id)
            return { outcome: 'unavailable', grant_id: null };
        const text = candidate.text;
        const candidateId = candidate.candidate_id;
        const sourceIds = candidate.source_ids;
        if (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.some(id => {
            const row = findEvidence.get(id) as unknown as EvidenceRow | undefined;
            return !row || row.session_id !== sessionId(agent);
        })) return { outcome: 'unavailable', grant_id: null };
        // Keep the exact item shown by this question, even if its caller mutates a draft while waiting.
        const exactSourceIds = [...sourceIds];
        const requestId = candidate.request_id;
        const subjectKey = candidate.subject_key;
        const facetKey = candidate.facet_key;
        const origin = candidate.origin;
        const result = await question({ agent, candidateId, sourceIds: exactSourceIds,
            requestId, title: '允许长期记住这条信息吗？', detail: displayText(text),
            labels: ['允许这条', '不保存'], negativeLabel: '不保存', signal });
        if (result.outcome !== 'allowed') return { outcome: result.outcome, grant_id: null };
        if (result.selected[0] !== '允许这条') return { outcome: 'rejected', grant_id: null };
        const scope: ScopeLike = { kind: 'item', candidate_id: candidateId, subject_key: subjectKey!,
            topic: facetKey!, session_id: sessionId(agent) ?? null, expires_at: new Date(now() + grantTtlMs).toISOString(),
            allow_inference: origin === 'inference' };
        const readable = await evidence.read(exactSourceIds, { agent, signal, request_id: requestId });
        if (signal?.aborted || result.epoch !== store.policyEpoch || exactSourceIds.some(id => !readable.sources.some(source => source.id === id)))
            return { outcome: 'cancelled', grant_id: null };
        const grantId = insertGrant(scope, exactSourceIds, agent, result.token!, candidateId, result.epoch!);
        const advanced = grantId && evidence.advanceClaim(exactSourceIds, { agent, previousEpoch: result.epoch!, request_id: requestId! });
        return { outcome: advanced ? 'allowed' : 'cancelled', grant_id: advanced ? grantId : null };
    }

    async function selectCandidates(kind: string, row: RequestRow, frame: HookFrame, candidateIds: string[]): Promise<string[] | null> {
        const permitted = kind === 'restore' ? ['forgotten'] : ['active', 'pending', 'history_only', 'superseded', 'unknown'];
        const rows: SnapshotRow[] = candidateIds.length ? candidateIds.map(id => getSnapshot.get(id) as unknown as SnapshotRow)
            : (db.prepare(`SELECT s.json,l.* FROM snapshots s JOIN lifecycle l ON l.candidate_id=s.candidate_id ORDER BY s.created_at DESC`).all() as unknown as SnapshotRow[])
                .filter(item => permitted.includes(item.status));
        if (!rows.length || rows.some(item => !item || !permitted.includes(item.status))) return null;
        const labels = rows.map(item => `[${item.candidate_id}] ${displayText((JSON.parse(item.json) as { text: string }).text)}`);
        const result = await question({ agent: frame.agent, requestId: row.id, sourceIds: JSON.parse(row.source_ids_json) as string[],
            title: kind === 'restore' ? '恢复哪些已遗忘的记忆？' : '遗忘哪些已保存的记忆？',
            detail: '请选择明确的候选。历史净化不可逆；恢复长期记忆不会重建已经净化的对话。', labels, multi: true, signal: frame.signal });
        if (result.outcome !== 'allowed') return null;
        return result.selected.map(label => rows[labels.indexOf(label)]!.candidate_id);
    }
    function curate(row: RequestRow, kind: string, candidateIds: string[]): void {
        const at = now();
        db.prepare(`INSERT INTO tasks(id,kind,request_id,status,payload_json,next_at,expires_at)
            VALUES (?,'curate',?,'pending',?,?,?)`).run(randomUUID(), row.id, JSON.stringify({ kind, candidate_ids: candidateIds }), at, at + config.timeouts.taskTtlMs);
    }
    function cancelUnsent(candidateIds: string[]): void {
        const targets = new Set(candidateIds);
        const tasks = db.prepare("SELECT id,candidate_id FROM tasks WHERE submitted_at IS NULL AND status IN ('pending','running','deferred')").all() as unknown as TaskRowLike[];
        const cancel = db.prepare("UPDATE tasks SET status='cancelled',draft_json=NULL,payload_json=NULL,lease_owner=NULL WHERE id=?");
        for (const task of tasks) if (!task.candidate_id || targets.has(task.candidate_id)) cancel.run(task.id);
    }
    async function revoke(row: RequestRow, request: ControlRequest, frame: HookFrame): Promise<RequestRow> {
        const grants = db.prepare('SELECT * FROM grants WHERE revoked_at IS NULL AND expires_at>? ORDER BY expires_at').all(now()) as unknown as GrantRow[];
        if (!grants.length) return update(row, 'needs_clarification');
        const labels = grants.map(grant => {
            const scope = JSON.parse(grant.scope_json) as ParsedScope;
            return `[${grant.id}] ${displayText(`${scope.subject_key} / ${scope.topic ?? '单项'} / ${scope.session_id ?? '跨会话'}`)}`;
        });
        const answer = await question({ agent: frame.agent, requestId: row.id, sourceIds: request.source_ids,
            title: '撤销哪些已确认的保存授权？', detail: '先停止新的相关保存；已有记忆默认保留。', labels, multi: true, signal: frame.signal });
        if (answer.outcome !== 'allowed') return update(row, 'unavailable', UNAVAILABLE);
        const chosen = answer.selected.map(label => grants[labels.indexOf(label)]!);
        const chosenIds = new Set(chosen.map(grant => grant.id));
        const candidates = (db.prepare('SELECT candidate_id,grant_id FROM lifecycle').all() as unknown as LifecycleRow[])
            .filter(item => chosenIds.has(item.grant_id!)).map(item => item.candidate_id);
        store.transaction(() => {
            const revokeGrant = db.prepare('UPDATE grants SET revoked_at=? WHERE id=?');
            for (const grant of chosen) revokeGrant.run(now(), grant.id);
            cancelUnsent(candidates);
            store.bumpPolicyEpoch();
            // Submitted jobs are reconciled/curated separately; an abort is not a remote retraction.
            curate(row, 'revoke', candidates);
            audit('grant', 'revoked', { ...frame, request_id: row.id }, { grant_ids: [...chosenIds], candidate_ids: candidates });
        });
        for (const entry of pending.values()) entry.controller.abort('policy-changed');
        update(row, 'revoked');
        const followup = await question({ agent: frame.agent, requestId: row.id, sourceIds: request.source_ids,
            title: '是否也遗忘这些授权下已有的记忆？', detail: '不回答时保留已有记忆，但不会继续依赖已撤销的授权保存新内容。',
            labels: ['保留已有记忆', '同时遗忘已有记忆'], signal: frame.signal });
        if (followup.outcome === 'allowed' && followup.selected[0] === '同时遗忘已有记忆' && candidates.length) {
            await history.plan(row.id, candidates);
            return update(row, 'local_isolating');
        }
        return findRequest.get(row.id) as unknown as RequestRow;
    }
    async function grant(row: RequestRow, request: ControlRequest, frame: HookFrame): Promise<RequestRow> {
        if (!request.scope || request.scope.kind === 'item') return update(row, 'needs_clarification');
        const continuous = request.scope.kind === 'continuous';
        const expiry = request.scope.expires_at === null ? now() + grantTtlMs : Date.parse(request.scope.expires_at ?? '');
        if (!Number.isFinite(expiry) || expiry <= now() || !request.scope.subject_key || !request.scope.topic)
            return update(row, 'needs_clarification');
        const scope: ScopeLike = {
            kind: request.scope.kind,
            ...(request.scope.candidate_id === undefined ? {} : { candidate_id: request.scope.candidate_id }),
            subject_key: request.scope.subject_key,
            topic: request.scope.topic,
            session_id: continuous ? null : sessionId(frame.agent) ?? null,
            expires_at: new Date(expiry).toISOString(),
            allow_inference: request.scope.allow_inference === true,
        };
        const detail = displayText(`主体：${scope.subject_key}\n话题：${scope.topic}\n会话：${scope.session_id ?? '跨会话持续授权'}\n到期：${scope.expires_at}\n包括未确认推断：${scope.allow_inference ? '是' : '否'}`);
        const answer = await question({ agent: frame.agent, requestId: row.id, sourceIds: request.source_ids,
            title: '允许在这个明确范围内长期保存吗？', detail, labels: ['允许所示范围', '不允许'], negativeLabel: '不允许', signal: frame.signal });
        if (answer.outcome !== 'allowed') return update(row, answer.outcome, answer.outcome === 'unavailable' ? UNAVAILABLE : null);
        const grantId = insertGrant(scope, request.source_ids, frame.agent, answer.token!, null, answer.epoch!);
        return grantId ? update(row, 'allowed', null, { grant_id: grantId }) : update(row, 'cancelled');
    }
    async function processRequest(row: RequestRow, request: ControlRequest, frame: HookFrame): Promise<RequestRow> {
        if (!['received', 'retry_pending'].includes(row.status)) return row;
        switch (request.kind) {
            case 'grant': return grant(row, request, frame);
            case 'revoke': return revoke(row, request, frame);
            case 'forget': {
                const chosen = await selectCandidates('forget', row, frame, request.candidate_ids);
                if (!chosen) return update(row, 'needs_clarification');
                await history.plan(row.id, chosen);
                return update(row, 'local_isolating');
            }
            case 'restore': {
                const chosen = await selectCandidates('restore', row, frame, request.candidate_ids);
                if (!chosen) return update(row, 'needs_clarification');
                store.transaction(() => {
                    // Remote versions must be reverified before they can become current.
                    const restore = db.prepare("UPDATE lifecycle SET status='unknown',policy_epoch=?,updated_at=? WHERE candidate_id=? AND status='forgotten'");
                    const epoch = store.bumpPolicyEpoch();
                    for (const id of chosen) restore.run(epoch, now(), id);
                    const scopes = db.prepare('SELECT * FROM forget_scopes WHERE active=1').all() as unknown as ForgetScopeRow[];
                    for (const scope of scopes) {
                        const remaining = (JSON.parse(scope.candidate_ids_json) as string[]).filter(id => !chosen.includes(id));
                        db.prepare('UPDATE forget_scopes SET candidate_ids_json=?,active=?,epoch=? WHERE id=?')
                            .run(JSON.stringify(remaining), Number(remaining.length > 0), epoch, scope.id);
                    }
                    curate(row, 'restore', chosen);
                    audit('forget', 'restoring', { ...frame, request_id: row.id }, { candidate_ids: chosen });
                });
                return update(row, 'restoring');
            }
            case 'correct': {
                if (!request.candidate_ids.length || request.candidate_ids.some(id => !['active', 'pending', 'history_only'].includes((getSnapshot.get(id) as unknown as SnapshotRow | undefined)?.status ?? '')))
                    return update(row, 'needs_clarification');
                store.transaction(() => {
                    const epoch = store.bumpPolicyEpoch();
                    const supersede = db.prepare("UPDATE lifecycle SET status='superseded',policy_epoch=?,updated_at=? WHERE candidate_id=? AND status IN ('active','pending','history_only')");
                    for (const id of request.candidate_ids) supersede.run(epoch, now(), id);
                    cancelUnsent(request.candidate_ids);
                    audit('memory', 'superseded', { ...frame, request_id: row.id }, { candidate_ids: request.candidate_ids });
                });
                break;
            }
            case 're_remember': {
                const answer = await question({ agent: frame.agent, requestId: row.id, sourceIds: request.source_ids,
                    title: '只重新记住这次新表达的内容吗？', detail: '这是一次新的候选处理；不会恢复其他旧记忆，也不会重建已经净化的对话。',
                    labels: ['重新记住这次内容', '不重新记住'], negativeLabel: '不重新记住', signal: frame.signal });
                if (answer.outcome !== 'allowed') return update(row, answer.outcome, answer.outcome === 'unavailable' ? UNAVAILABLE : null);
                if (answer.epoch !== store.policyEpoch || !liveRoot(frame.agent)) return update(row, 'cancelled');
                store.transaction(() => {
                    store.bumpPolicyEpoch();
                    const scopeIds = (db.prepare('SELECT id FROM forget_scopes WHERE active=1').all() as unknown as Array<{ id: string }>).map(scope => scope.id);
                    db.prepare('UPDATE requests SET payload_json=? WHERE id=?').run(JSON.stringify({ ...(JSON.parse(row.payload_json) as Record<string, unknown>),
                        exception_scope_ids: scopeIds, question_id: answer.token }), row.id);
                });
                break;
            }
        }
        if (['correct', 're_remember'].includes(request.kind) && frame.messages) {
            // Rebind only this still-claimed native payload after our own policy transaction.
            // The worker must separately enforce current forget/grant policy; no old surface is revived.
            evidence.claimed(frame.agent, frame.messages, frame.turn!, frame.step!);
        }
        const input = { request_id: row.id, session_id: row.session_id, source_ids: request.source_ids, kind: request.kind, explicit: true };
        if (!evidence.holdRequest(row.id, request.source_ids, frame.agent)) return update(row, 'resubmit_required', RESUBMIT);
        try { await enqueue(input); }
        catch (error) { evidence.releaseRequest(row.id); throw error; }
        return update(findRequest.get(row.id) as unknown as RequestRow, 'queued');
    }
    async function dispatch(request: ControlRequest, frame: HookFrame): Promise<RequestRow> {
        const row = register(request.kind, request.source_ids, frame, request.candidate_ids);
        if (!liveRoot(frame.agent)) return update(row, 'unavailable', 'LEPI_NO_INITIATOR');
        const running = inflight.get(row.id);
        if (running) return running;
        const work = Promise.resolve().then(() => processRequest(row, request, frame))
            .catch(() => update(findRequest.get(row.id) as unknown as RequestRow, 'unavailable', UNAVAILABLE));
        inflight.set(row.id, work);
        try { return await work; }
        finally { inflight.delete(row.id); }
    }

    async function guardsAllowed(result: ControlResult, frame: HookFrame, sources: SessionSourceLike[], contextSources: SessionSourceLike[]): Promise<boolean> {
        const scopes = db.prepare('SELECT * FROM forget_scopes WHERE active=1').all() as unknown as ForgetScopeRow[];
        if (!scopes.length) return true;
        if (!result.context_guards.length) return false;
        for (const guard of result.context_guards) {
            const primary = sources.find(source => guard.source_ids.includes(source.id) && source.actor === 'user');
            if (!primary || !guard.subject_key || !guard.facet_key) return false;
            for (const row of scopes) {
                const selector = JSON.parse(row.selector_json) as ParsedScope;
                if (!selector.subject_key || !selector.facet_key) return false;
                const candidate = { text: primary.text, source_ids: guard.source_ids, subject_key: guard.subject_key,
                    facet_key: guard.facet_key, origin: 'user', formed_at: primary.at };
                const match = await processor.matchGrant(candidate, { scope: { kind: 'topic', subject_key: selector.subject_key,
                    topic: selector.facet_key, session_id: row.session_id ?? null, allow_inference: false } }, { purpose: 'forget', agent: frame.agent, signal: frame.signal, sources: [...sources, ...contextSources] });
                if (match.match !== 'not_covered') return false;
            }
        }
        return true;
    }
    function park(frame: HookFrame, ids: string[], code = UNAVAILABLE): RequestRow {
        const row = register('check', ids, frame);
        const updated = update(row, code === RESUBMIT ? 'resubmit_required' : 'parked', code);
        if (!disposed && code !== RESUBMIT) for (const message of frame.messages!) if (message.source?.kind === 'user') frame.agent.steer(message);
        return updated;
    }
    async function beforeStep(frame: HookFrame, next: NextFn): Promise<RejectDecision> {
        if (disposed || blocked(frame.agent)) return { kind: 'reject' };
        contexts.delete(frame.agent.id);
        frame = { ...frame, signal: AbortSignal.any([lifetime.signal, ...(frame.signal ? [frame.signal] : [])]) };
        const users = frame.messages!.filter(message => message.source?.kind === 'user');
        if (!users.length) return next();
        const ids = evidence.claimed(frame.agent, users, frame.turn!, frame.step!);
        const epoch = store.policyEpoch;
        const messageIds = new Set(users.map(message => message.id));
        const prior = (db.prepare("SELECT * FROM requests WHERE session_id=? AND kind='check' AND status IN ('parked','retry_pending','resubmit_required')")
            .all(sessionId(frame.agent) ?? null) as unknown as RequestRow[]).filter(row => (JSON.parse(row.payload_json) as { message_ids: string[] }).message_ids.some(id => messageIds.has(id)));
        const latestFence = (db.prepare('SELECT max(epoch) AS epoch FROM forget_scopes').get() as unknown as { epoch: number | null }).epoch ?? 0;
        if (prior.some(row => row.status === 'resubmit_required' || (JSON.parse(row.payload_json) as { epoch: number }).epoch < latestFence)) {
            for (const row of prior) update(row, 'resubmit_required', RESUBMIT);
            park(frame, ids, RESUBMIT);
            return { kind: 'reject' };
        }
        if (prior.some(row => row.status === 'parked')) {
            for (const message of users) frame.agent.steer(message);
            return { kind: 'reject' };
        }
        let result: ControlResult;
        let sources: SessionSourceLike[];
        let contextSources: SessionSourceLike[];
        try {
            if (!ids.length) throw new Error(UNAVAILABLE);
            if (ids.some(id => !findEvidence.get(id))) throw new Error(UNAVAILABLE);
            const read = await evidence.read(ids, { agent: frame.agent, signal: frame.signal });
            sources = read.sources;
            if (ids.some(id => !sources.some(source => source.id === id)))
                throw new Error(read.excluded.some(item => item.code === RESUBMIT) ? RESUBMIT : UNAVAILABLE);
            const recent = await evidence.recent(frame.agent, { maxChars: 3000, signal: frame.signal });
            const activeSelectors = (db.prepare('SELECT selector_json FROM forget_scopes WHERE active=1').all() as unknown as Array<{ selector_json: string }>).map(row => JSON.parse(row.selector_json));
            contextSources = recent.sources.filter(source => source.actor === 'assistant');
            result = await processor.checkControl({ agent: frame.agent, sources, context_sources: contextSources,
                candidate_ids: (db.prepare("SELECT candidate_id FROM lifecycle WHERE status NOT IN ('forgotten','audit_only')").all() as unknown as Array<{ candidate_id: string }>).map(row => row.candidate_id),
                active_forget_selectors: activeSelectors }, { signal: frame.signal });
            if (epoch !== store.policyEpoch || blocked(frame.agent) || frame.signal?.aborted) throw new Error(RESUBMIT);
            if (!result.requests.length && (!await guardsAllowed(result, frame, sources, contextSources) || epoch !== store.policyEpoch
                || blocked(frame.agent) || frame.signal!.aborted)) throw new Error(RESUBMIT);
        } catch (error) {
            const code = error && typeof error === 'object' && 'message' in error ? error.message : null;
            const explicit = error && typeof error === 'object' && 'code' in error ? error.code : null;
            park(frame, ids, code === RESUBMIT || explicit === RESUBMIT ? RESUBMIT : UNAVAILABLE);
            return { kind: 'reject' };
        }
        const checked = register('check', ids, frame);
        store.transaction(() => {
            for (const row of [...prior, checked]) {
                db.prepare("UPDATE requests SET status='checked',error_code=NULL,updated_at=? WHERE id=?").run(now(), row.id);
            }
            audit('control.check', 'checked', { ...frame, request_id: checked.id }, { source_ids: ids });
        });
        contexts.set(frame.agent.id, { epoch, source_ids: ids, turn: frame.turn, step: frame.step, result });
        if (result.requests.length) {
            for (const request of [...result.requests].sort((a, b) => negativeFirst(a) - negativeFirst(b))) await dispatch(request, frame);
            return { kind: 'reject' };
        }
        if (epoch !== store.policyEpoch || blocked(frame.agent) || frame.signal!.aborted) {
            park(frame, ids, RESUBMIT);
            return { kind: 'reject' };
        }
        const decision = await next();
        if (epoch !== store.policyEpoch || blocked(frame.agent) || frame.signal?.aborted) return { kind: 'reject' };
        return decision;
    }

    async function requestFromTool(args: ToolArgs, exec: ExecLike): Promise<RenderedReceipt> {
        try { validateJsonSchemaValue(PARAMETERS, args); }
        catch { return { request_id: null, status: 'unavailable', code: UNAVAILABLE }; }
        if (!args.source_ids.length) return { request_id: null, status: 'unavailable', code: UNAVAILABLE };
        if (!liveRoot(exec.agent)) return { request_id: null, status: 'unavailable', code: 'LEPI_NO_INITIATOR' };
        const signal = AbortSignal.any([lifetime.signal, ...(exec.signal ? [exec.signal] : [])]);
        const context = contexts.get(exec.agent?.id);
        if (!context || context.epoch !== store.policyEpoch || blocked(exec.agent) || signal.aborted)
            return { request_id: null, status: 'unavailable', code: UNAVAILABLE };
        const request = context.result.requests.find(item => item.kind === args.kind);
        if (!request || !request.source_ids.some(id => context.source_ids.includes(id)))
            return { request_id: null, status: 'needs_clarification', code: UNAVAILABLE };
        if (args.candidate_ids.some(id => !request.candidate_ids.includes(id)))
            return { request_id: null, status: 'unavailable', code: UNAVAILABLE };
        let ids = args.source_ids;
        const inference = ids.includes('$current_assistant');
        if (inference) {
            if (args.kind !== 'remember' || ids.length !== 1) return { request_id: null, status: 'unavailable', code: UNAVAILABLE };
            const recent = await evidence.recent(exec.agent, { maxChars: config.limits.contextMaxChars, signal });
            if (signal.aborted || context.epoch !== store.policyEpoch || !liveRoot(exec.agent) || blocked(exec.agent))
                return { request_id: null, status: 'unavailable', code: RESUBMIT };
            const assistants = recent.sources.filter(source => source.actor === 'assistant');
            const last = assistants.at(-1);
            if (!last) return { request_id: null, status: 'needs_clarification', code: UNAVAILABLE };
            const messageId = (findEvidence.get(last.id) as unknown as EvidenceRow | undefined)?.message_id;
            ids = assistants.filter(source => (findEvidence.get(source.id) as unknown as EvidenceRow | undefined)?.message_id === messageId).map(source => source.id);
        } else if (ids.some(id => !request.source_ids.includes(id)))
            return { request_id: null, status: 'unavailable', code: UNAVAILABLE };
        const frame: HookFrame = { agent: exec.agent, turn: context.turn, step: context.step, signal, call_id: exec.callId };
        if (inference) {
            const row = register(request.kind, request.source_ids, frame, request.candidate_ids);
            store.transaction(() => {
                db.prepare('UPDATE requests SET payload_json=? WHERE id=?').run(JSON.stringify({ ...(JSON.parse(row.payload_json) as Record<string, unknown>), inference_source_ids: ids }), row.id);
                audit('control.tool', 'referenced', { ...frame, request_id: row.id }, { source_ids: ids, origin: 'inference' });
            });
        }
        const row = await dispatch(request, frame);
        audit('control.tool', row.status, { ...frame, request_id: row.id }, { source_ids: ids });
        if (['forget', 'restore', 'grant', 'revoke', 're_remember'].includes(args.kind)) exec.concludeTurn();
        return receipt(row);
    }
    function retry(requestId: string): RenderedReceipt {
        const row = findRequest.get(requestId) as unknown as RequestRow | undefined;
        if (!row || row.status !== 'parked') return receipt(row);
        const agent = ctx.agents?.get((JSON.parse(row.payload_json) as { agent_id: string }).agent_id);
        if (!liveRoot(agent) || blocked(agent)) return receipt(update(row, 'unavailable', UNAVAILABLE));
        const latestFence = (db.prepare('SELECT max(epoch) AS epoch FROM forget_scopes').get() as unknown as { epoch: number | null }).epoch ?? 0;
        if ((JSON.parse(row.payload_json) as { epoch: number }).epoch < latestFence) return receipt(update(row, 'resubmit_required', RESUBMIT));
        const updated = update(row, 'retry_pending');
        agent!.steer(notice('正在重新检查已停车的输入；检查成功之前不会进入角色模型。'));
        return receipt(updated);
    }
    async function dispose(): Promise<void> {
        disposed = true;
        lifetime.abort();
        for (const entry of pending.values()) {
            entry.detail = null;
            entry.controller.abort();
        }
        pending.clear();
        contexts.clear();
        await Promise.allSettled([...owned, ...inflight.values()]);
    }
    const tool = {
        name: 'manage_memory', description: '处理当前真实用户明确提出的记忆操作。只引用提供的来源与候选 ID，不传正文；不能由角色自行授权。',
        parameters: PARAMETERS, output: { schema: RECEIPT_SCHEMA,
            render: (_args: unknown, value: RenderedReceipt) => [{ type: 'text', text: JSON.stringify(value) }],
            presentationMeta: (_args: unknown, value: RenderedReceipt) => ({ request_id: value.request_id, status: value.status, code: value.code }) },
        execute: (args: ToolArgs, exec: ExecLike) => own(requestFromTool(args, exec)),
    };
    return { beforeStep: (frame: HookFrame, next: NextFn) => own(beforeStep(frame, next)), requestFromTool: (args: ToolArgs, exec: ExecLike) => own(requestFromTool(args, exec)),
        askPrivate: (candidate: CandidateLike, agent: AgentLike, options?: { signal?: AbortSignal }) => own(askPrivate(candidate, agent, options)), retry, dispose, tool,
        contextFor: (agent?: AgentLike) => contexts.get(agent?.id as string) ?? null };
}
