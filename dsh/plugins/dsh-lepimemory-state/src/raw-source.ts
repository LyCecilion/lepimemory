import { createHash } from 'node:crypto';
import type { Candidate } from './shared/domain.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  return value;
}

/** Semantic version: curation state/timestamps and retrieval scores are not source content. */
export function rawVersion(raw: Record<string, unknown>): string {
  const version = Object.fromEntries(
    [
      'id',
      'document_id',
      'text',
      'metadata',
      'fact_type',
      'date',
      'mentioned_at',
      'occurred_start',
      'occurred_end',
    ].map((key) => [key, raw[key] ?? null]),
  );
  return createHash('sha256')
    .update(JSON.stringify(canonical(version)))
    .digest('hex');
}

/** 只读证据的最小结构面：本模块仅按列名读取快照、生命周期与远端条目。 */
interface StatementLike {
  get(...params: unknown[]): unknown;
}
interface StoreLike {
  db: { prepare(sql: string): StatementLike };
}

/** 已核准的不可变快照 + 其当前生命周期行（`loadSource` 产物）。 */
export interface SourceSnapshot {
  candidate: Candidate;
  lifecycle: Record<string, unknown>;
  payloadHash: string;
  documentId: string;
}

/** 远端保留了来源正文的文档（只读其核对字段）。 */
interface RetainDocument {
  id?: unknown;
  bank_id?: unknown;
  original_text?: unknown;
  document_metadata?: { candidate_id?: unknown; payload_hash?: unknown } | null;
}

/** 远端条目（raw）的核对字段。 */
interface RawItem {
  id?: unknown;
  fact_type?: unknown;
  state?: unknown;
  text?: unknown;
  document_id?: unknown;
  metadata?: { candidate_id?: unknown; payload_hash?: unknown } | null;
}

/** Load only an immutable approved snapshot, never a draft or an original session log. */
export function loadSource(store: StoreLike, candidateId: string | null): SourceSnapshot | null {
  const row = store.db
    .prepare(
      `SELECT s.json,s.payload_hash,l.* FROM snapshots s JOIN lifecycle l USING(candidate_id) WHERE candidate_id=?`,
    )
    .get(candidateId) as
    | (Record<string, unknown> & { json: string; payload_hash: string })
    | undefined;
  if (!row) return null;
  const candidate = JSON.parse(row.json) as Candidate;
  if (
    candidate.candidate_id !== candidateId ||
    createHash('sha256').update(row.json).digest('hex') !== row.payload_hash
  )
    throw Object.assign(new Error('LEPI_SNAPSHOT_INVALID'), { code: 'LEPI_SNAPSHOT_INVALID' });
  return {
    candidate,
    lifecycle: row,
    payloadHash: row.payload_hash,
    documentId: `lepi-${candidateId}`,
  };
}

export function documentMatches(
  document: RetainDocument | null | undefined,
  source: SourceSnapshot | null | undefined,
  bank: string,
): boolean {
  return Boolean(
    document &&
      source &&
      document.id === source.documentId &&
      document.bank_id === bank &&
      document.original_text === source.candidate.text &&
      document.document_metadata?.candidate_id === source.candidate.candidate_id &&
      document.document_metadata?.payload_hash === source.payloadHash,
  );
}

export function rawMatches(
  raw: RawItem | null | undefined,
  source: SourceSnapshot | null | undefined,
  state = 'valid',
): boolean {
  return Boolean(
    raw &&
      source &&
      typeof raw.id === 'string' &&
      raw.id &&
      ['world', 'experience'].includes(raw.fact_type as string) &&
      raw.state === state &&
      typeof raw.text === 'string' &&
      /\S/u.test(raw.text) &&
      raw.document_id === source.documentId &&
      raw.metadata?.candidate_id === source.candidate.candidate_id &&
      raw.metadata?.payload_hash === source.payloadHash,
  );
}

export function retainItem(source: SourceSnapshot) {
  const candidate = source.candidate;
  return {
    content: candidate.text,
    timestamp: candidate.formed_at,
    document_id: source.documentId,
    metadata: {
      candidate_id: candidate.candidate_id,
      payload_hash: source.payloadHash,
      content_kind: candidate.content_kind,
      origin: candidate.origin,
      formed_at: candidate.formed_at,
      valid_from: candidate.valid_from ?? '',
      valid_until: candidate.valid_until ?? '',
      trust:
        candidate.origin === 'user'
          ? 'fact'
          : candidate.origin === 'action'
            ? 'experience'
            : 'inference',
    },
    context: `Subject: ${candidate.subject_key}; source: ${candidate.origin}; facet: ${candidate.facet_key}`,
    tags: ['lepimemory:v2'],
    update_mode: 'replace',
  };
}
