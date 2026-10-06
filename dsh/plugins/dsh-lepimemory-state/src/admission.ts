/**
 * Per-candidate value admission, independent of authorization and source policy.
 * Explicit requests bypass value only. The configured backend never changes implicitly.
 * Laya uses its own service token and reports actual noul scores, not calibrated confidence;
 * missing clipping evidence or unavailable backends defer, and clipped input cannot be accepted.
 * Generative admission uses the fixed processor route and never invents a probability.
 * Construction and cached health perform no work; only evaluate calls a backend.
 */

import {
  CONTENT_KINDS,
  ORIGINS,
  OCCURRENCES,
  CANDIDATE_TEXT_MAX,
  validateResult,
} from './contracts.js';
import { ErrorCodes } from './config.js';
import type { LepiConfig, ThresholdPair } from './config.js';
import type { Store } from './store.js';
import type {
  AdmissionReasonCode,
  AdmissionVerdict,
  ContentKind,
  Occurrence,
  Origin,
} from './shared/domain.js';

// ── laya 0.3.26 锁定值（deploy/laya/server.py：Router models + revisions）。──────
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
 * laya 的 `should_store` noul 指令（只描述长期价值，不含授权）。
 */
const INSTRUCTIONS =
  '这条候选是否值得在以记忆为核心的长期陪伴角色中保存？保留稳定事实、偏好、明确约定及重要关系或经历；' +
  '普通寒暄、无实质内容和仅对当前回复有用的噪声不保存。已过期安排不作为当前安排；需要有独立历史价值。';

/** 需要更严格阈值的类型（其余按 durable 档）。 */
const TRANSIENT_KINDS = new Set<string>(['temporary_state', 'other']);

/** 候选正文/时间/来源的本地校验失败（调用方契约问题，不是后端故障）。 */
export class AdmissionError extends Error {
  readonly code: string;
  readonly field: string | null;
  constructor(code: string, field: string | null = null) {
    super(`${code}${field ? ` [${field}]` : ''}`);
    this.name = 'AdmissionError';
    this.code = code;
    this.field = field;
  }
}

function configInvalid(field: string): never {
  throw new AdmissionError(ErrorCodes.CONFIG_INVALID, field);
}

function invalidCandidate(field: string): never {
  throw new AdmissionError(ErrorCodes.CONFIG_INVALID, field);
}

/** 校验一组阈值：两端均为 [0,1] 有限数，且 reject < accept。 */
function thresholdPair(
  value: ThresholdPair | undefined,
  field: string,
): { readonly accept: number; readonly reject: number } {
  const accept = value?.accept;
  const reject = value?.reject;
  if (
    typeof accept !== 'number' ||
    !Number.isFinite(accept) ||
    typeof reject !== 'number' ||
    !Number.isFinite(reject)
  )
    configInvalid(field);
  if (accept < 0 || accept > 1 || reject < 0 || reject > 1) configInvalid(field);
  if (!(reject < accept)) configInvalid(field);
  return Object.freeze({ accept, reject });
}

const ISO = (value: unknown): string | null =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;

/** 规整后的候选（只信任代码绑定字段）。 */
interface NormalizedCandidate {
  text: string;
  content_kind: ContentKind;
  origin: Origin | null;
  occurrence: Occurrence | null;
  subject_key: string | null;
  facet_key: string | null;
  formed_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  occurred_start: string | null;
  occurred_end: string | null;
  explicit: boolean;
  source_ids: readonly string[];
}
/** candidate 的边界形状，逐字段校验后才成为 NormalizedCandidate。 */
interface CandidateWire {
  text?: unknown;
  content_kind?: unknown;
  origin?: unknown;
  occurrence?: unknown;
  subject_key?: unknown;
  facet_key?: unknown;
  formed_at?: unknown;
  valid_from?: unknown;
  valid_until?: unknown;
  occurred_start?: unknown;
  occurred_end?: unknown;
  explicit?: unknown;
  source_ids?: unknown;
}
interface RelatedRow {
  id?: unknown;
  json?: unknown;
  created_at?: unknown;
  grant_id?: unknown;
}
interface RelatedSnapshotView {
  id: string;
  text: string;
  at: string;
  content_kind: ContentKind | null;
  subject_key: string | null;
  facet_key: string | null;
}
/** laya `/v1/systemone` 响应的边界形状。 */
interface LayaAnswer {
  type?: unknown;
  noul?: unknown;
}
interface LayaUsage {
  truncated?: unknown;
  state_tokens_dropped?: unknown;
  truncated_questions?: unknown;
  options?: unknown;
}
interface LayaPayload {
  answers?: { should_store?: unknown };
  usage?: unknown;
}
/** processor 的最小结构面：仅需 generative 准入。 */
interface ProcessorLike {
  evaluateAdmission(input: unknown, options?: { signal?: AbortSignal }): unknown;
}
/** 已解析的准入结论（无正文）。 */
interface AdmissionDecision {
  verdict: AdmissionVerdict | undefined;
  score: number | null;
  reason_code: AdmissionReasonCode | undefined;
  backend: 'laya' | 'generative';
  model: string | null;
  revision: string | null;
  truncated: boolean;
}

/** 规整候选：只信任代码绑定的字段，把非法/缺字段的候选挡在模块边界。 */
function normalizeCandidate(candidate: unknown): NormalizedCandidate {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    invalidCandidate('candidate');
  // Boundary read of the model-derived candidate; every field is validated next.
  const wire = candidate as CandidateWire;
  const text = wire.text;
  if (typeof text !== 'string' || text.length === 0 || text.length > CANDIDATE_TEXT_MAX)
    invalidCandidate('text');
  if (typeof wire.content_kind !== 'string' || !CONTENT_KINDS.includes(wire.content_kind))
    invalidCandidate('content_kind');
  const sourceIds = wire.source_ids;
  if (
    !Array.isArray(sourceIds) ||
    sourceIds.length === 0 ||
    sourceIds.some((id) => typeof id !== 'string' || id.length === 0)
  )
    invalidCandidate('source_ids');
  return Object.freeze({
    text,
    content_kind: wire.content_kind as ContentKind,
    origin: (typeof wire.origin === 'string' && ORIGINS.includes(wire.origin)
      ? wire.origin
      : null) as Origin | null,
    occurrence: (typeof wire.occurrence === 'string' && OCCURRENCES.includes(wire.occurrence)
      ? wire.occurrence
      : null) as Occurrence | null,
    subject_key: typeof wire.subject_key === 'string' && wire.subject_key ? wire.subject_key : null,
    facet_key: typeof wire.facet_key === 'string' && wire.facet_key ? wire.facet_key : null,
    formed_at: ISO(wire.formed_at),
    valid_from: ISO(wire.valid_from),
    valid_until: ISO(wire.valid_until),
    occurred_start: ISO(wire.occurred_start),
    occurred_end: ISO(wire.occurred_end),
    explicit: wire.explicit === true,
    source_ids: Object.freeze([...(sourceIds as string[])]),
  });
}

/** 送给后端做价值判断的候选投影：正文原样（保留否定/日期/条件），附类型/主体/时间限定。 */
function candidateView(candidate: NormalizedCandidate) {
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

function safeParse(text: unknown): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text as string);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 仅取真实存在、可追溯到候选的正文，避免把未知形状的 blob 当上下文。 */
function snapshotView(row: RelatedRow, now: number): RelatedSnapshotView | null {
  const snap = safeParse(row.json);
  if (!snap) return null;
  const text = typeof snap.text === 'string' && snap.text.length > 0 ? snap.text : null;
  if (!text) return null;
  if (
    typeof snap.valid_until === 'string' &&
    Number.isFinite(Date.parse(snap.valid_until)) &&
    Date.parse(snap.valid_until) < now
  )
    return null;
  const at = Number.isFinite(row.created_at)
    ? new Date(row.created_at as number).toISOString()
    : null;
  if (!at) return null;
  return {
    id: row.id as string,
    text,
    at,
    content_kind:
      typeof snap.content_kind === 'string' && CONTENT_KINDS.includes(snap.content_kind)
        ? (snap.content_kind as ContentKind)
        : null,
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
function relatedContext(store: Store, candidate: NormalizedCandidate): RelatedSnapshotView[] {
  if (!candidate.subject_key) return [];
  let rows: RelatedRow[];
  try {
    rows = store.db
      .prepare(
        `
            SELECT s.candidate_id AS id, s.json AS json, s.created_at AS created_at, l.grant_id AS grant_id
            FROM snapshots s JOIN lifecycle l ON l.candidate_id = s.candidate_id
            WHERE l.status = 'active'
            ORDER BY s.created_at DESC LIMIT ?`,
      )
      .all(RELATED_SCAN) as RelatedRow[];
  } catch {
    return [];
  }
  const now = store.now();
  const forgotten = new Set<string>();
  try {
    for (const scope of store.db
      .prepare('SELECT candidate_ids_json FROM forget_scopes WHERE active = 1')
      .all() as Array<{ candidate_ids_json?: unknown }>) {
      let ids: unknown;
      try {
        ids = JSON.parse(scope.candidate_ids_json as string);
      } catch {
        ids = null;
      }
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') forgotten.add(id);
    }
  } catch {
    return [];
  }
  const grants = new Map<string, { expires_at?: unknown; revoked_at?: unknown }>();
  try {
    for (const grant of store.db
      .prepare('SELECT id, expires_at, revoked_at FROM grants')
      .all() as Array<{ id?: unknown; expires_at?: unknown; revoked_at?: unknown }>) {
      grants.set(grant.id as string, grant);
    }
  } catch {
    return [];
  }
  const picked: RelatedSnapshotView[] = [];
  for (const row of rows) {
    if (picked.length >= MAX_RELATED) break;
    if (typeof row.id !== 'string' || forgotten.has(row.id)) continue;
    if (row.grant_id) {
      const grant = grants.get(row.grant_id as string);
      if (!grant || grant.revoked_at != null) continue;
      if (Number.isFinite(grant.expires_at) && (grant.expires_at as number) < now) continue;
    }
    const view = snapshotView(row, now);
    if (!view || view.subject_key !== candidate.subject_key) continue;
    picked.push(view);
  }
  return picked;
}

/** laya usage 的裁剪事实：`truncated` / `state_tokens_dropped` / `truncated_questions` / 选项坍缩。 */
function detectTruncation(usage: unknown): boolean {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false;
  const u = usage as LayaUsage;
  if (u.truncated === true) return true;
  if (typeof u.truncated === 'number' && u.truncated > 0) return true;
  if (
    typeof u.state_tokens_dropped === 'number' &&
    Number.isFinite(u.state_tokens_dropped) &&
    u.state_tokens_dropped > 0
  )
    return true;
  if (Array.isArray(u.truncated_questions) && u.truncated_questions.length > 0) return true;
  if (u.options && typeof u.options === 'object' && !Array.isArray(u.options)) return true;
  return false;
}

function combine(signal: AbortSignal | undefined, deadlineMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(deadlineMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

/**
 * 构造准入器。构造器只读 config 并校验；**不建连接、不发请求、不起 timer**。
 *
 * @param deps.config 已解析配置（`resolveConfig` 输出）。
 * @param deps.processor 处理器（需提供 `evaluateAdmission`，供 generative 后端）。
 * @param deps.store `openStore` 的 Store（只读查询相关 snapshot；本模块从不写入）。
 */
export function createAdmission({
  config,
  processor,
  store,
}: { config?: LepiConfig; processor?: ProcessorLike; store?: Store } = {}) {
  const backend = config?.admissionBackend;
  if (backend !== 'laya' && backend !== 'generative') configInvalid('admissionBackend');
  if (!store || typeof store.now !== 'function' || !store.db) configInvalid('store');
  const liveStore = store;

  const thresholds = {
    durable: thresholdPair(config?.layaThresholds?.durable, 'LEPI_LAYA_ACCEPT_DURABLE'),
    transient: thresholdPair(config?.layaThresholds?.transient, 'LEPI_LAYA_ACCEPT_TRANSIENT'),
  };

  let layaUrl: string | null = null;
  let layaApiKey = '';
  if (backend === 'laya') {
    const layaService = config?.services?.laya;
    layaUrl = config?.services?.laya?.url ?? null;
    layaApiKey = layaService && typeof layaService.apiKey === 'string' ? layaService.apiKey : '';
    if (typeof layaUrl !== 'string' || layaUrl === '') configInvalid('LEPI_LAYA_URL');
  }

  const processModel = config?.llm?.process?.model;
  if (backend === 'generative' && (typeof processModel !== 'string' || processModel === ''))
    configInvalid('LEPI_PROCESS_MODEL');
  if (backend === 'generative' && typeof processor?.evaluateAdmission !== 'function')
    configInvalid('processor');

  const rawTimeout = config?.limits?.processTimeoutMs;
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isSafeInteger(rawTimeout) && rawTimeout > 0
      ? rawTimeout
      : 30000;

  const identity = Object.freeze(
    backend === 'laya'
      ? { backend, model: LAYA_MODEL, revision: LAYA_REVISION }
      : { backend, model: processModel ?? null, revision: null },
  );

  // 只记录安全元数据：不含 endpoint / key / 候选或记忆正文。
  let observed: Readonly<{ available: boolean | null; truncated: boolean | null }> = Object.freeze({
    available: null,
    truncated: null,
  });

  const result = (
    verdict: AdmissionVerdict | undefined,
    reason_code: AdmissionReasonCode | undefined,
    { score = null, truncated = false }: { score?: number | null; truncated?: boolean } = {},
  ): AdmissionDecision =>
    Object.freeze({
      verdict,
      score,
      reason_code,
      backend: identity.backend,
      model: identity.model,
      revision: identity.revision,
      truncated,
    });

  async function evaluateLaya(
    candidate: NormalizedCandidate,
    signal: AbortSignal | undefined,
  ): Promise<AdmissionDecision> {
    const tier = TRANSIENT_KINDS.has(candidate.content_kind)
      ? thresholds.transient
      : thresholds.durable;

    let related: RelatedSnapshotView[];
    try {
      related = relatedContext(liveStore, candidate);
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

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (layaApiKey) headers.authorization = `Bearer ${layaApiKey}`;

    let response: Response;
    try {
      response = await fetch(`${layaUrl}/v1/systemone`, {
        method: 'POST',
        headers,
        body: serialized,
        signal: combine(signal, timeoutMs),
      });
    } catch {
      observed = Object.freeze({ available: false, truncated: null });
      return result('defer', 'backend_unavailable');
    }
    if (!response.ok) {
      observed = Object.freeze({ available: false, truncated: null });
      return result('defer', response.status === 413 ? 'input_truncated' : 'backend_unavailable', {
        truncated: response.status === 413,
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      observed = Object.freeze({ available: false, truncated: null });
      return result('defer', 'backend_unavailable');
    }

    const data = payload && typeof payload === 'object' ? (payload as LayaPayload) : null;
    const answer = (data?.answers?.should_store ?? null) as LayaAnswer | null;
    const usage = (data?.usage ?? null) as LayaUsage | null;
    const noul = answer?.noul;
    if (
      !answer ||
      answer.type !== 'noul' ||
      typeof usage?.truncated !== 'boolean' ||
      typeof noul !== 'number' ||
      !Number.isFinite(noul) ||
      noul < 0 ||
      noul > 1
    ) {
      observed = Object.freeze({ available: false, truncated: null });
      return result('defer', 'backend_unavailable');
    }

    const truncated = detectTruncation(data?.usage);
    observed = Object.freeze({ available: true, truncated });
    if (truncated) return result('defer', 'input_truncated', { truncated: true });

    const score = noul;
    if (score >= tier.accept) return result('accept', 'value_accept', { score });
    if (score <= tier.reject) return result('reject', 'value_reject', { score });
    return result('defer', 'value_uncertain', { score });
  }

  async function evaluateGenerative(
    candidate: NormalizedCandidate,
    { signal, agent }: { signal?: AbortSignal; agent?: unknown } = {},
  ): Promise<AdmissionDecision> {
    let related: RelatedSnapshotView[];
    try {
      related = relatedContext(liveStore, candidate);
    } catch {
      related = [];
    }
    // Construction validated this backend has an evaluator; only generative reaches here.
    const evaluator = processor as ProcessorLike;
    let verdictValue: unknown;
    try {
      verdictValue = await evaluator.evaluateAdmission(
        {
          candidate: candidateView(candidate),
          source_ids: [...candidate.source_ids],
          context_sources: related.map((item) => ({ ...item, actor: 'context', kind: 'context' })),
          agent,
        },
        { signal },
      );
      validateResult('admission', verdictValue);
    } catch {
      observed = Object.freeze({ available: false, truncated: null });
      return result('defer', 'backend_unavailable');
    }
    const decided = verdictValue as
      | { verdict?: AdmissionVerdict; reason_code?: AdmissionReasonCode }
      | null
      | undefined;
    const verdict = decided?.verdict;
    const reason = decided?.reason_code;
    observed = Object.freeze({ available: true, truncated: false });
    return result(verdict, reason);
  }

  async function evaluate(
    candidate: unknown,
    { signal, agent }: { signal?: AbortSignal; agent?: unknown } = {},
  ): Promise<AdmissionDecision> {
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
