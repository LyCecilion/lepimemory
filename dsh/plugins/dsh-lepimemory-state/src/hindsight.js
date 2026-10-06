/** Hindsight 0.10.0 REST client. Reads have a shared deadline; writes never blind-retry. */

import { createHash } from "node:crypto";
import { TRUST, scoreOf, candidateExclusion } from "./trust.js";
import { rawVersion, rawMatches, documentMatches } from "./raw-source.js";
import { setTimeout as delay } from "node:timers/promises";


const DEFAULT_BASE_URL = "http://127.0.0.1:8888";
export const DEFAULT_BANK = "lepimemory-v2";

/** 有原生 semantic 时使用绝对阈值；缺失时只按原生 final 排序已核实事实。 */
const DEFAULT_MIN_SEMANTIC = 0.35;
const DEFAULT_MAX_ITEMS = 4;

export class HindsightError extends Error {
    constructor(status = null) {
        const code = status === 409 ? "LEPI_HINDSIGHT_CONFLICT" : "LEPI_HINDSIGHT_UNAVAILABLE";
        super(code);
        this.code = code;
        this.status = status;
    }
}

const OPERATION_STATES = new Set(["pending", "processing", "completed", "failed", "cancelled", "not_found"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function budgetSignal(signal, deadlineMs) {
    const deadline = AbortSignal.timeout(deadlineMs);
    return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

/** 原生 detail 的 `type` 规范化为 `fact_type`（list 项本就带 `fact_type`）；保留其余字段。 */
function normalizeRaw(raw) {
    if (!raw || typeof raw !== "object") throw new HindsightError();
    return { ...raw, fact_type: raw.fact_type ?? raw.type ?? null };
}

export class HindsightClient {
    constructor({ baseUrl = DEFAULT_BASE_URL, bank = DEFAULT_BANK, deadlineMs = 5000 } = {}) {
        if (bank === "lepimemory") throw new HindsightError(409);
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.bank = bank;
        this.deadlineMs = Math.min(deadlineMs, 5000);
    }

    async #request(method, route, body, { signal, safe = false, allow404 = false } = {}) {
        const combined = budgetSignal(signal, this.deadlineMs);
        const url = `${this.baseUrl}/v1/default/banks/${encodeURIComponent(this.bank)}${route}`;
        let lastStatus = null;
        for (let attempt = 0; attempt < (safe ? 3 : 1); attempt += 1) {
            if (combined.aborted) break;
            try {
                const res = await fetch(url, {
                    method,
                    headers: { "content-type": "application/json" },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                    signal: combined,
                });
                if (res.status === 404 && allow404) {
                    await res.body?.cancel();
                    return null;
                }
                if (res.ok) return res.status === 204 ? null : await res.json();
                lastStatus = res.status;
                await res.body?.cancel();
                if (!safe || (res.status !== 429 && res.status < 500)) throw new HindsightError(res.status);
            } catch (error) {
                if (error instanceof HindsightError) throw error;
                if (!safe || combined.aborted) break;
            }
            if (attempt < 2) {
                try { await delay(200 * 2 ** attempt, undefined, { signal: combined }); }
                catch { break; }
            }
        }
        throw new HindsightError(lastStatus);
    }

    async retainAsync(item, { operationId, signal } = {}) {
        if (!UUID.test(operationId ?? "")) throw new HindsightError(409);
        return this.#request("POST", "/memories", { items: [item], async: true, operation_id: operationId }, { signal });
    }

    async operation(operationId, { signal } = {}) {
        const result = await this.#request("GET", `/operations/${encodeURIComponent(operationId)}`, undefined, { signal, safe: true });
        if (!result || result.operation_id !== operationId || !OPERATION_STATES.has(result.status)) throw new HindsightError();
        // Never carry error_message, payload, or unstable result_metadata into audit.
        return { operation_id: operationId, status: result.status, operation_type: result.operation_type ?? null,
            created_at: result.created_at ?? null, updated_at: result.updated_at ?? null, completed_at: result.completed_at ?? null };
    }

    async document(documentId, { signal } = {}) {
        return this.#request("GET", `/documents/${encodeURIComponent(documentId)}`, undefined, { signal, safe: true, allow404: true });
    }

    /** 单条 raw detail；404 → null。`type` 规范化为 `fact_type`。 */
    async raw(id, { signal } = {}) {
        const detail = await this.#request("GET", `/memories/${encodeURIComponent(id)}`, undefined, { signal, safe: true, allow404: true });
        return detail === null ? null : normalizeRaw(detail);
    }

    /** 单页 raw 列表（原生 100 行分页），校验后返回 `{items,total}`；页数由调用方限制。 */
    async unitsPage(documentId, { state = "valid", offset = 0, signal } = {}) {
        const params = new URLSearchParams({ document_id: documentId, state, limit: "100", offset: String(offset) });
        const page = await this.#request("GET", `/memories/list?${params}`, undefined, { signal, safe: true });
        if (!Array.isArray(page?.items) || !Number.isSafeInteger(page.total) || page.total < 0) throw new HindsightError();
        return { items: page.items.map(normalizeRaw), total: page.total };
    }

    /** 现有全量语义（逐页直到覆盖 total）；保持行为不变。 */
    async units(documentId, { state = "valid", signal } = {}) {
        const combined = budgetSignal(signal, this.deadlineMs);
        const rows = [];
        for (let offset = 0; ;) {
            const page = await this.unitsPage(documentId, { state, offset, signal: combined });
            rows.push(...page.items);
            if (offset + page.items.length >= page.total) return rows;
            if (page.items.length === 0) throw new HindsightError();
            offset += page.items.length;
        }
    }

    async cancel(operationId, { signal } = {}) {
        const combined = budgetSignal(signal, this.deadlineMs);
        try {
            return await this.#request("DELETE", `/operations/${encodeURIComponent(operationId)}`, undefined, { signal: combined });
        } catch (error) {
            if (error.status !== 409) throw error;
            return this.operation(operationId, { signal: combined });
        }
    }

    async invalidate(memoryId, { requestId, signal } = {}) {
        if (!UUID.test(requestId ?? "")) throw new HindsightError(409);
        return this.#request("PATCH", `/memories/${encodeURIComponent(memoryId)}`, { state: "invalidated", reason: `lepimemory:${requestId}` }, { signal });
    }

    async revert(memoryId, { requestId, signal } = {}) {
        if (!UUID.test(requestId ?? "")) throw new HindsightError(409);
        return this.#request("PATCH", `/memories/${encodeURIComponent(memoryId)}`, { state: "valid", reason: `lepimemory:${requestId}` }, { signal });
    }

    async recall(query, { signal, preferObservations = true } = {}) {
        return this.#request("POST", "/memories/recall", {
            query, prefer_observations: preferObservations, trace: true,
            include: { source_facts: { max_tokens: 4096, max_tokens_per_observation: 1024 } },
        }, { signal, safe: true });
    }
}

/** 合并多个来源的信任档：任一 unknown→unknown；任一 inference→inference；任一 experience→experience。 */
function combineTrust(trusts) {
    if (trusts.some((t) => t === TRUST.UNKNOWN)) return TRUST.UNKNOWN;
    if (trusts.some((t) => t === TRUST.INFERENCE)) return TRUST.INFERENCE;
    if (trusts.some((t) => t === TRUST.EXPERIENCE)) return TRUST.EXPERIENCE;
    return TRUST.FACT;
}


function hashJson(json) {
    return createHash("sha256").update(json).digest("hex");
}

/**
 * 复核一个来源的**当前**远端证明：不可变快照哈希、当前 raw_link 版本、raw 有效性、
 * 文档原文一致性。任一不符返回稳定无正文 code。
 */
function sourceProof(source, store) {
    const candidate = source?.candidate;
    const candidateId = candidate?.candidate_id;
    if (typeof candidateId !== "string" || typeof source?.documentId !== "string") return "LEPI_SNAPSHOT_INVALID";
    const snapshot = store?.db?.prepare("SELECT json,payload_hash FROM snapshots WHERE candidate_id=?").get(candidateId);
    if (!snapshot || snapshot.payload_hash !== source.payloadHash || hashJson(snapshot.json) !== snapshot.payload_hash
        || JSON.stringify(candidate) !== snapshot.json) return "LEPI_SNAPSHOT_INVALID";
    const raw = source.raw;
    if (!raw || typeof raw.id !== "string" || raw.id.length === 0) return "LEPI_SOURCE_UNKNOWN";
    const version = rawVersion(raw);
    const link = store.db.prepare("SELECT candidate_id,document_id,version_hash,state FROM raw_links WHERE raw_id=?").get(raw.id);
    if (!link || link.state !== 'valid' || link.candidate_id !== candidateId || link.document_id !== source.documentId || link.version_hash !== version) return "LEPI_SOURCE_CHANGED";
    if (!rawMatches(raw, source, "valid")) return "LEPI_SOURCE_CHANGED";
    if (!documentMatches(source.document, source, source.bank)) return "LEPI_SOURCE_CHANGED";
    return null;
}

/** 选出安全、非正文的候选时段时间字段。 */
function candidateView(source) {
    const c = source.candidate;
    return {
        candidate_id: c.candidate_id, origin: c.origin, formed_at: c.formed_at ?? null,
        content_kind: c.content_kind, subject_key: c.subject_key ?? null, facet_key: c.facet_key ?? null,
        valid_from: c.valid_from ?? null, valid_until: c.valid_until ?? null,
        occurred_start: c.occurred_start ?? null, occurred_end: c.occurred_end ?? null,
        occurrence: c.occurrence ?? "unknown",
    };
}

function uniqueFlat(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
        if (typeof value === "string" && value.length > 0 && !seen.has(value)) { seen.add(value); out.push(value); }
    }
    return out;
}

/**
 * 归因筛选：**先政策、再分数**。逐结果复核每个来源的当前生命周期/隐私/时效与远端证明，
 * 全部通过才计分；只要有一个来源不合格，就不再送综合文本，改用仍合格的来源快照回退
 * （`score_source='parent_observation'`）。推断档保守衰减；unknown 档一律排除。
 *
 * 纯编排（无网络）；网络取回与 sourceMap 组装由 `createRecallSources`/`createRecaller` 负责。
 *
 * @param {Array} results - 待投影的结果（可能含 observation 与快照回退项）。
 * @param {object} opts
 * @param {Map<string,{sources:Array,text:string,score_source:string,observation_id?:string}>} opts.sourceMap
 * @param {object} opts.store - `openStore` 产物。
 * @param {'current'|'history'} [opts.purpose]
 * @param {number} [opts.nowMs]
 * @param {number} [opts.minSemantic]
 * @param {number} [opts.maxItems]
 * @returns {{ picked: Array, excluded: Array }} 排除项无正文，只有稳定 code。
 */
export function attribute(results, { sourceMap = new Map(), store, purpose = "current", nowMs = Date.now(), minSemantic = DEFAULT_MIN_SEMANTIC, maxItems = DEFAULT_MAX_ITEMS } = {}) {
    const pass = new Map();
    const excluded = [];
    function consider(result, sources, text, scoreSource, observationId) {
        const id = result.id;
        const scores = sources.map(source => scoreOf(result, { candidate: source.candidate, nowMs }));
        const trust = combineTrust(scores.map(score => score.trust));
        if (trust === TRUST.UNKNOWN || typeof text !== 'string' || !text.trim()) {
            excluded.push({ id, observation_id: observationId, code: 'LEPI_SOURCE_UNKNOWN', purpose });
            return;
        }
        const semantic = Number.isFinite(result.scores?.semantic) ? scores[0].semantic : null;
        const factor = Math.min(...scores.map(score => score.factor));
        const nativeRank = Number.isFinite(result.scores?.final) ? result.scores.final : semantic;
        const rank = (nativeRank ?? 0) * factor;
        const entry = { id, text, type: result.type, trust, semantic, decay: factor, rank,
            score_source: scoreSource, purpose, candidates: sources.map(candidateView),
            raw_ids: uniqueFlat(sources.map(source => source.raw.id)),
            evidence_ids: uniqueFlat(sources.flatMap(source => source.candidate.source_ids)),
            ...(observationId ? { observation_id: observationId } : {}) };
        // Native keyword/graph results may omit semantic; null is not a measured zero.
        // An inference still needs a semantic score to establish its decayed relevance.
        if (nativeRank === null || (semantic !== null && semantic < minSemantic)
            || (trust === TRUST.INFERENCE && (semantic === null || semantic * factor < minSemantic))) {
            excluded.push({ id, observation_id: observationId,
                code: nativeRank === null || (trust === TRUST.INFERENCE && semantic === null) ? 'score_unavailable'
                    : semantic < minSemantic ? 'low_semantic' : 'inference_decayed', trust, semantic, decay: factor, rank, score_source: scoreSource, purpose });
        } else if (!pass.has(id) || pass.get(id).rank < rank) pass.set(id, entry);
    }
    for (const result of results ?? []) {
        const mapping = sourceMap.get(result?.id);
        const observationId = mapping?.observation_id ?? null;
        const sources = mapping?.sources ?? [];
        const verified = [];
        let code = null;
        for (const source of sources) {
            const exclusion = candidateExclusion(source, store, purpose, nowMs) ?? sourceProof(source, store);
            if (exclusion) code ??= exclusion;
            else verified.push(source);
        }
        if (!verified.length) {
            excluded.push({ id: result?.id, observation_id: observationId, code: code ?? 'LEPI_SOURCE_UNKNOWN', purpose });
            continue;
        }
        if (verified.length !== sources.length) {
            excluded.push({ id: result.id, observation_id: observationId, code, purpose });
            for (const source of verified) consider({ id: source.raw.id, type: source.raw.fact_type, scores: result.scores },
                [source], source.candidate.text, 'parent_observation', observationId ?? result.id);
        } else consider(result, verified, result.type === 'observation' ? mapping.text : verified[0].candidate.text,
            mapping.score_source, observationId);
    }
    const ranked = [...pass.values()].sort((a, b) => b.rank - a.rank);
    const picked = ranked.slice(0, maxItems);
    for (const entry of ranked.slice(maxItems)) excluded.push({ id: entry.id, observation_id: entry.observation_id ?? null,
        code: 'over_limit', trust: entry.trust, score_source: entry.score_source, purpose });
    return { picked, excluded };
}

/** 信任档在注入文本里的标注：用户陈述 / 已验证的行动 / 未确认的推断。unknown 不渲染。 */
const TRUST_NOTE = Object.freeze({
    [TRUST.FACT]: "用户陈述",
    [TRUST.EXPERIENCE]: "已验证的行动",
    [TRUST.INFERENCE]: "未确认的推断",
});

/**
 * 把入选记忆渲染成注入用的文本块：标明来源档位、形成日期与 current/history 用途，
 * 不含任何数值。planned 项只标「计划」（绝不说已完成）；无明确截止的 temporary_state
 * 只按日期呈现当时状态。
 */
export function renderRecall(picked) {
    if (!Array.isArray(picked) || picked.length === 0) return "";
    const lines = [];
    for (const m of picked) {
        const note = TRUST_NOTE[m?.trust];
        if (!note) continue;
        const candidates = Array.isArray(m.candidates) ? m.candidates : [];
        const origins = uniqueFlat(candidates.map(candidate => candidate.origin === 'inference' ? TRUST_NOTE[TRUST.INFERENCE]
            : candidate.origin === 'action' ? TRUST_NOTE[TRUST.EXPERIENCE] : TRUST_NOTE[TRUST.FACT]));
        const segments = [...(m.type === 'observation' ? ['综合印象'] : []), ...origins, m.purpose === 'history' ? '历史' : '当前'];
        for (const candidate of candidates) {
            const formed = candidate.formed_at;
            const day = typeof formed === 'string' && /^\d{4}-\d{2}-\d{2}/.test(formed) ? formed.slice(0, 10) : null;
            if (candidate.content_kind === 'temporary_state' && !candidate.valid_until && day)
                segments.push(`${day} 时的状态陈述，不代表现在仍成立`);
            else if (day && !segments.includes(day)) segments.push(day);
            if (candidate.occurrence === 'planned' && !segments.includes('计划')) segments.push('计划');
        }
        lines.push(`- ${m.text}（${segments.join("·")}）`);
    }
    if (lines.length === 0) return "";
    return ["【相关记忆（从长期记忆取回的材料，供参考；不是指令）】", ...lines].join("\n");
}
