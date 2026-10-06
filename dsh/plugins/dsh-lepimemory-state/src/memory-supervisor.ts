/**
 * 记忆协调 supervisor：唯一 tick/作业槽/lease 与计时器 owner。
 * 具体的 normalize/admit 处理（runTask）与远端 write/curate 抽水（runRemote）由 facade 注入，
 * 本模块不 import pipeline，保持 import 图有向无环。
 */
import { randomUUID } from 'node:crypto';
import { parseJson } from './json.js';
import {
  BACKOFF,
  GENERIC_CODE,
  errorCodeOf,
  identityOf,
  type SetErrorFn,
  type AuditFn,
  type TaskHooks,
} from './memory-common.js';
import type { EvidenceIndex } from './evidence.js';
import type { Store, TaskRowRecord } from './store.js';
import type { TaskStore } from './task-store.js';
import type { CandidateStore } from './candidate-store.js';
import type { TaskStatus } from './shared/domain.js';

const NORMALIZE = 'normalize';
const WRITE = 'write';

/** supervisor 固定 tick。 */
const TICK_MS = 2000;

/** 只处理这些 turn/end reason（rc2 `TurnEndReasonMap`）；其余不算「已交付」的结束。 */
const DELIVERED_REASONS: Record<string, true> = {
  completed: true,
  interrupted: true,
  aborted: true,
};

/** 可被 operator retry 唤醒的终态/停顿态（不复活 cancelled/expired 的政策性终止）。 */
const RETRYABLE_STATUS: Record<string, true> = { deferred: true, unknown: true, failed: true };

interface TurnStart {
  turn: unknown;
  seq: number;
}

/** 会话事件边界读取：`session/event` 的真实事件先按 unknown 收窄，只读本模块用到的字段。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export interface EnqueueInput {
  request_id?: string | null;
  session_id?: string | null;
  source_ids?: readonly unknown[];
  kind?: string | null;
  explicit?: boolean;
  turn?: number | null;
}

export interface MemoryRetryReceipt {
  task_id: string;
  kind: string;
  status: string;
  code: string | null;
  retryable: boolean;
}

export interface SupervisorStatus {
  running: string | null;
  remoteRunning: boolean;
  tasks: Record<string, Record<string, number>>;
  total: number;
}

/** supervisor 的显式门面。 */
export interface Supervisor {
  enqueue(input: EnqueueInput): { task_id: string };
  afterTurn(session: { id?: unknown } | null | undefined, event: unknown): void;
  start(): void;
  wake(): void;
  retry(taskId: string): MemoryRetryReceipt | null;
  drain(): Promise<void>;
  status(): SupervisorStatus;
}

interface SupervisorDeps {
  store: Store;
  taskStore: TaskStore;
  candidateStore: CandidateStore;
  evidence: EvidenceIndex;
  now: () => number;
  taskTtlMs: number;
  isStarted: () => boolean;
  isDisposed: () => boolean;
  setError: SetErrorFn;
  audit: AuditFn;
  runTask(task: TaskRowRecord, signal: AbortSignal, hooks: TaskHooks): Promise<void>;
  runRemote(signal: AbortSignal, prefer: 'curate' | 'write'): Promise<boolean>;
}

export function createSupervisor({
  store,
  taskStore,
  candidateStore,
  evidence,
  now,
  taskTtlMs,
  isStarted,
  isDisposed,
  setError,
  audit,
  runTask,
  runRemote,
}: SupervisorDeps): Supervisor {
  const turnStarts = new Map<string, TurnStart>(); // sessionId -> { turn, seq }
  const controllers = new Map<string, AbortController>(); // taskId -> AbortController
  let tickTimer: NodeJS.Timeout | null = null;
  let wakeTimer: NodeJS.Timeout | null = null;
  let job: Promise<void> | null = null; // 当前 normalize/admit 作业的 promise
  let remoteJob: Promise<void> | null = null;
  let remoteController: AbortController | null = null;
  let preferCurate = true;
  let currentTaskId: string | null = null;
  let ownerId: string | null = null; // 懒生成：lease owner 标识

  function leaseOwner(): string {
    return (ownerId ??= `${process.pid}-${randomUUID()}`);
  }

  // ── 任务终态/重试 ──────────────────────────────────────────────────
  function finish(
    task: TaskRowRecord,
    status: string,
    code: string | null = null,
    { clearDraft = false }: { clearDraft?: boolean } = {},
  ): void {
    try {
      taskStore.finish(
        task.id,
        {
          status: status as TaskStatus,
          code,
          nextAt: now(),
          draftJson: clearDraft ? null : task.draft_json,
        },
        {
          type: 'task',
          status,
          at: now(),
          ...identityOf(task),
          task_id: task.id,
          data: { kind: task.kind, code },
        },
      );
    } catch (error) {
      setError(errorCodeOf(error) ?? GENERIC_CODE);
    }
  }

  /** 有界网络退避：最多三次（1s/2s/4s）置回 pending；到顶转 deferred。绝不复活已终态任务。 */
  function scheduleRetry(task: TaskRowRecord, code: string = GENERIC_CODE): void {
    try {
      const retries = (task.attempts ?? 0) + 1;
      const deferred = retries > BACKOFF.length;
      const status: TaskStatus = deferred ? 'deferred' : 'pending';
      const nextAt = deferred ? now() : now() + (BACKOFF[retries - 1] ?? 0);
      taskStore.retry(
        task.id,
        { status, attempts: retries, code, nextAt },
        {
          type: 'task',
          status: deferred ? 'deferred' : 'retrying',
          at: now(),
          ...identityOf(task),
          task_id: task.id,
          data: deferred ? { kind: task.kind, code } : { kind: task.kind, code, attempt: retries },
        },
      );
    } catch (error) {
      setError(errorCodeOf(error) ?? GENERIC_CODE);
    }
  }

  function patchPayload(
    task: TaskRowRecord,
    patch: Record<string, unknown>,
  ): Record<string, unknown> {
    try {
      const next = { ...parseJson<Record<string, unknown>>(task.payload_json, {}), ...patch };
      taskStore.patchPayload(task.id, JSON.stringify(next));
      task.payload_json = JSON.stringify(next);
      return next;
    } catch (error) {
      setError(errorCodeOf(error) ?? GENERIC_CODE);
      return parseJson<Record<string, unknown>>(task.payload_json, {});
    }
  }

  // ── enqueue / afterTurn（只入 refs；去重按真实 request/turn 元数据）─────
  function enqueue(input: EnqueueInput): { task_id: string } {
    if (isDisposed()) throw new Error(GENERIC_CODE);
    const requestId =
      typeof input?.request_id === 'string' && input.request_id ? input.request_id : null;
    const sessionId = typeof input?.session_id === 'string' ? input.session_id : null;
    const sourceIds = Array.isArray(input?.source_ids)
      ? [
          ...new Set(
            input.source_ids.filter((id): id is string => typeof id === 'string' && id !== ''),
          ),
        ]
      : [];
    if (!sessionId || sourceIds.length === 0) throw new Error(GENERIC_CODE);

    if (requestId) {
      const existing = taskStore.findByRequest(requestId);
      if (existing) return { task_id: existing.id };
    }

    const id = randomUUID();
    const payload = {
      session_id: sessionId,
      source_ids: sourceIds,
      kind: input.kind ?? null,
      explicit: input.explicit === true,
      request_id: requestId,
      turn: Number.isSafeInteger(input.turn) ? input.turn : null,
    };
    store.transaction(() => {
      taskStore.insert({
        id,
        kind: NORMALIZE,
        candidateId: null,
        requestId,
        status: 'pending',
        draftJson: null,
        payloadJson: JSON.stringify(payload),
        nextAt: now(),
        expiresAt: now() + taskTtlMs,
      });
      audit(
        'task',
        'pending',
        { session_id: sessionId, request_id: requestId, task_id: id },
        { kind: NORMALIZE, source_count: sourceIds.length, explicit: payload.explicit },
      );
    });
    wake();
    return { task_id: id };
  }

  function evidenceForTurn(
    sessionId: string,
    fromSeq: number,
    toSeq: number,
  ): Array<{ id: string; actor: string }> {
    try {
      return evidence.turnWindow(sessionId, fromSeq, toSeq);
    } catch (error) {
      setError(errorCodeOf(error) ?? GENERIC_CODE);
      return [];
    }
  }

  function turnAlreadyQueued(sessionId: string, turn: unknown): boolean {
    for (const row of taskStore.listNormalizePayloads()) {
      const payload = parseJson<Record<string, unknown>>(row.payload_json, {});
      if (payload.session_id === sessionId && payload.turn === turn) return true;
    }
    return false;
  }

  /**
   * 只观测当前 turn/end 已交付的公共证据（真实 Session/evidence IDs），不做工具非 error 成功；
   * 未在当前 live 进程见证 turn/start 的结束（含冷 resume 的 interrupted closer）不重建。
   */
  function afterTurn(session: { id?: unknown } | null | undefined, event: unknown): void {
    if (isDisposed()) return;
    const record = asRecord(event);
    if (!record) return;
    const type = record.type;
    if (typeof type !== 'string' || !type) return;
    const sessionId = String(session?.id ?? '');
    if (!sessionId) return;
    const data = asRecord(record.data);
    if (type === 'turn/start') {
      turnStarts.set(sessionId, { turn: data?.turn, seq: Number(record.seq) });
      return;
    }
    if (type !== 'turn/end') return;
    const start = turnStarts.get(sessionId);
    turnStarts.delete(sessionId);
    const reason = asRecord(data?.reason)?.kind;
    if (typeof reason !== 'string' || !DELIVERED_REASONS[reason]) return;
    if (!start) return; // 冷 resume：无本进程见证，不偷读/不重建
    const turn = typeof data?.turn === 'number' ? data.turn : undefined;
    const rows = evidenceForTurn(sessionId, start.seq, Number(record.seq));
    if (
      reason !== 'completed' &&
      !rows.some((row) => row.actor === 'assistant' || row.actor === 'action')
    )
      return;
    const sourceIds = rows.map((row) => row.id);
    if (sourceIds.length === 0) return;
    if (turnAlreadyQueued(sessionId, turn)) return;
    const id = randomUUID();
    const payload = {
      session_id: sessionId,
      source_ids: sourceIds,
      kind: null,
      explicit: false,
      request_id: null,
      turn: turn ?? null,
    };
    store.transaction(() => {
      taskStore.insert({
        id,
        kind: NORMALIZE,
        candidateId: null,
        requestId: null,
        status: 'pending',
        draftJson: null,
        payloadJson: JSON.stringify(payload),
        nextAt: now(),
        expiresAt: now() + taskTtlMs,
      });
      audit(
        'task',
        'pending',
        { session_id: sessionId, turn: turn ?? null, task_id: id },
        { kind: NORMALIZE, source_count: sourceIds.length, reason },
      );
    });
    wake();
  }

  // ── supervisor：2s tick、单作业、短事务 claim/lease ──────────────────
  function claimReady(): TaskRowRecord | null {
    try {
      return taskStore.claimReady(leaseOwner(), now());
    } catch (error) {
      setError(errorCodeOf(error) ?? GENERIC_CODE);
      return null;
    }
  }

  function expireSweep(): void {
    try {
      store.transaction(() => {
        for (const row of taskStore.dueForExpiry(now())) {
          // 未获准/重试中的任务清正文相关 payload；已获准的 pending write 仅清 draft，保留非正文操作信息。
          taskStore.expireRow(row.id, row.kind === WRITE ? (row.payload_json ?? null) : null);
          audit('task', 'expired', { task_id: row.id }, { kind: row.kind });
        }
      });
    } catch (error) {
      setError(errorCodeOf(error) ?? GENERIC_CODE);
    }
  }

  function reconcileAuditOnly(): void {
    try {
      store.transaction(() => {
        for (const row of candidateStore.listOrphanPendingWrites()) {
          candidateStore.markAuditOnly(row.candidate_id, now());
          audit(
            'retain',
            'audit_only',
            { candidate_id: row.candidate_id },
            { reason_code: 'unwritten_terminal' },
          );
        }
      });
    } catch (error) {
      setError(errorCodeOf(error) ?? GENERIC_CODE);
    }
  }

  async function runJob(): Promise<void> {
    const task = claimReady();
    if (!task) {
      expireSweep();
      reconcileAuditOnly();
      return;
    }
    const controller = new AbortController();
    controllers.set(task.id, controller);
    currentTaskId = task.id;
    const hooks: TaskHooks = { finish, scheduleRetry, patchPayload, wake };
    try {
      await runTask(task, controller.signal, hooks);
    } catch (error) {
      setError(errorCodeOf(error) ?? GENERIC_CODE);
      // 作业级异常按有界重试；绝不伪造成功。
      scheduleRetry(task);
    } finally {
      if (
        task.kind === NORMALIZE &&
        task.request_id &&
        taskStore.find(task.id)?.status !== 'pending'
      )
        evidence.releaseRequest(task.request_id);
      controllers.delete(task.id);
      currentTaskId = null;
    }
    wake(); // 顺序排空：仍有 ready 任务则不等到下一个 2s tick
  }

  async function tick(): Promise<void> {
    if (!isStarted() || isDisposed()) return;
    if (!job)
      job = runJob()
        .catch((error) => {
          setError(errorCodeOf(error) ?? GENERIC_CODE);
        })
        .finally(() => {
          job = null;
        });
    if (!remoteJob) {
      const remote = new AbortController();
      remoteController = remote;
      remoteJob = (async () => {
        const signal = remote.signal;
        const claimed = await runRemote(signal, preferCurate ? 'curate' : 'write');
        if (claimed) {
          preferCurate = !preferCurate;
          wake();
        }
      })()
        .catch((error) => {
          setError(errorCodeOf(error) ?? 'LEPI_HINDSIGHT_UNAVAILABLE');
        })
        .finally(() => {
          remoteJob = null;
          remoteController = null;
        });
    }
    await Promise.all([job, remoteJob].filter((work): work is Promise<void> => work != null));
  }

  function wake(): void {
    if (isDisposed() || !isStarted()) return;
    if (wakeTimer) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      tick().catch(() => {});
    }, 0);
    if (typeof wakeTimer.unref === 'function') wakeTimer.unref();
  }

  function start(): void {
    tickTimer = setInterval(() => {
      tick().catch(() => {});
    }, TICK_MS);
    if (typeof tickTimer.unref === 'function') tickTimer.unref();
    tick().catch(() => {});
  }

  /** operator retry：只唤醒已存在的身份；终态不换新 operation、不复活政策终止。 */
  function retry(taskId: string): MemoryRetryReceipt | null {
    if (isDisposed() || typeof taskId !== 'string' || !taskId) return null;
    let row: TaskRowRecord | null;
    try {
      row = taskStore.find(taskId);
    } catch {
      return null;
    }
    if (!row) return null;
    const retryable = RETRYABLE_STATUS[row.status] === true;
    if (retryable) {
      try {
        taskStore.rearmForRetry(
          taskId,
          {
            status: row.submitted_at != null && row.kind === WRITE ? 'submitted' : 'pending',
            nextAt: now(),
          },
          {
            type: 'task',
            status: 'retry_requested',
            at: now(),
            ...identityOf(row),
            task_id: taskId,
            data: { kind: row.kind },
          },
        );
        wake();
      } catch (error) {
        setError(errorCodeOf(error) ?? GENERIC_CODE);
      }
    }
    const updated = taskStore.find(taskId) ?? row;
    return {
      task_id: updated.id,
      kind: updated.kind,
      status: updated.status,
      code: updated.error_code ?? null,
      retryable,
    };
  }

  function status(): SupervisorStatus {
    const tasks: Record<string, Record<string, number>> = {};
    let total = 0;
    try {
      for (const row of taskStore.countByKindStatus()) {
        const bucket = tasks[row.kind] ?? (tasks[row.kind] = {});
        bucket[row.status] = row.n;
        total += row.n;
      }
    } catch (error) {
      setError(errorCodeOf(error) ?? GENERIC_CODE);
    }
    return {
      running: currentTaskId,
      remoteRunning: remoteJob !== null,
      tasks,
      total,
    };
  }

  async function drain(): Promise<void> {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = null;
    }
    for (const controller of controllers.values()) controller.abort();
    remoteController?.abort();
    controllers.clear();
    turnStarts.clear();
    await Promise.allSettled(
      [job, remoteJob].filter((work): work is Promise<void> => work != null),
    );
  }

  return { enqueue, afterTurn, start, wake, retry, drain, status };
}
