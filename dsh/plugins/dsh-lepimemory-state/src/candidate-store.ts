/**
 * `snapshots` + `lifecycle` 的写入 owner（记忆协调流程内）。原子性由调用方的外层事务保证：
 * snapshot + lifecycle 两个 INSERT 必须与 write 任务和审计同事务，绝不拆成多次提交。
 */
import type { StatementSync } from 'node:sqlite';
import { allRows } from './memory-common.js';
import type { Store } from './store.js';

interface Statements {
  insertSnapshot: StatementSync;
  insertLifecycle: StatementSync;
  orphanWrites: StatementSync;
  markAuditOnly: StatementSync;
}

/** insertPending 的绑定参数；正文正文只在获准后落库。 */
export interface PendingCandidate {
  candidateId: string;
  json: string;
  payloadHash: string;
  confirmedBy: string;
  grantId: string | null;
  epoch: number;
}

/** `snapshots` + `lifecycle` owner 的显式操作面。 */
export interface CandidateStore {
  insertPending(candidate: PendingCandidate): void;
  listOrphanPendingWrites(): Array<{ candidate_id: string }>;
  markAuditOnly(candidateId: string, at: number): void;
}

export function createCandidateStore({
  store,
  now,
}: {
  store: Store;
  now: () => number;
}): CandidateStore {
  const db = store.db;
  let sql: Statements | null = null;
  function statements(): Statements {
    return (sql ??= {
      insertSnapshot: db.prepare(
        'INSERT INTO snapshots(candidate_id,json,payload_hash,created_at) VALUES (?,?,?,?)',
      ),
      insertLifecycle: db.prepare(`INSERT INTO lifecycle
          (candidate_id,status,purpose,superseded_by,confirmed_by,grant_id,policy_epoch,updated_at)
          VALUES (?,?,?,?,?,?,?,?)`),
      orphanWrites: db.prepare(`SELECT candidate_id FROM lifecycle WHERE status='pending'
          AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.candidate_id=lifecycle.candidate_id
          AND t.kind='write' AND t.status IN ('pending','running','submitted','deferred'))`),
      markAuditOnly: db.prepare(
        "UPDATE lifecycle SET status='audit_only', updated_at=? WHERE candidate_id=? AND status='pending'",
      ),
    });
  }

  return {
    /** 原 snapshot + lifecycle 两次 INSERT；调用方仍持有外层事务。 */
    insertPending({
      candidateId,
      json,
      payloadHash,
      confirmedBy,
      grantId,
      epoch,
    }: PendingCandidate): void {
      statements().insertSnapshot.run(candidateId, json, payloadHash, now());
      statements().insertLifecycle.run(
        candidateId,
        'pending',
        'current',
        null,
        confirmedBy,
        grantId,
        epoch,
        now(),
      );
    },
    /** 仍有 pending lifecycle 却无可达 write 任务的候选（audit-only reconcile 输入）。 */
    listOrphanPendingWrites(): Array<{ candidate_id: string }> {
      return allRows<{ candidate_id: string }>(statements().orphanWrites);
    },
    /** 仅把 pending lifecycle 标记为 audit_only。 */
    markAuditOnly(candidateId: string, at: number): void {
      statements().markAuditOnly.run(at, candidateId);
    },
  };
}
