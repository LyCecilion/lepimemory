/**
 * evidence.js — 会话证据索引（Lepimemory 运行时收敛 Step 4）。
 *
 * 目标：为「中性请求处理」提供可核验的来源引用，而**不落正文**：
 *   - SQLite `evidence` 只保存元数据与唯一引用（session/message/seq/block/offset/actor/at/kind）；
 *   - 正文只存在于**当前处理 heap**（`bodies`）。进程重启后正文仅能从**当前会话的
 *     canonical surface**（`sessionQuery.readSurface`，已应用 replace/投影）重取；
 *     shadowed（被替换/净化）的旧消息**不可**从旧审计日志复活。
 *
 * 事件取证（以安装版 dsh-session / dsh-agent 实际 envelope 为准）：
 *   - `user/message` 的 `event.data` **就是 UserMessage**（不是 wrapper）。
 *     `source.kind === 'user'` → actor='user'；其余（injected context / notice / recall …）
 *     → actor='context'（**context 永不作为独立事实**，见 step4 契约）。
 *   - `assistant/message` 是 `event.data.message`；只取公共 text block，**不收 reasoning**。
 *   - `tool/result` 是 `event.data.message`；`isError === false` **不足以**构成行动来源。
 *     actor='action' / kind='verified_action' 仅当 `actions` 表存在
 *     `(session_id, call_id)` 且 `status='executed'`（journal 确认的已执行行动）。
 *   - `agent/inbox/spliced` 是 session 事件（dsh-agent 扩表）：`inserted[]` 携带真实
 *     UserMessage id 与首次 `event.time/seq`。同一 id 被 requeue 时**保留最初 seq/时间**，
 *     绝不刷新。blocked 输入只有原 splice、没有提交的 `user/message`。
 *
 * `claimed` 只引用已观测的 splice 事件（真实 event seq），**不读 agent.inbox 本体**，
 * 也不把未提交的 inbox 当作已提交事实。
 *
 * 读取门槛（当前会话限定）：
 *   - 已提交来源（user/assistant/action/context）：必须仍是**当前 surface** 上的节点，
 *     否则不可读，不从旧日志或 heap 取回。
 *   - 未提交来源（splice）：本步 claimed/current epoch，或明确操作按 request_id 精确交接的 heap-only claim。
 *     后者只供该请求的后台处理；普通取证不可读，进程重启/终态释放/新政策后不能恢复。
 *   - 其他旧 unclaimed/blocked/canceled 及无法证明安全的媒体来源保守 hold。
 *   - 可选 `setReadableGate(fn)`：由 Step 9 history coordinator 注入精确 `isReadable(ref)`；
 *     返回 falsy 即视为 fenced。**这是 step4 为 step9 预留的唯一集成缝**（见交付说明）。
 *
 * 预算：`read` 由 processor 计 fetch 调用预算；本模块只对 `recent` 的 `maxChars` 负责，
 * 且**只整块取舍**——绝不截断片段（避免截掉否定/条件）。
 *
 * 本模块不启动任务、不注册 hook、不二次写 session（sessionQuery 只读）。
 */
import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface';
import type { StatementSync } from 'node:sqlite';
import type { EvidenceRow, Store } from './store.js';
import type { SourceActor } from './shared/domain.js';

const ACTOR_USER: SourceActor = 'user';
const ACTOR_CONTEXT: SourceActor = 'context';
const ACTOR_ASSISTANT: SourceActor = 'assistant';
const ACTOR_ACTION: SourceActor = 'action';

const KIND_USER = 'user_message';
const KIND_CONTEXT = 'context';
const KIND_ASSISTANT = 'assistant_message';
const KIND_ACTION = 'verified_action';
const KIND_SPLICE = 'splice';

const MEDIA_BLOCK_TYPES: Record<string, true> = { image: true, file: true };
/** `recent` 单次最多回看的 evidence 行数（正文预算另行裁剪）。 */
const RECENT_SCAN_LIMIT = 200;

// ── 边界形状（dsh-session append / dsh-agent spliced 的实际 envelope）──────
/** session 的最小面：只读 id。 */
interface SessionLike {
  id?: unknown;
}
/** session event：type/seq/time 与 data 由 dsh-session 定义。 */
interface SessionEventLike {
  type?: unknown;
  seq?: unknown;
  time?: unknown;
  data?: unknown;
}
/** event.data：user 消息本身，或 { inserted } / { message } envelope。 */
interface MessageEnvelopeLike {
  id?: unknown;
  source?: unknown;
  content?: unknown;
  toolCallId?: unknown;
  inserted?: unknown;
  message?: unknown;
}
/** message 的最小面：身份、正文、作者判定与行动 call id。 */
interface MessageLike {
  id?: unknown;
  content?: unknown;
  source?: unknown;
  toolCallId?: unknown;
}
/** message source 的最小面：只判定注入上下文。 */
interface SourceLike {
  kind?: unknown;
}
/** content block 的最小面：只读 type/text。 */
interface ContentBlockLike {
  type?: unknown;
  text?: unknown;
}
/** live agent handle 的最小面：会话 id。 */
interface AgentLike {
  session?: { id?: unknown } | null;
  id?: unknown;
}
interface SpliceRow {
  seq?: unknown;
  at?: unknown;
}
interface RequestRow {
  session_id?: unknown;
  kind?: unknown;
  source_ids_json?: unknown;
}
interface ActionStatusRow {
  status?: unknown;
}

/** 边界断言：event/inbox 里的 message 一律先过这里，再逐字段 typeof 检查。 */
function asMessage(value: unknown): MessageLike | null {
  return value && typeof value === 'object' ? (value as MessageLike) : null;
}
/** 边界断言：content 一律先过这里，再逐 block 检查 type/text。 */
function asBlocks(content: unknown): readonly ContentBlockLike[] {
  return Array.isArray(content) ? (content as readonly ContentBlockLike[]) : [];
}

function isoOf(ms: number): string | null {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * evidence id 的 opaque 编码。语义分量是契约里记录的
 * `session:seq:block_index:start:end`；额外内嵌 `message_id` 以保证
 * 同一次 splice 内多消息、同偏移时的 id 唯一（PK 唯一，见 store.js 表约束）。
 */
function encodeId(
  sessionId: string,
  messageId: string,
  seq: number,
  blockIndex: number,
  start: number,
  end: number,
): string {
  return Buffer.from(JSON.stringify([sessionId, messageId, seq, blockIndex, start, end])).toString(
    'base64url',
  );
}

export interface DecodedEvidenceId {
  sessionId: string;
  messageId: string;
  seq: number;
  blockIndex: number;
  start: number;
  end: number;
}

export function decodeEvidenceId(id: unknown): DecodedEvidenceId | null {
  try {
    const parts: unknown = JSON.parse(Buffer.from(String(id), 'base64url').toString('utf8'));
    if (!Array.isArray(parts) || parts.length !== 6) return null;
    const [sessionId, messageId, seq, blockIndex, start, end] = parts;
    if (typeof sessionId !== 'string' || typeof messageId !== 'string') return null;
    if (
      typeof seq !== 'number' ||
      typeof blockIndex !== 'number' ||
      typeof start !== 'number' ||
      typeof end !== 'number'
    )
      return null;
    for (const n of [seq, blockIndex, start, end])
      if (!Number.isSafeInteger(n) || n < 0) return null;
    if (end < start) return null;
    return { sessionId, messageId, seq, blockIndex, start, end };
  } catch {
    return null;
  }
}

/** 一条消息 content 里的 text block（保留原始 block 下标），跳过 reasoning/tool-call/媒体。 */
function textBlocks(content: unknown): Array<{ index: number; text: string }> {
  const blocks = asBlocks(content);
  const out: Array<{ index: number; text: string }> = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block && block.type === 'text' && typeof block.text === 'string')
      out.push({ index, text: block.text });
  }
  return out;
}

function hasMedia(content: unknown): boolean {
  return asBlocks(content).some(
    (block) => typeof block.type === 'string' && MEDIA_BLOCK_TYPES[block.type] === true,
  );
}

function sessionIdOf(agent: unknown): string | null {
  if (!agent || typeof agent !== 'object') return null;
  const handle = agent as AgentLike;
  const value = handle.session?.id ?? handle.id;
  return value == null ? null : String(value);
}

/** `read` 与 `recent` 返回的来源；`at` 可为 null（时间无法解析时）。 */
export interface ResolvedEvidence {
  id: string;
  actor: SourceActor;
  kind: string;
  at: string | null;
  text: string;
}
export interface ExcludedEvidence {
  id: string | null;
  code: string;
}
/** Step 9 注入的 isReadable(ref) 所看到的引用。 */
export interface EvidenceRef {
  id: string;
  session_id: string;
  message_id: string;
  seq: number;
  block_index: number;
  start: number;
  end: number;
  actor: SourceActor;
  kind: string;
}
export interface ReadEvidenceOptions {
  agent?: unknown;
  signal?: AbortSignal | null;
  request_id?: string;
}
export interface RecentEvidenceOptions {
  maxChars?: number;
  actor?: string;
  beforeAt?: number;
  signal?: AbortSignal;
}
/** createEvidenceIndex 的门面，供 processor/history 消费。 */
export interface EvidenceIndex {
  observe(session: unknown, event: unknown): void;
  claimed(agent: unknown, messages: readonly unknown[], turn: number, step: number): string[];
  holdRequest(requestId: string, ids: readonly string[], agent: unknown): boolean;
  releaseRequest(requestId: string): void;
  advanceClaim(
    ids: readonly string[],
    context: { agent: unknown; previousEpoch: number; request_id: string },
  ): boolean;
  read(
    ids: readonly unknown[],
    options?: ReadEvidenceOptions,
  ): Promise<{ sources: ResolvedEvidence[]; excluded: ExcludedEvidence[] }>;
  recent(agent: unknown, options?: RecentEvidenceOptions): Promise<{ sources: ResolvedEvidence[] }>;
  turnWindow(
    sessionId: string,
    fromSeq: number,
    toSeq: number,
  ): Array<{ id: string; actor: string }>;
  setReadableGate(gate: ((ref: EvidenceRef) => unknown) | null): void;
  dispose(): void;
}

interface SurfaceSnapshotLike {
  events?: readonly unknown[];
}
interface SessionQueryLike {
  readSurface(sessionId: string): Promise<SurfaceSnapshotLike | null>;
}
interface PreparedStatements {
  insert: StatementSync;
  byId: StatementSync;
  earliestSplice: StatementSync;
  hasCommitted: StatementSync;
  recent: StatementSync;
  windowIds: StatementSync;
}
interface ActiveClaim {
  turn: number;
  step: number;
  epoch: number | null;
  ids: Set<string>;
}
interface RequestClaim {
  agent: unknown;
  epoch: number | null;
  ids: Set<string>;
}
interface ResolveContext {
  loadSurface: () => Promise<Map<string, MessageLike> | null>;
  agent: unknown;
  requestClaim?: RequestClaim;
}

/**
 * @param deps.store: openStore() 产物；仅用其 `db`（prepared SQL）、`policyEpoch` getter、`readOnly`。
 * @param deps.sessionQuery: dsh-session-query 服务（只读 `readSurface`）。
 */
export function createEvidenceIndex({
  store,
  sessionQuery,
}: { store?: Store; sessionQuery?: SessionQueryLike } = {}): EvidenceIndex {
  if (!store || !store.db || typeof store.db.prepare !== 'function')
    throw new Error('LEPI_STORE_UNAVAILABLE');
  const liveStore = store;
  const db = store.db;
  const writable = store.readOnly !== true;

  /** messageId -> (string|undefined)[]，按下标对齐 content；仅 text block 有字符串。 */
  const bodies = new Map<string, Array<string | undefined>>();
  /** messageId -> boolean：消息是否含 image/file 等媒体/外部引用 block。 */
  const mediaFlags = new Map<string, boolean>();
  /** messageId -> { seq, at }：**首次** splice 的真实 event 序号与毫秒时间（不可刷新）。 */
  const firstSplice = new Map<string, { seq: number; at: number }>();
  /** messageId -> number：首次捕获时的 policy_epoch，用于 fence 后的保守判定。 */
  const captureEpoch = new Map<string, number | null>();
  /** messageId：本进程内已提交（user/assistant/action/context）来源。 */
  const committed = new Set<string>();
  /** sessionId -> { turn, step, epoch, ids:Set<messageId> }：本步 claimed 的活跃输入。 */
  const active = new Map<string | null, ActiveClaim>();
  // Explicit controller-to-worker handoff only; heap-only, exact request/agent/epoch.
  const requestClaims = new Map<string, RequestClaim>();
  /** 可选 Step 9 注入的 isReadable(ref)。 */
  let gate: ((ref: EvidenceRef) => unknown) | null = null;
  let prepared: PreparedStatements | null = null;

  const sql = () =>
    (prepared ??= {
      insert: db.prepare(
        `INSERT OR IGNORE INTO evidence
             (id,session_id,message_id,seq,block_index,start,end,actor,at,kind)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ),
      byId: db.prepare('SELECT * FROM evidence WHERE id=?'),
      earliestSplice: db.prepare(
        `SELECT seq, at FROM evidence WHERE session_id=? AND message_id=? AND kind='splice'
             ORDER BY seq ASC, at ASC LIMIT 1`,
      ),
      hasCommitted: db.prepare(
        `SELECT 1 AS n FROM evidence WHERE session_id=? AND message_id=? AND kind<>'splice' LIMIT 1`,
      ),
      recent: db.prepare(
        `SELECT id FROM evidence WHERE session_id=? AND kind<>'splice'
             AND actor IN ('user','assistant','action')
             ORDER BY seq DESC, block_index DESC LIMIT ?`,
      ),
      windowIds: db.prepare(
        `SELECT id, actor FROM evidence WHERE session_id=? AND kind<>'splice'
             AND actor IN ('user','assistant','action') AND seq>? AND seq<=? ORDER BY seq, block_index`,
      ),
    });

  function epochNow(): number | null {
    try {
      return liveStore.policyEpoch;
    } catch {
      return null;
    }
  }

  function rememberBody(message: MessageLike): void {
    if (!message || message.id == null) return;
    const mid = String(message.id);
    if (!bodies.has(mid)) {
      const arr: Array<string | undefined> = [];
      for (const block of asBlocks(message.content)) {
        arr.push(block.type === 'text' && typeof block.text === 'string' ? block.text : undefined);
      }
      bodies.set(mid, arr);
      mediaFlags.set(mid, hasMedia(message.content));
      if (!captureEpoch.has(mid)) captureEpoch.set(mid, epochNow());
    }
  }

  function persistRows(
    sessionId: string,
    message: MessageLike,
    seq: number,
    at: number,
    actor: SourceActor,
    kind: string,
  ): void {
    if (!writable) return;
    const mid = String(message.id);
    for (const { index, text } of textBlocks(message.content)) {
      const id = encodeId(sessionId, mid, seq, index, 0, text.length);
      sql().insert.run(id, sessionId, mid, seq, index, 0, text.length, actor, at, kind);
    }
  }

  /** 首次 splice wins：仅在从未见过该 message id 时写入一条 splice 行。 */
  function ensureSplice(sessionId: string, message: MessageLike, seq: number, at: number): void {
    const mid = String(message.id);
    rememberBody(message);
    let known = firstSplice.get(mid);
    if (!known) {
      try {
        const row = sql().earliestSplice.get(sessionId, mid) as SpliceRow | undefined;
        if (row) known = { seq: Number(row.seq), at: Number(row.at) };
      } catch {
        known = undefined;
      }
    }
    if (known) {
      firstSplice.set(mid, known); // requeue 同 id：保留最初 seq/at，不刷新
      return;
    }
    firstSplice.set(mid, { seq, at });
    persistRows(sessionId, message, seq, at, ACTOR_USER, KIND_SPLICE);
  }

  function isCommitted(sessionId: string | null, mid: string): boolean {
    if (committed.has(mid)) return true;
    try {
      const row = sql().hasCommitted.get(sessionId, mid);
      if (row) {
        committed.add(mid);
        return true;
      }
    } catch {
      /* keep heap knowledge only */
    }
    return false;
  }

  /** 已提交来源：`at` 采用最初 splice 时间（存在时），保证 requeue 后时间不可变。 */
  function recordCommitted(
    sessionId: string,
    message: MessageLike,
    seq: number,
    at: number,
    actor: SourceActor,
    kind: string,
  ): void {
    const mid = String(message.id);
    rememberBody(message);
    committed.add(mid);
    const splice = firstSplice.get(mid);
    const useAt = splice && Number.isFinite(splice.at) ? splice.at : at;
    persistRows(sessionId, message, seq, useAt, actor, kind);
  }

  function actionExecuted(sessionId: string, callId: unknown): boolean {
    if (callId == null) return false;
    try {
      const row = db
        .prepare('SELECT status FROM actions WHERE session_id=? AND call_id=?')
        .get(sessionId, String(callId)) as ActionStatusRow | undefined;
      return row?.status === 'executed';
    } catch {
      return false;
    }
  }

  /** 注册到 `session/event`（纯 observe；不得重入 append，不得抛穿 append 边界）。 */
  function observe(session: unknown, event: unknown): void {
    if (!session || typeof session !== 'object' || !event || typeof event !== 'object') return;
    const handle = session as SessionLike;
    const envelope = event as SessionEventLike;
    if (!envelope.type) return;
    const sessionId = String(handle.id);
    const data: MessageEnvelopeLike | null =
      envelope.data && typeof envelope.data === 'object'
        ? (envelope.data as MessageEnvelopeLike)
        : null;
    const type = envelope.type as string;
    try {
      switch (type) {
        case 'agent/inbox/spliced': {
          const inserted = data?.inserted;
          if (Array.isArray(inserted)) {
            for (const raw of inserted) {
              const message = asMessage(raw);
              if (message && message.id != null)
                ensureSplice(sessionId, message, Number(envelope.seq), Number(envelope.time));
            }
          }
          break;
        }
        case 'user/message': {
          const message = data;
          if (message && message.id != null) {
            const source = message.source as SourceLike | undefined;
            const context = source?.kind !== 'user';
            recordCommitted(
              sessionId,
              message,
              Number(envelope.seq),
              Number(envelope.time),
              context ? ACTOR_CONTEXT : ACTOR_USER,
              context ? KIND_CONTEXT : KIND_USER,
            );
          }
          break;
        }
        case 'assistant/message': {
          const message = asMessage(data?.message);
          if (message?.id != null) {
            recordCommitted(
              sessionId,
              message,
              Number(envelope.seq),
              Number(envelope.time),
              ACTOR_ASSISTANT,
              KIND_ASSISTANT,
            );
          }
          break;
        }
        case 'tool/result': {
          const message = asMessage(data?.message);
          if (message?.id != null && actionExecuted(sessionId, message.toolCallId)) {
            recordCommitted(
              sessionId,
              message,
              Number(envelope.seq),
              Number(envelope.time),
              ACTOR_ACTION,
              KIND_ACTION,
            );
          }
          break;
        }
        case 'turn/end':
          active.delete(sessionId);
          break;
        default:
          break;
      }
    } catch {
      /* 取证失败绝不能影响 session append（session store 自身也会 contain listener 失败）。 */
    }
  }

  /** 本步即将进入 step 的 messages → 引用最初 splice 的 source id 数组（不读 inbox 本体）。 */
  function claimed(
    agent: unknown,
    messages: readonly unknown[],
    turn: number,
    step: number,
  ): string[] {
    const sessionId = sessionIdOf(agent);
    if (!sessionId) return [];
    const ids: string[] = [];
    const activeIds = new Set<string>();
    for (const raw of Array.isArray(messages) ? messages : []) {
      const message = asMessage(raw);
      if (!message || message.id == null) continue;
      const mid = String(message.id);
      let splice = firstSplice.get(mid);
      if (!splice) {
        try {
          const row = sql().earliestSplice.get(sessionId, mid) as SpliceRow | undefined;
          if (row) splice = { seq: Number(row.seq), at: Number(row.at) };
        } catch {
          splice = undefined;
        }
        if (splice) firstSplice.set(mid, splice);
      }
      if (!splice) continue; // 无 splice 依据：不伪造 seq
      rememberBody(message);
      activeIds.add(mid);
      for (const { index, text } of textBlocks(message.content)) {
        ids.push(encodeId(sessionId, mid, splice.seq, index, 0, text.length));
      }
    }
    active.set(sessionId, { turn, step, epoch: epochNow(), ids: activeIds });
    return ids;
  }

  function holdRequest(requestId: string, ids: readonly string[], agent: unknown): boolean {
    const sessionId = sessionIdOf(agent);
    const row = db
      .prepare('SELECT session_id,kind,source_ids_json FROM requests WHERE id=?')
      .get(requestId) as RequestRow | undefined;
    const refs = ids.map(decodeEvidenceId);
    if (
      !row ||
      row.session_id !== sessionId ||
      !['remember', 'correct', 're_remember'].includes(row.kind as string) ||
      refs.some((ref) => !ref || ref.sessionId !== sessionId)
    )
      return false;
    const sourceIds = JSON.parse(row.source_ids_json as string) as string[];
    if (ids.some((id) => !sourceIds.includes(id))) return false;
    const claim = active.get(sessionId);
    if (
      refs.some(
        (ref) =>
          !ref ||
          (!isCommitted(sessionId, ref.messageId) &&
            (!claim || claim.epoch !== epochNow() || !claim.ids.has(ref.messageId))),
      )
    )
      return false;
    requestClaims.set(requestId, { agent, epoch: epochNow(), ids: new Set(ids) });
    return true;
  }

  function releaseRequest(requestId: string): void {
    requestClaims.delete(requestId);
  }

  // Only the caller's validated, single per-item grant may advance an existing claim.
  function advanceClaim(
    ids: readonly string[],
    {
      agent,
      previousEpoch,
      request_id,
    }: { agent: unknown; previousEpoch: number; request_id: string },
  ): boolean {
    const sessionId = sessionIdOf(agent);
    if (epochNow() !== previousEpoch + 1) return false;
    const uncommitted = ids
      .map((id) => decodeEvidenceId(id))
      .filter(
        (ref): ref is DecodedEvidenceId => !!ref && !isCommitted(ref.sessionId, ref.messageId),
      );
    if (uncommitted.some((ref) => ref.sessionId !== sessionId)) return false;
    if (!uncommitted.length) return true;
    const claim = active.get(sessionId);
    const held = requestClaims.get(request_id);
    const live =
      claim &&
      claim.epoch === previousEpoch &&
      uncommitted.every((ref) => claim.ids.has(ref.messageId));
    const scoped =
      held &&
      held.agent === agent &&
      held.epoch === previousEpoch &&
      ids.every((id) => held.ids.has(id));
    if (!live && !scoped) return false;
    if (live && claim) claim.epoch = epochNow();
    if (scoped && held) held.epoch = epochNow();
    return true;
  }

  function sliceBody(mid: string, row: EvidenceRow): string | null {
    const arr = bodies.get(mid);
    const text = Array.isArray(arr) ? arr[row.block_index] : undefined;
    if (typeof text !== 'string' || row.end > text.length) return null;
    return text.slice(row.start, row.end);
  }

  function sliceMessage(message: MessageLike, row: EvidenceRow): string | null {
    const block = asBlocks(message.content)[row.block_index];
    if (
      !block ||
      block.type !== 'text' ||
      typeof block.text !== 'string' ||
      row.end > block.text.length
    )
      return null;
    return block.text.slice(row.start, row.end);
  }

  function mediaHeld(mid: string): boolean {
    if (!mediaFlags.get(mid)) return false;
    // 有策略门时由 gate 决定；无门且捕获后 epoch 已变 → 保守 hold。
    return (
      typeof gate !== 'function' &&
      captureEpoch.get(mid) != null &&
      captureEpoch.get(mid) !== epochNow()
    );
  }

  async function resolveRow(
    row: EvidenceRow,
    ctx: ResolveContext,
  ): Promise<{ text?: string; code?: string }> {
    const mid = row.message_id;
    const uncommitted = row.kind === KIND_SPLICE && !isCommitted(row.session_id, mid);
    if (mediaHeld(mid)) return { code: 'LEPI_INPUT_RESUBMIT_REQUIRED' };

    if (uncommitted) {
      const a = active.get(row.session_id);
      const held = ctx.requestClaim;
      const live = a && a.ids.has(mid) && a.epoch === epochNow();
      const scoped =
        held && held.agent === ctx.agent && held.epoch === epochNow() && held.ids.has(row.id);
      if (!live && !scoped) return { code: 'LEPI_INPUT_RESUBMIT_REQUIRED' };
      const text = sliceBody(mid, row);
      return text == null ? { code: 'LEPI_CONTROL_UNAVAILABLE' } : { text };
    }

    // 已提交：优先当前 canonical surface（replace/投影已生效，shadowed 不可见）。
    const surfaceMap = await ctx.loadSurface();
    if (surfaceMap) {
      const message = surfaceMap.get(mid);
      const text = message ? sliceMessage(message, row) : null;
      return text == null ? { code: 'LEPI_INPUT_RESUBMIT_REQUIRED' } : { text };
    }
    // 无 canonical surface 证明时不能恢复 heap 中的旧副本。
    return { code: 'LEPI_CONTROL_UNAVAILABLE' };
  }

  /**
   * 受限取证：仅当前会话、仅政策/epoch 允许、仅当前有效 surface 上的明确片段。
   */
  async function read(
    ids: readonly unknown[],
    options: ReadEvidenceOptions = {},
  ): Promise<{ sources: ResolvedEvidence[]; excluded: ExcludedEvidence[] }> {
    const list = Array.isArray(ids) ? ids : [];
    const agent = options.agent ?? null;
    const signal = options.signal ?? null;
    const sessionId = sessionIdOf(agent);
    const sources: ResolvedEvidence[] = [];
    const excluded: ExcludedEvidence[] = [];
    if (!sessionId || !Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      return {
        sources,
        excluded: list.map((id) => ({
          id: typeof id === 'string' ? id : null,
          code: 'LEPI_CONTROL_UNAVAILABLE',
        })),
      };
    }

    let surfaceMap: Map<string, MessageLike> | null | undefined;
    let surfaceLoaded = false;
    const loadSurface = async (): Promise<Map<string, MessageLike> | null> => {
      if (surfaceLoaded) return surfaceMap ?? null;
      surfaceLoaded = true;
      if (!sessionId || !sessionQuery || typeof sessionQuery.readSurface !== 'function')
        return (surfaceMap = null);
      try {
        const snapshot = await sessionQuery.readSurface(sessionId);
        const map = new Map<string, MessageLike>();
        for (const event of snapshot?.events ?? []) {
          let message: MessageLike | null = null;
          try {
            message = deriveEventMessage(event as Parameters<typeof deriveEventMessage>[0]);
          } catch {
            message = null;
          }
          if (message?.id != null) map.set(String(message.id), message);
        }
        surfaceMap = map;
      } catch {
        surfaceMap = null;
      }
      return surfaceMap ?? null;
    };

    const stringIds = ids as readonly string[];
    for (const id of stringIds) {
      if (signal?.aborted) break;
      let row: EvidenceRow | undefined;
      try {
        row = sql().byId.get(id) as EvidenceRow | undefined;
      } catch {
        row = undefined;
      }
      if (!row) {
        excluded.push({ id, code: 'LEPI_CONTROL_UNAVAILABLE' });
        continue;
      }
      if (row.session_id !== sessionId) {
        excluded.push({ id, code: 'LEPI_CONTROL_UNAVAILABLE' });
        continue;
      }
      if (typeof gate === 'function') {
        const ref: EvidenceRef = {
          id,
          session_id: row.session_id,
          message_id: row.message_id,
          seq: Number(row.seq),
          block_index: Number(row.block_index),
          start: Number(row.start),
          end: Number(row.end),
          actor: row.actor,
          kind: row.kind,
        };
        let allowed = false;
        try {
          allowed = Boolean(gate(ref));
        } catch {
          /* gate failure ⇒ conservative hold; allowed stays false */
        }
        if (!allowed) {
          excluded.push({ id, code: 'LEPI_INPUT_RESUBMIT_REQUIRED' });
          continue;
        }
      }
      const requestClaim =
        options.request_id == null ? undefined : requestClaims.get(options.request_id);
      const resolved = await resolveRow(row, { loadSurface, agent, requestClaim });
      if (resolved.text == null) {
        excluded.push({ id, code: resolved.code ?? 'LEPI_CONTROL_UNAVAILABLE' });
        continue;
      }
      sources.push({
        id,
        actor: row.actor,
        kind: row.kind,
        at: isoOf(Number(row.at)),
        text: resolved.text,
      });
    }
    return { sources, excluded };
  }

  /** 当前会话最近可用片段；可先限定作者及 beforeAt(ms)，再按 maxChars 整块裁剪。 */
  async function recent(
    agent: unknown,
    options: RecentEvidenceOptions = {},
  ): Promise<{ sources: ResolvedEvidence[] }> {
    const sessionId = sessionIdOf(agent);
    const maxChars =
      typeof options.maxChars === 'number' &&
      Number.isSafeInteger(options.maxChars) &&
      options.maxChars > 0
        ? options.maxChars
        : 0;
    if (!sessionId || maxChars === 0) return { sources: [] };
    if (options.beforeAt !== undefined && !Number.isFinite(options.beforeAt))
      return { sources: [] };
    let rows: Array<{ id: string }>;
    try {
      rows = sql().recent.all(sessionId, RECENT_SCAN_LIMIT) as Array<{ id: string }>;
    } catch {
      rows = [];
    }
    rows.reverse(); // 升序（旧 → 新）
    const { sources } = await read(
      rows.map((row) => row.id),
      { agent, signal: options.signal },
    );
    const kept: ResolvedEvidence[] = [];
    let used = 0;
    for (let i = sources.length - 1; i >= 0; i -= 1) {
      const source = sources[i];
      if (!source) continue;
      if (options.actor !== undefined && source.actor !== options.actor) continue;
      if (options.beforeAt !== undefined && Date.parse(source.at ?? '') > options.beforeAt)
        continue;
      if (used + source.text.length > maxChars) break; // 整块取舍
      used += source.text.length;
      kept.push(source);
    }
    kept.reverse();
    return { sources: kept };
  }

  /** 只读：取某会话 (fromSeq, toSeq] 区间内 user/assistant/action 的真实已交付证据 id。 */
  function turnWindow(
    sessionId: string,
    fromSeq: number,
    toSeq: number,
  ): Array<{ id: string; actor: string }> {
    return sql().windowIds.all(sessionId, fromSeq, toSeq) as Array<{ id: string; actor: string }>;
  }

  /** Step 9 集成缝：注入精确 isReadable(ref)；传 null 清除（回到本地保守判定）。 */
  function setReadableGate(fn: ((ref: EvidenceRef) => unknown) | null): void {
    gate = typeof fn === 'function' ? fn : null;
  }

  function dispose(): void {
    bodies.clear();
    mediaFlags.clear();
    firstSplice.clear();
    captureEpoch.clear();
    committed.clear();
    active.clear();
    requestClaims.clear();
    gate = null;
  }

  return {
    observe,
    claimed,
    holdRequest,
    releaseRequest,
    advanceClaim,
    read,
    recent,
    turnWindow,
    setReadableGate,
    dispose,
  };
}
