/**
 * `tasks` 表的唯一写入 owner（记忆协调流程内）。只暴露明确操作：读取、入队、
 * claim/lease、终态/重试/改期与到期清扫。事务边界由调用方决定，本模块不额外提交业务单元。
 */
import type { StatementSync } from 'node:sqlite';
import type { TaskKind, TaskStatus } from './shared/domain.js';
import { allRows, firstRow } from './memory-common.js';
import type { AuditEvent, Store, TaskRowRecord } from './store.js';

/** 原 INSERT 的完整行参数；调用方保证它落在原业务事务里。 */
export interface NewTaskRow {
  id: string;
  kind: TaskKind;
  candidateId: string | null;
  requestId: string | null;
  status: TaskStatus;
  draftJson: string | null;
  payloadJson: string | null;
  nextAt: number;
  expiresAt: number;
}

interface Statements {
  findTask: StatementSync;
  claim: StatementSync;
  markRunning: StatementSync;
  byRequest: StatementSync;
  turnTasks: StatementSync;
  insertTask: StatementSync;
  finishTask: StatementSync;
  retryTask: StatementSync;
  rearmRetry: StatementSync;
  rearmPending: StatementSync;
  patchTaskPayload: StatementSync;
  expire: StatementSync;
  expireOne: StatementSync;
  counts: StatementSync;
}

/** `tasks` 表 owner 的显式操作面。 */
export interface TaskStore {
  find(id: string): TaskRowRecord | null;
  findByRequest(requestId: string): { id: string } | null;
  listNormalizePayloads(): Array<{ id: string; payload_json: string | null }>;
  countByKindStatus(): Array<{ kind: TaskKind; status: TaskStatus; n: number }>;
  claimReady(lease: string, at: number): TaskRowRecord | null;
  insert(row: NewTaskRow): void;
  finish(
    id: string,
    change: { status: TaskStatus; code: string | null; nextAt: number; draftJson: string | null },
    auditEvent: AuditEvent,
  ): boolean;
  retry(
    id: string,
    change: { status: TaskStatus; attempts: number; code: string | null; nextAt: number },
    auditEvent: AuditEvent,
  ): boolean;
  rearmForRetry(
    id: string,
    change: { status: TaskStatus; nextAt: number },
    auditEvent: AuditEvent,
  ): void;
  rearmPending(id: string, change: { code: string | null; nextAt: number }): void;
  patchPayload(id: string, payloadJson: string): void;
  dueForExpiry(at: number): Array<{ id: string; kind: TaskKind; payload_json: string | null }>;
  expireRow(id: string, payloadJson: string | null): void;
}

export function createTaskStore({ store }: { store: Store; now: () => number }): TaskStore {
  const db = store.db;
  let sql: Statements | null = null;
  function statements(): Statements {
    return (sql ??= {
      findTask: db.prepare('SELECT * FROM tasks WHERE id=?'),
      claim: db.prepare(`SELECT * FROM tasks WHERE kind IN ('normalize','admit')
          AND status='pending' AND next_at<=? AND expires_at>? ORDER BY next_at, rowid LIMIT 1`),
      markRunning: db.prepare("UPDATE tasks SET status='running', lease_owner=? WHERE id=?"),
      byRequest: db.prepare("SELECT id FROM tasks WHERE kind='normalize' AND request_id=? LIMIT 1"),
      turnTasks: db.prepare("SELECT id, payload_json FROM tasks WHERE kind='normalize'"),
      insertTask: db.prepare(`INSERT INTO tasks
          (id,kind,candidate_id,request_id,status,draft_json,payload_json,next_at,expires_at)
          VALUES (?,?,?,?,?,?,?,?,?)`),
      finishTask: db.prepare(
        'UPDATE tasks SET status=?, error_code=?, lease_owner=NULL, next_at=?, draft_json=? WHERE id=?',
      ),
      retryTask: db.prepare(
        'UPDATE tasks SET attempts=?, status=?, error_code=?, lease_owner=NULL, next_at=? WHERE id=?',
      ),
      rearmRetry: db.prepare(
        'UPDATE tasks SET status=?, attempts=0, next_at=?, lease_owner=NULL, error_code=NULL WHERE id=?',
      ),
      rearmPending: db.prepare(
        "UPDATE tasks SET status='pending', error_code=?, next_at=?, lease_owner=NULL WHERE id=?",
      ),
      patchTaskPayload: db.prepare('UPDATE tasks SET payload_json=? WHERE id=?'),
      expire:
        db.prepare(`SELECT id,kind,payload_json FROM tasks WHERE kind<>'curate' AND submitted_at IS NULL
          AND status IN ('pending','deferred','running') AND expires_at<=?`),
      expireOne: db.prepare(
        "UPDATE tasks SET status='expired', lease_owner=NULL, draft_json=NULL, payload_json=? WHERE id=?",
      ),
      counts: db.prepare('SELECT kind, status, count(*) AS n FROM tasks GROUP BY kind, status'),
    });
  }

  return {
    /** 按 id 读取任务；DB 错误上抛给原 caller 的错误分支。 */
    find(id: string): TaskRowRecord | null {
      return firstRow<TaskRowRecord>(statements().findTask, id) ?? null;
    },
    /** 按 request 去重读取 normalize 任务。 */
    findByRequest(requestId: string): { id: string } | null {
      return firstRow<{ id: string }>(statements().byRequest, requestId) ?? null;
    },
    /** 现有 normalize 任务的 payload 投影（turn 去重）。 */
    listNormalizePayloads(): Array<{ id: string; payload_json: string | null }> {
      return allRows<{ id: string; payload_json: string | null }>(statements().turnTasks);
    },
    /** 任务计数投影（health）。 */
    countByKindStatus(): Array<{ kind: TaskKind; status: TaskStatus; n: number }> {
      return allRows<{ kind: TaskKind; status: TaskStatus; n: number }>(statements().counts);
    },
    /**
     * 短同步事务 claim：select pending normalize/admit → mark running/lease，
     * 返回「原 select 的行」（其 status 仍是 pending）。
     */
    claimReady(lease: string, at: number): TaskRowRecord | null {
      return store.transaction(() => {
        const row = firstRow<TaskRowRecord>(statements().claim, at, at);
        if (!row) return null;
        statements().markRunning.run(lease, row.id);
        return row;
      });
    },
    /** 原 INSERT；调用方把它放在原业务事务里，本方法自身不提交。 */
    insert(row: NewTaskRow): void {
      statements().insertTask.run(
        row.id,
        row.kind,
        row.candidateId,
        row.requestId,
        row.status,
        row.draftJson,
        row.payloadJson,
        row.nextAt,
        row.expiresAt,
      );
    },
    /** 终态：running/pending guard，UPDATE 与审计同事务；guard 不符返回 false。 */
    finish(
      id: string,
      {
        status,
        code,
        nextAt,
        draftJson,
      }: { status: TaskStatus; code: string | null; nextAt: number; draftJson: string | null },
      auditEvent: AuditEvent,
    ): boolean {
      const row = firstRow<TaskRowRecord>(statements().findTask, id);
      if (!row || !['running', 'pending'].includes(row.status)) return false;
      store.transaction(() => {
        statements().finishTask.run(status, code, nextAt, draftJson, id);
        store.audit(auditEvent);
      });
      return true;
    },
    /** 有界退避：attempts 置值、状态改期、清 lease/记 code，与审计同事务；guard 不符返回 false。 */
    retry(
      id: string,
      {
        status,
        attempts,
        code,
        nextAt,
      }: { status: TaskStatus; attempts: number; code: string | null; nextAt: number },
      auditEvent: AuditEvent,
    ): boolean {
      const row = firstRow<TaskRowRecord>(statements().findTask, id);
      if (!row || !['running', 'pending'].includes(row.status)) return false;
      store.transaction(() => {
        statements().retryTask.run(attempts, status, code, nextAt, id);
        store.audit(auditEvent);
      });
      return true;
    },
    /** operator retry：attempts=0、清 lease/error、改期并同事务审计。 */
    rearmForRetry(
      id: string,
      { status, nextAt }: { status: TaskStatus; nextAt: number },
      auditEvent: AuditEvent,
    ): void {
      store.transaction(() => {
        statements().rearmRetry.run(status, nextAt, id);
        store.audit(auditEvent);
      });
    },
    /** schema-retry 的独立 UPDATE 事务；调用方仍在事务之后写那条审计。 */
    rearmPending(id: string, { code, nextAt }: { code: string | null; nextAt: number }): void {
      store.transaction(() => statements().rearmPending.run(code, nextAt, id));
    },
    /** 同步替换任务 payload。 */
    patchPayload(id: string, payloadJson: string): void {
      store.transaction(() => statements().patchTaskPayload.run(payloadJson, id));
    },
    /** 到期候选行投影；外层单一事务覆盖 sweep 与审计。 */
    dueForExpiry(at: number): Array<{ id: string; kind: TaskKind; payload_json: string | null }> {
      return allRows<{ id: string; kind: TaskKind; payload_json: string | null }>(
        statements().expire,
        at,
      );
    },
    /** 到期置 expired、清 draft/lease 并写回 payload。 */
    expireRow(id: string, payloadJson: string | null): void {
      statements().expireOne.run(payloadJson, id);
    },
  };
}
