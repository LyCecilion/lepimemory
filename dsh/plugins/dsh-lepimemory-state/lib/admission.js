/**
 * Per-candidate value admission, independent of authorization and source policy.
 * Explicit requests bypass value only. The configured backend never changes implicitly.
 * Laya uses its own service token and reports actual noul scores, not calibrated confidence;
 * missing clipping evidence or unavailable backends defer, and clipped input cannot be accepted.
 * Generative admission uses the fixed processor route and never invents a probability.
 * Construction and cached health perform no work; only evaluate calls a backend.
 */

import { CONTENT_KINDS, ORIGINS, OCCURRENCES, CANDIDATE_TEXT_MAX, validateResult } from './contracts.js';
import { ErrorCodes } from './config.js';

// ── laya 0.3.26 锁定值（PLAN Step 2 / deploy/laya/server.py：Router models + revisions）。──────
// 这些是显式锁定值，不是运行期从服务探测出来的；laya 服务与 config 均按此固定。
export const LAYA_MODEL = 'multilingual';
export const LAYA_REVISION = '1720e3e3357cfe1e281542e223f8273b0890ca34';
export const LAYA_LANG = 'zh';
export const LAYA_MAX_LEN = 2048;

/** 单次准入最多纳入的相关已允许 snapshot 条数。 */
export const MAX_RELATED = 3;

/** 相关 snapshot 候选池上限（仅用于把 SQL 读取量束死，不改变入选规则）。 */
const RELATED_SCAN = 32;

/**
 * laya 的 `should_store` noul 指令（PLAN Step 6 原文；只描述长期价值，不含授权）。
 */
const INSTRUCTIONS =
    '这条候选是否值得在以记忆为核心的长期陪伴角色中保存？保留稳定事实、偏好、明确约定及重要关系或经历；' +
    '普通寒暄、无实质内容和仅对当前回复有用的噪声不保存。已过期安排不作为当前安排；需要有独立历史价值。';

/** 需要更严格阈值的类型（其余按 durable 档）。 */
const TRANSIENT_KINDS = new Set(['temporary_state', 'other']);

/** 候选正文/时间/来源的本地校验失败（调用方契约问题，不是后端故障）。 */
export class AdmissionError extends Error {
    constructor(code, field = null) {
        super(`${code}${field ? ` [${field}]` : ''}`);
        this.name = 'AdmissionError';
        this.code = code;
        this.field = field;
    }
}

function configInvalid(field) {
    throw new AdmissionError(ErrorCodes.CONFIG_INVALID, field);
}

function invalidCandidate(field) {
    throw new AdmissionError(ErrorCodes.CONFIG_INVALID, field);
}

/** 校验一组阈值：两端均为 [0,1] 有限数，且 reject < accept。 */
function thresholdPair(value, field) {
    const accept = value?.accept;
    const reject = value?.reject;
    if (!Number.isFinite(accept) || !Number.isFinite(reject)) configInvalid(field);
    if (accept < 0 || accept > 1 || reject < 0 || reject > 1) configInvalid(field);
    if (!(reject < accept)) configInvalid(field);
    return Object.freeze({ accept, reject });
}

const ISO = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null);

/** 规整候选：只信任代码绑定的字段，把非法/缺字段的候选挡在模块边界。 */
function normalizeCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) invalidCandidate('candidate');
    const text = candidate.text;
    if (typeof text !== 'string' || text.length === 0 || text.length > CANDIDATE_TEXT_MAX) invalidCandidate('text');
    if (!CONTENT_KINDS.includes(candidate.content_kind)) invalidCandidate('content_kind');
    if (!Array.isArray(candidate.source_ids) || candidate.source_ids.length === 0 ||
        candidate.source_ids.some((id) => typeof id !== 'string' || id.length === 0)) invalidCandidate('source_ids');
    return Object.freeze({
        text,
        content_kind: candidate.content_kind,
        origin: ORIGINS.includes(candidate.origin) ? candidate.origin : null,
        occurrence: OCCURRENCES.includes(candidate.occurrence) ? candidate.occurrence : null,
        subject_key: typeof candidate.subject_key === 'string' && candidate.subject_key ? candidate.subject_key : null,
        facet_key: typeof candidate.facet_key === 'string' && candidate.facet_key ? candidate.facet_key : null,
        formed_at: ISO(candidate.formed_at),
        valid_from: ISO(candidate.valid_from),
        valid_until: ISO(candidate.valid_until),
        occurred_start: ISO(candidate.occurred_start),
        occurred_end: ISO(candidate.occurred_end),
        explicit: candidate.explicit === true,
        source_ids: Object.freeze([...candidate.source_ids]),
    });
}

/** 送给后端做价值判断的候选投影：正文原样（保留否定/日期/条件），附类型/主体/时间限定。 */
function candidateView(candidate) {
    return {
        text: candidate.text,
        content_kind: candidate.content_kind,
        origin: candidate.origin,
        occurrence: candidate.occurrence,
        subject_key: candidate.subject_key,
        facet_key: candidate.facet_key,
        formed_at: candidate.formed_at,
        valid_from: candidate.valid_from,
        valid_until: candidate.valid_until,
        occurred_start: candidate.occurred_start,
        occurred_end: candidate.occurred_end,
    };
}

function safeParse(text) {
    try {
        const value = JSON.parse(text);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}

/** 仅取真实存在、可追溯到候选的正文，避免把未知形状的 blob 当上下文。 */
function snapshotView(row, now) {
    const snap = safeParse(row.json);
    if (!snap) return null;
    const text = typeof snap.text === 'string' && snap.text.length > 0 ? snap.text : null;
    if (!text) return null;
    if (typeof snap.valid_until === 'string' && Number.isFinite(Date.parse(snap.valid_until)) && Date.parse(snap.valid_until) < now) return null;
    const at = Number.isFinite(row.created_at) ? new Date(row.created_at).toISOString() : null;
    if (!at) return null;
    return {
        id: row.id,
        text,
        at,
        content_kind: CONTENT_KINDS.includes(snap.content_kind) ? snap.content_kind : null,
        subject_key: typeof snap.subject_key === 'string' ? snap.subject_key : null,
        facet_key: typeof snap.facet_key === 'string' ? snap.facet_key : null,
    };
}

/**
 * 已允许的相关 snapshot（最多 MAX_RELATED 条）。
 *
 * 保守过滤链（任一环节无法核验即**排除**，绝不降级放进未核验材料）：
 *   1. lifecycle.status === 'active'（排除 pending/history_only/superseded/forgotten/audit_only/unknown）；
 *   2. 不在任何 active forget scope 覆盖的候选集合里；
 *   3. 绑定授权未撤销、未过期（grant_id 为空视为不设限）；
 *   4. 候选 `valid_until` 未过期；
 *   5. 与候选同主体（`subject_key`），且能从 snapshot 正文追溯到文本。
 * 存储读取失败时返回空数组（fail-closed）。
 */
function relatedContext(store, candidate) {
    if (!candidate.subject_key) return [];
    let rows;
    try {
        rows = store.db.prepare(`
            SELECT s.candidate_id AS id, s.json AS json, s.created_at AS created_at, l.grant_id AS grant_id
            FROM snapshots s JOIN lifecycle l ON l.candidate_id = s.candidate_id
            WHERE l.status = 'active'
            ORDER BY s.created_at DESC LIMIT ?`).all(RELATED_SCAN);
    } catch {
        return [];
    }
    const now = store.now();
    const forgotten = new Set();
    try {
        for (const scope of store.db.prepare('SELECT candidate_ids_json FROM forget_scopes WHERE active = 1').all()) {
            let ids;
            try { ids = JSON.parse(scope.candidate_ids_json); } catch { ids = null; }
            if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') forgotten.add(id);
        }
    } catch {
        return [];
    }
    const grants = new Map();
    try {
        for (const grant of store.db.prepare('SELECT id, expires_at, revoked_at FROM grants').all()) grants.set(grant.id, grant);
    } catch {
        return [];
    }
    const picked = [];
    for (const row of rows) {
        if (picked.length >= MAX_RELATED) break;
        if (typeof row.id !== 'string' || forgotten.has(row.id)) continue;
        if (row.grant_id) {
            const grant = grants.get(row.grant_id);
            if (!grant || grant.revoked_at != null) continue;
            if (Number.isFinite(grant.expires_at) && grant.expires_at < now) continue;
        }
        const view = snapshotView(row, now);
        if (!view || view.subject_key !== candidate.subject_key) continue;
        picked.push(view);
    }
    return picked;
}

/** laya usage 的裁剪事实：`truncated` / `state_tokens_dropped` / `truncated_questions` / 选项坍缩。 */
function detectTruncation(usage) {
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false;
    if (usage.truncated === true) return true;
    if (typeof usage.truncated === 'number' && usage.truncated > 0) return true;
    if (Number.isFinite(usage.state_tokens_dropped) && usage.state_tokens_dropped > 0) return true;
    if (Array.isArray(usage.truncated_questions) && usage.truncated_questions.length > 0) return true;
    if (usage.options && typeof usage.options === 'object' && !Array.isArray(usage.options)) return true;
    return false;
}

function combine(signal, deadlineMs) {
    const deadline = AbortSignal.timeout(deadlineMs);
    return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

/**
 * 构造准入器。构造器只读 config 并校验；**不建连接、不发请求、不起 timer**。
 *
 * @param {object} deps
 * @param {object} deps.config 已解析配置（`resolveConfig` 输出）。
 * @param {object} deps.processor 处理器（需提供 `evaluateAdmission`，供 generative 后端）。
 * @param {object} deps.store `openStore` 的 Store（只读查询相关 snapshot；本模块从不写入）。
 * @returns {{evaluate:Function, health:Function}}
 */
export function createAdmission({ config, processor, store } = {}) {
    const backend = config?.admissionBackend;
    if (backend !== 'laya' && backend !== 'generative') configInvalid('admissionBackend');
    if (!store || typeof store.now !== 'function' || !store.db) configInvalid('store');

    const thresholds = {
        durable: thresholdPair(config?.layaThresholds?.durable, 'LEPI_LAYA_ACCEPT_DURABLE'),
        transient: thresholdPair(config?.layaThresholds?.transient, 'LEPI_LAYA_ACCEPT_TRANSIENT'),
    };

    let layaUrl = null;
    let layaApiKey = '';
    if (backend === 'laya') {
        layaUrl = config?.services?.laya?.url;
        layaApiKey = typeof config?.services?.laya?.apiKey === 'string' ? config.services.laya.apiKey : '';
        if (typeof layaUrl !== 'string' || layaUrl === '') configInvalid('LEPI_LAYA_URL');
    }

    const processModel = config?.llm?.process?.model;
    if (backend === 'generative' && (typeof processModel !== 'string' || processModel === '')) configInvalid('LEPI_PROCESS_MODEL');
    if (backend === 'generative' && typeof processor?.evaluateAdmission !== 'function') configInvalid('processor');

    const rawTimeout = config?.limits?.processTimeoutMs;
    const timeoutMs = Number.isSafeInteger(rawTimeout) && rawTimeout > 0 ? rawTimeout : 30000;

    const identity = Object.freeze(backend === 'laya'
        ? { backend, model: LAYA_MODEL, revision: LAYA_REVISION }
        : { backend, model: processModel ?? null, revision: null });

    // 只记录安全元数据：不含 endpoint / key / 候选或记忆正文。
    let observed = Object.freeze({ available: null, truncated: null });

    const result = (verdict, reason_code, { score = null, truncated = false } = {}) => Object.freeze({
        verdict,
        score,
        reason_code,
        backend: identity.backend,
        model: identity.model,
        revision: identity.revision,
        truncated,
    });

    async function evaluateLaya(candidate, signal) {
        const tier = TRANSIENT_KINDS.has(candidate.content_kind) ? thresholds.transient : thresholds.durable;

        let related;
        try {
            related = relatedContext(store, candidate);
        } catch {
            related = [];
        }
        const body = {
            model: LAYA_MODEL,
            lang: LAYA_LANG,
            max_len: LAYA_MAX_LEN,
            state: { candidate: candidateView(candidate), related },
            questions: { should_store: { type: 'noul', instructions: INSTRUCTIONS } },
        };
        const serialized = JSON.stringify(body);
        if (serialized.length > 50000) return result('defer', 'input_truncated', { truncated: true });

        const headers = { 'content-type': 'application/json' };
        if (layaApiKey) headers.authorization = `Bearer ${layaApiKey}`;

        let response;
        try {
            response = await fetch(`${layaUrl}/v1/systemone`, {
                method: 'POST', headers, body: serialized, signal: combine(signal, timeoutMs),
            });
        } catch {
            observed = Object.freeze({ available: false, truncated: null });
            return result('defer', 'backend_unavailable');
        }
        if (!response.ok) {
            observed = Object.freeze({ available: false, truncated: null });
            return result('defer', response.status === 413 ? 'input_truncated' : 'backend_unavailable', { truncated: response.status === 413 });
        }

        let payload;
        try {
            payload = await response.json();
        } catch {
            observed = Object.freeze({ available: false, truncated: null });
            return result('defer', 'backend_unavailable');
        }

        const answer = payload && typeof payload === 'object' ? payload.answers?.should_store : null;
        if (!answer || typeof answer !== 'object' || answer.type !== 'noul' ||
            typeof payload.usage?.truncated !== 'boolean' ||
            typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
            observed = Object.freeze({ available: false, truncated: null });
            return result('defer', 'backend_unavailable');
        }

        const truncated = detectTruncation(payload.usage);
        observed = Object.freeze({ available: true, truncated });
        if (truncated) return result('defer', 'input_truncated', { truncated: true });

        const score = answer.noul;
        if (score >= tier.accept) return result('accept', 'value_accept', { score });
        if (score <= tier.reject) return result('reject', 'value_reject', { score });
        return result('defer', 'value_uncertain', { score });
    }

    async function evaluateGenerative(candidate, { signal, agent } = {}) {
        let related;
        try {
            related = relatedContext(store, candidate);
        } catch {
            related = [];
        }
        let verdictValue;
        try {
            verdictValue = await processor.evaluateAdmission({
                candidate: candidateView(candidate),
                source_ids: [...candidate.source_ids],
                context_sources: related.map((item) => ({ ...item, actor: 'context', kind: 'context' })),
                agent,
            }, { signal });
            validateResult('admission', verdictValue);
        } catch {
            observed = Object.freeze({ available: false, truncated: null });
            return result('defer', 'backend_unavailable');
        }
        const verdict = verdictValue?.verdict;
        const reason = verdictValue?.reason_code;
        observed = Object.freeze({ available: true, truncated: false });
        return result(verdict, reason);
    }

    async function evaluate(candidate, { signal, agent } = {}) {
        const normalized = normalizeCandidate(candidate);
        // 明确记住/纠错：直接 accept，不询问后端。运行期权限由 control 独立把关。
        if (normalized.explicit) return result('accept', 'explicit_request');
        if (signal?.aborted) return result('defer', 'backend_unavailable');
        return backend === 'laya'
            ? evaluateLaya(normalized, signal)
            : evaluateGenerative(normalized, { signal, agent });
    }

    /** 同步返回上一次已观测的安全元数据；无 endpoint / key / 正文，不发请求、不起 timer。 */
    function health() {
        return Object.freeze({
            backend: identity.backend,
            available: observed.available,
            model: identity.model,
            revision: identity.revision,
            truncated: observed.truncated,
        });
    }

    return { evaluate, health };
}
