/**
 * 记忆协调模块图的纯共享叶子：无状态、无 SQL、无副作用，仅类型、常量与纯函数。
 * 被 authorization / pipeline / supervisor / facade 复用，本身不 import 这些模块。
 */
import type { StatementSync } from 'node:sqlite';
import { parseJson } from './json.js';
import type { TaskRowRecord } from './store.js';

/** node:sqlite 边界：绑定参数与「按调用处已知行形状读取」的断言出口。 */
export type SqlParam = string | number | bigint | null;
/** `get()` 返回 `Record<string, SQLOutputValue>`；调用处已读 SQL 行形状，故集中断言。 */
export function firstRow<T>(stmt: StatementSync, ...params: SqlParam[]): T | undefined {
  return stmt.get(...params) as unknown as T | undefined;
}
/** `all()` 同 {@link firstRow}，用于已知行形状的集合读取。 */
export function allRows<T>(stmt: StatementSync, ...params: SqlParam[]): T[] {
  return stmt.all(...params) as unknown as T[];
}

/** 有界网络退避（毫秒）：最多三次重试 1s/2s/4s，仍失败才 deferred。 */
export const BACKOFF = [1000, 2000, 4000] as const;

export const GENERIC_CODE = 'LEPI_CONTROL_UNAVAILABLE';
export const RESUBMIT_CODE = 'LEPI_INPUT_RESUBMIT_REQUIRED';

/** 任务审计身份（缺省字段入库为 NULL）。 */
export interface AuditIdentity {
  session_id?: string | null;
  turn?: number | null;
  step?: number | null;
  request_id?: string | null;
  task_id?: string | null;
  candidate_id?: string | null;
  operation_id?: string | null;
}
/** facade 审计包装器的调用面。 */
export type AuditFn = (
  type: string,
  status: string,
  identity?: AuditIdentity,
  data?: Record<string, unknown>,
) => void;
/** 各 owner 共享的错误码落点（由 facade 闭包提供）。 */
export type SetErrorFn = (code: string | null) => void;

/** candidate 在本模块图内消费的结构面（处理器绑定 + 系统赋值身份）。 */
export interface MemoryCandidate {
  candidate_id: string;
  request_id: string | null;
  formed_at: string;
  explicit: boolean;
  text: string;
  content_kind: string;
  origin: string;
  sensitivity: string;
  subject_key: string;
  facet_key: string;
  source_ids: string[];
  valid_from: string | null;
  valid_until: string | null;
  occurred_start: string | null;
  occurred_end: string | null;
  occurrence: string;
}
/** 一次 normalize/admit 的政策作用域（authorizeAndCommit 会推进 epoch）。 */
export interface Scope {
  agent: MemoryAgent;
  signal: AbortSignal | undefined;
  sessionId: string;
  explicit: boolean;
  requestId: string | null;
  requestKind: string | null;
  turn: number | null;
  epoch: number;
  fence: number;
}
/** 会话/事件的最小读取面（真实 Session/evidence ID）。 */
export interface MemoryAgent {
  id: string;
}
export interface MemoryContext {
  agents?: { get(id: string): MemoryAgent | undefined; roots?(): MemoryAgent[] };
}
export type Outcome = 'approved' | 'rejected' | 'cancelled' | 'suppressed' | 'failed' | 'deferred';

/** `extract` 的输入面：处理器只按已读字段取用；`request_id` 允许显式 null（同原调用）。 */
export interface ExtractInput {
  agent?: unknown;
  source_ids?: readonly string[];
  explicit?: boolean;
  request_id?: string | null;
  [key: string]: unknown;
}
/** admission.evaluate 的返回值面（只读这些判定/元数据字段）。 */
export interface AdmissionResult {
  verdict?: string;
  reason_code?: string;
  score?: number | null;
  backend?: string;
  model?: string | null;
  revision?: string | null;
  truncated?: boolean;
}
/** 已构造 processor 的消费面（extract / matchGrant）。 */
export interface MemoryProcessor {
  extract(
    input: ExtractInput,
    options?: { signal?: AbortSignal },
  ): Promise<{ candidates: MemoryCandidate[] }>;
  matchGrant(
    candidate: unknown,
    grant: unknown,
    options?: {
      purpose?: string;
      agent?: unknown;
      sources?: readonly unknown[];
      signal?: AbortSignal;
    },
  ): Promise<object | null>;
}
/** 已构造 admission 的消费面（evaluate / health）。 */
export interface MemoryAdmission {
  evaluate(
    candidate: unknown,
    options?: { signal?: AbortSignal; agent?: unknown },
  ): Promise<AdmissionResult>;
  health?(): Record<string, unknown>;
}
/** pipeline 作业级 hooks；由 supervisor 每次调用注入，pipeline 不引用 supervisor。 */
export interface TaskHooks {
  finish(
    task: TaskRowRecord,
    status: string,
    code?: string | null,
    options?: { clearDraft?: boolean },
  ): void;
  scheduleRetry(task: TaskRowRecord, code?: string): void;
  patchPayload(task: TaskRowRecord, patch: Record<string, unknown>): Record<string, unknown>;
  wake(): void;
}

/** 稳定错误码读取（第三方/自有错误都可能带 code）。 */
export function errorCodeOf(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
    return error.code;
  return null;
}

/** 任务审计身份：从 payload 读取真实 session/request/turn，缺省为 NULL。 */
export function identityOf(task: TaskRowRecord): AuditIdentity {
  const payload = parseJson<Record<string, unknown>>(task.payload_json, {});
  return {
    session_id: (payload.session_id as string | undefined) ?? null,
    request_id: task.request_id ?? (payload.request_id as string | undefined) ?? null,
    candidate_id: task.candidate_id ?? null,
    turn: (payload.turn as number | undefined) ?? null,
  };
}
