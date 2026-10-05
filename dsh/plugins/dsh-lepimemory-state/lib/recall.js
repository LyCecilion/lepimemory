import { attribute, renderRecall } from './hindsight.js';
import { candidateExclusion } from './trust.js';
import { createRecallSources } from './recall-source.js';
import { loadSource } from './raw-source.js';

function stopped(code = 'LEPI_INPUT_RESUBMIT_REQUIRED') {
    return Object.assign(new Error(code), { code });
}

/** One policy projection for character recall and auxiliary processor fetch_memory. */
export function createRecaller({ store, hindsight, processor, now = Date.now }) {
    function expireSources() {
        const at = now();
        const rows = store.db.prepare(`SELECT candidate_id FROM lifecycle WHERE status='active'
            AND candidate_id IN (SELECT candidate_id FROM snapshots WHERE json_extract(json,'$.valid_until') IS NOT NULL)`).all();
        for (const { candidate_id } of rows) {
            const source = loadSource(store, candidate_id);
            if (!source || !(Date.parse(source.candidate.valid_until) < at)) continue;
            store.transaction(() => {
                const changed = store.db.prepare(`UPDATE lifecycle SET status='history_only',purpose='history',updated_at=?
                    WHERE candidate_id=? AND status='active'`).run(at, candidate_id).changes;
                if (changed) store.audit({ type: 'recall.lifecycle', status: 'history_only', candidate_id,
                    data: { code: 'validity_elapsed', occurrence: source.candidate.occurrence } });
            });
        }
    }

    async function project(input, verifyObservations) {
        const { query, purpose = 'current', agent, signal } = input;
        const epoch = input.epoch ?? store.policyEpoch;
        const check = () => {
            if (signal?.aborted || store.policyEpoch !== epoch) throw stopped();
        };
        check();
        if (typeof query !== 'string' || !query.trim() || !['current', 'history'].includes(purpose))
            throw stopped('LEPI_RECALL_UNAVAILABLE');
        expireSources();
        const resolver = createRecallSources({ store, hindsight, now,
            checkSource: (source, requestedPurpose) => candidateExclusion(source, store, requestedPurpose, now()) });
        let response;
        try { response = await hindsight.recall(query, { signal, preferObservations: verifyObservations }); }
        catch {
            check();
            const audit_id = store.audit({ type: 'recall', status: 'unavailable',
                session_id: agent?.session?.id ?? null, data: { purpose, policy_epoch: epoch, code: 'LEPI_HINDSIGHT_UNAVAILABLE', chains: [], excluded: [] } });
            return { picked: [], excluded: [], sources: [], text: '', audit_id, code: 'LEPI_HINDSIGHT_UNAVAILABLE' };
        }
        check();
        const sourceMap = new Map();
        const results = new Map();
        const excluded = [];
        const chains = [];
        const verifiedObservations = new Set();
        const chain = rawId => {
            const row = store.db.prepare(`SELECT r.candidate_id,json_extract(s.json,'$.source_ids') AS evidence_ids
                FROM raw_links r JOIN snapshots s USING(candidate_id) WHERE r.raw_id=?`).get(rawId);
            return { raw_id: rawId, candidate_id: row?.candidate_id ?? null,
                evidence_ids: row ? JSON.parse(row.evidence_ids ?? '[]') : [] };
        };
        const addSnapshot = (source, result, observationId = null) => {
            const id = source.raw.id;
            const score_source = observationId ? 'parent_observation' : 'raw';
            const previous = results.get(id);
            const previousRank = Number.isFinite(previous?.scores?.final) ? previous.scores.final : previous?.scores?.semantic ?? 0;
            const rank = Number.isFinite(result.scores?.final) ? result.scores.final : result.scores?.semantic ?? 0;
            if (previous && previousRank >= rank) return;
            results.set(id, { id, type: source.raw.fact_type, scores: result.scores });
            sourceMap.set(id, { sources: [source], text: source.candidate.text, score_source, observation_id: observationId });
        };

        for (const result of response?.results ?? []) {
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
            const association = await resolver.observationIds(result, { signal, epoch, truncated: response.source_facts_truncated === true });
            check();
            const allowed = [];
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
            let used = null;
            const relevant = Number.isFinite(result.scores?.semantic) && result.scores.semantic >= 0.35;
            if (complete && verifyObservations && relevant) {
                let proof;
                try { proof = await processor.verifyObservation({ agent, purpose,
                    observation: { id: result.id, text: result.text },
                    sources: allowed.map(source => ({ id: source.raw.id,
                        actor: source.candidate.origin === 'action' ? 'action' : source.candidate.origin === 'inference' ? 'assistant' : 'user',
                        kind: source.candidate.origin === 'action' ? 'verified_action' : 'approved_snapshot',
                        at: source.candidate.formed_at, text: source.candidate.text })),
                    source_policies: allowed.map(source => ({ source_id: source.raw.id, candidate_id: source.candidate.candidate_id,
                        origin: source.candidate.origin, formed_at: source.candidate.formed_at, content_kind: source.candidate.content_kind,
                        valid_from: source.candidate.valid_from, valid_until: source.candidate.valid_until,
                        occurred_start: source.candidate.occurred_start, occurred_end: source.candidate.occurred_end,
                        occurrence: source.candidate.occurrence, lifecycle: source.lifecycle.status })),
                }, { signal }); }
                catch { proof = null; }
                check();
                const known = new Set(allowed.map(source => source.raw.id));
                if (proof?.safe === true && Array.isArray(proof.used_source_ids) && proof.used_source_ids.length > 0
                    && proof.used_source_ids.every(id => known.has(id))) {
                    used = allowed.filter(source => proof.used_source_ids.includes(source.raw.id));
                }
            }
            if (used) {
                results.set(result.id, result);
                // All sources retain policy/trust constraints, even if the verifier cites a subset.
                sourceMap.set(result.id, { sources: allowed, text: result.text, score_source: 'observation', observation_id: result.id });
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
            const live = [];
            for (const source of entry.sources) {
                const resolved = await resolver.resolve(source.raw.id, { purpose, signal, epoch });
                check();
                if (resolved.source) live.push(resolved.source);
                else excluded.push({ id: source.raw.id, observation_id: entry.observation_id ?? null, code: resolved.code });
            }
            if (verifiedObservations.has(id)) {
                const association = await resolver.observationIds(results.get(id), { signal, epoch, truncated: response.source_facts_truncated === true });
                check();
                const original = new Set(entry.sources.map(source => source.raw.id));
                if (live.length !== entry.sources.length || !association.complete
                    || association.ids.length !== original.size || association.ids.some(rawId => !original.has(rawId))) {
                    sourceMap.delete(id);
                    results.delete(id);
                    verifiedObservations.delete(id);
                    excluded.push({ id, code: 'observation_source_changed' });
                    for (const source of live) addSnapshot(source, { scores: response.results.find(result => result.id === id)?.scores }, id);
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
        const sources = picked.map(item => ({ id: `memory:${item.id}`, actor: 'context', kind: 'context',
            at: item.candidates[0].formed_at, text: renderRecall([item]) }));
        return { picked, excluded, sources, text: renderRecall(picked), audit_id, code: null };
    }

    return {
        recall: input => project(input, true),
        // Nested verification cannot recursively invoke more observation model calls.
        readMemory: input => project(input, false),
    };
}
