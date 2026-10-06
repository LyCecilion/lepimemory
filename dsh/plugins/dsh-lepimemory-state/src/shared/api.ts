/**
 * 面板 HTTP 接口的共享 DTO（host `panel.ts` 构造、浏览器消费同一份定义）。
 *
 * 只描述**线上 JSON**：`ok`/`preview`/`error` 判别字段、可空/可缺字段与数值取值域。
 * 内部运行对象（Store 行、SQLite 结果）不在此；边界先按 `unknown` 收窄后再组装。
 *
 * Browser-safe：只依赖 `./state.ts` 的纯类型，无任何 `node:` 依赖。
 */
import type { MoodState, RelationState } from './state.js';

/** 简单失败体：只带稳定错误码，不回显原始请求或异常。 */
export interface ErrorResponse {
  ok: false;
  error: string;
}

/** 公开只读 readiness：launcher 与面板共用的 bool 集合。 */
export interface HealthResponse {
  ok: true;
  /** 固定 Node + dsh peer + schema 三者一致。 */
  core: boolean;
  /** 当前进程 Node 是否为钉住版本。 */
  node: boolean;
  /** 已安装 dsh 是否等于插件 peer 版本。 */
  dsh: boolean;
  /** 库内 schema_version 是否为当前值。 */
  schema: boolean;
  /** 内存运行时已启动且未销毁（**不**声称远端 provider 健康）。 */
  serviceReady: boolean;
}

/** 渲染基调（与 `state.ts` 的 `toneOf` 一致）。 */
export type PanelTone = 'bright' | 'plain' | 'low';

/** 协调器 `health()` 的快照；形状由运行时拥有，面板只透传。 */
export type ServiceStatus = Record<string, unknown>;

/** 认证状态元数据计数（只统计行数，无正文）。 */
export interface StateCountsResponse {
  lifecycle: Record<string, number>;
  requests: Record<string, number>;
  tasks: Record<string, number>;
  grants: { total: number; active: number };
}

/**
 * `GET /lepimemory/state`：按 clock 衰减后的有效视图 + 元数据。
 * 数值域：valence ∈ [-1,1]，arousal/trust/closeness/familiarity ∈ [0,1]。
 */
export interface StateResponse {
  ok: true;
  rendered: string;
  tone: PanelTone;
  near: boolean;
  mood: MoodState;
  relation: RelationState;
  updatedAt: string;
  core: boolean;
  status: ServiceStatus | null;
  counts: StateCountsResponse;
}

/** 操作者状态 body：恰好这两个分组，且每个数值在 `NUMERIC_FIELDS` 区间内。 */
export interface OperatorStateInput {
  mood: { valence: number; arousal: number };
  relation: { trust: number; closeness: number; familiarity: number };
}

/** `POST /lepimemory/state?preview=1`：dry-run 结果，字段与提交后一致但不落库。 */
export interface StatePreviewResponse {
  ok: true;
  preview: true;
  rendered: string;
  tone: PanelTone;
  mood: MoodState;
  relation: RelationState;
}

/** 审计行 → 面板 entry（flat history 与分组 history 共用同一投影）。 */
export interface HistoryEntry {
  id: number;
  at: number;
  type: string;
  status: string;
  summary: string;
  session_id: string | null;
  turn: number | null;
  step: number | null;
  call_id: string | null;
  request_id: string | null;
  task_id: string | null;
  candidate_id: string | null;
  operation_id: string | null;
  data: Record<string, unknown>;
}

/** `GET /lepimemory/history`（逐条审计分页）。 */
export interface FlatHistoryResponse {
  ok: true;
  kind: string;
  total: number;
  offset: number;
  limit: number;
  entries: HistoryEntry[];
}

/** 一个「主体」组：组内阶段新→旧，`truncated` 表示超过服务端单组上限。 */
export interface HistoryGroup {
  key: string;
  truncated: boolean;
  entries: HistoryEntry[];
}

/** `GET /lepimemory/history?grouped=1`（按主体分组、以组为单位分页）。 */
export interface GroupedHistoryResponse {
  ok: true;
  kind: string;
  grouped: true;
  total: number;
  offset: number;
  limit: number;
  groups: HistoryGroup[];
}

/** 已核准快照 + 核对字段（正文可能因遗忘而按 `reveal` 隐藏）。 */
export interface CandidateSnapshot extends Record<string, unknown> {
  payload_hash: string;
  created_at: number;
}

/** 候选的当前生命周期行。 */
export interface CandidateLifecycle {
  status: string;
  purpose: string;
  superseded_by: string | null;
  confirmed_by: string | null;
  grant_id: string | null;
  policy_epoch: number;
  updated_at: number;
}

/** 来源证明引用（`evidence` 行的只读投影）。 */
export interface CandidateSource {
  id: string;
  session_id: string;
  message_id: string;
  seq: number;
  block_index: number;
  start: number;
  end: number;
  actor: string;
  at: number;
  kind: string;
}

/** raw_links 行（远端原始条目核对状态）。 */
export interface CandidateRawLink {
  raw_id: string;
  document_id: string;
  version_hash: string;
  state: string;
  verified_at: number | null;
}

/** 候选相关 task 的只读投影。 */
export interface CandidateTask {
  id: string;
  kind: string;
  status: string;
  request_id: string | null;
  operation_id: string | null;
  attempts: number;
  submitted_at: number | null;
  expires_at: number | null;
  error_code: string | null;
}

/** 由 task 派生的 operation 引用（仅包含真实非空 operation_id）。 */
export interface CandidateOperation {
  task_id: string;
  operation_id: string;
  status: string;
}

/** 授权行（`scope` 为解析后的 JSON，无法解析时为 null）。 */
export interface CandidateGrant {
  id: string;
  scope: unknown;
  session_id: string | null;
  expires_at: number;
  revoked_at: number | null;
  allow_inference: number;
}

/** `GET /lepimemory/candidate`：快照/生命周期/来源引用（无 heap 回退）。 */
export interface CandidateResponse {
  ok: true;
  candidate_id: string;
  snapshot: CandidateSnapshot;
  lifecycle: CandidateLifecycle;
  sources: CandidateSource[];
  raw_links: CandidateRawLink[];
  tasks: CandidateTask[];
  operations: CandidateOperation[];
  grants: CandidateGrant[];
}

/** `POST /lepimemory/retry` 成功：按既有身份唤醒，不新开 operation。 */
export interface RetrySuccessResponse {
  ok: true;
  kind: 'request' | 'task';
  id: string;
  status: string;
  code: string | null;
  retryable: true;
}

/** `POST /lepimemory/retry` 冲突：身份存在但不可重试（409）。 */
export interface RetryConflictResponse {
  ok: false;
  kind: 'request' | 'task';
  id: string;
  status: string;
  code: string | null;
  error: string;
}

export type RetryResponse = RetrySuccessResponse | RetryConflictResponse;

/** 面板所有 JSON 响应的并集（含稳定失败体）。 */
export type PanelResponse =
  | HealthResponse
  | StateResponse
  | StatePreviewResponse
  | FlatHistoryResponse
  | GroupedHistoryResponse
  | CandidateResponse
  | RetryResponse
  | ErrorResponse;
