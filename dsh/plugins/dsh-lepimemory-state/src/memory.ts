/**
 * 记忆运行时 facade：构造 stores → authorizer → pipeline → workers → supervisor，并暴露门面。
 * 构造器不查库、不起 timer、不注册 hook；prepared SQL 全部惰性初始化。
 * 内部 owner 接口不从插件 package exports 暴露。
 */
import { createWriteWorker } from './write-worker.js';
import { createCurateWorker } from './curate-worker.js';
import { createRecaller } from './recall.js';
import type { RecallInput } from './recall.js';
import type { HindsightClient } from './hindsight.js';
import type { EvidenceIndex } from './evidence.js';
import type { Store } from './store.js';
import {
  errorCodeOf,
  GENERIC_CODE,
  type AuditFn,
  type MemoryAdmission,
  type MemoryAgent,
  type MemoryCandidate,
  type MemoryContext,
  type MemoryProcessor,
  type SetErrorFn,
} from './memory-common.js';
import { createTaskStore } from './task-store.js';
import { createCandidateStore } from './candidate-store.js';
import { createAuthorization } from './memory-authorization.js';
import { createPipeline } from './memory-pipeline.js';
import { createSupervisor } from './memory-supervisor.js';

/** recall.ts 消费的观察核验面（该模块未导出 ProcessorLike；此处按已读成员重建窄面）。 */
interface VerifiableProcessor {
  verifyObservation(
    input: unknown,
    options?: { signal?: AbortSignal },
  ):
    | Promise<{ safe?: boolean; used_source_ids?: string[] } | null>
    | { safe?: boolean; used_source_ids?: string[] }
    | null;
}
interface MemoryHealth {
  started: boolean;
  disposed: boolean;
  running: string | null;
  tasks: Record<string, Record<string, number>>;
  total: number;
  writeExecutor: true;
  remoteRunning: boolean;
  admission: Record<string, unknown> | null;
  last_error: string | null;
}
/** 召回结果的最小可命名面（recall.ts 的 RecallProjection 未导出）。 */
interface MemoryRecall {
  picked: readonly unknown[];
  excluded: readonly unknown[];
  sources: readonly unknown[];
  text: string;
  audit_id: number;
  code: string | null;
}
/** supervisor 作业槽 / recall 作业。 */
interface RecallWork {
  controller: AbortController;
  promise: Promise<unknown> | null;
}

/**
 * @param deps.ctx cordis 上下文（只读 `agents.get/roots`）。
 * @param deps.config `resolveConfig` 产物（只读 timeouts.taskTtlMs）。
 * @param deps.store `openStore` 产物（同步事务；本模块是唯一 writer）。
 * @param deps.processor `createProcessor` 产物（`extract`/`matchGrant`）。
 * @param deps.admission `createAdmission` 产物（`evaluate`/`health`）。
 * @param deps.hindsight Hindsight REST client.
 * @param deps.evidence `createEvidenceIndex` 产物（`read`）。
 * @param deps.askPrivate 单项私密授权询问（control 门面）。
 * @param deps.now 可注入时钟。
 */
export function createMemoryRuntime({
  ctx,
  config,
  store,
  processor,
  admission,
  hindsight,
  evidence,
  askPrivate,
  now = Date.now,
}: {
  ctx: MemoryContext;
  config?: { timeouts?: { taskTtlMs?: number } } | null;
  store: Store;
  processor: MemoryProcessor;
  admission: MemoryAdmission;
  hindsight: HindsightClient;
  evidence: EvidenceIndex;
  askPrivate(
    candidate: MemoryCandidate,
    agent: MemoryAgent,
    options: { signal?: AbortSignal },
  ): Promise<{ outcome: string; grant_id: string | null }>;
  now?: () => number;
}) {
  const taskTtlMs = config?.timeouts?.taskTtlMs ?? 604800000;

  // 运行期堆状态（构造器不做任何工作；不注册、不起 timer、不写库）。
  const recallJobs = new Set<RecallWork>();
  let started = false;
  let disposed = false;
  let lastError: string | null = null;
  const setError: SetErrorFn = (code) => {
    lastError = code;
  };

  /** 后台审计：真实 session/turn/step/IDs；背景动作没有 tool/call，call_id 恒为 NULL。 */
  const audit: AuditFn = (type, status, identity = {}, data = {}) => {
    try {
      store.audit({
        type,
        status,
        at: now(),
        session_id: identity.session_id ?? null,
        turn: identity.turn ?? null,
        step: identity.step ?? null,
        call_id: null,
        request_id: identity.request_id ?? null,
        task_id: identity.task_id ?? null,
        candidate_id: identity.candidate_id ?? null,
        operation_id: identity.operation_id ?? null,
        data,
      });
    } catch (error) {
      lastError = errorCodeOf(error) ?? GENERIC_CODE;
      throw error;
    }
  };

  const taskStore = createTaskStore({ store, now });
  const candidateStore = createCandidateStore({ store, now });
  const authorizer = createAuthorization({
    ctx,
    store,
    taskStore,
    candidateStore,
    processor,
    evidence,
    askPrivate,
    now,
    taskTtlMs,
    isDisposed: () => disposed,
    setError,
    audit,
  });
  const pipeline = createPipeline({
    ctx,
    store,
    taskStore,
    evidence,
    processor,
    admission,
    authorizer,
    now,
    taskTtlMs,
    setError,
    audit,
  });
  const writeWorker = createWriteWorker({
    store,
    hindsight,
    checkPolicy: authorizer.checkPolicy,
    now,
  });
  const curateWorker = createCurateWorker({
    store,
    hindsight,
    checkPolicy: authorizer.checkPolicy,
    now,
  });
  // recall.ts 只消费 verifyObservation；其 ProcessorLike 未导出，按已读成员做窄断言。
  const recaller = createRecaller({
    store,
    hindsight,
    processor: processor as unknown as VerifiableProcessor,
    now,
  });
  const supervisor = createSupervisor({
    store,
    taskStore,
    candidateStore,
    evidence,
    now,
    taskTtlMs,
    isStarted: () => started,
    isDisposed: () => disposed,
    setError,
    audit,
    runTask: async (task, signal, hooks) => {
      if (task.kind === 'normalize') await pipeline.runNormalize(task, signal, hooks);
      else await pipeline.runAdmit(task, signal, hooks);
    },
    runRemote: async (signal, prefer) => {
      const first = prefer === 'curate' ? curateWorker : writeWorker;
      const second = prefer === 'curate' ? writeWorker : curateWorker;
      return (await first.runNext(signal)) || (await second.runNext(signal));
    },
  });

  function runRecall(input: RecallInput, auxiliary = false): Promise<MemoryRecall> {
    if (disposed)
      throw Object.assign(new Error('LEPI_WORKER_STOPPED'), { code: 'LEPI_WORKER_STOPPED' });
    const controller = new AbortController();
    const signal = input.signal
      ? AbortSignal.any([input.signal, controller.signal])
      : controller.signal;
    const work: RecallWork = { controller, promise: null };
    recallJobs.add(work);
    const promise = (auxiliary ? recaller.readMemory : recaller.recall)({ ...input, signal });
    work.promise = promise;
    return promise.finally(() => recallJobs.delete(work));
  }

  function start(): void {
    if (started || disposed) return;
    started = true;
    supervisor.start();
  }

  function health(): MemoryHealth {
    const current = supervisor.status();
    let admissionHealth: Record<string, unknown> | null;
    try {
      admissionHealth = typeof admission?.health === 'function' ? admission.health() : null;
    } catch {
      admissionHealth = null;
    }
    return {
      started,
      disposed,
      running: current.running,
      tasks: current.tasks,
      total: current.total,
      writeExecutor: true,
      remoteRunning: current.remoteRunning,
      admission: admissionHealth,
      last_error: lastError,
    };
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    for (const work of recallJobs) work.controller.abort();
    await supervisor.drain();
    await Promise.allSettled(
      [...recallJobs]
        .map((work) => work.promise)
        .filter((work): work is Promise<unknown> => work != null),
    );
  }

  return {
    enqueue: supervisor.enqueue,
    afterTurn: supervisor.afterTurn,
    start,
    wake: supervisor.wake,
    retry: supervisor.retry,
    health,
    dispose,
    recall: (input: RecallInput) => runRecall(input),
    readMemory: (input: RecallInput) => runRecall(input, true),
  };
}
