import { createHash } from 'node:crypto';

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}

/** Semantic version: curation state/timestamps and retrieval scores are not source content. */
export function rawVersion(raw) {
    const version = Object.fromEntries(['id', 'document_id', 'text', 'metadata', 'fact_type', 'date', 'mentioned_at', 'occurred_start', 'occurred_end']
        .map(key => [key, raw[key] ?? null]));
    return createHash('sha256').update(JSON.stringify(canonical(version))).digest('hex');
}

/** Load only an immutable approved snapshot, never a draft or an original session log. */
export function loadSource(store, candidateId) {
    const row = store.db.prepare(`SELECT s.json,s.payload_hash,l.* FROM snapshots s JOIN lifecycle l USING(candidate_id) WHERE candidate_id=?`).get(candidateId);
    if (!row) return null;
    const candidate = JSON.parse(row.json);
    if (candidate.candidate_id !== candidateId || createHash('sha256').update(row.json).digest('hex') !== row.payload_hash)
        throw Object.assign(new Error('LEPI_SNAPSHOT_INVALID'), { code: 'LEPI_SNAPSHOT_INVALID' });
    return { candidate, lifecycle: row, payloadHash: row.payload_hash, documentId: `lepi-${candidateId}` };
}

export function documentMatches(document, source, bank) {
    return Boolean(document && source && document.id === source.documentId && document.bank_id === bank
        && document.original_text === source.candidate.text
        && document.document_metadata?.candidate_id === source.candidate.candidate_id
        && document.document_metadata?.payload_hash === source.payloadHash);
}

export function rawMatches(raw, source, state = 'valid') {
    return Boolean(raw && source && typeof raw.id === 'string' && raw.id
        && ['world', 'experience'].includes(raw.fact_type) && raw.state === state
        && typeof raw.text === 'string' && /\S/u.test(raw.text)
        && raw.document_id === source.documentId && raw.metadata?.candidate_id === source.candidate.candidate_id
        && raw.metadata?.payload_hash === source.payloadHash);
}

export function retainItem(source) {
    const candidate = source.candidate;
    return {
        content: candidate.text, timestamp: candidate.formed_at, document_id: source.documentId,
        metadata: {
            candidate_id: candidate.candidate_id, payload_hash: source.payloadHash,
            content_kind: candidate.content_kind, origin: candidate.origin, formed_at: candidate.formed_at,
            valid_from: candidate.valid_from ?? '', valid_until: candidate.valid_until ?? '',
            trust: candidate.origin === 'user' ? 'fact' : candidate.origin === 'action' ? 'experience' : 'inference',
        },
        context: `Subject: ${candidate.subject_key}; source: ${candidate.origin}; facet: ${candidate.facet_key}`,
        tags: ['lepimemory:v2'], update_mode: 'replace',
    };
}
