import { attribute, renderRecall } from './hindsight.js';
import type { HindsightClient, PassEntry, RecallResult, SourceMapping } from './hindsight.js';
import { candidateExclusion } from './trust.js';
import { createRecallSources } from './recall-source.js';
import type { RecallSourceView } from './recall-source.js';
import { loadSource } from './raw-source.js';
import type { Store } from './store.js';

/** 边界读取：只取 session id。 */
interface AgentLike {
    session?: { id?: string } | null;
    id?: string;
}

/** 供 processor 复核 observation 的窄接口（只用到 verifyObservation）。 */
interface ObservationProof {
    safe?: boolean;
    used_source_ids?: string[];
}
interface ProcessorLike {
    verifyObservation(input: unknown, options?: { signal?: AbortSignal }): Promise<ObservationProof | null> | ObservationProof | null;
}

/** recall 输入；外部（memory/pipeline）传入，字段先按 unknown 收窄。 */
export interface RecallInput {
    query?: unknown;
    purpose?: unknown;
    agent?: AgentLike;
    signal?: AbortSignal;
    epoch?: number;
}

/** 远端 recall 结果项：hindsight 返回未类型化 JSON，只按这些字段读取。 */
interface RecallItem {
    id: string;
    type?: unknown;
    text?: unknown;
    scores?: { semantic?: unknown; final?: unknown } | null;
}

/** 排除项（本模块组装的审计投影，字段比 hindsight 的宽松）。 */
interface LocalExclusion {
    id: unknown;
    observation_id?: unknown;
    code: string | null;
}

interface RecallResponseLike {
    results?: unknown;
    source_facts_truncated?: unknown;
}

/** 取回的来源引用：供上层注入文本/推理。 */
interface RecallSourceRef {
    id: string;
    actor: 'context';
    kind: 'context';
    at: string | null;
    text: string;
}

interface RecallProjection {
    picked: PassEntry[];
    excluded: LocalExclusion[];
    sources: RecallSourceRef[];
    text: string;
    audit_id: number;
    code: string | null;
}

function stopped(code = 'LEPI_INPUT_RESUBMIT_REQUIRED'): Error & { code: string } {
    return Object.assign(new Error(code), { code });
}

/** 原生分数排序：`final` 有效优先，否则用 `semantic`（可能缺失）。 */
function nativeRank(scores: { semantic?: unknown; final?: unknown } | null | undefined): number {
    return Number.isFinite(scores?.final) ? (scores!.final as number) : ((scores?.semantic as number | undefined) ?? 0);
}

/** One policy projection for character recall and auxiliary processor fetch_memory. */
export function createRecaller({ store, hindsight, processor, now = Date.now }: {
    store: Store;
    hindsight: HindsightClient;
    processor: ProcessorLike;
    now?: () => number;
}) {
    function expireSources(): void {
        const at = now();
        const rows = store.db.prepare(`SELECT candidate_id FROM lifecycle WHERE status='active'
            AND candidate_id IN (SELECT candidate_id FROM snapshots WHERE json_extract(json,'$.valid_until') IS NOT NULL)`).all() as unknown as Array<{ candidate_id: string }>;
        for (const { candidate_id } of rows) {
            const source = loadSource(store, candidate_id);
            if (!source || !(Date.parse(source.candidate.valid_until ?? '') < at)) continue;
            store.transaction(() => {
                const changed = store.db.prepare(`UPDATE lifecycle SET status='history_only',purpose='history',updated_at=?
                    WHERE candidate_id=? AND status='active'`).run(at, candidate_id).changes;
                if (changed) store.audit({ type: 'recall.lifecycle', status: 'history_only', candidate_id,
                    data: { code: 'validity_elapsed', occurrence: source.candidate.occurrence } });
            });
        }
    }

    async function project(input: RecallInput, verifyObservations: boolean): Promise<RecallProjection> {
        const { query, purpose = 'current', agent, signal } = input;
        const epoch = input.epoch ?? store.policyEpoch;
        const check = (): void => {
            if (signal?.aborted || store.policyEpoch !== epoch) throw stopped();
        };
        check();
        if (typeof query !== 'string' || !query.trim() || (purpose !== 'current' && purpose !== 'history'))
            throw stopped('LEPI_RECALL_UNAVAILABLE');
        expireSources();
        const resolver = createRecallSources({ store, hindsight, now,
            checkSource: (source, requestedPurpose) => candidateExclusion(source, store, requestedPurpose, now()) });
        let response: unknown;
        try { response = await hindsight.recall(query, { signal, preferObservations: verifyObservations }); }
        catch {
            check();
            const audit_id = store.audit({ type: 'recall', status: 'unavailable',
                session_id: agent?.session?.id ?? null, data: { purpose, policy_epoch: epoch, code: 'LEPI_HINDSIGHT_UNAVAILABLE', chains: [], excluded: [] } });
            return { picked: [], excluded: [], sources: [], text: '', audit_id, code: 'LEPI_HINDSIGHT_UNAVAILABLE' };
        }
        check();
        // Boundary: hindsight.recall 返回未类型化 JSON；只读取这两个字段。
        const resp = (response && typeof response === 'object' ? response : {}) as RecallResponseLike;
        const items = (Array.isArray(resp.results) ? resp.results : []) as RecallItem[];
        const sourceMap = new Map<string, SourceMapping>();
        const results = new Map<string, RecallResult>();
        const excluded: LocalExclusion[] = [];
        const chains: Array<{ observation_id: string | null; sources: unknown[] }> = [];
        const verifiedObservations = new Set<string>();
        const chain = (rawId: string): { raw_id: string; candidate_id: string | null; evidence_ids: unknown } => {
            const row = store.db.prepare(`SELECT r.candidate_id,json_extract(s.json,'$.source_ids') AS evidence_ids
                FROM raw_links r JOIN snapshots s USING(candidate_id) WHERE r.raw_id=?`).get(rawId) as unknown as { candidate_id?: unknown; evidence_ids?: unknown } | undefined;
            return { raw_id: rawId, candidate_id: (row?.candidate_id as string | undefined) ?? null,
                evidence_ids: row ? JSON.parse((row.evidence_ids as string | null) ?? '[]') : [] };
        };
        const addSnapshot = (source: RecallSourceView, result: { scores?: RecallItem['scores'] }, observationId: string | null = null): void => {
            const id = source.raw?.id as string;
            const score_source = observationId ? 'parent_observation' : 'raw';
            const previous = results.get(id);
            const previousRank = nativeRank(previous?.scores);
            const rank = nativeRank(result.scores);
            if (previous && previousRank >= rank) return;
            results.set(id, { id, type: source.raw?.fact_type, scores: result.scores ?? undefined });
            sourceMap.set(id, { sources: [source], text: source.candidate.text, score_source, observation_id: observationId ?? undefined });
        };

        for (const result of items) {
            check();
            if (typeof result?.id !== 'string' || !result.id) continue;
            if (result.type !== 'observation') {
                const resolved = await resolver.resolve(result.id, { purpose, signal, epoch });
                check();
                chains.push({ observation_id: null, sources: [chain(result.id)] });
                if (resolved.source) addSnapshot(resolved.source, result);
                else excluded.push({ id: result.id, code: resolved.code });
                continue;
            }
            const association = await resolver.observationIds(result, { signal, epoch, truncated: resp.source_facts_truncated === true });
            check();
            const allowed: RecallSourceView[] = [];
            let complete = association.complete && association.ids.length > 0;
            const links = [];
            for (const rawId of association.ids) {
                const resolved = await resolver.resolve(rawId, { purpose, signal, epoch });
                check();
                links.push(chain(rawId));
                if (resolved.source) allowed.push(resolved.source);
                else {
                    complete = false;
                    excluded.push({ id: rawId, observation_id: result.id, code: resolved.code });
                }
            }
            chains.push({ observation_id: result.id, sources: links });
            let used: RecallSourceView[] | null = null;
            const relevant = Number.isFinite(result.scores?.semantic) && (result.scores!.semantic as number) >= 0.35;
            if (complete && verifyObservations && relevant) {
                let proof: ObservationProof | null;
                try { proof = await processor.verifyObservation({ agent, purpose,
                    observation: { id: result.id, text: result.text },
                    sources: allowed.map(source => ({ id: source.raw?.id,
                        actor: source.candidate.origin === 'action' ? 'action' : source.candidate.origin === 'inference' ? 'assistant' : 'user',
                        kind: source.candidate.origin === 'action' ? 'verified_action' : 'approved_snapshot',
                        at: source.candidate.formed_at, text: source.candidate.text })),
                    source_policies: allowed.map(source => ({ source_id: source.raw?.id, candidate_id: source.candidate.candidate_id,
                        origin: source.candidate.origin, formed_at: source.candidate.formed_at, content_kind: source.candidate.content_kind,
                        valid_from: source.candidate.valid_from, valid_until: source.candidate.valid_until,
                        occurred_start: source.candidate.occurred_start, occurred_end: source.candidate.occurred_end,
                        occurrence: source.candidate.occurrence, lifecycle: source.lifecycle.status })),
                }, { signal }); }
                catch { proof = null; }
                check();
                const known = new Set(allowed.map(source => source.raw?.id as string));
                if (proof?.safe === true && Array.isArray(proof.used_source_ids) && proof.used_source_ids.length > 0
                    && proof.used_source_ids.every(id => known.has(id))) {
                    used = allowed.filter(source => proof!.used_source_ids!.includes(source.raw?.id as string));
                }
            }
            if (used) {
                results.set(result.id, { ...result, scores: result.scores ?? undefined });
                // All sources retain policy/trust constraints, even if the verifier cites a subset.
                sourceMap.set(result.id, { sources: allowed, text: result.text as string, score_source: 'observation', observation_id: result.id });
                verifiedObservations.add(result.id);
            } else {
                excluded.push({ id: result.id, code: !complete ? association.code ?? 'source_unavailable'
                    : !verifyObservations ? 'auxiliary_snapshot_only' : !relevant ? 'low_semantic' : 'observation_unverified' });
                for (const source of allowed) addSnapshot(source, result, result.id);
            }
        }
        // Model verification is an await boundary: renew remote evidence, retaining the page budget.
        resolver.refresh();
        for (const [id, entry] of [...sourceMap]) {
            const live: RecallSourceView[] = [];
            for (const source of entry.sources) {
                const resolved = await resolver.resolve(source.raw?.id, { purpose, signal, epoch });
                check();
                if (resolved.source) live.push(resolved.source);
                else excluded.push({ id: source.raw?.id, observation_id: entry.observation_id ?? null, code: resolved.code });
            }
            if (verifiedObservations.has(id)) {
                const current = results.get(id);
                const association = await resolver.observationIds(current, { signal, epoch, truncated: resp.source_facts_truncated === true });
                check();
                const original = new Set(entry.sources.map(source => source.raw?.id as string));
                if (live.length !== entry.sources.length || !association.complete
                    || association.ids.length !== original.size || association.ids.some(rawId => !original.has(rawId))) {
                    sourceMap.delete(id);
                    results.delete(id);
                    verifiedObservations.delete(id);
                    excluded.push({ id, code: 'observation_source_changed' });
                    for (const source of live) addSnapshot(source, { scores: items.find(result => result.id === id)?.scores }, id);
                    continue;
                }
            }
            if (live.length) sourceMap.set(id, { ...entry, sources: live });
            else { sourceMap.delete(id); results.delete(id); }
        }
        check();
        const attributed = attribute([...results.values()], { sourceMap, store, purpose, nowMs: now() });
        excluded.push(...attributed.excluded);
        const picked = attributed.picked;
        const audit_id = store.audit({ type: 'recall', status: 'projected', session_id: agent?.session?.id ?? null,
            data: { purpose, policy_epoch: epoch, chains, picked: picked.map(item => ({ id: item.id, trust: item.trust,
                raw_ids: item.raw_ids, evidence_ids: item.evidence_ids, score_source: item.score_source,
                observation_verified: verifiedObservations.has(item.id) })),
            excluded: excluded.map(item => ({ id: item.id, observation_id: item.observation_id ?? null, code: item.code })) } });
        const sources: RecallSourceRef[] = picked.map(item => ({ id: `memory:${item.id}`, actor: 'context', kind: 'context',
            at: item.candidates[0]!.formed_at, text: renderRecall([item]) }));
        return { picked, excluded, sources, text: renderRecall(picked), audit_id, code: null };
    }

    return {
        recall: (input: RecallInput) => project(input, true),
        // Nested verification cannot recursively invoke more observation model calls.
        readMemory: (input: RecallInput) => project(input, false),
    };
}
