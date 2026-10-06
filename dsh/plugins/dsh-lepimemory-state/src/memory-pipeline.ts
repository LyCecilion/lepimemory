/**
 * normalize/admit 作业处理：候选价值判定、有界准入、普通/私密分流与授权交接。
 * 本模块不含任何 SQL：政策与落库都经 authorizer / taskStore / store.transaction。
 * 私有候选的价值判定与单项授权先在内存完成，未获准前正文/hash 不落库。
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseJson } from './json.js';
import {
  BACKOFF,
  GENERIC_CODE,
  RESUBMIT_CODE,
  errorCodeOf,
  identityOf,
  type AdmissionResult,
  type AuditFn,
  type MemoryCandidate,
  type MemoryContext,
  type MemoryProcessor,
  type MemoryAdmission,
  type Outcome,
  type Scope,
  type SetErrorFn,
  type TaskHooks,
} from './memory-common.js';
import type { Authorization } from './memory-authorization.js';
import type { EvidenceIndex, ExcludedEvidence, ResolvedEvidence } from './evidence.js';
import type { Store, TaskRowRecord } from './store.js';
import type { TaskStore } from './task-store.js';
import type { TaskStatus } from './shared/domain.js';

const NORMALIZE = 'normalize';
const ADMIT = 'admit';

interface EvidenceRead {
  sources: ResolvedEvidence[];
  excluded: ExcludedEvidence[];
}

/** normalize/admit 作业的显式门面；hooks 每次由 supervisor 注入。 */
export interface Pipeline {
  runNormalize(task: TaskRowRecord, signal: AbortSignal, hooks: TaskHooks): Promise<void>;
  runAdmit(task: TaskRowRecord, signal: AbortSignal, hooks: TaskHooks): Promise<void>;
}

interface PipelineDeps {
  ctx: MemoryContext;
  store: Store;
  taskStore: TaskStore;
  evidence: EvidenceIndex;
  processor: MemoryProcessor;
  admission: MemoryAdmission;
  authorizer: Authorization;
  now: () => number;
  taskTtlMs: number;
  setError: SetErrorFn;
  audit: AuditFn;
}

export function createPipeline({
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
}: PipelineDeps): Pipeline {
  const { latestFence, fenced, liveRoot, current, sourcesCurrent } = authorizer.guards;

  function createAdmitTask(
    candidate: MemoryCandidate,
    scope: Scope,
    status: TaskStatus,
    hooks: TaskHooks,
  ): void {
    const id = randomUUID();
    const payload = {
      session_id: scope.sessionId,
      request_id: scope.requestId ?? null,
      kind: scope.requestKind ?? null,
      reason_code: null,
    };
    store.transaction(() => {
      taskStore.insert({
        id,
        kind: ADMIT,
        candidateId: candidate.candidate_id ?? null,
        requestId: scope.requestId ?? null,
        status,
        draftJson: JSON.stringify(candidate),
        payloadJson: JSON.stringify(payload),
        nextAt: now(),
        expiresAt: now() + taskTtlMs,
      });
      audit(
        'retain',
        status,
        {
          session_id: scope.sessionId,
          turn: scope.turn,
          request_id: scope.requestId,
          candidate_id: candidate.candidate_id,
          task_id: id,
        },
        { content_kind: candidate.content_kind, origin: candidate.origin },
      );
    });
    if (status === 'pending') hooks.wake();
  }

  async function evaluateAdmissionBounded(
    candidate: MemoryCandidate,
    scope: Scope,
  ): Promise<AdmissionResult | null> {
    const { agent, signal } = scope;
    for (let attempt = 0; ; attempt += 1) {
      if (!current(scope)) return null;
      let result: AdmissionResult | undefined;
      let transient: boolean;
      try {
        result = await admission.evaluate(candidate, { signal, agent });
        transient = false;
      } catch (error) {
        if (error instanceof Error && error.name === 'AdmissionError')
          return { verdict: 'reject', reason_code: 'value_reject' };
        transient = true;
      }
      if (!current(scope)) return null;
      const deferredBackend =
        result?.verdict === 'defer' && result.reason_code === 'backend_unavailable';
      if (!transient && !deferredBackend) return result ?? null;
      if (attempt >= BACKOFF.length) return null;
      await delay(BACKOFF[attempt], undefined, { signal }).catch(() => {});
    }
  }

  async function processCandidate(
    candidate: MemoryCandidate,
    scope: Scope,
    hooks: TaskHooks,
  ): Promise<Outcome> {
    const identity = {
      session_id: scope.sessionId,
      turn: scope.turn,
      request_id: scope.requestId,
      candidate_id: candidate.candidate_id,
    };
    if (!current(scope)) return 'cancelled';
    if (candidate.sensitivity === 'excluded') {
      audit('retain', 'rejected', identity, { reason_code: 'excluded_source' });
      return 'rejected';
    }
    if (candidate.sensitivity === 'private') {
      // private 价值判断先在内存堆做；正文绝不进 queue/draft。
      let verdict = 'accept';
      let reasonCode = 'explicit_request';
      if (!scope.explicit) {
        const result = await evaluateAdmissionBounded(candidate, scope);
        if (!current(scope)) return 'cancelled';
        if (!result) {
          audit('retain', 'deferred', identity, { reason_code: 'backend_unavailable' });
          return 'deferred';
        }
        verdict = result.verdict ?? 'accept';
        reasonCode = result.reason_code ?? 'value_uncertain';
        audit('retain', 'admission', identity, {
          verdict,
          reason_code: reasonCode,
          score: result.score ?? null,
          backend: result.backend ?? null,
          model: result.model ?? null,
          revision: result.revision ?? null,
          truncated: result.truncated === true,
        });
      }
      if (verdict === 'reject') return 'rejected';
      if (verdict === 'defer') {
        audit('retain', 'deferred', identity, { reason_code: reasonCode });
        return 'deferred';
      }
      return authorizer.authorizeAndCommit(candidate, scope, reasonCode);
    }
    // ordinary：明确请求直接处理；其余进 durable admit 任务由准入槽评估（允许持久 draft）。
    if (scope.explicit) return authorizer.authorizeAndCommit(candidate, scope, 'explicit_request');
    createAdmitTask(candidate, scope, 'pending', hooks);
    return 'deferred';
  }

  async function runNormalize(
    task: TaskRowRecord,
    signal: AbortSignal,
    hooks: TaskHooks,
  ): Promise<void> {
    const payload = parseJson<Record<string, unknown>>(task.payload_json, {});
    const sessionId = payload.session_id as string | undefined;
    const explicit = payload.explicit === true;
    const sourceIds = Array.isArray(payload.source_ids) ? (payload.source_ids as string[]) : [];
    if (!sessionId || sourceIds.length === 0) {
      hooks.finish(task, 'cancelled', null, { clearDraft: true });
      return;
    }
    const epoch0 = store.policyEpoch;
    const fence0 = latestFence();
    const agent = ctx?.agents?.get?.(sessionId);
    if (!agent || !liveRoot(agent)) {
      hooks.finish(task, 'unknown', null, { clearDraft: true });
      return;
    }
    if (fenced(sessionId)) {
      hooks.finish(task, explicit ? 'unknown' : 'cancelled', explicit ? RESUBMIT_CODE : null, {
        clearDraft: true,
      });
      return;
    }

    // 先只读一次以区分「政策/来源不可用」与普通失败分类。
    let read: EvidenceRead;
    try {
      read = await evidence.read(sourceIds, {
        agent,
        signal,
        request_id: payload.request_id as string | undefined,
      });
    } catch {
      hooks.scheduleRetry(task);
      return;
    }
    if (store.policyEpoch !== epoch0 || latestFence() !== fence0 || !liveRoot(agent)) {
      hooks.finish(task, 'unknown', RESUBMIT_CODE, { clearDraft: true });
      return;
    }
    if (signal?.aborted) {
      hooks.finish(task, 'cancelled', null, { clearDraft: true });
      return;
    }
    if (read.excluded.length > 0) {
      const resubmit = read.excluded.some((item) => item.code === RESUBMIT_CODE);
      hooks.finish(task, 'unknown', resubmit ? RESUBMIT_CODE : GENERIC_CODE, { clearDraft: true });
      return;
    }

    let extraction: { candidates: MemoryCandidate[] };
    try {
      extraction = await processor.extract(
        {
          agent,
          source_ids: sourceIds,
          explicit,
          request_id: (payload.request_id as string | undefined) ?? null,
        },
        { signal },
      );
    } catch (error) {
      const code = errorCodeOf(error) ?? GENERIC_CODE;
      if (error instanceof Error && error.name === 'ContractError') {
        if (!payload.schema_retry) {
          hooks.patchPayload(task, { schema_retry: true });
          try {
            taskStore.rearmPending(task.id, { code, nextAt: now() + BACKOFF[0] });
          } catch (writeError) {
            setError(errorCodeOf(writeError) ?? GENERIC_CODE);
          }
          audit(
            'task',
            'retrying',
            { ...identityOf(task), task_id: task.id },
            { kind: NORMALIZE, code, reason: 'schema' },
          );
        } else {
          hooks.finish(task, 'unknown', code, { clearDraft: true });
        }
        return;
      }
      // 确定性失败（重发无意义）不重试；其余按有界退避。
      if (code === RESUBMIT_CODE || code === 'LEPI_EVIDENCE_BUDGET') {
        hooks.finish(task, 'unknown', code, { clearDraft: true });
        return;
      }
      hooks.scheduleRetry(task, code);
      return;
    }
    if (signal?.aborted) {
      hooks.finish(task, 'cancelled', null, { clearDraft: true });
      return;
    }
    if (store.policyEpoch !== epoch0 || latestFence() !== fence0 || !liveRoot(agent)) {
      hooks.finish(task, 'unknown', RESUBMIT_CODE, { clearDraft: true });
      return;
    }

    const baseScope: Scope = {
      agent,
      signal,
      sessionId,
      explicit,
      requestId: (payload.request_id as string | undefined) ?? null,
      requestKind: (payload.kind as string | undefined) ?? null,
      turn: (payload.turn as number | undefined) ?? null,
      epoch: epoch0,
      fence: fence0,
    };
    const outcomes: Outcome[] = [];
    for (const candidate of extraction.candidates ?? []) {
      if (signal?.aborted) {
        outcomes.push('cancelled');
        break;
      }
      if (!liveRoot(agent)) {
        outcomes.push('cancelled');
        break;
      }
      if (!current(baseScope)) {
        outcomes.push('cancelled');
        break;
      }
      try {
        outcomes.push(await processCandidate(candidate, baseScope, hooks));
      } catch (error) {
        setError(errorCodeOf(error) ?? GENERIC_CODE);
        outcomes.push('failed');
      }
    }

    if (outcomes.includes('failed')) hooks.finish(task, 'unknown', GENERIC_CODE);
    else if (explicit && outcomes.includes('suppressed'))
      hooks.finish(task, 'unknown', RESUBMIT_CODE);
    else hooks.finish(task, 'reconciled');
  }

  async function runAdmit(
    task: TaskRowRecord,
    signal: AbortSignal,
    hooks: TaskHooks,
  ): Promise<void> {
    const draft = parseJson<Record<string, unknown> | null>(task.draft_json, null);
    const payload = parseJson<Record<string, unknown>>(task.payload_json, {});
    const sessionId = payload.session_id as string | undefined;
    const candidate = draft
      ? ({
          ...draft,
          candidate_id: task.candidate_id ?? (draft.candidate_id as string),
          explicit: false,
          request_id:
            (payload.request_id as string | undefined) ??
            (draft.request_id as string | undefined) ??
            null,
        } as unknown as MemoryCandidate)
      : null;
    if (!candidate || !sessionId) {
      hooks.finish(task, 'cancelled', null, { clearDraft: true });
      return;
    }
    const agent = ctx?.agents?.get?.(sessionId);
    if (!agent || !liveRoot(agent)) {
      hooks.finish(task, 'unknown', null, { clearDraft: false });
      return;
    }
    if (fenced(sessionId)) {
      hooks.finish(task, 'cancelled', null, { clearDraft: true });
      return;
    }

    const epoch0 = store.policyEpoch;
    const scope: Scope = {
      agent,
      signal,
      sessionId,
      explicit: false,
      requestId: (payload.request_id as string | undefined) ?? null,
      requestKind: (payload.kind as string | undefined) ?? null,
      turn: null,
      epoch: epoch0,
      fence: latestFence(),
    };
    if (!(await sourcesCurrent(candidate, scope))) {
      hooks.finish(task, 'unknown', RESUBMIT_CODE, { clearDraft: true });
      return;
    }
    let result: AdmissionResult | undefined;
    try {
      result = await admission.evaluate(candidate, { signal, agent });
    } catch (error) {
      if (error instanceof Error && error.name === 'AdmissionError') {
        hooks.finish(task, 'cancelled', null, { clearDraft: true });
        return;
      }
      const code = errorCodeOf(error);
      if (code === RESUBMIT_CODE || code === 'LEPI_EVIDENCE_BUDGET') {
        hooks.finish(task, 'unknown', code, { clearDraft: true });
        return;
      }
      hooks.scheduleRetry(task);
      return;
    }
    if (signal?.aborted) {
      hooks.finish(task, 'cancelled', null, { clearDraft: false });
      return;
    }
    if (!liveRoot(agent)) {
      hooks.finish(task, 'cancelled', null, { clearDraft: false });
      return;
    }
    if (store.policyEpoch !== epoch0) {
      hooks.finish(task, 'unknown', RESUBMIT_CODE, { clearDraft: true });
      return;
    }

    const verdict = result?.verdict;
    const reasonCode = result?.reason_code ?? 'value_uncertain';
    audit(
      'retain',
      'admission',
      {
        session_id: sessionId,
        request_id: (payload.request_id as string | undefined) ?? null,
        candidate_id: candidate.candidate_id,
        task_id: task.id,
      },
      {
        verdict,
        reason_code: reasonCode,
        score: result?.score ?? null,
        backend: result?.backend ?? null,
        model: result?.model ?? null,
        revision: result?.revision ?? null,
        truncated: result?.truncated === true,
      },
    );

    if (verdict === 'reject') {
      hooks.finish(task, 'cancelled', null, { clearDraft: true });
      return;
    }
    if (verdict === 'defer') {
      if (reasonCode === 'backend_unavailable') hooks.scheduleRetry(task);
      else hooks.finish(task, 'deferred', null, { clearDraft: false });
      return;
    }
    const outcome = await authorizer.authorizeAndCommit(candidate, scope, reasonCode);
    if (outcome === 'approved') hooks.finish(task, 'reconciled', null, { clearDraft: true });
    else if (outcome === 'failed') hooks.finish(task, 'unknown', null, { clearDraft: false });
    else hooks.finish(task, 'cancelled', null, { clearDraft: true });
  }

  return { runNormalize, runAdmit };
}
