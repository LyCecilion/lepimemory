/**
 * 状态面板（Host 侧，Step 11 切换）：把**真实运行状态**投影成只读/受限操作 HTTP JSON，
 * 供浏览器半的面板组件（client.js）显示。
 *
 * 与旧实现的差别（本次 clean cutover）：
 *   - 不再读 `state.json` / `*.jsonl`（文件派生），也不再仅凭 Host/Origin 判断本机；
 *     所有数据/操作路由改走**共享 connection 鉴权**（`scope.connection.requestRejection`），
 *     数据只来自单一 SQLite `store`（不可变快照 + 统一审计）。
 *   - 操作者鉴权在**任何** DB 读取/正文动作之前完成；未鉴权请求即使 ID 不存在也返回 401/403，
 *     绝不泄露 404/正文。
 *
 * 路由：
 *   - `GET  /lepimemory/health`                          公开只读 bool（launcher readiness）
 *   - `GET  /lepimemory/state`                           操作者；有效状态（衰减视图，不落库）+ 状态元数据
 *   - `POST /lepimemory/state[?preview=1]`               操作者；精确数值字段 → 固定原因 → （preview=1 时只 dry-run 不落库）原子提交 + 完整审计
 *   - `GET  /lepimemory/history?kind=&limit=&offset=[&grouped=1]`  操作者；`grouped=1` 时按「主体」分组、以组为单位分页（审计分页仍是逐条）
 *   - `GET  /lepimemory/candidate?id=&reveal=`           操作者；已获准快照/生命周期/来源引用（无 heap 回退）
 *   - `POST /lepimemory/retry`                           操作者；按既有身份唤醒 request/task（不新开 operation）
 *   - `GET  /lepimemory/avatar?key=`                     操作者；提供 assets/avatar/ 下清单内的立绘 GIF
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StatementSync } from 'node:sqlite';
import type { Context } from '@deepseek-ai/cordis';
// Type-only loads: 让 webServer / connection 服务 augmentation 参与本模块的边界类型，不产生 runtime require。
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-client-connection';
import { decayMood } from './machine.js';
import { AVATAR_ASSETS } from './shared/avatar-assets.js';
import type { AvatarKey } from './shared/avatar-assets.js';
import { NUMERIC_FIELDS, renderState, toneOf, nearOf, validateState } from './shared/state.js';
import type { LepiState } from './shared/state.js';
import { SCHEMA_VERSION } from './store.js';
import type { HistoryPage, Store } from './store.js';
import { NODE_VERSION } from './shared/pins.js';
import type {
  CandidateGrant,
  CandidateLifecycle,
  CandidateOperation,
  CandidateRawLink,
  CandidateResponse,
  CandidateSnapshot,
  CandidateSource,
  CandidateTask,
  FlatHistoryResponse,
  GroupedHistoryResponse,
  HealthResponse,
  HistoryEntry,
  OperatorStateInput,
  RetryResponse,
  ServiceStatus,
  StateCountsResponse,
  StatePreviewResponse,
  StateResponse,
} from './shared/api.js';

/** node:sqlite 边界：绑定参数与「按调用处已知行形状读取」的断言出口。 */
type SqlParam = string | number | bigint | null;
/** `get()` 返回 `Record<string, SQLOutputValue>`；调用处已读 SQL 行形状，故集中断言。 */
function firstRow<T>(stmt: StatementSync, ...params: SqlParam[]): T | undefined {
  return stmt.get(...params) as unknown as T | undefined;
}
/** `all()` 同 {@link firstRow}，用于已知行形状的集合读取。 */
function allRows<T>(stmt: StatementSync, ...params: SqlParam[]): T[] {
  return stmt.all(...params) as unknown as T[];
}

/** 固定的运行时 Node（共享版本钉，见 src/shared/pins.ts）。 */
const PINNED_NODE = NODE_VERSION;
/** 本插件 package.json 声明的 peer dsh 版本（唯一事实来源，不重复硬编码）。 */
const PINNED_DSH: string | null = (() => {
  try {
    const manifest = createRequire(import.meta.url)('../package.json') as {
      peerDependencies?: Record<string, string>;
    };
    return manifest.peerDependencies?.['@deepseek-ai/dsh'] ?? null;
  } catch {
    return null;
  }
})();

/** 允许的历史 kind（与 store.history 的封闭集合一致）。 */
const HISTORY_KINDS = new Set([
  'audit',
  'recall',
  'retain',
  'forget',
  'action',
  'control',
  'consent',
  'task',
]);
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
/** 小型 JSON body 上限（16KiB）；超过即 413，绝不缓冲无界正文。 */
const BODY_LIMIT = 16384;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 操作者调整状态的固定原因（不接受自由文本原因）。 */
const OPERATOR_CAUSE = '操作者调整演示状态';
const RESUBMIT_CODE = 'LEPI_INPUT_RESUBMIT_REQUIRED';

/** 立绘素材目录（相对本模块解析，随插件 link 一起被 $DSH_HOME profile 引用）。 */
const AVATAR_DIR = fileURLToPath(new URL('../assets/avatar/', import.meta.url));
/** 立绘 key 形状：短、小写、可带连字符；只有清单内的 key 才会被读取。 */
const AVATAR_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** key → { mtimeMs, buffer }：按 mtime 失效，替换素材后无需重启即生效。 */
const avatarCache = new Map<string, { mtimeMs: number; buffer: Buffer }>();

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const shortId = (id: unknown): string =>
  typeof id === 'string' && id.length > 8 ? id.slice(0, 8) : String(id ?? '');

/** 真实 status → 人可读标签（绝不把 `!skipped` 之类误报成成功）。 */
const STATUS_LABEL: Record<string, string> = {
  pending: '待处理',
  deferred: '待判定',
  written: '已核实入库',
  reconciled: '处理完成',
  unknown: '结果不明',
  failed: '处理失败',
  rejected: '已拒绝',
  cancelled: '已取消',
  expired: '已过期',
  running: '处理中',
  submitted: '已提交',
  retry_pending: '待重试',
  resubmit_required: '需重新发起',
  parked: '已停车',
  received: '已接收',
  allowed: '已允许',
  revoked: '已撤销',
  superseded: '已取代',
  local_isolating: '本地隔离中',
  local_isolated: '已停止使用',
  remote_curating: '后端清理中',
  remote_pending: '后端清理待完成',
  restoring: '恢复中',
  restored: '已恢复',
  suppressed: '已抑制',
  invalidated: '已作废',
  admission: '准入判定',
  audit_only: '仅审计',
  cleaning: '清理中',
  retry_requested: '已请求重试',
  retrying: '重试中',
  checked: '已检查',
  referenced: '已引用',
  ok: '正常',
};

/** 审计行的面板投影输入（store.history 的条目；`data` 为已解析 JSON）。 */
type AuditItem = HistoryPage['items'][number];

/** 一条审计记录的人可读摘要（只含类型/状态/ID/reason 元数据，绝不回显任何正文）。 */
function summarize(row: AuditItem): string {
  const data = isPlainObject(row.data) ? row.data : {};
  const parts = [row.type, STATUS_LABEL[row.status] ?? row.status];
  if (row.candidate_id) parts.push(`候选 ${shortId(row.candidate_id)}`);
  if (row.task_id) parts.push(`任务 ${shortId(row.task_id)}`);
  if (data.verdict) parts.push(`判定 ${data.verdict}`);
  if (data.reason_code) parts.push(`原因 ${data.reason_code}`);
  return `${parts.join(' · ')}${data.legacy ? '（历史记录）' : ''}`;
}

/** 审计行 → 面板 entry（`history` 与 `historyGroups` 两条路径共用同一投影）。 */
function mapEntry(row: AuditItem): HistoryEntry {
  return {
    id: row.id,
    at: row.at,
    type: row.type,
    status: row.status,
    summary: summarize(row),
    session_id: row.session_id ?? null,
    turn: row.turn ?? null,
    step: row.step ?? null,
    call_id: row.call_id ?? null,
    request_id: row.request_id ?? null,
    task_id: row.task_id ?? null,
    candidate_id: row.candidate_id ?? null,
    operation_id: row.operation_id ?? null,
    data: isPlainObject(row.data) ? row.data : {},
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/** 方法守卫：附带 Allow 头，错误体为稳定 code（不回显原始请求）。 */
function methodNotAllowed(res: ServerResponse, allow: readonly string[]): void {
  res.writeHead(405, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    allow: allow.join(', '),
  });
  res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
}

/** connection 服务在鉴权边界所需的最小结构面（headers 是唯一读取字段）。 */
interface ConnectionLike {
  requestRejection(request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined;
}

/** 操作者鉴权：在**任何** DB 读取/正文动作之前调用。返回 true 表示已拒绝并发出响应。 */
function rejected(res: ServerResponse, connection: ConnectionLike, req: IncomingMessage): boolean {
  const code = connection.requestRejection(req);
  if (code === undefined) return false;
  const status = code === 401 ? 401 : 403;
  sendJson(res, status, { ok: false, error: status === 401 ? 'unauthorized' : 'forbidden' });
  return true;
}

type BodyRead = { ok: true; value: unknown } | { ok: false };

/** 有界读取 JSON body；错误只暴露稳定 code，不拼接原始异常。
 *  成功返回 `{ok:true,value}`（value 可能是任意 JSON，包括 null）；失败返回 `{ok:false}` 并已发出响应。 */
function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<BodyRead> {
  const { promise, resolve } = Promise.withResolvers<BodyRead>();
  let size = 0;
  const chunks: Buffer[] = [];
  let settled = false;
  const fail = (status: number, error: string): void => {
    if (settled) return;
    settled = true;
    sendJson(res, status, { ok: false, error });
    resolve({ ok: false });
  };
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > BODY_LIMIT) {
    fail(413, 'payload_too_large');
    return promise;
  }
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      req.destroy();
      fail(413, 'payload_too_large');
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (settled) return;
    settled = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_json' });
      resolve({ ok: false });
      return;
    }
    resolve({ ok: true, value: parsed });
  });
  req.on('error', () => fail(400, 'invalid_body'));
  return promise;
}

// ── 只读投影（绝不改库）─────────────────────────────────────────────

/** 面板读取的协调器面：health/retry。 */
interface PanelCoordinator {
  health?(): unknown;
  retry?(id: string): RetryReceipt | null;
}
/** retry 回执：只读取这三个字段（与 memory/control 的真实返回一致）。 */
interface RetryReceipt {
  retryable?: unknown;
  status?: unknown;
  code?: unknown;
}
/** 面板读取的控制面：retry。 */
interface PanelControl {
  retry?(id: string): RetryReceipt | null;
}

type PanelLogger = { warn(message: string): void; info(message: string): void };

interface PanelDeps {
  logger?: PanelLogger;
  store: Store;
  coordinator: PanelCoordinator;
  control: PanelControl;
  dataRoot?: string;
}

function installedDshVersion(): string | null {
  try {
    const manifest = createRequire(import.meta.url)('@deepseek-ai/dsh/package.json') as {
      version?: string;
    };
    return manifest.version ?? null;
  } catch {
    return null;
  }
}

function schemaMatches(store: Store): boolean {
  try {
    const row = firstRow<{ value?: unknown }>(
      store.db.prepare("SELECT value FROM meta WHERE key='schema_version'"),
    );
    return row?.value === String(SCHEMA_VERSION);
  } catch {
    return false;
  }
}

function coreReady(store: Store): boolean {
  return (
    process.version === PINNED_NODE &&
    PINNED_DSH != null &&
    installedDshVersion() === PINNED_DSH &&
    schemaMatches(store)
  );
}

function safeHealth(coordinator: PanelCoordinator): ServiceStatus | null {
  try {
    if (typeof coordinator?.health !== 'function') return null;
    const health = coordinator.health();
    return health && typeof health === 'object' ? (health as ServiceStatus) : null;
  } catch {
    return null;
  }
}

/** serviceReady：内存运行时已启动且未销毁（**不**声称远端 provider 健康）。 */
function serviceReady(coordinator: PanelCoordinator): boolean {
  const health = safeHealth(coordinator);
  return Boolean(health && health.started === true && health.disposed === false);
}

/** 有效状态（按 clock 衰减 mood，**不落库**）；与 state-runtime.readEffective 同义。 */
function effectiveState(store: Store, at: number): LepiState {
  const state = store.readState();
  const decayed = decayMood(state.mood, at);
  if (!decayed.changed) return state;
  const next = structuredClone(state);
  next.mood.valence = decayed.valence;
  next.mood.arousal = decayed.arousal;
  next.mood.updatedAt = new Date(at).toISOString();
  return next;
}

/** 认证状态的元数据计数（只统计行数，无任何正文）。 */
function collectCounts(store: Store): StateCountsResponse {
  const group = (sql: string): Record<string, number> => {
    const out: Record<string, number> = {};
    try {
      for (const row of allRows<{ status: string; n: number }>(store.db.prepare(sql)))
        out[row.status] = row.n;
    } catch {
      /* 计数失败不阻断状态投影 */
    }
    return out;
  };
  const scalar = (sql: string): number => {
    try {
      return firstRow<{ n?: number }>(store.db.prepare(sql))?.n ?? 0;
    } catch {
      return 0;
    }
  };
  return {
    lifecycle: group('SELECT status,count(*) AS n FROM lifecycle GROUP BY status'),
    requests: group('SELECT status,count(*) AS n FROM requests GROUP BY status'),
    tasks: group('SELECT status,count(*) AS n FROM tasks GROUP BY status'),
    grants: {
      total: scalar('SELECT count(*) AS n FROM grants'),
      active: scalar('SELECT count(*) AS n FROM grants WHERE revoked_at IS NULL'),
    },
  };
}

function statePayload(store: Store, coordinator: PanelCoordinator, at: number): StateResponse {
  const effective = effectiveState(store, at);
  return {
    ok: true,
    rendered: renderState(effective, at),
    tone: toneOf(effective),
    near: nearOf(effective),
    mood: effective.mood,
    relation: effective.relation,
    updatedAt: effective.mood.updatedAt,
    core: coreReady(store),
    status: safeHealth(coordinator),
    counts: collectCounts(store),
  };
}

// ── 输入校验 ────────────────────────────────────────────────────────

const RANGE = new Map<string, readonly [number, number]>(
  NUMERIC_FIELDS.map(([p, lo, hi]) => [p, [lo, hi] as const]),
);
const inRange = (p: string, value: unknown): boolean => {
  const range = RANGE.get(p);
  if (!range) return false;
  const [lo, hi] = range;
  return typeof value === 'number' && Number.isFinite(value) && value >= lo && value <= hi;
};

/** 操作者状态 body：**恰好** {mood:{valence,arousal}, relation:{trust,closeness,familiarity}}，全数值且在区间。 */
function operatorInput(body: unknown): OperatorStateInput | null {
  if (!isPlainObject(body)) return null;
  const top = Object.keys(body).sort();
  if (top.length !== 2 || top[0] !== 'mood' || top[1] !== 'relation') return null;
  const { mood, relation } = body;
  if (!isPlainObject(mood) || !isPlainObject(relation)) return null;
  const moodKeys = Object.keys(mood).sort();
  if (moodKeys.length !== 2 || moodKeys[0] !== 'arousal' || moodKeys[1] !== 'valence') return null;
  const relKeys = Object.keys(relation).sort();
  if (
    relKeys.length !== 3 ||
    relKeys[0] !== 'closeness' ||
    relKeys[1] !== 'familiarity' ||
    relKeys[2] !== 'trust'
  )
    return null;
  if (!inRange('mood.valence', mood.valence) || !inRange('mood.arousal', mood.arousal)) return null;
  if (
    !inRange('relation.trust', relation.trust) ||
    !inRange('relation.closeness', relation.closeness) ||
    !inRange('relation.familiarity', relation.familiarity)
  )
    return null;
  return {
    mood: { valence: mood.valence as number, arousal: mood.arousal as number },
    relation: {
      trust: relation.trust as number,
      closeness: relation.closeness as number,
      familiarity: relation.familiarity as number,
    },
  };
}

function parseIntParam(raw: string | null, def: number, min: number, max: number): number | null {
  if (raw === null || raw === undefined || raw === '') return def;
  if (!/^[+-]?\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) return null;
  return n;
}

/**
 * 由当前状态与操作者输入算出**下一个状态对象**（纯函数：不落库、不写审计）。
 * 提交与 dry-run 预览共用同一算法，保证「预览所见」就是「提交将写入」。
 */
function nextStateFrom(current: LepiState, input: OperatorStateInput, at: number): LepiState {
  const next = structuredClone(current);
  const moodChange =
    Math.abs(input.mood.valence - current.mood.valence) +
    Math.abs(input.mood.arousal - current.mood.arousal);
  const relChange =
    Math.abs(input.relation.trust - current.relation.trust) +
    Math.abs(input.relation.closeness - current.relation.closeness) +
    Math.abs(input.relation.familiarity - current.relation.familiarity);
  next.mood.valence = input.mood.valence;
  next.mood.arousal = input.mood.arousal;
  next.relation.trust = input.relation.trust;
  next.relation.closeness = input.relation.closeness;
  next.relation.familiarity = input.relation.familiarity;
  next.mood.updatedAt = new Date(at).toISOString();
  const dimension: 'mood' | 'relation' = relChange > moodChange ? 'relation' : 'mood';
  next.reasons = [
    { dimension, text: OPERATOR_CAUSE, at: new Date(at).toISOString() },
    ...current.reasons,
  ].slice(0, 10);
  return next;
}

// ── 安装 ────────────────────────────────────────────────────────────

/** 候选路由的 join 行（snapshots ⋈ lifecycle）。 */
interface CandidateJoinRow {
  json: string;
  payload_hash: string;
  created_at: number;
  status: string;
  purpose: string;
  superseded_by: string | null;
  confirmed_by: string | null;
  grant_id: string | null;
  policy_epoch: number;
  updated_at: number;
}
/** grants 只读投影行（含原始 scope_json）。 */
interface CandidateGrantRow {
  id: string;
  scope_json: string;
  session_id: string | null;
  expires_at: number;
  revoked_at: number | null;
  allow_inference: number;
}

/**
 * 安装面板路由（`config.panel.enabled === false` 或无 webServer 时跳过；缺 connection 只装 health）。
 * @param ctx cordis 根上下文（webServer / connection 为注入服务）。
 * @param config 已解析配置（只读 `panel.enabled`）。
 * @param deps 已构造的 Store / coordinator / control 与日志。
 */
export function installPanel(
  ctx: Context,
  config: unknown,
  { logger, store, coordinator, control }: PanelDeps,
): void {
  const panel = isPlainObject(config) ? config.panel : undefined;
  if (isPlainObject(panel) && panel.enabled === false) return;
  if (typeof ctx.inject !== 'function') {
    logger?.warn('面板：ctx.inject 不可用，跳过 /lepimemory/* 路由（面板将显示「状态不可用」）');
    return;
  }

  void ctx.inject(['webServer', 'connection'], (scope) => {
    const server = scope.webServer;
    if (!server || typeof server.register !== 'function') {
      logger?.warn('面板：webServer 不可用，跳过 /lepimemory/* 路由（面板将显示「状态不可用」）');
      return;
    }
    const connection: ConnectionLike | undefined = scope.connection;
    const authed = typeof connection?.requestRejection === 'function';

    const healthRoute: WebRoute = {
      kind: 'exact',
      path: '/lepimemory/health',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
        let core: boolean;
        try {
          core = coreReady(store);
        } catch {
          core = false;
        }
        const body: HealthResponse = {
          ok: true,
          core,
          node: process.version === PINNED_NODE,
          dsh: PINNED_DSH != null && installedDshVersion() === PINNED_DSH,
          schema: schemaMatches(store),
          serviceReady: serviceReady(coordinator),
        };
        sendJson(res, 200, body);
      },
    };

    const disposers = [server.register(healthRoute)];

    if (!authed) {
      logger?.warn('面板：connection 不可用，仅装载公开 /lepimemory/health（数据路由不开放）');
    } else {
      const stateRoute: WebRoute = {
        kind: 'exact',
        path: '/lepimemory/state',
        handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
          if (rejected(res, connection, req)) return;
          if (req.method === 'GET') {
            try {
              sendJson(res, 200, statePayload(store, coordinator, Date.now()));
            } catch {
              sendJson(res, 500, { ok: false, error: 'LEPI_STATE_UNAVAILABLE' });
            }
            return;
          }
          if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
          const preview =
            new URL(req.url ?? '/', 'http://localhost').searchParams.get('preview') === '1';
          const read = await readJsonBody(req, res);
          if (!read.ok) return;
          const input = operatorInput(read.value);
          if (!input) {
            sendJson(res, 400, { ok: false, error: 'invalid_state' });
            return;
          }
          const at = Date.now();
          try {
            const current = store.readState();
            const next = nextStateFrom(current, input, at);
            if (preview) {
              // dry-run：只算渲染与基调，绝不 commitState、绝不写审计。
              if (!validateState(next).ok) {
                sendJson(res, 500, { ok: false, error: 'LEPI_STATE_INVALID' });
                return;
              }
              const body: StatePreviewResponse = {
                ok: true,
                preview: true,
                rendered: renderState(next, at),
                tone: toneOf(next),
                mood: next.mood,
                relation: next.relation,
              };
              sendJson(res, 200, body);
              return;
            }
            if (!validateState(next).ok) {
              sendJson(res, 500, { ok: false, error: 'LEPI_STATE_INVALID' });
              return;
            }
            store.commitState(next, {
              at,
              type: 'control',
              status: 'state_set',
              data: { operator: true },
            });
            sendJson(res, 200, statePayload(store, coordinator, at));
          } catch {
            sendJson(res, 500, { ok: false, error: 'LEPI_STATE_UNAVAILABLE' });
          }
        },
      };

      const historyRoute: WebRoute = {
        kind: 'exact',
        path: '/lepimemory/history',
        handler: (req: IncomingMessage, res: ServerResponse): void => {
          if (rejected(res, connection, req)) return;
          if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
          const url = new URL(req.url ?? '/', 'http://localhost');
          const kind = url.searchParams.get('kind') ?? 'audit';
          if (!HISTORY_KINDS.has(kind)) {
            sendJson(res, 400, { ok: false, error: 'unknown_kind' });
            return;
          }
          const limit = parseIntParam(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
          const offset = parseIntParam(
            url.searchParams.get('offset'),
            0,
            0,
            Number.MAX_SAFE_INTEGER,
          );
          if (limit === null || offset === null) {
            sendJson(res, 400, { ok: false, error: 'invalid_pagination' });
            return;
          }
          const grouped = url.searchParams.get('grouped') === '1';
          if (grouped) {
            let page;
            try {
              page = store.historyGroups({ kind, limit, offset });
            } catch {
              sendJson(res, 500, { ok: false, error: 'LEPI_STORE_UNAVAILABLE' });
              return;
            }
            const body: GroupedHistoryResponse = {
              ok: true,
              kind,
              grouped: true,
              total: page.total,
              offset,
              limit,
              groups: page.groups.map((g) => ({
                key: g.key,
                truncated: g.truncated,
                entries: g.items.map(mapEntry),
              })),
            };
            sendJson(res, 200, body);
            return;
          }
          let page;
          try {
            page = store.history({ kind, limit, offset });
          } catch {
            sendJson(res, 500, { ok: false, error: 'LEPI_STORE_UNAVAILABLE' });
            return;
          }
          const body: FlatHistoryResponse = {
            ok: true,
            kind,
            total: page.total,
            offset,
            limit,
            entries: page.items.map(mapEntry),
          };
          sendJson(res, 200, body);
        },
      };

      const candidateRoute: WebRoute = {
        kind: 'exact',
        path: '/lepimemory/candidate',
        handler: (req: IncomingMessage, res: ServerResponse): void => {
          if (rejected(res, connection, req)) return;
          if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
          const url = new URL(req.url ?? '/', 'http://localhost');
          const id = url.searchParams.get('id') ?? '';
          if (!UUID_RE.test(id)) {
            sendJson(res, 400, { ok: false, error: 'invalid_id' });
            return;
          }
          const reveal = url.searchParams.get('reveal') === '1';
          let row: CandidateJoinRow | undefined;
          try {
            row = firstRow<CandidateJoinRow>(
              store.db.prepare(
                'SELECT s.json,s.payload_hash,s.created_at,l.status,l.purpose,l.superseded_by,l.confirmed_by,l.grant_id,l.policy_epoch,l.updated_at FROM snapshots s JOIN lifecycle l USING(candidate_id) WHERE s.candidate_id=?',
              ),
              id,
            );
          } catch {
            sendJson(res, 500, { ok: false, error: 'LEPI_STORE_UNAVAILABLE' });
            return;
          }
          if (!row) {
            sendJson(res, 404, { ok: false, error: 'not_found' });
            return;
          }
          let candidate: Record<string, unknown>;
          try {
            candidate = JSON.parse(row.json) as Record<string, unknown>;
          } catch {
            sendJson(res, 500, { ok: false, error: 'LEPI_SNAPSHOT_INVALID' });
            return;
          }
          const forgotten = row.status === 'forgotten';
          const snapshot: CandidateSnapshot = {
            ...candidate,
            payload_hash: row.payload_hash,
            created_at: row.created_at,
          };
          if (forgotten && !reveal) delete snapshot.text;
          const sourceIds: string[] = Array.isArray(candidate.source_ids)
            ? candidate.source_ids.filter((value): value is string => typeof value === 'string')
            : [];
          let sources: CandidateSource[] = [];
          if (sourceIds.length > 0) {
            const holes = sourceIds.map(() => '?').join(',');
            try {
              sources = allRows<CandidateSource>(
                store.db.prepare(
                  `SELECT id,session_id,message_id,seq,block_index,start,end,actor,at,kind FROM evidence WHERE id IN (${holes})`,
                ),
                ...sourceIds,
              );
            } catch {
              sendJson(res, 500, { ok: false, error: 'LEPI_STORE_UNAVAILABLE' });
              return;
            }
          }
          let rawLinks: CandidateRawLink[];
          let tasks: CandidateTask[];
          let grants: CandidateGrantRow[];
          try {
            rawLinks = allRows<CandidateRawLink>(
              store.db.prepare(
                'SELECT raw_id,document_id,version_hash,state,verified_at FROM raw_links WHERE candidate_id=?',
              ),
              id,
            );
            tasks = allRows<CandidateTask>(
              store.db.prepare(
                'SELECT id,kind,status,request_id,operation_id,attempts,submitted_at,expires_at,error_code FROM tasks WHERE candidate_id=?',
              ),
              id,
            );
            grants = allRows<CandidateGrantRow>(
              store.db.prepare(
                "SELECT id,scope_json,session_id,expires_at,revoked_at,allow_inference FROM grants WHERE json_extract(scope_json,'$.candidate_id')=? OR id=?",
              ),
              id,
              row.grant_id ?? '',
            );
          } catch {
            sendJson(res, 500, { ok: false, error: 'LEPI_STORE_UNAVAILABLE' });
            return;
          }
          const operations: CandidateOperation[] = tasks
            .filter((task) => typeof task.operation_id === 'string' && task.operation_id)
            .map((task) => ({
              task_id: task.id,
              operation_id: task.operation_id as string,
              status: task.status,
            }));
          const parsedGrants: CandidateGrant[] = grants.map((grant) => {
            let scope: unknown;
            try {
              scope = JSON.parse(grant.scope_json);
            } catch {
              scope = null;
            }
            return {
              id: grant.id,
              scope,
              session_id: grant.session_id,
              expires_at: grant.expires_at,
              revoked_at: grant.revoked_at,
              allow_inference: grant.allow_inference,
            };
          });
          const lifecycle: CandidateLifecycle = {
            status: row.status,
            purpose: row.purpose,
            superseded_by: row.superseded_by,
            confirmed_by: row.confirmed_by,
            grant_id: row.grant_id,
            policy_epoch: row.policy_epoch,
            updated_at: row.updated_at,
          };
          const body: CandidateResponse = {
            ok: true,
            candidate_id: id,
            snapshot,
            lifecycle,
            sources,
            raw_links: rawLinks,
            tasks,
            operations,
            grants: parsedGrants,
          };
          sendJson(res, 200, body);
        },
      };

      const retryRoute: WebRoute = {
        kind: 'exact',
        path: '/lepimemory/retry',
        handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
          if (rejected(res, connection, req)) return;
          if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
          const read = await readJsonBody(req, res);
          if (!read.ok) return;
          const body = read.value;
          if (!isPlainObject(body)) {
            sendJson(res, 400, { ok: false, error: 'invalid_body' });
            return;
          }
          const keys = Object.keys(body).sort();
          if (keys.length !== 2 || keys[0] !== 'id' || keys[1] !== 'kind') {
            sendJson(res, 400, { ok: false, error: 'invalid_body' });
            return;
          }
          const kind = body.kind;
          const id = body.id;
          if (kind !== 'request' && kind !== 'task') {
            sendJson(res, 400, { ok: false, error: 'invalid_kind' });
            return;
          }
          if (typeof id !== 'string' || !UUID_RE.test(id)) {
            sendJson(res, 400, { ok: false, error: 'invalid_id' });
            return;
          }
          if (kind === 'task') {
            let row: { id: string } | undefined;
            try {
              row = firstRow<{ id: string }>(
                store.db.prepare('SELECT id FROM tasks WHERE id=?'),
                id,
              );
            } catch {
              sendJson(res, 500, { ok: false, error: 'LEPI_STORE_UNAVAILABLE' });
              return;
            }
            if (!row) {
              sendJson(res, 404, { ok: false, error: 'not_found' });
              return;
            }
            const receipt = typeof coordinator?.retry === 'function' ? coordinator.retry(id) : null;
            if (receipt && receipt.retryable === true) {
              const okBody: RetryResponse = {
                ok: true,
                kind: 'task',
                id,
                status: typeof receipt.status === 'string' ? receipt.status : 'unknown',
                code: typeof receipt.code === 'string' ? receipt.code : null,
                retryable: true,
              };
              sendJson(res, 200, okBody);
              return;
            }
            const conflict: RetryResponse = {
              ok: false,
              kind: 'task',
              id,
              status: typeof receipt?.status === 'string' ? receipt.status : 'unknown',
              code: typeof receipt?.code === 'string' ? receipt.code : null,
              error: 'not_retryable',
            };
            sendJson(res, 409, conflict);
            return;
          }
          let row: { id: string } | undefined;
          try {
            row = firstRow<{ id: string }>(
              store.db.prepare('SELECT id FROM requests WHERE id=?'),
              id,
            );
          } catch {
            sendJson(res, 500, { ok: false, error: 'LEPI_STORE_UNAVAILABLE' });
            return;
          }
          if (!row) {
            sendJson(res, 404, { ok: false, error: 'not_found' });
            return;
          }
          const receipt = typeof control?.retry === 'function' ? control.retry(id) : null;
          if (receipt && receipt.status === 'retry_pending') {
            const okBody: RetryResponse = {
              ok: true,
              kind: 'request',
              id,
              status: 'retry_pending',
              code: typeof receipt.code === 'string' ? receipt.code : null,
              retryable: true,
            };
            sendJson(res, 200, okBody);
            return;
          }
          const code = typeof receipt?.code === 'string' ? receipt.code : 'LEPI_RETRY_FORBIDDEN';
          const conflict: RetryResponse = {
            ok: false,
            kind: 'request',
            id,
            status: typeof receipt?.status === 'string' ? receipt.status : 'unknown',
            code,
            error: code === RESUBMIT_CODE ? 'resubmit_required' : 'not_retryable',
          };
          sendJson(res, 409, conflict);
        },
      };

      /**
       * 立绘素材路由：只按清单内的 key 提供 `assets/avatar/` 下的 GIF。
       * 与其它数据路由同样走共享 connection 鉴权；未鉴权请求在读取任何素材之前被拒。
       */
      const avatarRoute: WebRoute = {
        kind: 'exact',
        path: '/lepimemory/avatar',
        handler: (req: IncomingMessage, res: ServerResponse): void => {
          if (rejected(res, connection, req)) return;
          if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
          const key = new URL(req.url ?? '/', 'http://localhost').searchParams.get('key') ?? '';
          if (!AVATAR_KEY_RE.test(key) || !(key in AVATAR_ASSETS)) {
            sendJson(res, 404, { ok: false, error: 'not_found' });
            return;
          }
          try {
            // 每次按 mtime 判定：素材被替换后无需重启进程即生效；
            // 命中 if-modified-since 时回 304，避免每次加载重传整帧。
            const file = path.join(AVATAR_DIR, AVATAR_ASSETS[key as AvatarKey]);
            const stat = fs.statSync(file);
            const mtimeMs = Math.floor(stat.mtimeMs / 1000) * 1000;
            let entry = avatarCache.get(key);
            if (!entry || entry.mtimeMs !== mtimeMs) {
              entry = { mtimeMs, buffer: fs.readFileSync(file) };
              avatarCache.set(key, entry);
            }
            const lastModified = new Date(mtimeMs).toUTCString();
            const sinceHeader = req.headers['if-modified-since'];
            const since = Date.parse(typeof sinceHeader === 'string' ? sinceHeader : '');
            if (Number.isFinite(since) && since >= mtimeMs) {
              res.writeHead(304, {
                'cache-control': 'private, no-cache',
                'last-modified': lastModified,
              });
              res.end();
              return;
            }
            res.writeHead(200, {
              'content-type': 'image/gif',
              'cache-control': 'private, no-cache',
              'last-modified': lastModified,
              'content-length': entry.buffer.length,
            });
            res.end(entry.buffer);
          } catch {
            sendJson(res, 500, { ok: false, error: 'LEPI_AVATAR_UNAVAILABLE' });
          }
        },
      };

      disposers.push(
        server.register(stateRoute),
        server.register(historyRoute),
        server.register(candidateRoute),
        server.register(retryRoute),
        server.register(avatarRoute),
      );
    }

    scope.effect(
      () => () => {
        for (const dispose of disposers) dispose();
      },
      'lepimemory.panel.routes()',
    );
    logger?.info('面板路由已装载：/lepimemory/health、state、history、candidate、retry、avatar');
  });
}
