/**
 * evidence.js — 会话证据索引（Lepimemory 运行时收敛 Step 4）。
 *
 * 目标：为「中性请求处理」提供可核验的来源引用，而**不落正文**：
 *   - SQLite `evidence` 只保存元数据与唯一引用（session/message/seq/block/offset/actor/at/kind）；
 *   - 正文只存在于**当前处理 heap**（`bodies`）。进程重启后正文仅能从**当前会话的
 *     canonical surface**（`sessionQuery.readSurface`，已应用 replace/投影）重取；
 *     shadowed（被替换/净化）的旧消息**不可**从旧审计日志复活。
 *
 * 事件取证（以安装版 dsh-session / dsh-agent 实际 envelope 为准）：
 *   - `user/message` 的 `event.data` **就是 UserMessage**（不是 wrapper）。
 *     `source.kind === 'user'` → actor='user'；其余（injected context / notice / recall …）
 *     → actor='context'（**context 永不作为独立事实**，见 step4 契约）。
 *   - `assistant/message` 是 `event.data.message`；只取公共 text block，**不收 reasoning**。
 *   - `tool/result` 是 `event.data.message`；`isError === false` **不足以**构成行动来源。
 *     actor='action' / kind='verified_action' 仅当 `actions` 表存在
 *     `(session_id, call_id)` 且 `status='executed'`（journal 确认的已执行行动）。
 *   - `agent/inbox/spliced` 是 session 事件（dsh-agent 扩表）：`inserted[]` 携带真实
 *     UserMessage id 与首次 `event.time/seq`。同一 id 被 requeue 时**保留最初 seq/时间**，
 *     绝不刷新。blocked 输入只有原 splice、没有提交的 `user/message`。
 *
 * `claimed` 只引用已观测的 splice 事件（真实 event seq），**不读 agent.inbox 本体**，
 * 也不把未提交的 inbox 当作已提交事实。
 *
 * 读取门槛（当前会话限定）：
 *   - 已提交来源（user/assistant/action/context）：必须仍是**当前 surface** 上的节点，
 *     否则不可读，不从旧日志或 heap 取回。
 *   - 未提交来源（splice）：本步 claimed/current epoch，或明确操作按 request_id 精确交接的 heap-only claim。
 *     后者只供该请求的后台处理；普通取证不可读，进程重启/终态释放/新政策后不能恢复。
 *   - 其他旧 unclaimed/blocked/canceled 及无法证明安全的媒体来源保守 hold。
 *   - 可选 `setReadableGate(fn)`：由 Step 9 history coordinator 注入精确 `isReadable(ref)`；
 *     返回 falsy 即视为 fenced。**这是 step4 为 step9 预留的唯一集成缝**（见交付说明）。
 *
 * 预算：`read` 由 processor 计 fetch 调用预算；本模块只对 `recent` 的 `maxChars` 负责，
 * 且**只整块取舍**——绝不截断片段（避免截掉否定/条件）。
 *
 * 本模块不启动任务、不注册 hook、不二次写 session（sessionQuery 只读）。
 */
import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface';

const ACTOR_USER = 'user';
const ACTOR_CONTEXT = 'context';
const ACTOR_ASSISTANT = 'assistant';
const ACTOR_ACTION = 'action';

const KIND_USER = 'user_message';
const KIND_CONTEXT = 'context';
const KIND_ASSISTANT = 'assistant_message';
const KIND_ACTION = 'verified_action';
const KIND_SPLICE = 'splice';

const MEDIA_BLOCK_TYPES = new Set(['image', 'file']);
/** `recent` 单次最多回看的 evidence 行数（正文预算另行裁剪）。 */
const RECENT_SCAN_LIMIT = 200;

const isoOf = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/**
 * evidence id 的 opaque 编码。语义分量是契约里记录的
 * `session:seq:block_index:start:end`；额外内嵌 `message_id` 以保证
 * 同一次 splice 内多消息、同偏移时的 id 唯一（PK 唯一，见 store.js 表约束）。
 */
function encodeId(sessionId, messageId, seq, blockIndex, start, end) {
    return Buffer.from(JSON.stringify([sessionId, messageId, seq, blockIndex, start, end])).toString('base64url');
}

export function decodeEvidenceId(id) {
    try {
        const parts = JSON.parse(Buffer.from(String(id), 'base64url').toString('utf8'));
        if (!Array.isArray(parts) || parts.length !== 6) return null;
        const [sessionId, messageId, seq, blockIndex, start, end] = parts;
        if (typeof sessionId !== 'string' || typeof messageId !== 'string') return null;
        for (const n of [seq, blockIndex, start, end]) if (!Number.isSafeInteger(n) || n < 0) return null;
        if (end < start) return null;
        return { sessionId, messageId, seq, blockIndex, start, end };
    } catch {
        return null;
    }
}

/** 一条消息 content 里的 text block（保留原始 block 下标），跳过 reasoning/tool-call/媒体。 */
function textBlocks(content) {
    if (!Array.isArray(content)) return [];
    const out = [];
    for (let index = 0; index < content.length; index += 1) {
        const block = content[index];
        if (block && block.type === 'text' && typeof block.text === 'string') out.push({ index, text: block.text });
    }
    return out;
}

function hasMedia(content) {
    return Array.isArray(content) && content.some((block) => block && MEDIA_BLOCK_TYPES.has(block.type));
}

function sessionIdOf(agent) {
    if (!agent) return null;
    const id = agent.session?.id ?? agent.id;
    return id == null ? null : String(id);
}

/**
 * @param {{ store: object, sessionQuery?: object }} deps
 *   - store: openStore() 产物；仅用其 `db`（prepared SQL）、`policyEpoch` getter、`readOnly`。
 * @returns {{
 *   observe(session: object, event: object): void,
 *   claimed(agent: object, messages: readonly object[], turn: number, step: number): string[],
 *   read(ids: readonly string[], options: { agent?: object, signal?: AbortSignal }): Promise<{ sources: object[], excluded: object[] }>,
 *   recent(agent: object, options: { maxChars: number }): Promise<{ sources: object[] }>,
 *   setReadableGate(gate: ((ref: object) => boolean) | null): void,
 *   dispose(): void,
 * }}
 */
export function createEvidenceIndex({ store, sessionQuery } = {}) {
    const db = store?.db;
    if (!db || typeof db.prepare !== 'function') throw new Error('LEPI_STORE_UNAVAILABLE');
    const writable = store.readOnly !== true;

    /** messageId -> (string|undefined)[]，按下标对齐 content；仅 text block 有字符串。 */
    const bodies = new Map();
    /** messageId -> boolean：消息是否含 image/file 等媒体/外部引用 block。 */
    const mediaFlags = new Map();
    /** messageId -> { seq, at }：**首次** splice 的真实 event 序号与毫秒时间（不可刷新）。 */
    const firstSplice = new Map();
    /** messageId -> number：首次捕获时的 policy_epoch，用于 fence 后的保守判定。 */
    const captureEpoch = new Map();
    /** messageId：本进程内已提交（user/assistant/action/context）来源。 */
    const committed = new Set();
    /** sessionId -> { turn, step, epoch, ids:Set<messageId> }：本步 claimed 的活跃输入。 */
    const active = new Map();
    // Explicit controller-to-worker handoff only; heap-only, exact request/agent/epoch.
    const requestClaims = new Map();
    /** 可选 Step 9 注入的 isReadable(ref)。 */
    let gate = null;
    let prepared = null;

    const sql = () => (prepared ??= {
        insert: db.prepare(
            `INSERT OR IGNORE INTO evidence
             (id,session_id,message_id,seq,block_index,start,end,actor,at,kind)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ),
        byId: db.prepare('SELECT * FROM evidence WHERE id=?'),
        earliestSplice: db.prepare(
            `SELECT seq, at FROM evidence WHERE session_id=? AND message_id=? AND kind='splice'
             ORDER BY seq ASC, at ASC LIMIT 1`,
        ),
        hasCommitted: db.prepare(
            `SELECT 1 AS n FROM evidence WHERE session_id=? AND message_id=? AND kind<>'splice' LIMIT 1`,
        ),
        recent: db.prepare(
            `SELECT id FROM evidence WHERE session_id=? AND kind<>'splice'
             AND actor IN ('user','assistant','action')
             ORDER BY seq DESC, block_index DESC LIMIT ?`,
        ),
    });

    function epochNow() {
        try {
            return store.policyEpoch;
        } catch {
            return null;
        }
    }

    function rememberBody(message) {
        if (!message || message.id == null) return;
        const mid = String(message.id);
        if (!bodies.has(mid)) {
            const arr = [];
            if (Array.isArray(message.content)) {
                for (const block of message.content) arr.push(block && block.type === 'text' && typeof block.text === 'string' ? block.text : undefined);
            }
            bodies.set(mid, arr);
            mediaFlags.set(mid, hasMedia(message.content));
            if (!captureEpoch.has(mid)) captureEpoch.set(mid, epochNow());
        }
    }

    function persistRows(sessionId, message, seq, at, actor, kind) {
        if (!writable) return;
        const mid = String(message.id);
        for (const { index, text } of textBlocks(message.content)) {
            const id = encodeId(sessionId, mid, seq, index, 0, text.length);
            sql().insert.run(id, sessionId, mid, seq, index, 0, text.length, actor, at, kind);
        }
    }

    /** 首次 splice wins：仅在从未见过该 message id 时写入一条 splice 行。 */
    function ensureSplice(sessionId, message, seq, at) {
        const mid = String(message.id);
        rememberBody(message);
        let known = firstSplice.get(mid);
        if (!known) {
            try {
                const row = sql().earliestSplice.get(sessionId, mid);
                if (row) known = { seq: Number(row.seq), at: Number(row.at) };
            } catch {
                known = null;
            }
        }
        if (known) {
            firstSplice.set(mid, known); // requeue 同 id：保留最初 seq/at，不刷新
            return;
        }
        firstSplice.set(mid, { seq, at });
        persistRows(sessionId, message, seq, at, ACTOR_USER, KIND_SPLICE);
    }

    function isCommitted(sessionId, mid) {
        if (committed.has(mid)) return true;
        try {
            const row = sql().hasCommitted.get(sessionId, mid);
            if (row) {
                committed.add(mid);
                return true;
            }
        } catch {
            /* keep heap knowledge only */
        }
        return false;
    }

    /** 已提交来源：`at` 采用最初 splice 时间（存在时），保证 requeue 后时间不可变。 */
    function recordCommitted(sessionId, message, seq, at, actor, kind) {
        const mid = String(message.id);
        rememberBody(message);
        committed.add(mid);
        const splice = firstSplice.get(mid);
        const useAt = splice && Number.isFinite(splice.at) ? splice.at : at;
        persistRows(sessionId, message, seq, useAt, actor, kind);
    }

    function actionExecuted(sessionId, callId) {
        if (callId == null) return false;
        try {
            const row = db.prepare('SELECT status FROM actions WHERE session_id=? AND call_id=?').get(sessionId, String(callId));
            return row?.status === 'executed';
        } catch {
            return false;
        }
    }

    /** 注册到 `session/event`（纯 observe；不得重入 append，不得抛穿 append 边界）。 */
    function observe(session, event) {
        if (!session || !event || !event.type) return;
        const sessionId = String(session.id);
        try {
            switch (event.type) {
                case 'agent/inbox/spliced': {
                    const inserted = event.data?.inserted;
                    if (Array.isArray(inserted)) {
                        for (const message of inserted) {
                            if (message?.id != null) ensureSplice(sessionId, message, Number(event.seq), Number(event.time));
                        }
                    }
                    break;
                }
                case 'user/message': {
                    const message = event.data;
                    if (message?.id != null) {
                        const context = message.source?.kind !== 'user';
                        recordCommitted(
                            sessionId, message, Number(event.seq), Number(event.time),
                            context ? ACTOR_CONTEXT : ACTOR_USER,
                            context ? KIND_CONTEXT : KIND_USER,
                        );
                    }
                    break;
                }
                case 'assistant/message': {
                    const message = event.data?.message;
                    if (message?.id != null) {
                        recordCommitted(sessionId, message, Number(event.seq), Number(event.time), ACTOR_ASSISTANT, KIND_ASSISTANT);
                    }
                    break;
                }
                case 'tool/result': {
                    const message = event.data?.message;
                    if (message?.id != null && actionExecuted(sessionId, message.toolCallId)) {
                        recordCommitted(sessionId, message, Number(event.seq), Number(event.time), ACTOR_ACTION, KIND_ACTION);
                    }
                    break;
                }
                case 'turn/end':
                    active.delete(sessionId);
                    break;
                default:
                    break;
            }
        } catch {
            /* 取证失败绝不能影响 session append（session store 自身也会 contain listener 失败）。 */
        }
    }

    /** 本步即将进入 step 的 messages → 引用最初 splice 的 source id 数组（不读 inbox 本体）。 */
    function claimed(agent, messages, turn, step) {
        const sessionId = sessionIdOf(agent);
        if (!sessionId) return [];
        const ids = [];
        const activeIds = new Set();
        for (const message of Array.isArray(messages) ? messages : []) {
            const mid = message?.id == null ? null : String(message.id);
            if (!mid) continue;
            let splice = firstSplice.get(mid);
            if (!splice) {
                try {
                    const row = sql().earliestSplice.get(sessionId, mid);
                    if (row) splice = { seq: Number(row.seq), at: Number(row.at) };
                } catch {
                    splice = null;
                }
                if (splice) firstSplice.set(mid, splice);
            }
            if (!splice) continue; // 无 splice 依据：不伪造 seq
            rememberBody(message);
            activeIds.add(mid);
            for (const { index, text } of textBlocks(message.content)) {
                ids.push(encodeId(sessionId, mid, splice.seq, index, 0, text.length));
            }
        }
        active.set(sessionId, { turn, step, epoch: epochNow(), ids: activeIds });
        return ids;
    }

    function holdRequest(requestId, ids, agent) {
        const sessionId = sessionIdOf(agent);
        const row = db.prepare('SELECT session_id,kind,source_ids_json FROM requests WHERE id=?').get(requestId);
        const refs = ids.map(decodeEvidenceId);
        if (!row || row.session_id !== sessionId || !['remember', 'correct', 're_remember'].includes(row.kind)
            || refs.some(ref => !ref || ref.sessionId !== sessionId)
            || ids.some(id => !JSON.parse(row.source_ids_json).includes(id))) return false;
        const claim = active.get(sessionId);
        if (refs.some(ref => !isCommitted(sessionId, ref.messageId)
            && (!claim || claim.epoch !== epochNow() || !claim.ids.has(ref.messageId)))) return false;
        requestClaims.set(requestId, { agent, epoch: epochNow(), ids: new Set(ids) });
        return true;
    }

    function releaseRequest(requestId) { requestClaims.delete(requestId); }

    // Only the caller's validated, single per-item grant may advance an existing claim.
    function advanceClaim(ids, { agent, previousEpoch, request_id }) {
        const sessionId = sessionIdOf(agent);
        if (epochNow() !== previousEpoch + 1) return false;
        const uncommitted = ids.map(id => decodeEvidenceId(id)).filter(ref => ref && !isCommitted(ref.sessionId, ref.messageId));
        if (uncommitted.some(ref => ref.sessionId !== sessionId)) return false;
        if (!uncommitted.length) return true;
        const claim = active.get(sessionId);
        const held = requestClaims.get(request_id);
        const live = claim && claim.epoch === previousEpoch && uncommitted.every(ref => claim.ids.has(ref.messageId));
        const scoped = held && held.agent === agent && held.epoch === previousEpoch && ids.every(id => held.ids.has(id));
        if (!live && !scoped) return false;
        if (live) claim.epoch = epochNow();
        if (scoped) held.epoch = epochNow();
        return true;
    }

    function sliceBody(mid, row) {
        const arr = bodies.get(mid);
        const text = Array.isArray(arr) ? arr[row.block_index] : undefined;
        if (typeof text !== 'string' || row.end > text.length) return null;
        return text.slice(row.start, row.end);
    }

    function sliceMessage(message, row) {
        const block = message?.content?.[row.block_index];
        if (!block || block.type !== 'text' || typeof block.text !== 'string' || row.end > block.text.length) return null;
        return block.text.slice(row.start, row.end);
    }

    function mediaHeld(mid) {
        if (!mediaFlags.get(mid)) return false;
        // 有策略门时由 gate 决定；无门且捕获后 epoch 已变 → 保守 hold。
        return typeof gate !== 'function'
            && captureEpoch.get(mid) != null
            && captureEpoch.get(mid) !== epochNow();
    }

    /**
     * @returns {Promise<{ text?: string, code?: string }>}
     */
    async function resolveRow(row, ctx) {
        const mid = row.message_id;
        const uncommitted = row.kind === KIND_SPLICE && !isCommitted(row.session_id, mid);
        if (mediaHeld(mid)) return { code: 'LEPI_INPUT_RESUBMIT_REQUIRED' };

        if (uncommitted) {
            const a = active.get(row.session_id);
            const held = ctx.requestClaim;
            const live = a && a.ids.has(mid) && a.epoch === epochNow();
            const scoped = held && held.agent === ctx.agent && held.epoch === epochNow() && held.ids.has(row.id);
            if (!live && !scoped) return { code: 'LEPI_INPUT_RESUBMIT_REQUIRED' };
            const text = sliceBody(mid, row);
            return text == null ? { code: 'LEPI_CONTROL_UNAVAILABLE' } : { text };
        }

        // 已提交：优先当前 canonical surface（replace/投影已生效，shadowed 不可见）。
        const surfaceMap = await ctx.loadSurface();
        if (surfaceMap) {
            const message = surfaceMap.get(mid);
            const text = message ? sliceMessage(message, row) : null;
            return text == null ? { code: 'LEPI_INPUT_RESUBMIT_REQUIRED' } : { text };
        }
        // 无 canonical surface 证明时不能恢复 heap 中的旧副本。
        return { code: 'LEPI_CONTROL_UNAVAILABLE' };
    }

    /**
     * 受限取证：仅当前会话、仅政策/epoch 允许、仅当前有效 surface 上的明确片段。
     * @returns {{ sources: {id,actor,kind,at,text}[], excluded: {id,code}[] }}
     */
    async function read(ids, options = {}) {
        const list = Array.isArray(ids) ? ids : [];
        const agent = options.agent ?? null;
        const signal = options.signal ?? null;
        const sessionId = sessionIdOf(agent);
        const sources = [];
        const excluded = [];
        if (!sessionId || !Array.isArray(ids) || ids.some(id => typeof id !== 'string')) {
            return { sources, excluded: list.map(id => ({ id: typeof id === 'string' ? id : null, code: 'LEPI_CONTROL_UNAVAILABLE' })) };
        }

        let surfaceMap;
        let surfaceLoaded = false;
        const loadSurface = async () => {
            if (surfaceLoaded) return surfaceMap;
            surfaceLoaded = true;
            if (!sessionId || !sessionQuery || typeof sessionQuery.readSurface !== 'function') return (surfaceMap = null);
            try {
                const snapshot = await sessionQuery.readSurface(sessionId);
                const map = new Map();
                for (const event of snapshot?.events ?? []) {
                    let message = null;
                    try {
                        message = deriveEventMessage(event);
                    } catch {
                        message = null;
                    }
                    if (message?.id != null) map.set(String(message.id), message);
                }
                surfaceMap = map;
            } catch {
                surfaceMap = null;
            }
            return surfaceMap;
        };

        for (const rawId of list) {
            if (signal?.aborted) break;
            const id = rawId;
            let row = null;
            try {
                row = sql().byId.get(id);
            } catch {
                row = null;
            }
            if (!row) {
                excluded.push({ id, code: 'LEPI_CONTROL_UNAVAILABLE' });
                continue;
            }
            if (row.session_id !== sessionId) {
                excluded.push({ id, code: 'LEPI_CONTROL_UNAVAILABLE' });
                continue;
            }
            if (typeof gate === 'function') {
                const ref = {
                    id, session_id: row.session_id, message_id: row.message_id, seq: Number(row.seq),
                    block_index: Number(row.block_index), start: Number(row.start), end: Number(row.end),
                    actor: row.actor, kind: row.kind,
                };
                let allowed = false;
                try {
                    allowed = Boolean(gate(ref));
                } catch {
                    allowed = false;
                }
                if (!allowed) {
                    excluded.push({ id, code: 'LEPI_INPUT_RESUBMIT_REQUIRED' });
                    continue;
                }
            }
            const resolved = await resolveRow(row, { loadSurface, agent, requestClaim: requestClaims.get(options.request_id) });
            if (resolved.text == null) {
                excluded.push({ id, code: resolved.code ?? 'LEPI_CONTROL_UNAVAILABLE' });
                continue;
            }
            sources.push({ id, actor: row.actor, kind: row.kind, at: isoOf(Number(row.at)), text: resolved.text });
        }
        return { sources, excluded };
    }

    /** 当前会话最近可用片段；可先限定作者及 beforeAt(ms)，再按 maxChars 整块裁剪。 */
    async function recent(agent, options = {}) {
        const sessionId = sessionIdOf(agent);
        const maxChars = Number.isSafeInteger(options.maxChars) && options.maxChars > 0 ? options.maxChars : 0;
        if (!sessionId || maxChars === 0) return { sources: [] };
        if (options.beforeAt !== undefined && !Number.isFinite(options.beforeAt)) return { sources: [] };
        let rows = [];
        try {
            rows = sql().recent.all(sessionId, RECENT_SCAN_LIMIT);
        } catch {
            rows = [];
        }
        rows.reverse(); // 升序（旧 → 新）
        const { sources } = await read(rows.map((row) => row.id), { agent, signal: options.signal });
        const kept = [];
        let used = 0;
        for (let i = sources.length - 1; i >= 0; i -= 1) {
            const source = sources[i];
            if (options.actor !== undefined && source.actor !== options.actor) continue;
            if (options.beforeAt !== undefined && Date.parse(source.at) > options.beforeAt) continue;
            if (used + source.text.length > maxChars) break; // 整块取舍
            used += source.text.length;
            kept.push(source);
        }
        kept.reverse();
        return { sources: kept };
    }

    /** Step 9 集成缝：注入精确 isReadable(ref)；传 null 清除（回到本地保守判定）。 */
    function setReadableGate(fn) {
        gate = typeof fn === 'function' ? fn : null;
    }

    function dispose() {
        bodies.clear();
        mediaFlags.clear();
        firstSplice.clear();
        captureEpoch.clear();
        committed.clear();
        active.clear();
        requestClaims.clear();
        gate = null;
    }

    return { observe, claimed, holdRequest, releaseRequest, advanceClaim, read, recent, setReadableGate, dispose };
}
