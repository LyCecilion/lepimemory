/**
 * 记忆的信任档、衰减与「现行政策投影」共享契约（PLAN 第 8 步）。
 *
 * 信任档只从**已关联快照的候选**推导（`candidate.origin` / `candidate.formed_at`），
 * 绝不再用远端 metadata 或 observation 兜底成 fact：
 *   - `user`      → `fact`        用户明说的事实（不衰减）。
 *   - `action`    → `experience`  经 journal 核实的行动（不衰减）。
 *   - `inference` → `inference`   角色自己的推断（半衰期衰减）。
 *   - 其余/缺失   → `unknown`     不能归因，绝不升级为事实。
 *
 * `candidateExclusion` 是同步、体外的**生命周期/隐私/时效**预检：只读当前 store 的
 * lifecycle（不信任 compound 里的旧副本），在远端取回之前与之后都复用同一判定。
 */
import type { Candidate, RecallPurpose, Trust } from './shared/domain.js';

/** 四个信任档。写入用，读回用；`unknown` 表示不能归因。 */
export const TRUST = Object.freeze({
  FACT: 'fact',
  EXPERIENCE: 'experience',
  INFERENCE: 'inference',
  UNKNOWN: 'unknown',
} as const);

/** 推断档的半衰期：14 天。比心境（6h）慢得多，但足以让旧推断自然退场。 */
export const INFERENCE_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

/** current 用途只认 active；history 用途额外承认 history_only / superseded 的旧事实。 */
const CURRENT_STATUSES: readonly string[] = Object.freeze(['active']);
const HISTORY_STATUSES: readonly string[] = Object.freeze(['active', 'history_only', 'superseded']);

/**
 * 解析一条 recall 结果的信任档：只接受**已关联快照的候选**的 origin。
 * 缺失/未知 origin → `unknown`；绝不回落到 `metadata.trust`、`type` 或 observation。
 */
export function trustOf(_result: unknown, candidate: Candidate | null | undefined): Trust {
  if (!Number.isFinite(Date.parse(candidate?.formed_at ?? ''))) return TRUST.UNKNOWN;
  const origin = candidate?.origin;
  if (origin === 'user') return TRUST.FACT;
  if (origin === 'action') return TRUST.EXPERIENCE;
  if (origin === 'inference') return TRUST.INFERENCE;
  return TRUST.UNKNOWN;
}

/**
 * 衰减系数 ∈ (0,1]：**仅推断档**按形成时间 `formed_at` 做半衰期衰减。
 * 缺可解析时间戳 → 1（不衰减，宁可保留不误杀）。
 */
export function decayFactor(
  trust: Trust,
  formedAt: string | null | undefined,
  nowMs: number,
): number {
  if (trust !== TRUST.INFERENCE) return 1;
  const t = typeof formedAt === 'string' ? Date.parse(formedAt) : Number.NaN;
  if (!Number.isFinite(t)) return 1;
  const ageMs = Math.max(0, nowMs - t);
  return Math.pow(0.5, ageMs / INFERENCE_HALF_LIFE_MS);
}

/**
 * 一条结果的档位 + 衰减后有效分（纯函数，好测）。形成时间取自候选 `formed_at`。
 */
export function scoreOf(
  result: { scores?: { semantic?: unknown } } | null | undefined,
  { candidate, nowMs = Date.now() }: { candidate?: Candidate | null; nowMs?: number } = {},
): { trust: Trust; semantic: number; factor: number; effective: number } {
  const trust = trustOf(result, candidate);
  const raw = result?.scores?.semantic;
  const semantic = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  const factor = decayFactor(trust, candidate?.formed_at, nowMs);
  return { trust, semantic, factor, effective: semantic * factor };
}

/** SQLite 行/语句的最小结构面：本模块只按列名读取生命周期、授权与遗忘范围。 */
interface StatementLike {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface StoreLike {
  db: { prepare(sql: string): StatementLike };
}

interface LifecycleRow {
  status: string;
  grant_id: string | null;
}
interface GrantRow {
  scope_json: string;
  source_ids_json: string;
  allow_inference: number;
}
interface ForgetScopeRow {
  candidate_ids_json: string;
}
interface ParsedScope {
  kind: string;
  candidate_id?: string;
  session_id?: string | null;
}

/**
 * 同步、无正文的生命周期/隐私/时效预检。
 *
 * 只读**当前** store：compounded `source.lifecycle` 视为陈旧，一律重查。
 *
 * @param source 已关联快照的候选来源。
 * @param store `openStore` 产物（使用其 `db`）。
 * @param purpose current / history 用途。
 * @param nowMs 当前时钟。
 * @returns null=允许；否则稳定的、无正文的 code。
 */
export function candidateExclusion(
  source: { candidate?: Candidate } | null | undefined,
  store: StoreLike,
  purpose: RecallPurpose = 'current',
  nowMs: number = Date.now(),
): string | null {
  const candidate = source?.candidate;
  if (
    !candidate ||
    typeof candidate.candidate_id !== 'string' ||
    candidate.candidate_id.length === 0
  ) {
    return 'LEPI_SNAPSHOT_INVALID';
  }
  const candidateId = candidate.candidate_id;
  // credentials/government_id/exact_address/payment 等 excluded 永不外泄。
  if (candidate.sensitivity === 'excluded') return 'LEPI_MEMORY_SUPPRESSED';

  const lifecycle = store.db
    .prepare('SELECT status,grant_id FROM lifecycle WHERE candidate_id=?')
    .get(candidateId) as LifecycleRow | undefined;
  if (!lifecycle) return 'LEPI_SOURCE_UNKNOWN';
  const statuses = purpose === 'history' ? HISTORY_STATUSES : CURRENT_STATUSES;
  if (!statuses.includes(lifecycle.status)) return 'LEPI_MEMORY_SUPPRESSED';

  // 当前适用的时间窗：未来才生效、或已过期，都不作 current 材料（history 不做时限）。
  if (purpose !== 'history') {
    if (typeof candidate.valid_from === 'string' && Date.parse(candidate.valid_from) > nowMs)
      return 'LEPI_MEMORY_SUPPRESSED';
    if (typeof candidate.valid_until === 'string' && Date.parse(candidate.valid_until) < nowMs)
      return 'LEPI_MEMORY_SUPPRESSED';
  }

  // private 来源必须有**当初准入时的** original grant 行绑定到该候选；grant 后来过期/撤销
  // 只阻止**新**保存，绝不追溯删除已被显式保留的 active/history 来源。
  if (candidate.sensitivity === 'private') {
    if (typeof lifecycle.grant_id !== 'string' || lifecycle.grant_id.length === 0)
      return 'LEPI_GRANT_INVALID';
    const grant = store.db.prepare('SELECT * FROM grants WHERE id=?').get(lifecycle.grant_id) as
      | GrantRow
      | undefined;
    if (!grant) return 'LEPI_GRANT_INVALID';
    let scope: ParsedScope;
    let sourceIds: unknown[];
    try {
      scope = JSON.parse(grant.scope_json) as ParsedScope;
      sourceIds = JSON.parse(grant.source_ids_json) as unknown[];
    } catch {
      return 'LEPI_GRANT_INVALID';
    }
    if (
      !['item', 'topic', 'continuous'].includes(scope.kind) ||
      (candidate.origin === 'inference' && !grant.allow_inference)
    )
      return 'LEPI_GRANT_INVALID';
    if (
      scope.kind === 'item' &&
      (scope.candidate_id !== candidateId ||
        !Array.isArray(sourceIds) ||
        sourceIds.length !== candidate.source_ids.length ||
        sourceIds.some((id, i) => id !== candidate.source_ids[i]))
    )
      return 'LEPI_GRANT_INVALID';
    const sessionId = (
      store.db
        .prepare('SELECT session_id FROM evidence WHERE id=?')
        .get(candidate.source_ids?.[0]) as { session_id?: string } | undefined
    )?.session_id;
    if (scope.session_id != null && scope.session_id !== sessionId) return 'LEPI_GRANT_INVALID';
  }

  // 直接落在 active forget scope 候选集合里的，一律排除（selector 级判定留给父级异步处理）。
  for (const row of store.db
    .prepare('SELECT candidate_ids_json FROM forget_scopes WHERE active=1')
    .all() as ForgetScopeRow[]) {
    let ids: unknown;
    try {
      ids = JSON.parse(row.candidate_ids_json);
    } catch {
      ids = null;
    }
    if (Array.isArray(ids) && ids.includes(candidateId)) return 'LEPI_MEMORY_SUPPRESSED';
  }
  return null;
}
