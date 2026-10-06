/**
 * state-runtime.ts — 状态会话运行时（Lepimemory 运行时收敛 Step 10）。
 *
 * 职责（与既有 state/machine/store 的关系）：
 *   - `observe(session, event)`：串联真实 `session/event`（`turn/start` / `user/message` /
 *     `tool/call` / `tool/result` / `turn/end`）到状态机。**纯 observe**：只做 session 之外
 *     的状态记录，绝不重入 `session.append`（对齐 evidence.js 的同名约束）。
 *   - `text({agent})`：native system-prompt section 体（dsh-agent 的 `AssembleContext` 扩了
 *     `agent?`）。按当前 clock 在一个短同步事务里把 mood 向基线衰减并落 `mood.decay` 审计
 *     （关联其 session 及已观察 turn）；无 agent（diagnostic）只返回只读有效视图，**绝不提交**。
 *     失败**fail-closed**：抛稳定错误，绝不回退渲染旧状态（旧原因可能属于已遗忘内容）。
 *   - `readEffective()`：只读有效视图（已衰减、未提交），供面板/diagnostic。
 *
 * 事实来源优先级（务必保持）：
 *   - 工具结果是否算「行动成功」以 `actions` journal 为准（`status='executed'`），
 *     不以 `isError`/renderer 是否报错判断；journal 已执行但 renderer 失败 → 仍算成功。
 *   - 审批 `rejected`/`cancelled`/`unavailable` 与控制/管理工具（如 `manage_memory`）的错误
 *     **不算工具失败**；一般真实工具错误才算失败（machine 里只降 valence，不动 trust）。
 *   - `turn/end` 只在**未结算**的真实 turn 事务里应用：新事实 + 剩余时间衰减 +
 *     `actions.state_applied` + `settled_turns` + 完整 state 审计，同一事务提交。
 *     重复 `turn/end`/重放/重启由 `settled_turns` 与 `state_applied` 保证不二次 brighten/衰减。
 *   - 每次 state 提交的审计都带**完整 state 前后值**（`before`/`after` 是整个 state 对象），
 *     `mood.decay` 也不例外；turn 结算的 `state` 审计为权威终值。
 */
import { advance, decayMood } from './machine.js';
import type { RoundFacts } from './machine.js';
import { renderState } from './shared/state.js';
import type { LepiState } from './shared/state.js';
import type { Store } from './store.js';

/** 审批/控制类工具：其（即使 isError 的）结果绝不折算成工具失败。 */
const DEFAULT_CONTROL_TOOLS = ['manage_memory'];

/** journal 里明确「没执行」的状态；既不是成功也不是失败，直接忽略。 */
const NOT_FAILURES: Record<string, true> = {
  prepared: true,
  rejected: true,
  cancelled: true,
  unavailable: true,
  unknown: true,
};

const TURN_END_STATUS = 'settled';
const META_PREFIX = 'turn_facts:';

/** 一个 turn 的内存账本：只含结构事实（无正文）。 */
interface TurnState {
  turn: number | null;
  userMessages: number;
  toolFailures: number;
  calls: Map<string, string>;
  seq: number | null;
}

/** session/event 的最小结构面（只读这些字段）。 */
interface EventMessageLike {
  toolCallId?: unknown;
  isError?: unknown;
}
interface EventDataLike {
  turn?: number | null;
  source?: { kind?: string } | null;
  callId?: unknown;
  name?: unknown;
  message?: EventMessageLike | null;
}
interface SessionEventLike {
  type?: string;
  seq?: number;
  data?: EventDataLike;
}

interface MetaRow {
  value: string;
}
interface ActionStatusRow {
  action_id: string;
  status: string;
  state_applied: number;
}
interface ActionJoinRow {
  action_id: string;
  session_id: string;
  turn: number | null;
}
interface ExecutedRow {
  action_id: string;
}
interface TurnCallRow {
  action_id: string;
  step: number;
  call_id: string;
  status: string;
}

function numOrNull(value: unknown): number | null {
  return Number.isSafeInteger(value) ? (value as number) : null;
}

function sessionIdOf(session: unknown): string | null {
  if (!session || typeof session !== 'object' || !('id' in session)) return null;
  const id = session.id;
  return id == null ? null : String(id);
}

/**
 * @param deps.store `openStore()` 产物（本模块只用其 `db` / `readOnly` / 同步事务与读）。
 */
export function createStateRuntime({
  store: input,
  now = Date.now,
  controlTools,
}: {
  store?: Store;
  now?: () => number;
  controlTools?: Set<string>;
} = {}) {
  if (!input || !input.db || typeof input.db.prepare !== 'function')
    throw new Error('LEPI_STORE_UNAVAILABLE');
  const store = input;
  const db = store.db;
  const clock = typeof now === 'function' ? now : Date.now;
  const writable = store.readOnly !== true;
  const control = controlTools instanceof Set ? controlTools : new Set(DEFAULT_CONTROL_TOOLS);

  // sessionId -> { turn, userMessages, toolFailures, calls: Map<callId,name>, seq }
  const turns = new Map<string, TurnState>();

  const selectAction = db.prepare(
    'SELECT action_id,session_id,turn,status,state_applied FROM actions WHERE session_id=? AND call_id=?',
  );
  const selectActionById = db.prepare(
    'SELECT status,state_applied,session_id,turn FROM actions WHERE action_id=?',
  );
  const selectUnappliedExecuted = db.prepare(
    "SELECT action_id FROM actions WHERE session_id=? AND turn=? AND status='executed' AND state_applied=0",
  );
  const selectTurnCalls = db.prepare(
    'SELECT action_id,step,call_id,status FROM actions WHERE session_id=? AND turn=? ORDER BY step,call_id',
  );
  const markApplied = db.prepare('UPDATE actions SET state_applied=1 WHERE action_id=?');
  const selectSettled = db.prepare('SELECT 1 FROM settled_turns WHERE session_id=? AND turn=?');
  const insertSettled = db.prepare('INSERT INTO settled_turns(session_id,turn,at) VALUES (?,?,?)');
  const updateState = db.prepare('UPDATE state SET json=? WHERE id=1');
  const readMeta = db.prepare('SELECT value FROM meta WHERE key=?');
  const writeMeta = db.prepare(
    'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  );
  const deleteMeta = db.prepare('DELETE FROM meta WHERE key=?');

  /** 只读有效视图：按 clock 衰减 mood，不落库（diagnostic）。 */
  function effectiveView(atMs: number): LepiState {
    const state = store.readState();
    const decayed = decayMood(state.mood, atMs);
    if (!decayed.changed) return state;
    const next = structuredClone(state);
    next.mood.valence = decayed.valence;
    next.mood.arousal = decayed.arousal;
    next.mood.updatedAt = new Date(atMs).toISOString();
    return next;
  }

  /** 从 meta 重建中途重启丢失的回合事实（只在内存中没有该 session 时）。 */
  function loadTurn(sessionId: string): TurnState | undefined {
    const cached = turns.get(sessionId);
    if (cached) return cached;
    if (!writable) return undefined;
    let row: MetaRow | undefined;
    try {
      row = readMeta.get(META_PREFIX + sessionId) as unknown as MetaRow | undefined;
    } catch {
      return undefined;
    }
    if (!row) return undefined;
    let data: {
      turn?: unknown;
      userMessages?: unknown;
      toolFailures?: unknown;
      calls?: unknown;
      seq?: unknown;
    };
    try {
      data = JSON.parse(row.value) as typeof data;
    } catch {
      return undefined;
    }
    if (!data || !Number.isSafeInteger(data.turn)) return undefined;
    const restored: TurnState = {
      turn: data.turn as number,
      userMessages: Number.isSafeInteger(data.userMessages) ? (data.userMessages as number) : 0,
      toolFailures: Number.isSafeInteger(data.toolFailures) ? (data.toolFailures as number) : 0,
      calls: new Map((Array.isArray(data.calls) ? data.calls : []) as Array<[string, string]>),
      seq: Number.isSafeInteger(data.seq) ? (data.seq as number) : null,
    };
    turns.set(sessionId, restored);
    return restored;
  }

  /** 持久化回合事实（仅元数据，无正文）；短事务。 */
  function persistTurn(sessionId: string, turnState: TurnState | undefined): void {
    if (!writable || !turnState) return;
    const value = JSON.stringify({
      turn: turnState.turn,
      userMessages: turnState.userMessages,
      toolFailures: turnState.toolFailures,
      calls: [...turnState.calls.entries()],
      seq: turnState.seq ?? null,
    });
    store.transaction(() => writeMeta.run(META_PREFIX + sessionId, value));
  }

  /** 由 mood 衰减结果构造完整 decayed state（供 mood.decay 审计的 after）。 */
  function decayedState(
    state: LepiState,
    atMs: number,
  ): { decayed: { valence: number; arousal: number; changed: boolean }; next: LepiState } {
    const decayed = decayMood(state.mood, atMs);
    if (!decayed.changed) return { decayed, next: state };
    const next = structuredClone(state);
    next.mood.valence = decayed.valence;
    next.mood.arousal = decayed.arousal;
    next.mood.updatedAt = new Date(atMs).toISOString();
    return { decayed, next };
  }

  /** turn/end：在未结算的真实 turn 事务内应用事实 + 剩余衰减 + state_applied + settled + 审计。 */
  function settle(sessionId: string, turn: number | null, facts: TurnState | undefined): void {
    if (turn == null) return; // 无 turn 身份不结算（不伪造 turn）
    const key = META_PREFIX + sessionId;
    store.transaction(() => {
      const alreadySettled = Boolean(selectSettled.get(sessionId, turn));
      const pending = readMeta.get(key) as unknown as MetaRow | undefined;
      if (pending && (JSON.parse(pending.value) as { turn?: unknown }).turn === turn)
        deleteMeta.run(key);
      if (alreadySettled) return;
      const at = clock();
      const state = store.readState();
      const { decayed, next: decayedNext } = decayedState(state, at);
      const executed = selectUnappliedExecuted.all(sessionId, turn) as unknown as ExecutedRow[];
      const roundFacts: RoundFacts = {
        userMessages: facts?.userMessages ?? 0,
        toolFailures: facts?.toolFailures ?? 0,
        actionSuccesses: executed.length,
      };
      const result = advance(state, roundFacts, at);
      insertSettled.run(sessionId, turn, at);
      for (const row of executed) markApplied.run(row.action_id);
      if (result.changed) updateState.run(JSON.stringify(result.state));
      if (decayed.changed) {
        store.audit({
          at,
          type: 'mood.decay',
          status: TURN_END_STATUS,
          session_id: sessionId,
          turn,
          data: { before: state, after: decayedNext },
        });
      }
      if (result.changed) {
        store.audit({
          at,
          type: 'state',
          status: TURN_END_STATUS,
          session_id: sessionId,
          turn,
          data: {
            before: state,
            after: result.state,
            fired: result.fired,
            changes: result.changes,
            action_calls: selectTurnCalls.all(sessionId, turn) as unknown as TurnCallRow[],
          },
        });
      }
    });
  }

  /**
   * 迟到的「已执行行动」精确一次回收。
   * 仅在 (session,turn) 已结算（说明该轮确实结束且当时未计入）时补记一次成功。
   */
  function recoverExecutedAction(row: ActionJoinRow): void {
    const sessionId = row.session_id;
    const turn = numOrNull(row.turn);
    if (sessionId == null || turn == null) return;
    if (!selectSettled.get(sessionId, turn)) return; // 未结算：保守跳过
    store.transaction(() => {
      const fresh = selectActionById.get(row.action_id) as unknown as ActionStatusRow | undefined;
      if (!fresh || fresh.status !== 'executed' || fresh.state_applied) return;
      const pending = selectUnappliedExecuted.all(sessionId, turn) as unknown as ExecutedRow[];
      const alreadyCounted = db
        .prepare(
          "SELECT 1 FROM actions WHERE session_id=? AND turn=? AND status='executed' AND state_applied=1 LIMIT 1",
        )
        .get(sessionId, turn);
      const at = clock();
      const state = store.readState();
      const result = advance(
        state,
        { userMessages: 0, toolFailures: 0, actionSuccesses: alreadyCounted ? 0 : 1 },
        at,
      );
      for (const action of pending) markApplied.run(action.action_id);
      if (result.changed) updateState.run(JSON.stringify(result.state));
      store.audit({
        at,
        type: 'state',
        status: 'recovered',
        session_id: sessionId,
        turn,
        data: {
          before: state,
          after: result.changed ? result.state : state,
          fired: result.fired,
          changes: result.changes,
          recovered: true,
          action_ids: pending.map((action) => action.action_id),
          action_calls: selectTurnCalls.all(sessionId, turn) as unknown as TurnCallRow[],
          already_counted: Boolean(alreadyCounted),
          reason: 'action_executed_after_settle',
        },
      });
    });
  }

  /** Explicit startup reconciliation after the file journal has been recovered. */
  function reconcileActions(): void {
    const rows = db
      .prepare(
        `SELECT a.action_id,a.session_id,a.turn FROM actions a
            JOIN settled_turns s ON s.session_id=a.session_id AND s.turn=a.turn
            WHERE a.status='executed' AND a.state_applied=0`,
      )
      .all() as unknown as ActionJoinRow[];
    for (const row of rows) recoverExecutedAction(row);
  }

  function handleToolResult(sessionId: string, event: SessionEventLike): void {
    const turnState = loadTurn(sessionId);
    const message = event.data?.message;
    const callId = message?.toolCallId != null ? String(message.toolCallId) : null;
    const isError = message?.isError === true;
    const name = callId ? turnState?.calls?.get(callId) : undefined;
    if (name && control.has(name)) return; // 控制/管理工具：绝不折算成工具失败

    const row = callId
      ? (selectAction.get(sessionId, callId) as unknown as ActionStatusRow | undefined)
      : undefined;
    if (row) {
      if (row.status === 'executed') {
        if (row.state_applied) return; // 已计入；renderer 报错不得变成失败
        if (!turnState)
          recoverExecutedAction({
            action_id: row.action_id,
            session_id: sessionId,
            turn: numOrNull(event.data?.turn),
          });
        return; // 未结算轮：留到 turn/end 事务统一应用
      }
      if (NOT_FAILURES[row.status] === true) return;
      if (row.status === 'failed' && turnState) {
        turnState.toolFailures += 1;
        persistTurn(sessionId, turnState);
      }
      return;
    }
    // 无 journal 项的普通工具：仅按真实 isError 计失败。
    if (isError && turnState) {
      turnState.toolFailures += 1;
      persistTurn(sessionId, turnState);
    }
  }

  /** 纯 observe：绝不 `session.append`；失败必须被吞掉，不能影响 session append 边界。 */
  function observe(
    session: { id?: unknown } | null | undefined,
    event: SessionEventLike | null | undefined,
  ): void {
    if (!session || !event || !event.type) return;
    const sessionId = sessionIdOf(session);
    if (sessionId == null) return;
    const seq = Number.isSafeInteger(event.seq) ? (event.seq as number) : null;
    try {
      switch (event.type) {
        case 'turn/start': {
          const fresh: TurnState = {
            turn: numOrNull(event.data?.turn),
            userMessages: 0,
            toolFailures: 0,
            calls: new Map(),
            seq,
          };
          turns.set(sessionId, fresh);
          persistTurn(sessionId, fresh);
          break;
        }
        case 'user/message': {
          const turnState = loadTurn(sessionId);
          if (turnState && event.data?.source?.kind === 'user') {
            turnState.userMessages += 1;
            turnState.seq = seq;
            persistTurn(sessionId, turnState);
          }
          break;
        }
        case 'tool/call': {
          const turnState = loadTurn(sessionId);
          if (turnState && event.data?.callId != null) {
            turnState.calls.set(String(event.data.callId), String(event.data?.name ?? ''));
            turnState.seq = seq;
            persistTurn(sessionId, turnState);
          }
          break;
        }
        case 'tool/result': {
          handleToolResult(sessionId, event);
          break;
        }
        case 'turn/end': {
          const turnState = loadTurn(sessionId);
          const turn = numOrNull(event.data?.turn) ?? turnState?.turn ?? null;
          const sameTurn = turnState?.turn === turn;
          if (sameTurn) turns.delete(sessionId);
          settle(sessionId, turn, sameTurn ? turnState : undefined);
          break;
        }
        default:
          break;
      }
    } catch {
      /* 状态观察失败绝不能影响 session append。 */
    }
  }

  /**
   * native section 体：`text({agent})`（`context.agent` 是 dsh-agent 为
   * `systemPrompt.AssembleContext` 扩出的真实字段）。有 agent → 短事务衰减 + mood.decay 审计
   * （完整 state 前后值）；无 agent（diagnostic）只读有效视图，绝不提交。
   * 失败 fail-closed：抛稳定错误，绝不渲染缓冲/旧状态。
   */
  function text(context: { agent?: unknown } = {}): string {
    const at = clock();
    const sessionId = context && typeof context === 'object' ? sessionIdOf(context.agent) : null;
    try {
      if (!writable || sessionId == null) {
        return renderState(effectiveView(at), at);
      }
      const observedTurn = loadTurn(sessionId)?.turn ?? null;
      const effective = store.transaction(() => {
        const state = store.readState();
        const { decayed, next } = decayedState(state, at);
        if (!decayed.changed) {
          return state;
        }
        updateState.run(JSON.stringify(next));
        store.audit({
          at,
          type: 'mood.decay',
          status: 'ok',
          session_id: sessionId,
          turn: observedTurn,
          data: { before: state, after: next },
        });
        return next;
      });
      return renderState(effective, at);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code) throw error; // 传播既有 StoreError 等稳定错误
      throw new Error('LEPI_STATE_UNAVAILABLE', { cause: error });
    }
  }

  function readEffective(): LepiState {
    return effectiveView(clock());
  }

  return { observe, text, readEffective, reconcileActions };
}
