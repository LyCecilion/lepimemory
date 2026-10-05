/**
 * recall-source.js — 取回期的来源绑定（Lepimemory 运行时收敛 Step 8 前置）。
 *
 * 作用：把 Hindsight recall 返回的 `raw_id`（以及 observation 的当前来源 ID）绑回
 * **不可变获准快照**，并证明「当前远端 link/document/raw 身份」与本地政策一致，
 * 这样取回投影就不会复活被取代、被遗忘或本地已改动的旧副本。
 *
 * 约束（与 step8 契约一致）：
 *   - 只读既有 `raw_links`；**绝不**创建/覆写 link。
 *   - 全程无副作用：不写审计、不改行/状态、构造器不做 I/O（SQL 首次使用才 prepare）。
 *   - 网络只用于只读 raw/document 查询 + 有界文档分页兜底。
 *   - 注入的 `checkSource`（父级 `candidateExclusion`）在**任何网络之前**与**每次 await 之后**
 *     各跑一次；trust 只认 link 绑定的 candidate 的 origin/formed_at。
 *   - abort / epoch 不一致一律 fail closed（返回稳定、无正文的 code）。
 *
 * 缓存只在一个 recall 实例（一次工厂）内有效：`documents`/`raws` 按 id 复用同一 Promise，
 * 避免重复请求；`refresh()` 同步清空这些缓存但**保留同一 4 页兜底预算**，供父级在
 * `processor.verifyObservation` 之后强制刷新远端证明再重新 resolve。
 */
import { loadSource, rawMatches, documentMatches, rawVersion } from './raw-source.js';

/** 已知文档兜底：每个实例最多 4 次分页请求（每次 100 行）。 */
const MAX_PAGE_REQUESTS = 4;

/** 稳定、无正文的来源排除/失败码。 */
const CODE = Object.freeze({
    UNLINKED: 'LEPI_SOURCE_UNLINKED',
    SNAPSHOT_INVALID: 'LEPI_SNAPSHOT_INVALID',
    CHANGED: 'LEPI_SOURCE_CHANGED',
    MISSING: 'LEPI_SOURCE_MISSING',
    UNKNOWN: 'LEPI_SOURCE_UNKNOWN',
    UNAVAILABLE: 'LEPI_HINDSIGHT_UNAVAILABLE',
    POLICY: 'LEPI_POLICY_CHANGED',
    ABORTED: 'LEPI_SOURCE_ABORTED',
    OBSERVATION_INCOMPLETE: 'LEPI_OBSERVATION_INCOMPLETE',
});

/** 归一化 id 列表：全为非空字符串才有效，否则 null（缺失/畸形）。 */
function normalizedIds(value) {
    if (!Array.isArray(value)) return null;
    const out = [];
    const seen = new Set();
    for (const entry of value) {
        if (typeof entry !== 'string' || entry.length === 0) return null;
        if (!seen.has(entry)) { seen.add(entry); out.push(entry); }
    }
    return out;
}

/** recall 结果里可安全使用的已知 id（畸形时降级为空列表）。 */
function knownIds(result) {
    return normalizedIds(result?.source_fact_ids) ?? [];
}

function isCurrentObservation(raw, result) {
    return Boolean(raw && raw.state === 'valid'
        && (raw.type === 'observation' || raw.fact_type === 'observation')
        && typeof raw.text === 'string' && typeof result?.text === 'string' && raw.text === result.text);
}

/**
 * @param {object} deps
 * @param {object} deps.store `openStore` 产物（本模块只读，不写行/状态）。
 * @param {object} deps.hindsight `HindsightClient`（`bank` / `raw` / `document` / `unitsPage`）。
 * @param {(source:object, purpose:*) => string|null} deps.checkSource 父级 `candidateExclusion`：
 *   同步返回 `null` 或稳定、无正文的排除码。source 为 `{candidate,lifecycle,payloadHash,documentId,link,raw,document,bank}`。
 * @param {() => number} [deps.now] 预留（时间政策由 `checkSource` 负责）。
 * @returns {{ resolve:Function, observationIds:Function, refresh:Function }}
 */
export function createRecallSources({ store, hindsight, checkSource, now = Date.now }) {
    const documents = new Map();
    const raws = new Map();
    // 单一全局兜底预算：跨 resolve/observationIds/refresh 共享，绝不重置。
    let pageRequests = 0;
    let linkStatement = null;

    function linkFor(rawId) {
        linkStatement ??= store.db.prepare(
            'SELECT raw_id,candidate_id,document_id,version_hash,state,verified_at FROM raw_links WHERE raw_id=?');
        return linkStatement.get(rawId) ?? null;
    }

    function policy(source, purpose) {
        let code;
        try { code = checkSource(source, purpose); }
        catch { return CODE.POLICY; }
        return typeof code === 'string' && code.length > 0 ? code : null;
    }

    /** 把一次读取固定为同一 Promise，避免同实例重复请求；错误也缓存（不重复打远端）。 */
    function memo(map, key, load) {
        if (!map.has(key)) map.set(key, Promise.resolve().then(load).then(value => ({ value }), error => ({ error })));
        return map.get(key);
    }

    const getDocument = (documentId, signal) =>
        memo(documents, documentId, () => hindsight.document(documentId, { signal }));

    const getRawDetail = (rawId, signal) =>
        memo(raws, rawId, () => hindsight.raw(rawId, { signal }));

    /** 有界文档分页兜底：直接 raw 查询 404/不可用时的已知文档扫描。 */
    async function scanDocument(documentId, rawId, signal, guard) {
        let offset = 0;
        for (;;) {
            if (signal?.aborted) return { raw: null, code: CODE.ABORTED };
            if (pageRequests >= MAX_PAGE_REQUESTS) return { raw: null, code: CODE.UNKNOWN };
            pageRequests += 1;
            let page;
            try { page = await hindsight.unitsPage(documentId, { state: 'valid', offset, signal }); }
            catch { return { raw: null, code: CODE.UNAVAILABLE }; }
            const policyCode = guard();
            if (policyCode) return { raw: null, code: policyCode };
            if (!page || !Array.isArray(page.items) || !Number.isSafeInteger(page.total) || page.total < 0)
                return { raw: null, code: CODE.UNAVAILABLE };
            const found = page.items.find(item => item && item.id === rawId);
            if (found) return { raw: found, complete: true };
            if (page.items.length === 0) return { raw: null, code: CODE.UNKNOWN };
            offset += page.items.length;
            if (offset >= page.total) return { raw: null, complete: true };
        }
    }

    async function resolveRaw(rawId, source, signal, guard) {
        const direct = await getRawDetail(rawId, signal);
        const policyCode = guard();
        if (policyCode) return { raw: null, code: policyCode };
        if (!direct.error && direct.value != null) return { raw: direct.value, complete: true };
        // 404 / 网络不可用 → 有界已知文档兜底；不把未完成的扫描当作“来源缺失”的证据。
        if (signal?.aborted) return { raw: null, code: CODE.ABORTED };
        return scanDocument(source.documentId, rawId, signal, guard);
    }

    /**
     * 解析单个 recall raw id → 不可变来源复合体。
     * @returns {Promise<{source:object|null, code:string|null}>}
     */
    async function resolve(rawId, { purpose, signal, epoch } = {}) {
        if (typeof rawId !== 'string' || rawId.length === 0) return { source: null, code: CODE.UNLINKED };
        if (signal?.aborted) return { source: null, code: CODE.ABORTED };

        const link = linkFor(rawId);
        if (!link) return { source: null, code: CODE.UNLINKED };

        let loaded;
        try { loaded = loadSource(store, link.candidate_id); }
        catch (error) {
            return { source: null, code: error?.code === CODE.SNAPSHOT_INVALID ? CODE.SNAPSHOT_INVALID : CODE.UNAVAILABLE };
        }
        if (!loaded) return { source: null, code: CODE.SNAPSHOT_INVALID };
        if (link.document_id !== loaded.documentId || link.state !== 'valid') return { source: null, code: CODE.CHANGED };

        const bank = hindsight?.bank ?? null;
        let source = {
            candidate: loaded.candidate, lifecycle: loaded.lifecycle, payloadHash: loaded.payloadHash,
            documentId: loaded.documentId, link, raw: null, document: null, bank,
        };

        let code = policy(source, purpose);
        if (code) return { source: null, code };
        const guard = () => {
            if (signal?.aborted) return CODE.ABORTED;
            if (epoch != null && store.policyEpoch !== epoch) return CODE.POLICY;
            const currentLink = linkFor(rawId);
            if (!currentLink || currentLink.state !== 'valid' || currentLink.candidate_id !== link.candidate_id
                || currentLink.document_id !== link.document_id || currentLink.version_hash !== link.version_hash) return CODE.CHANGED;
            let current;
            try { current = loadSource(store, link.candidate_id); }
            catch { return CODE.SNAPSHOT_INVALID; }
            if (!current || current.payloadHash !== loaded.payloadHash) return CODE.SNAPSHOT_INVALID;
            return policy({ ...source, lifecycle: current.lifecycle }, purpose);
        };
        code = guard();
        if (code) return { source: null, code };

        const docResult = await getDocument(loaded.documentId, signal);
        code = guard();
        if (code) return { source: null, code };
        const rawResult = await resolveRaw(rawId, source, signal, guard);
        code = guard();
        if (code) return { source: null, code };
        if (signal?.aborted) return { source: null, code: CODE.ABORTED };

        if (docResult.error) return { source: null, code: CODE.UNAVAILABLE };
        if (!documentMatches(docResult.value, source, bank)) return { source: null, code: CODE.CHANGED };
        if (rawResult.code) return { source: null, code: rawResult.code };
        if (!rawResult.raw) return { source: null, code: rawResult.complete ? CODE.MISSING : CODE.UNKNOWN };
        const raw = rawResult.raw;
        if (!rawMatches(raw, source, 'valid')) return { source: null, code: CODE.CHANGED };
        if (rawVersion(raw) !== link.version_hash) return { source: null, code: CODE.CHANGED };

        // await 之后重新核验：epoch、当前 link/生命周期、当前政策。
        if (epoch != null && store.policyEpoch !== epoch) return { source: null, code: CODE.POLICY };
        const freshLink = linkFor(rawId);
        if (!freshLink || freshLink.candidate_id !== link.candidate_id
            || freshLink.document_id !== link.document_id || freshLink.version_hash !== link.version_hash)
            return { source: null, code: CODE.CHANGED };
        let fresh;
        try { fresh = loadSource(store, link.candidate_id); }
        catch { return { source: null, code: CODE.SNAPSHOT_INVALID }; }
        if (!fresh) return { source: null, code: CODE.SNAPSHOT_INVALID };

        source = { ...source, lifecycle: fresh.lifecycle, link: freshLink, raw, document: docResult.value };
        code = policy(source, purpose);
        if (code) return { source: null, code };
        if (signal?.aborted) return { source: null, code: CODE.ABORTED };
        return { source, code: null };
    }

    function fallbackIds(result, truncated) {
        const ids = normalizedIds(result?.source_fact_ids);
        if (truncated === false && ids && ids.length > 0) return { ids, complete: true, code: null };
        return { ids: ids ?? [], complete: false, code: CODE.OBSERVATION_INCOMPLETE };
    }

    /**
     * observation → 权威、完整的来源 raw id 列表（不携带 observation 正文）。
     * 优先后端当前 observation 详情（state=valid、type=observation、正文与 recall 一致）；
     * 详情不可用时退回未截断且良构的 recall `source_fact_ids`；截断/缺失一律 fail closed
     * （`complete:false`，父级只允许按快照处理）。
     * @returns {Promise<{ids:string[], complete:boolean, code:string|null}>}
     */
    async function observationIds(result, { signal, epoch, truncated } = {}) {
        if (signal?.aborted) return { ids: knownIds(result), complete: false, code: CODE.ABORTED };
        const id = typeof result?.id === 'string' && result.id.length > 0 ? result.id : null;
        if (!id) return fallbackIds(result, truncated);

        const detail = await getRawDetail(id, signal);
        if (signal?.aborted) return { ids: knownIds(result), complete: false, code: CODE.ABORTED };
        if (epoch != null && store.policyEpoch !== epoch)
            return { ids: knownIds(result), complete: false, code: CODE.POLICY };

        if (!detail.error && isCurrentObservation(detail.value, result)) {
            const ids = normalizedIds(detail.value.source_memory_ids);
            if (ids && ids.length > 0) return { ids, complete: true, code: null };
            return { ids: ids ?? [], complete: false, code: CODE.OBSERVATION_INCOMPLETE };
        }
        if (!detail.error && detail.value != null)
            return { ids: knownIds(result), complete: false, code: CODE.CHANGED };
        return fallbackIds(result, truncated);
    }

    /**
     * 同步清空 raw/document 详情缓存（无 I/O），保留同一全局 4 页兜底预算。
     * 供父级在 `processor.verifyObservation` 之后强制刷新远端证明、再重新 resolve。
     */
    function refresh() {
        documents.clear();
        raws.clear();
    }

    return { resolve, observationIds, refresh };
}
