/**
 * 授权与落库 owner：政策读取（grants/forget_scopes/requests/history_work fence + evidence session 查找）、
 * 候选政策核验、单项授权核验与「原子提交」。
 * candidate/task 的写入委托给各自 store；本模块只保留政策读取 SQL 与外层事务。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { StatementSync } from 'node:sqlite';
import { parseJson } from './json.js';
import { loadSource, type SourceSnapshot } from './raw-source.js';
import {
  allRows,
  firstRow,
  GENERIC_CODE,
  RESUBMIT_CODE,
  errorCodeOf,
  type AuditFn,
  type MemoryAgent,
  type MemoryCandidate,
  type MemoryProcessor,
  type Outcome,
  type Scope,
  type SetErrorFn,
} from './memory-common.js';
import type { EvidenceIndex } from './evidence.js';
import type { GrantRow, LifecycleRow, Store, TaskRowRecord } from './store.js';
import type { TaskStore } from './task-store.js';
import type { CandidateStore } from './candidate-store.js';

const WRITE = 'write';

/** `forget_scopes` 行（只读其 selector / candidate_ids / epoch）。 */
interface ForgetScopeRow {
  id: string;
  selector_json: string;
  candidate_ids_json?: string | null;
  epoch?: number;
}
/** 请求行的只读投影（policy 检查需要 kind/payload）。 */
interface RequestRow {
  kind: string;
  payload_json: string | null;
}

/** 政策读取的惰性 prepared SQL。 */
interface Statements {
  fence: StatementSync;
  blocked: StatementSync;
  activeScopes: StatementSync;
  liveGrants: StatementSync;
  grantById: StatementSync;
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function arrayEq(a: unknown, b: unknown): boolean {
  return (
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])
  );
}

/** processor.matchGrant 返回未类型化 object；本模块只读其 `match` 判别字段。 */
function matchKind(value: object | null | undefined): string | undefined {
  if (!value || !('match' in value)) return undefined;
  return typeof value.match === 'string' ? value.match : undefined;
}

interface AuthorizationDeps {
  ctx: { agents?: { get(id: string): MemoryAgent | undefined; roots?(): MemoryAgent[] } };
  store: Store;
  taskStore: TaskStore;
  candidateStore: CandidateStore;
  processor: MemoryProcessor;
  evidence: EvidenceIndex;
  askPrivate(
    candidate: MemoryCandidate,
    agent: MemoryAgent,
    options: { signal?: AbortSignal },
  ): Promise<{ outcome: string; grant_id: string | null }>;
  now: () => number;
  taskTtlMs: number;
  isDisposed: () => boolean;
  setError: SetErrorFn;
  audit: AuditFn;
}

/** 授权 owner 的显式门面。 */
export interface Authorization {
  guards: {
    latestFence(): number;
    fenced(sessionId: string | null | undefined): boolean;
    liveRoot(agent: MemoryAgent | undefined): boolean;
    current(scope: Scope): boolean;
    sourcesCurrent(candidate: MemoryCandidate, scope: Scope): Promise<boolean>;
  };
  checkPolicy(
    source: SourceSnapshot | null,
    task: TaskRowRecord,
    options?: { signal?: AbortSignal; restore?: boolean },
  ): Promise<{ allowed: boolean; epoch: number; code: string | null }>;
  authorizeAndCommit(
    candidate: MemoryCandidate,
    scope: Scope,
    reasonCode: string,
  ): Promise<Exclude<Outcome, 'deferred'>>;
}

export function createAuthorization({
  ctx,
  store,
  taskStore,
  candidateStore,
  processor,
  evidence,
  askPrivate,
  now,
  taskTtlMs,
  isDisposed,
  setError,
  audit,
}: AuthorizationDeps): Authorization {
  const db = store.db;
  let sql: Statements | null = null;
  function statements(): Statements {
    return (sql ??= {
      fence: db.prepare('SELECT max(epoch) AS epoch FROM forget_scopes'),
      blocked: db.prepare(
        "SELECT 1 FROM history_work WHERE session_id=? AND status!='applied' LIMIT 1",
      ),
      activeScopes: db.prepare('SELECT id, selector_json FROM forget_scopes WHERE active=1'),
      liveGrants: db.prepare('SELECT * FROM grants WHERE revoked_at IS NULL AND expires_at>?'),
      grantById: db.prepare('SELECT * FROM grants WHERE id=?'),
    });
  }

  function latestFence(): number {
    const row = firstRow<{ epoch: number | null }>(statements().fence);
    return row?.epoch ?? 0;
  }

  function fenced(sessionId: string | null | undefined): boolean {
    if (!sessionId) return false;
    try {
      return Boolean(firstRow<Record<string, unknown>>(statements().blocked, sessionId));
    } catch {
      return true;
    }
  }

  function liveRoot(agent: MemoryAgent | undefined): boolean {
    if (isDisposed() || !agent) return false;
    const get = ctx?.agents?.get;
    if (typeof get !== 'function' || get.call(ctx.agents, agent.id) !== agent) return false;
    const roots = ctx?.agents?.roots;
    if (typeof roots === 'function' && !roots.call(ctx.agents).includes(agent)) return false;
    return true;
  }

  function current(scope: Scope): boolean {
    return (
      liveRoot(scope.agent) &&
      !scope.signal?.aborted &&
      !fenced(scope.sessionId) &&
      store.policyEpoch === scope.epoch &&
      latestFence() === scope.fence
    );
  }

  async function sourcesCurrent(candidate: MemoryCandidate, scope: Scope): Promise<boolean> {
    if (!current(scope)) return false;
    try {
      const read = await evidence.read(candidate.source_ids, {
        agent: scope.agent,
        signal: scope.signal,
        request_id: scope.requestId ?? undefined,
      });
      return (
        current(scope) &&
        candidate.source_ids.every((id) => read.sources.some((source) => source.id === id))
      );
    } catch {
      return false;
    }
  }

  async function checkWritePolicy(
    source: SourceSnapshot | null,
    task: TaskRowRecord,
    { signal, restore = false }: { signal?: AbortSignal; restore?: boolean } = {},
  ): Promise<{ allowed: boolean; epoch: number; code: string | null }> {
    const epoch = store.policyEpoch;
    const denied = (code: string): { allowed: boolean; epoch: number; code: string | null } => ({
      allowed: false,
      epoch,
      code,
    });
    if (isDisposed() || signal?.aborted) return denied('LEPI_WORKER_STOPPED');
    if (!source) return denied('LEPI_SNAPSHOT_INVALID');
    source = loadSource(store, source.candidate.candidate_id);
    if (!source) return denied('LEPI_SNAPSHOT_INVALID');
    const candidate = source.candidate;
    const lifecycle = source.lifecycle as unknown as LifecycleRow;
    const payload = parseJson<Record<string, unknown>>(task.payload_json, {});
    const restoring =
      restore &&
      task.kind === 'curate' &&
      payload.kind === 'restore' &&
      Array.isArray(payload.candidate_ids) &&
      payload.candidate_ids.includes(candidate.candidate_id);
    if (
      restoring
        ? lifecycle.status !== 'unknown'
        : !['pending', ...(task.submitted_at != null ? ['unknown'] : [])].includes(lifecycle.status)
    )
      return denied('LEPI_MEMORY_SUPPRESSED');
    if (candidate.sensitivity === 'excluded') return denied('LEPI_MEMORY_SUPPRESSED');
    if (candidate.sensitivity === 'private') {
      const grant = lifecycle.grant_id
        ? firstRow<GrantRow>(statements().grantById, lifecycle.grant_id)
        : undefined;
      if (!grant || grant.revoked_at != null || grant.expires_at <= now())
        return denied('LEPI_GRANT_INVALID');
      const scope = parseJson<Record<string, unknown>>(grant.scope_json, {});
      if (
        !(typeof scope.kind === 'string' && ['item', 'topic', 'continuous'].includes(scope.kind)) ||
        (candidate.origin === 'inference' && !grant.allow_inference)
      )
        return denied('LEPI_GRANT_INVALID');
      if (
        scope.kind === 'item' &&
        (scope.candidate_id !== candidate.candidate_id ||
          !arrayEq(parseJson(grant.source_ids_json, []), candidate.source_ids))
      )
        return denied('LEPI_GRANT_INVALID');
      const sessionId =
        payload.session_id ??
        firstRow<{ session_id: string }>(
          db.prepare('SELECT session_id FROM evidence WHERE id=?'),
          candidate.source_ids[0] ?? null,
        )?.session_id;
      if (scope.session_id != null && scope.session_id !== sessionId)
        return denied('LEPI_GRANT_INVALID');
    }
    const request = task.request_id
      ? firstRow<RequestRow>(
          db.prepare('SELECT kind,payload_json FROM requests WHERE id=?'),
          task.request_id,
        )
      : undefined;
    const exceptions = new Set<string>(
      request?.kind === 're_remember' ? parseJson<string[]>(request.payload_json, []) : [],
    );
    for (const row of allRows<ForgetScopeRow>(
      db.prepare('SELECT * FROM forget_scopes WHERE active=1'),
    )) {
      if (parseJson<string[]>(row.candidate_ids_json, []).includes(candidate.candidate_id))
        return denied('LEPI_MEMORY_SUPPRESSED');
      if (exceptions.has(row.id) || (row.epoch ?? 0) <= Number(lifecycle.policy_epoch)) continue;
      const selector = parseJson<Record<string, unknown>>(row.selector_json, {});
      if (!selector.subject_key || !selector.facet_key) return denied('LEPI_MEMORY_SUPPRESSED');
      // Classify typed scope only: never re-send an old potentially forgotten value to a model.
      const typed = {
        subject_key: candidate.subject_key,
        facet_key: candidate.facet_key,
        origin: candidate.origin,
        source_ids: [] as string[],
        text: '',
      };
      const match = await processor.matchGrant(
        typed,
        {
          id: row.id,
          scope: {
            kind: 'topic',
            subject_key: selector.subject_key,
            topic: selector.facet_key,
            session_id: null,
            allow_inference: false,
          },
        },
        { purpose: 'forget', signal, sources: [] },
      );
      if (isDisposed() || signal?.aborted || store.policyEpoch !== epoch)
        return denied('LEPI_POLICY_CHANGED');
      if (matchKind(match) !== 'not_covered') return denied('LEPI_MEMORY_SUPPRESSED');
    }
    if (store.policyEpoch !== epoch) return denied('LEPI_POLICY_CHANGED');
    return { allowed: true, epoch, code: null };
  }

  function exceptionScopeIds(requestId: string | null): string[] {
    if (!requestId) return [];
    try {
      const row = firstRow<{ payload_json: string | null }>(
        db.prepare('SELECT payload_json FROM requests WHERE id=?'),
        requestId,
      );
      const payload = parseJson<Record<string, unknown>>(row?.payload_json, {});
      return Array.isArray(payload.exception_scope_ids)
        ? (payload.exception_scope_ids as string[])
        : [];
    } catch {
      return [];
    }
  }

  /** active forget scopes：仅用 typed selector 比对，绝不把旧正文喂给 checker。 */
  async function suppressionMatch(candidate: MemoryCandidate, scope: Scope): Promise<boolean> {
    const { agent, signal, requestId, requestKind } = scope;
    let scopes: ForgetScopeRow[];
    try {
      scopes = allRows<ForgetScopeRow>(statements().activeScopes);
    } catch {
      return true;
    } // 读取失败：保守抑制
    if (!scopes.length) return false;
    const exceptions = new Set<string>(
      requestKind === 're_remember' ? exceptionScopeIds(requestId) : [],
    );
    for (const row of scopes) {
      if (exceptions.has(row.id)) continue;
      const selector = parseJson<Record<string, unknown>>(row.selector_json, {});
      if (!selector.subject_key || !selector.facet_key) return true; // 无法核验：保守抑制
      const grant = {
        scope: {
          kind: 'topic',
          subject_key: selector.subject_key,
          topic: selector.facet_key,
          session_id: null,
          allow_inference: false,
        },
        id: row.id,
      };
      let match: object | null | undefined;
      try {
        match = await processor.matchGrant(candidate, grant, { purpose: 'forget', agent, signal });
      } catch {
        return true;
      }
      if (!current(scope)) return true;
      const kind = matchKind(match);
      if (kind === 'covered' || kind === 'uncertain') return true;
    }
    return false;
  }

  /** 既有授权覆盖：item 精确绑定候选/source；topic/continuous 语义覆盖 + allow_inference。 */
  async function matchActiveGrant(
    candidate: MemoryCandidate,
    scope: Scope,
  ): Promise<string | null> {
    const { agent, signal, sessionId } = scope;
    let grants: GrantRow[];
    try {
      grants = allRows<GrantRow>(statements().liveGrants, now());
    } catch {
      return null;
    }
    for (const row of grants) {
      const grantScope = parseJson<Record<string, unknown>>(row.scope_json, {});
      if (
        !grantScope ||
        (grantScope.kind !== 'item' &&
          grantScope.kind !== 'topic' &&
          grantScope.kind !== 'continuous')
      )
        continue;
      if (candidate.origin === 'inference' && !Number(grantScope.allow_inference)) continue;
      if (grantScope.kind === 'item') {
        if (grantScope.candidate_id !== candidate.candidate_id) continue;
        if (row.session_id !== sessionId) continue;
        if (!arrayEq(parseJson(row.source_ids_json, []), candidate.source_ids)) continue;
      } else if (grantScope.kind === 'topic') {
        if (grantScope.session_id != null && grantScope.session_id !== sessionId) continue;
      } else if (grantScope.kind === 'continuous') {
        if (grantScope.session_id != null) continue;
      }
      let match: object | null | undefined;
      try {
        match = await processor.matchGrant(
          candidate,
          { scope: grantScope, id: row.id },
          { agent, signal },
        );
      } catch {
        return null;
      }
      if (!current(scope)) return null;
      if (matchKind(match) === 'covered') return row.id;
    }
    return null;
  }

  /** 核验自身 per-item 授权：候选/source 精确、live、未撤销/未过期、恰 +1 epoch、fence 未变。 */
  function validateOwnGrant(
    grantId: string,
    candidate: MemoryCandidate,
    {
      agent,
      sessionId,
      epochBefore,
      fenceBefore,
    }: { agent: MemoryAgent; sessionId: string; epochBefore: number; fenceBefore: number },
  ): boolean {
    let row: GrantRow | undefined;
    try {
      row = firstRow<GrantRow>(statements().grantById, grantId);
    } catch {
      return false;
    }
    if (!row) return false;
    if (row.revoked_at != null || Number(row.expires_at) <= now()) return false;
    if (row.session_id !== sessionId) return false;
    const scope = parseJson<Record<string, unknown>>(row.scope_json, {});
    if (scope.kind !== 'item' || scope.candidate_id !== candidate.candidate_id) return false;
    if (!arrayEq(parseJson(row.source_ids_json, []), candidate.source_ids)) return false;
    if (Number(scope.allow_inference) !== (candidate.origin === 'inference' ? 1 : 0)) return false;
    if (!liveRoot(agent)) return false;
    if (store.policyEpoch !== epochBefore + 1) return false;
    if (latestFence() !== fenceBefore) return false;
    return true;
  }

  /** INSERT 快照 + lifecycle pending + pending write 任务，同一事务；正文只在获准后落库。 */
  function commitApproved(
    candidate: MemoryCandidate,
    scope: Scope,
    grantId: string | null,
    reasonCode: string,
    expectedEpoch: number,
    expectedFence: number,
  ): boolean {
    const snapshotJson = JSON.stringify(candidate);
    const payloadHash = hashText(snapshotJson);
    const writeId = randomUUID();
    try {
      store.transaction(() => {
        if (store.policyEpoch !== expectedEpoch)
          throw Object.assign(new Error(RESUBMIT_CODE), { code: RESUBMIT_CODE });
        if (latestFence() !== expectedFence)
          throw Object.assign(new Error(RESUBMIT_CODE), { code: RESUBMIT_CODE });
        candidateStore.insertPending({
          candidateId: candidate.candidate_id,
          json: snapshotJson,
          payloadHash,
          confirmedBy: grantId ?? (scope.explicit ? 'explicit_request' : 'auto'),
          grantId,
          epoch: store.policyEpoch,
        });
        taskStore.insert({
          id: writeId,
          kind: WRITE,
          candidateId: candidate.candidate_id,
          requestId: scope.requestId ?? null,
          status: 'pending',
          draftJson: null,
          payloadJson: JSON.stringify({
            session_id: scope.sessionId,
            request_id: scope.requestId ?? null,
          }),
          nextAt: now(),
          expiresAt: now() + taskTtlMs,
        });
        audit(
          'retain',
          'pending',
          {
            session_id: scope.sessionId,
            turn: scope.turn,
            request_id: scope.requestId,
            candidate_id: candidate.candidate_id,
            task_id: writeId,
          },
          {
            content_kind: candidate.content_kind,
            origin: candidate.origin,
            sensitivity: candidate.sensitivity,
            reason_code: reasonCode,
            grant_id: grantId,
          },
        );
      });
      return true;
    } catch (error) {
      if (errorCodeOf(error) === RESUBMIT_CODE) return false;
      setError(errorCodeOf(error) ?? GENERIC_CODE);
      throw error;
    }
  }

  async function authorizeAndCommit(
    candidate: MemoryCandidate,
    scope: Scope,
    reasonCode: string,
  ): Promise<Exclude<Outcome, 'deferred'>> {
    const { agent, signal, sessionId } = scope;
    if (!current(scope)) return 'cancelled';
    const epochNow = scope.epoch;
    const fenceNow = scope.fence;

    const suppressed = await suppressionMatch(candidate, scope);
    if (!current(scope)) return 'cancelled';
    if (suppressed) {
      audit(
        'forget',
        'suppressed',
        {
          session_id: sessionId,
          turn: scope.turn,
          request_id: scope.requestId,
          candidate_id: candidate.candidate_id,
        },
        { reason_code: 'forget_scope' },
      );
      return scope.explicit ? 'suppressed' : 'rejected';
    }
    if (store.policyEpoch !== epochNow || latestFence() !== fenceNow) return 'cancelled';
    if (!(await sourcesCurrent(candidate, scope))) return 'cancelled';

    let grantId: string | null = null;
    let expectedEpoch = epochNow;
    let expectedFence = fenceNow;
    if (candidate.sensitivity === 'private') {
      const matched = await matchActiveGrant(candidate, scope);
      if (!current(scope)) return 'cancelled';
      if (matched) {
        grantId = matched;
      } else {
        const epochBefore = store.policyEpoch;
        const fenceBefore = latestFence();
        let consent: { outcome: string; grant_id: string | null };
        try {
          consent = await askPrivate(candidate, agent, { signal });
        } catch {
          consent = { outcome: 'unavailable', grant_id: null };
        }
        if (!liveRoot(agent) || signal?.aborted) {
          audit('consent', 'cancelled', {
            session_id: sessionId,
            request_id: scope.requestId,
            candidate_id: candidate.candidate_id,
          });
          return 'cancelled';
        }
        if (consent?.outcome !== 'allowed' || !consent.grant_id) {
          audit('consent', consent?.outcome ?? 'unavailable', {
            session_id: sessionId,
            request_id: scope.requestId,
            candidate_id: candidate.candidate_id,
          });
          return consent?.outcome === 'rejected' ? 'rejected' : 'cancelled';
        }
        if (
          !validateOwnGrant(consent.grant_id, candidate, {
            agent,
            sessionId,
            epochBefore,
            fenceBefore,
          })
        ) {
          audit(
            'consent',
            'cancelled',
            {
              session_id: sessionId,
              request_id: scope.requestId,
              candidate_id: candidate.candidate_id,
            },
            { reason_code: 'grant_invalid' },
          );
          return 'cancelled';
        }
        grantId = consent.grant_id;
        expectedEpoch = epochBefore + 1;
        expectedFence = fenceBefore;
        scope.epoch = expectedEpoch;
      }
    }

    if (!(await sourcesCurrent(candidate, scope))) return 'cancelled';
    try {
      const committed = commitApproved(
        candidate,
        scope,
        grantId,
        reasonCode,
        expectedEpoch,
        expectedFence,
      );
      return committed ? 'approved' : 'cancelled';
    } catch {
      return 'failed';
    }
  }

  return {
    guards: { latestFence, fenced, liveRoot, current, sourcesCurrent },
    checkPolicy: checkWritePolicy,
    authorizeAndCommit,
  };
}
