/**
 * 行动工具：能产生**真实副作用**的工具（注册到 `ctx.tools`），执行前经 `ctx.approval` 确认。
 *
 * 目前只有 `write_note`：把一段文字写成一张真实便条（落盘为 `<dataRoot>/notes/<action_id>.md`）。
 * 副作用落在**插件自有目录**，不越权写用户项目。
 *
 * 事实来源（本文件的核心约定）：
 *   - 每次调用分配一个 `action_id`，并先在 SQLite `actions` 表登记 `prepared`（事务外才做 I/O）。
 *   - 落盘先写同目录独占临时文件（`openSync('wx')`，记录 dev/ino）、fsync，再用 `link(final)`
 *     原子只创建；碰撞（EEXIST）**绝不覆盖、绝不宣称成功**。
 *   - 只有把落盘后的最终文件 hash 与登记值核对通过，才在**同一事务**里把该行改成 `executed` 并写完整 audit。
 *   - 审批 rejected/cancelled/unavailable 记录**真实 outcome**（executed=false），不造成功经历。
 *   - 任何文件写/hash/审计失败都抛稳定 `LEPI_NOTE_*` 错误码；工具**正常输出**的 outcome 只有
 *     `allowed-once`/`rejected`/`cancelled`/`unavailable` 四种，真正的 unknown 通过 journal + 抛错呈现。
 *   - 崩溃后遗留的 `prepared` 行由 `recoverActions({store,dataRoot})` 显式对账：最终文件 hash 匹配则
 *     “recovered executed”，否则 `unknown`；**绝不重写、绝不删除无所有权证明的临时文件**。
 *   - `toolResultInfo(message, meta)` 只依据 journal/meta 事实判定成功，不拿 `isError === false` 当成功。
 *
 * 真实身份：`installAction` 订阅原生 `session/event` 的 `tool/call`（含 `turn`/`step`/`callId`/`name`），
 * 在执行前记下本工具的精确 `(sessionId, callId) → {turn, step}`；`turn/end` 清理该会话索引。
 * 执行时按精确 `(sessionId, callId)` 取真实 turn/step（必须为正整数），否则抛 `LEPI_ACTION_IDENTITY`，
 * 绝不猜旧 step。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools';
import type { Store } from './store.js';

/** 会产生真实副作用的工具名（供状态机 / 写路径识别）。 */
export const ACTION_TOOLS = new Set(['write_note']);

/** 本模块注册的工具名。 */
const ACTION_TOOL = 'write_note';

/** 持久 presentationMeta 的 kind。 */
const META_KIND = 'lepimemory-action';

/** 工具**正常输出**允许的 outcome（其余真相一律通过 journal + 抛稳定码呈现）。 */
export const ACTION_OUTCOMES = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable']);

/** 稳定错误码。 */
export const ACTION_ERRORS = {
  empty: 'LEPI_NOTE_EMPTY',
  invalid: 'LEPI_NOTE_INVALID',
  identity: 'LEPI_ACTION_IDENTITY',
  writeFailed: 'LEPI_NOTE_WRITE_FAILED',
  collision: 'LEPI_NOTE_COLLISION',
  unknown: 'LEPI_NOTE_UNKNOWN',
  approvalUnavailable: 'LEPI_APPROVAL_UNAVAILABLE',
} as const;

/** `write_note` 参数 schema（dsh-tools 受限子集）。仅用于本地复核，不做任何 `String(...)` 修补。 */
const NOTE_ARGS_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    body: { type: 'string' },
  },
  required: ['title', 'body'],
};

/** 工具输出 schema：`{action_id,path,title,outcome,executed}`。 */
const NOTE_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action_id: { type: 'string' },
    path: { type: 'string' },
    title: { type: 'string' },
    outcome: { type: 'string' },
    executed: { type: 'boolean' },
  },
  required: ['action_id', 'path', 'title', 'outcome', 'executed'],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ActionError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'ActionError';
    this.code = code;
  }
}

/** 工具输出值（journal 投影）。 */
interface NoteValue {
  action_id: string;
  path: string;
  title: string;
  outcome: string;
  executed: boolean;
}
/** 持久 meta 的已校验归一化结果。 */
interface NormalizedMeta {
  kind: string;
  action_id: string;
  outcome: string;
  executed: boolean;
  path: string;
}
/** tool/result 事件的 message 最小面。 */
interface ToolResultMessageLike {
  toolCallId?: unknown;
  callId?: unknown;
  isError?: unknown;
}
/** `tool/result` 的 `data.meta`：未类型化 JSON。 */
interface MetaLike {
  kind?: unknown;
  action_id?: unknown;
  outcome?: unknown;
  executed?: unknown;
  path?: unknown;
}
/** `actions` 行。 */
interface ActionRow {
  action_id: string;
  session_id: string;
  turn: number;
  step: number;
  call_id: string;
  title: string | null;
  path: string | null;
  temp_path: string | null;
  body_hash: string | null;
  status: string;
  error_code: string | null;
}
interface PreparedRow {
  action_id: string;
  session_id: string;
  turn: number;
  step: number;
  call_id: string;
  title: string;
  path: string;
  temp_path: string;
  body_hash: string;
}
interface TerminalRow {
  action_id: string;
  session_id: string;
  turn: number;
  step: number;
  call_id: string;
  title: string;
}
interface TempIdentity {
  dev: bigint;
  ino: bigint;
}
interface NoteArgs {
  title: string;
  body: string;
}
interface AgentLike {
  session?: { id?: string } | null;
  id?: string;
}
interface ActionExec {
  agent: AgentLike;
  callId?: unknown;
  signal?: AbortSignal;
}
interface ApprovalLike {
  request(options: unknown): Promise<string>;
}
interface ActionEventLike {
  type?: string;
  data?: { name?: unknown; callId?: unknown; turn?: unknown; step?: unknown } | null;
}
interface ActionLogger {
  error?(...args: unknown[]): void;
}
interface ActionContext {
  tools?: { register(tool: unknown): unknown };
  on?(name: string, listener: (session: unknown, event: ActionEventLike) => void): unknown;
  effect(fn: () => unknown, label: string): unknown;
  get?(name: string): ApprovalLike | undefined;
}

/**
 * 从 `tool/result` 事件的 message/meta 里取执行事实。
 * @param message V4 first-class tool-role 消息（`toolCallId`/`isError` 在顶层）。
 * @param meta `tool/result` 事件 `data.meta`，即工具 `output.presentationMeta` 的持久投影。
 */
export function toolResultInfo(
  message: ToolResultMessageLike | null | undefined,
  meta: unknown,
): { callId: string | null; isError: boolean; metadata: NormalizedMeta | null } {
  const callId = message?.toolCallId ?? message?.callId ?? null;
  const isError = message?.isError === true;
  return { callId: callId == null ? null : String(callId), isError, metadata: normalizeMeta(meta) };
}

/** 校验并归一化持久 meta；形状不合法一律返回 null（不因可疑 payload 破坏调用方）。 */
function normalizeMeta(meta: unknown): NormalizedMeta | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const value = meta as MetaLike;
  if (value.kind !== META_KIND) return null;
  if (typeof value.action_id !== 'string' || !value.action_id) return null;
  if (!ACTION_OUTCOMES.has(value.outcome as string)) return null;
  if (typeof value.executed !== 'boolean') return null;
  if (typeof value.path !== 'string') return null;
  return {
    kind: META_KIND,
    action_id: value.action_id,
    outcome: value.outcome as string,
    executed: value.executed,
    path: value.path,
  };
}

/** 把工具结果渲染成模型可见文本。只有 journal 确认 executed 才宣称已写下。 */
function renderNote(value: NoteValue): string {
  if (value?.executed === true && typeof value.path === 'string' && value.path) {
    return `已写下便条《${value.title}》→ ${value.path}`;
  }
  switch (value?.outcome) {
    case 'rejected':
      return '用户拒绝了，未写便条。';
    case 'cancelled':
      return '便条写入已取消。';
    case 'unavailable':
      return '没有可用的确认通道，未写便条。';
    default:
      return `便条未写入（outcome=${value?.outcome ?? 'unknown'}，executed=false）。`;
  }
}

/** 从 agent 取真实 session id。 */
function sessionIdOf(agent: AgentLike | null | undefined): string | null {
  const id = agent?.session?.id ?? agent?.id;
  return id == null ? null : String(id);
}

/** 从任意 session 值取 id（event feed 边界）。 */
function sessionKeyOf(session: unknown): string | null {
  if (!session || typeof session !== 'object' || !('id' in session)) return null;
  const id = session.id;
  return id == null ? null : String(id);
}

/** 便条落盘正文（确定性；hash 基于它的 UTF-8 字节）。 */
function noteContent(title: string, body: string): string {
  return `# ${title}\n\n${body}\n`;
}

function sha256hex(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function hashFile(file: string): string {
  return sha256hex(fs.readFileSync(file));
}

/** 便条最终路径必须是我们自己推导的确切路径，否则不读、不写、不删。 */
function exactNotePath(dataRoot: string, actionId: string): string | null {
  if (typeof dataRoot !== 'string' || !dataRoot) return null;
  if (typeof actionId !== 'string' || !UUID_RE.test(actionId)) return null;
  return path.join(dataRoot, 'notes', `${actionId}.md`);
}

/** 只删除确实由本调用创建、且未被替换的临时文件（dev/ino 双重校验）。 */
function removeOwnTemp(temp: string | null, identity: TempIdentity | null): void {
  if (!identity || typeof temp !== 'string' || !temp) return;
  try {
    const st = fs.statSync(temp, { bigint: true });
    if (st.dev !== identity.dev || st.ino !== identity.ino) return;
    fs.unlinkSync(temp);
  } catch {
    /* Already gone or replaced; never delete a foreign file. */
  }
}

function findAction(store: Store, sessionId: string, callId: string): ActionRow | undefined {
  return store.db
    .prepare('SELECT * FROM actions WHERE session_id=? AND call_id=?')
    .get(sessionId, callId) as unknown as ActionRow | undefined;
}

function value(
  action_id: string,
  p: string,
  title: string,
  outcome: string,
  executed: boolean,
): NoteValue {
  return { action_id, path: p, title, outcome, executed };
}

/** 事务：登记 prepared 行 + audit（I/O 之前，以便崩溃可对账）。 */
function insertPrepared(store: Store, row: PreparedRow): void {
  store.transaction(() => {
    store.db
      .prepare(
        `INSERT INTO actions
                 (action_id,session_id,turn,step,call_id,title,path,temp_path,body_hash,status,error_code,state_applied)
                 VALUES (?,?,?,?,?,?,?,?,?,'prepared',NULL,0)`,
      )
      .run(
        row.action_id,
        row.session_id,
        row.turn,
        row.step,
        row.call_id,
        row.title,
        row.path,
        row.temp_path,
        row.body_hash,
      );
    store.audit({
      type: 'action',
      status: 'prepared',
      session_id: row.session_id,
      turn: row.turn,
      step: row.step,
      call_id: row.call_id,
      data: {
        action_id: row.action_id,
        outcome: 'allowed-once',
        executed: false,
        hash: row.body_hash,
      },
    });
  });
}

/** 事务：记录未执行的真实 outcome（rejected/cancelled/unavailable），executed=false。 */
function recordTerminal(
  store: Store,
  row: TerminalRow,
  outcome: string,
  errorCode: string | null,
): void {
  store.transaction(() => {
    store.db
      .prepare(
        `INSERT INTO actions
                 (action_id,session_id,turn,step,call_id,title,path,temp_path,body_hash,status,error_code,state_applied)
                 VALUES (?,?,?,?,?,?,NULL,NULL,NULL,?,?,0)`,
      )
      .run(
        row.action_id,
        row.session_id,
        row.turn,
        row.step,
        row.call_id,
        row.title,
        outcome,
        errorCode ?? null,
      );
    store.audit({
      type: 'action',
      status: outcome,
      session_id: row.session_id,
      turn: row.turn,
      step: row.step,
      call_id: row.call_id,
      data: { action_id: row.action_id, outcome, executed: false, error_code: errorCode ?? null },
    });
  });
}

/** 事务：最终文件 hash 已核对 → executed + 完整 audit。 */
function markExecuted(store: Store, row: PreparedRow, recovered: boolean): void {
  store.transaction(() => {
    store.db
      .prepare(
        "UPDATE actions SET status='executed', path=?, temp_path=NULL, error_code=NULL WHERE action_id=?",
      )
      .run(row.path, row.action_id);
    store.audit({
      type: 'action',
      status: 'executed',
      session_id: row.session_id,
      turn: row.turn,
      step: row.step,
      call_id: row.call_id,
      data: {
        action_id: row.action_id,
        outcome: 'allowed-once',
        executed: true,
        hash: row.body_hash,
        recovered: recovered === true,
      },
    });
  });
}

/** 事务：无法证明成功（碰撞/失配/对账失败）→ unknown；绝不重写。 */
function markUnknown(
  store: Store,
  row: { action_id: string; session_id: string; turn: number; step: number; call_id: string },
  errorCode: string,
): void {
  store.transaction(() => {
    store.db
      .prepare("UPDATE actions SET status='unknown', error_code=? WHERE action_id=?")
      .run(errorCode, row.action_id);
    store.audit({
      type: 'action',
      status: 'unknown',
      session_id: row.session_id,
      turn: row.turn,
      step: row.step,
      call_id: row.call_id,
      data: {
        action_id: row.action_id,
        outcome: 'unknown',
        executed: false,
        error_code: errorCode,
      },
    });
  });
}

/** 事务：确证未落盘（I/O 前失败）→ failed。 */
function markFailed(
  store: Store,
  row: { action_id: string; session_id: string; turn: number; step: number; call_id: string },
  errorCode: string,
): void {
  store.transaction(() => {
    store.db
      .prepare("UPDATE actions SET status='failed', error_code=? WHERE action_id=?")
      .run(errorCode, row.action_id);
    store.audit({
      type: 'action',
      status: 'failed',
      session_id: row.session_id,
      turn: row.turn,
      step: row.step,
      call_id: row.call_id,
      data: { action_id: row.action_id, outcome: 'failed', executed: false, error_code: errorCode },
    });
  });
}

/**
 * 对账一条 `prepared` 行：仅当精确路径可推导、最终文件 hash 匹配才 recovered executed，否则 unknown。
 * 不读/删任何非精确推导出的路径，不清理临时文件（无持久所有权证明）。
 * @returns 对账后的 status。
 */
function finalizePrepared(store: Store, row: ActionRow, dataRoot: string): 'executed' | 'unknown' {
  const expected = exactNotePath(dataRoot, row.action_id);
  let matches = false;
  if (
    expected &&
    row.path === expected &&
    typeof row.body_hash === 'string' &&
    row.body_hash.length === 64
  ) {
    try {
      matches = hashFile(expected) === row.body_hash;
    } catch {
      matches = false;
    }
  }
  if (matches) {
    markExecuted(store, row as unknown as PreparedRow, true);
    return 'executed';
  }
  markUnknown(store, row, 'LEPI_NOTE_UNKNOWN');
  return 'unknown';
}

/**
 * 显式初始化对账：扫描遗留 `prepared` 行动，核对最终文件，绝不重写一次。
 */
export function recoverActions({ store, dataRoot }: { store?: Store | null; dataRoot: string }): {
  scanned: number;
  recovered: string[];
  unknown: string[];
} {
  if (!store || typeof store.db?.prepare !== 'function')
    return { scanned: 0, recovered: [], unknown: [] };
  const rows = store.db
    .prepare("SELECT * FROM actions WHERE status='prepared'")
    .all() as unknown as ActionRow[];
  const recovered: string[] = [];
  const unknown: string[] = [];
  for (const row of rows) {
    const status = finalizePrepared(store, row, dataRoot);
    if (status === 'executed') recovered.push(row.action_id);
    else unknown.push(row.action_id);
  }
  return { scanned: rows.length, recovered, unknown };
}

/** 把已有 journal 行投影成工具输出。终态 executed 成功；unknown/failed 抛稳定码（绝不假成功）。 */
function existingValue(
  store: Store,
  row: ActionRow,
  dataRoot: string,
  fallbackTitle: string,
): NoteValue {
  let status = row.status;
  if (status === 'prepared') status = finalizePrepared(store, row, dataRoot);
  if (status === 'executed')
    return value(row.action_id, row.path!, row.title ?? fallbackTitle, 'allowed-once', true);
  if (status === 'rejected' || status === 'cancelled' || status === 'unavailable') {
    return value(row.action_id, '', row.title ?? fallbackTitle, status, false);
  }
  throw new ActionError(
    row.error_code === 'LEPI_NOTE_COLLISION' ? 'LEPI_NOTE_COLLISION' : 'LEPI_NOTE_UNKNOWN',
  );
}

function isUniqueViolation(error: unknown): boolean {
  const message = error && typeof error === 'object' && 'message' in error ? error.message : '';
  return /UNIQUE/i.test(String(message ?? ''));
}

function errorCodeOf(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : null;
}

/**
 * 安装行动工具（若 config.action.enabled === false、工具注册表缺失或缺少 store/dataRoot 则跳过）。
 * 显式初始化时先对账遗留 prepared 行动，并订阅原生 `session/event` 记录本工具调用的真实 turn/step。
 */
export function installAction(
  ctx: ActionContext,
  config: { action?: { enabled?: boolean } } | null | undefined,
  { logger, store, dataRoot }: { logger?: ActionLogger; store: Store; dataRoot: string },
): void {
  if (config?.action?.enabled === false) return;
  const tools = ctx.tools;
  if (!tools || typeof tools.register !== 'function') return;
  if (
    !store ||
    typeof store.transaction !== 'function' ||
    typeof dataRoot !== 'string' ||
    !dataRoot
  )
    return;

  try {
    recoverActions({ store, dataRoot });
  } catch {
    logger?.error?.('lepimemory-action: 遗留行动对账失败');
  }

  /** sessionId -> Map(callId -> {turn, step})：本工具真实调用的 turn/step。 */
  const callIndex = new Map<string, Map<string, { turn: unknown; step: unknown }>>();
  if (typeof ctx.on === 'function') {
    ctx.on('session/event', (session, event) => {
      try {
        const sid = sessionKeyOf(session);
        if (!sid || !event?.type) return;
        if (event.type === 'tool/call' && event.data?.name === ACTION_TOOL) {
          let byCall = callIndex.get(sid);
          if (!byCall) {
            byCall = new Map();
            callIndex.set(sid, byCall);
          }
          byCall.set(String(event.data.callId), { turn: event.data.turn, step: event.data.step });
        } else if (event.type === 'turn/end') {
          callIndex.delete(sid);
        }
      } catch {
        /* never let bookkeeping break the event feed */
      }
    });
  }

  ctx.effect(
    () =>
      tools.register({
        name: ACTION_TOOL,
        description:
          '把一段文字写成一张真实便条（落盘为文件）。执行前会请求用户确认。当用户明确要你“记下来/写下来/记一张便条”时调用。',
        parameters: NOTE_ARGS_SCHEMA,
        output: {
          schema: NOTE_OUTPUT_SCHEMA,
          render: (_args: unknown, val: NoteValue) => [{ type: 'text', text: renderNote(val) }],
          presentationMeta: (_args: unknown, val: NoteValue) => ({
            kind: META_KIND,
            action_id: val.action_id,
            outcome: val.outcome,
            executed: val.executed,
            path: val.path,
          }),
        },
        execute: async (args: NoteArgs, exec: ActionExec) => {
          const violations = validateJsonSchemaValue(NOTE_ARGS_SCHEMA, args, 'args');
          if (violations.length) throw new ActionError('LEPI_NOTE_INVALID');
          const title = args.title.trim();
          const body = args.body.trim();
          if (!title || !body) throw new ActionError('LEPI_NOTE_EMPTY');

          const sessionId = sessionIdOf(exec.agent);
          const callId = exec.callId == null ? null : String(exec.callId);
          if (!sessionId || !callId) throw new ActionError('LEPI_ACTION_IDENTITY');

          const observed = callIndex.get(sessionId)?.get(callId);
          const turn = observed?.turn;
          const step = observed?.step;
          if (
            !Number.isSafeInteger(turn) ||
            (turn as number) <= 0 ||
            !Number.isSafeInteger(step) ||
            (step as number) <= 0
          ) {
            throw new ActionError('LEPI_ACTION_IDENTITY');
          }
          const identity = {
            session_id: sessionId,
            turn: turn as number,
            step: step as number,
            call_id: callId,
            title,
          };

          const existing = findAction(store, sessionId, callId);
          if (existing) return existingValue(store, existing, dataRoot, title);

          const actionId = randomUUID();
          const final = exactNotePath(dataRoot, actionId)!;
          const content = noteContent(title, body);
          const hash = sha256hex(Buffer.from(content, 'utf8'));

          if (exec.signal?.aborted) {
            recordTerminal(store, { ...identity, action_id: actionId }, 'cancelled', null);
            return value(actionId, '', title, 'cancelled', false);
          }

          const approver = ctx.get ? ctx.get('approval') : undefined;
          let outcome = 'unavailable';
          let errorCode: string | null = null;
          if (approver && typeof approver.request === 'function') {
            try {
              outcome = await approver.request({
                agent: exec.agent,
                toolName: ACTION_TOOL,
                callId: exec.callId,
                reason: `写一张便条：${title}`,
                displayReason: {
                  zh: `写一张便条：${title}`,
                  en: `Write a note titled "${title}".`,
                },
                ...(exec.signal ? { signal: exec.signal } : {}),
              });
            } catch {
              outcome = 'unavailable';
              errorCode = ACTION_ERRORS.approvalUnavailable;
            }
          } else {
            errorCode = ACTION_ERRORS.approvalUnavailable;
          }

          if (outcome === 'rejected' || outcome === 'cancelled' || outcome === 'unavailable') {
            recordTerminal(store, { ...identity, action_id: actionId }, outcome, errorCode);
            return value(actionId, '', title, outcome, false);
          }
          if (outcome !== 'allowed-once') {
            recordTerminal(
              store,
              { ...identity, action_id: actionId },
              'unavailable',
              ACTION_ERRORS.approvalUnavailable,
            );
            return value(actionId, '', title, 'unavailable', false);
          }
          if (exec.signal?.aborted) {
            recordTerminal(store, { ...identity, action_id: actionId }, 'cancelled', null);
            return value(actionId, '', title, 'cancelled', false);
          }

          const temp = path.join(path.dirname(final), `.${actionId}.${randomUUID()}.tmp`);
          const prepared: PreparedRow = {
            ...identity,
            action_id: actionId,
            path: final,
            temp_path: temp,
            body_hash: hash,
          };
          try {
            insertPrepared(store, prepared);
          } catch (error) {
            if (isUniqueViolation(error)) {
              const row = findAction(store, sessionId, callId);
              if (row) return existingValue(store, row, dataRoot, title);
            }
            throw new ActionError('LEPI_NOTE_WRITE_FAILED');
          }

          let tempIdentity: TempIdentity | null = null;
          try {
            fs.mkdirSync(path.dirname(final), { recursive: true, mode: 0o700 });
            const fd = fs.openSync(temp, 'wx', 0o600);
            const st = fs.fstatSync(fd, { bigint: true });
            tempIdentity = { dev: st.dev, ino: st.ino };
            try {
              fs.writeSync(fd, content);
              fs.fsyncSync(fd);
            } finally {
              fs.closeSync(fd);
            }
            fs.linkSync(temp, final);
          } catch (error) {
            removeOwnTemp(temp, tempIdentity);
            if (errorCodeOf(error) === 'EEXIST') {
              markUnknown(store, prepared, 'LEPI_NOTE_COLLISION');
              throw new ActionError('LEPI_NOTE_COLLISION');
            }
            markFailed(store, prepared, 'LEPI_NOTE_WRITE_FAILED');
            throw new ActionError('LEPI_NOTE_WRITE_FAILED');
          }
          removeOwnTemp(temp, tempIdentity);

          let verified: boolean;
          try {
            verified = hashFile(final) === hash;
          } catch {
            verified = false;
          }
          if (!verified) {
            markUnknown(store, prepared, 'LEPI_NOTE_UNKNOWN');
            throw new ActionError('LEPI_NOTE_UNKNOWN');
          }

          try {
            markExecuted(store, prepared, false);
          } catch {
            // A real file exists but the execution audit did not commit: keep
            // `prepared` for recovery and report unknown, never a false failure.
            logger?.error?.('lepimemory-action: 行动执行审计未提交');
            throw new ActionError('LEPI_NOTE_UNKNOWN');
          }
          return value(actionId, final, title, 'allowed-once', true);
        },
      }),
    'lepimemory.write_note()',
  );
}
