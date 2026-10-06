import { createHash, randomUUID } from 'node:crypto';
import {
  createUserMessage,
  createSystemMessage,
  createDeveloperMessage,
} from '@deepseek-ai/dsh-llm';
import type { ContextFormed, Message } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface';
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction';
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { decodeEvidenceId } from './evidence.js';
import type { EvidenceIndex, EvidenceRef } from './evidence.js';
import type { Candidate, HistoryWorkStatus } from './shared/domain.js';
import type { Store } from './store.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'lepimemory-redacted': { kind: 'lepimemory-redacted' } & ContextFormed;
  }
}

const NOTICE = '这段历史已按你的选择净化。';
const BLOCKED = 'LEPI_INPUT_RESUBMIT_REQUIRED';
const UNAVAILABLE = 'LEPI_CONTROL_UNAVAILABLE';

interface ContentBlockLike {
  type?: unknown;
  text?: unknown;
}
function asBlocks(content: unknown): readonly ContentBlockLike[] {
  return Array.isArray(content) ? (content as readonly ContentBlockLike[]) : [];
}

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)!).digest('hex');
const roleNode = (event: SessionEvent): boolean =>
  event.type === 'system/message' || event.type === 'developer/message';
const notice = (text: string): Message =>
  createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'lepimemory-redacted', form: 'notice', summary: NOTICE },
  });
const sid = (agent: MaintenanceAgent): string => agent.session.id;

/** `history_work.plan_json` 的已读结构面。 */
interface HistoryPlan {
  request_ids?: string[];
  fence_seq?: number | null;
  captured_hash?: string;
  proof?: Array<{ seq: number; hash: string }>;
  replaced_seqs?: number[];
  source_chains?: unknown[];
}
const parse = (row: WorkRow | undefined): HistoryPlan =>
  row?.plan_json ? (JSON.parse(row.plan_json) as HistoryPlan) : {};

/** `history_work` 行 / `meta` 行 / `requests` 行。 */
interface WorkRow {
  session_id: string;
  epoch: number;
  status: HistoryWorkStatus;
  captured_seq: number | null;
  plan_json: string | null;
  error_code: string | null;
}
interface MetaRow {
  value: string;
}
interface RequestRow {
  id: string;
  status: string;
  session_id: string;
  payload_json: string;
}

interface SafeNode {
  keep: boolean;
  text: string;
}
interface SourceLike {
  id: string;
  actor: string;
  kind: string;
  at: string;
  text: string;
}
interface Prepared {
  epoch: number;
  rows: WorkRow[];
  surface: SurfaceSnapshotLike;
  safe: Map<number, SafeNode>;
  chains: unknown[];
  requestIds: string[];
}

/** session-query 面：只读取这些字段。 */
interface SurfaceSnapshotLike {
  events: SessionEvent[];
  capturedThroughSeq?: number | null;
}
interface TraceLike {
  replacementChain: number[];
  derivedEventSeqs: number[];
}
interface SessionQueryLike {
  listSessions(signal: AbortSignal): Promise<Array<{ header: { id: string } }>>;
  readSurface(id: string): Promise<SurfaceSnapshotLike>;
  traceEvent(request: { sessionId: string; seq: number }, signal?: AbortSignal): Promise<TraceLike>;
  traceSession(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ ancestors: Array<{ header: { id: string } }> }>;
}

/** live agent 面：只读取这些成员。 */
interface SessionHandle {
  id: string;
  seq: number;
  append(type: string, payload: unknown, intent?: unknown): unknown;
}
interface MaintenanceAgent {
  id: string;
  status: string;
  session: SessionHandle;
  cancel(reason: unknown, options?: unknown): unknown;
  send(message: unknown, mode: 'next-turn', flag: boolean): unknown;
  whenIdle(): Promise<void>;
  runMaintenance<T>(fn: (signal: AbortSignal) => T | Promise<T>): Promise<T>;
}

/** processor 面：只用到 redactHistory。 */
interface RedactSpan {
  block_index: number;
  start: number;
  end: number;
  source_ids: string[];
}
interface RedactNode {
  seq: number;
  keep_spans?: RedactSpan[];
  decision?: string;
}
interface RedactResult {
  nodes: RedactNode[];
  uncertain_seqs?: number[];
}
interface ProcessorLike {
  redactHistory(
    input: unknown,
    options: {
      signal?: AbortSignal;
      readContext?: (
        ids: string[],
        context: { signal: AbortSignal },
      ) => Promise<{ sources: unknown[]; excluded: Array<{ id: string; code: string }> }>;
    },
  ): Promise<RedactResult>;
}

/** History coordinator 的 ctx 边界：只声明本模块实际读取的成员。 */
interface HistoryContext {
  agents: {
    list(): MaintenanceAgent[];
    get(id: string): MaintenanceAgent | undefined;
    resume(options: {
      resumeSessionId: string;
      signal: AbortSignal;
      setup: (agentCtx: unknown, agent: MaintenanceAgent) => Promise<void> | void;
    }): Promise<{ agent: MaintenanceAgent; dispose(): Promise<void> }>;
  };
  sessionQuery: SessionQueryLike;
  sessions: {
    list(): Array<{ id: string; seq: number }>;
    flush(session: SessionHandle): Promise<boolean>;
  };
  systemPrompt: {
    assemble(options: {
      agent: MaintenanceAgent;
      scope: MaintenanceAgent;
      signal?: AbortSignal;
    }): Promise<Parameters<typeof renderPrompt>[0]>;
  };
  sessionProjections: { stateOf(session: SessionHandle, key: string): unknown };
  agentPresets: { mount(agentCtx: unknown, preset: unknown): Promise<unknown> };
}

interface HookFrame {
  agent: MaintenanceAgent;
  messages: readonly Message[];
  turn?: number;
  step?: number;
  signal?: AbortSignal;
}
interface Decision {
  kind: string;
  messages?: readonly Message[];
}
type NextFn = () => Promise<Decision>;

interface Ticket {
  message: Message;
  epoch: number;
  prepared: Prepared;
  frame: { turn?: number; step?: number } | null;
  applied: boolean;
  rejected: boolean;
}

/** No registrations, timers, I/O, or background work at construction.
 * beforeStep/beforeRequest are the mandatory native-window seams; the root installs
 * them before starting workers. A management ticket never authorizes a model call.
 */
export function createHistoryCoordinator({
  ctx,
  store,
  processor,
  evidence,
}: {
  ctx: HistoryContext;
  store: Store;
  processor: ProcessorLike;
  evidence: EvidenceIndex;
}) {
  const lifetime = new AbortController();
  const tickets = new Map<string, Ticket>();
  const permits = new Map<string, number>();
  const preparing = new Map<string, Promise<Prepared | null>>();
  const sweeping = new Map<string, Promise<boolean>>();
  const owned = new Set<Promise<unknown>>();
  let disposed = false;
  const db = () => store.db;
  const own = <T>(work: Promise<T>): Promise<T> => {
    owned.add(work);
    work.then(
      () => owned.delete(work),
      () => owned.delete(work),
    );
    return work;
  };
  const workRows = (id: string): WorkRow[] =>
    db()
      .prepare("SELECT * FROM history_work WHERE session_id=? AND status!='applied' ORDER BY epoch")
      .all(id) as unknown as WorkRow[];
  const allRows = (id: string): WorkRow[] =>
    db()
      .prepare('SELECT * FROM history_work WHERE session_id=? ORDER BY epoch')
      .all(id) as unknown as WorkRow[];
  const request = (id: string): RequestRow | undefined =>
    db().prepare('SELECT * FROM requests WHERE id=?').get(id) as unknown as RequestRow | undefined;
  const enumerating = (): MetaRow | undefined =>
    db().prepare("SELECT value FROM meta WHERE key='history:enumerating'").get() as unknown as
      | MetaRow
      | undefined;
  const check = (epoch: number, signal: AbortSignal | undefined): void => {
    signal?.throwIfAborted();
    if (disposed || epoch !== store.policyEpoch) throw new Error(BLOCKED);
  };
  function record(
    row: WorkRow,
    status: HistoryWorkStatus,
    data: HistoryPlan,
    code: string | null = null,
  ): void {
    db()
      .prepare(
        'UPDATE history_work SET status=?,plan_json=?,error_code=? WHERE session_id=? AND epoch=?',
      )
      .run(status, JSON.stringify(data), code, row.session_id, row.epoch);
  }
  function enroll(id: string, epoch: number, requestIds: string[], fenceSeq: number | null): void {
    db()
      .prepare(
        `INSERT OR IGNORE INTO history_work(session_id,epoch,status,captured_seq,plan_json)
            VALUES (?,?,'pending',?,?)`,
      )
      .run(id, epoch, fenceSeq, JSON.stringify({ request_ids: requestIds, fence_seq: fenceSeq }));
  }
  function liveAgent(id: string): MaintenanceAgent | undefined {
    return ctx.agents.list().find((agent) => sid(agent) === id);
  }
  function latestScope(): { epoch: number; request_id: string } | null {
    // Restore/re-remember may change suppression scope epochs, but can never
    // advance or undo a completed canonical-history cutover.
    const row = db().prepare("SELECT value FROM meta WHERE key='history:last'").get() as unknown as
      | MetaRow
      | undefined;
    return row ? (JSON.parse(row.value) as { epoch: number; request_id: string }) : null;
  }
  function ensureEnrolled(agent: MaintenanceAgent): void {
    const scope = latestScope();
    if (scope) enroll(sid(agent), scope.epoch, [scope.request_id], agent.session.seq - 1);
  }

  async function enumerate(
    epoch: number,
    requestIds: string[],
    signal: AbortSignal,
  ): Promise<void> {
    const observedEpoch = store.policyEpoch;
    const sessions = await ctx.sessionQuery.listSessions(signal);
    check(observedEpoch, signal);
    store.transaction(() => {
      for (const { header } of sessions) enroll(header.id, epoch, requestIds, null);
      const remaining = (JSON.parse(enumerating()?.value ?? '[]') as number[]).filter(
        (value) => value !== epoch,
      );
      if (remaining.length)
        db()
          .prepare("UPDATE meta SET value=? WHERE key='history:enumerating'")
          .run(JSON.stringify(remaining));
      else db().prepare("DELETE FROM meta WHERE key='history:enumerating'").run();
    });
  }
  async function plan(
    requestId: string,
    candidateIds: string[],
  ): Promise<{ request_id: string; status: string; epoch: number }> {
    if (disposed || !candidateIds.length) throw new Error(UNAVAILABLE);
    const row = request(requestId);
    if (!row) throw new Error(UNAVAILABLE);
    const existing = db().prepare('SELECT * FROM forget_scopes WHERE request_id=?').all(requestId);
    if (existing.length)
      return {
        request_id: requestId,
        status: row.status === 'local_isolated' ? 'local_isolated' : 'local_isolating',
        epoch: (JSON.parse(row.payload_json) as { history_epochs: number[] }).history_epochs[0]!,
      };
    const ids = [...new Set(candidateIds)];
    const snapshots = ids.map((id) => {
      const snapshotRow = db()
        .prepare(
          `SELECT s.json,l.status FROM snapshots s
                JOIN lifecycle l ON l.candidate_id=s.candidate_id WHERE s.candidate_id=?`,
        )
        .get(id) as unknown as { json: string; status: string } | undefined;
      return snapshotRow;
    });
    if (snapshots.some((item) => !item || ['forgotten', 'audit_only'].includes(item.status)))
      throw new Error(UNAVAILABLE);
    const current = ctx.sessions
      .list()
      .map((session) => ({ id: session.id, seq: session.seq - 1 }));
    const at = store.now();
    let epoch: number;
    store.transaction(() => {
      epoch = store.bumpPolicyEpoch();
      for (let index = 0; index < ids.length; index++) {
        const candidate = JSON.parse(snapshots[index]!.json) as Candidate;
        db()
          .prepare(
            `UPDATE lifecycle SET status='forgotten',policy_epoch=?,updated_at=? WHERE candidate_id=?`,
          )
          .run(epoch, at, ids[index]!);
        db()
          .prepare(
            `INSERT INTO forget_scopes(id,request_id,candidate_ids_json,selector_json,active,epoch)
                    VALUES (?,?,?,?,1,?)`,
          )
          .run(
            randomUUID(),
            requestId,
            JSON.stringify([ids[index]!]),
            JSON.stringify({ subject_key: candidate.subject_key, facet_key: candidate.facet_key }),
            epoch,
          );
      }
      const tasks = db()
        .prepare(
          "SELECT * FROM tasks WHERE status IN ('pending','running','submitted','deferred','unknown')",
        )
        .all() as unknown as Array<{ id: string; kind: string; candidate_id: string | null }>;
      const selected = snapshots.map((item) => JSON.parse(item!.json) as Candidate);
      for (const task of tasks) {
        // Curation is the recovery path for earlier submitted operations: never
        // cancel it merely because its candidate identity is in its payload.
        if (task.kind === 'curate') continue;
        const otherRow = task.candidate_id
          ? (db()
              .prepare('SELECT json FROM snapshots WHERE candidate_id=?')
              .get(task.candidate_id) as unknown as { json: string } | undefined)
          : undefined;
        const candidate = otherRow && (JSON.parse(otherRow.json) as Candidate);
        const independent =
          candidate &&
          !ids.includes(task.candidate_id!) &&
          selected.every(
            (target) =>
              (candidate.subject_key !== target.subject_key ||
                candidate.facet_key !== target.facet_key) &&
              !candidate.source_ids.some((id) => target.source_ids.includes(id)),
          );
        if (independent) continue;
        db()
          .prepare(
            `UPDATE tasks SET status='cancelled',lease_owner=NULL,
                    draft_json=CASE WHEN submitted_at IS NULL THEN NULL ELSE draft_json END,
                    payload_json=CASE WHEN submitted_at IS NULL THEN NULL ELSE payload_json END WHERE id=?`,
          )
          .run(task.id);
      }
      for (const session of current) enroll(session.id, epoch, [requestId], session.seq);
      db()
        .prepare(
          "INSERT INTO meta(key,value) VALUES ('history:last',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(JSON.stringify({ epoch, request_id: requestId }));
      db()
        .prepare('UPDATE requests SET payload_json=? WHERE id=?')
        .run(
          JSON.stringify({
            ...(JSON.parse(request(requestId)!.payload_json) as Record<string, unknown>),
            history_epochs: [epoch],
          }),
          requestId,
        );
      const enumerations = [
        ...new Set([...(JSON.parse(enumerating()?.value ?? '[]') as number[]), epoch]),
      ];
      db()
        .prepare(
          "INSERT INTO meta(key,value) VALUES ('history:enumerating',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(JSON.stringify(enumerations));
      const state = store.readState();
      store.commitState(
        { ...state, reasons: [] },
        {
          type: 'forget.state',
          status: 'local_isolating',
          request_id: requestId,
          session_id: row.session_id,
          data: { epoch },
        },
      );
      db()
        .prepare(
          `INSERT INTO tasks(id,kind,request_id,status,payload_json,next_at,expires_at)
                VALUES (?,'curate',?,'pending',?,?,?)`,
        )
        .run(
          randomUUID(),
          requestId,
          JSON.stringify({ kind: 'forget', candidate_ids: ids }),
          at,
          Number.MAX_SAFE_INTEGER,
        );
      store.audit({
        type: 'forget',
        status: 'local_isolating',
        request_id: requestId,
        session_id: row.session_id,
        data: { candidate_ids: ids, epoch },
      });
    });
    permits.clear();
    for (const agent of ctx.agents.list())
      if (sid(agent) !== row.session_id && agent.status !== 'idle')
        agent.cancel({ kind: 'hook', reason: 'lepimemory-forget' });
    // Enumeration failure leaves the durable global fence in place for sweep/restart.
    await enumerate(epoch!, [requestId], lifetime.signal);
    return { request_id: requestId, status: 'local_isolating', epoch: epoch! };
  }

  function isReadable(ref: EvidenceRef): boolean {
    if (disposed || enumerating()) return false;
    const rows = allRows(ref.session_id);
    const scope = latestScope();
    if (scope && !rows.some((row) => row.epoch === scope.epoch)) return false;
    if (rows.some((row) => row.status !== 'applied')) return false;
    if (
      ref.kind === 'splice' &&
      rows.some((row) => parse(row).fence_seq == null || ref.seq <= parse(row).fence_seq!)
    )
      return false;
    return true; // Evidence still independently proves presence on the current surface.
  }

  async function prepare(agent: MaintenanceAgent, signal: AbortSignal): Promise<Prepared | null> {
    const id = sid(agent);
    const rows = workRows(id);
    if (!rows.length) return null;
    const epoch = store.policyEpoch;
    const surface = await ctx.sessionQuery.readSurface(id);
    check(epoch, signal);
    const requestIds = [...new Set(rows.flatMap((row) => parse(row).request_ids ?? []))];
    const management = requestIds.every((id) => request(id)?.status !== 'local_isolated');
    const scopes = db().prepare('SELECT * FROM forget_scopes').all() as unknown as Array<{
      request_id: string;
      candidate_ids_json: string;
    }>;
    const wanted = scopes.filter((scope) => requestIds.includes(scope.request_id));
    const candidateIds = [
      ...new Set(wanted.flatMap((scope) => JSON.parse(scope.candidate_ids_json) as string[])),
    ];
    const targets = management
      ? candidateIds.map((id) => {
          const snapshotRow = db()
            .prepare('SELECT json FROM snapshots WHERE candidate_id=?')
            .get(id) as unknown as { json: string } | undefined;
          return JSON.parse(snapshotRow!.json) as Candidate;
        })
      : [];
    const forbiddenIds = new Set(targets.flatMap((target) => target.source_ids));
    const forbiddenSeqs = new Set<number>();
    const chains: unknown[] = [];
    if (management)
      for (const sourceId of forbiddenIds) {
        const ref = decodeEvidenceId(sourceId);
        if (!ref) continue;
        // A candidate may cite its FIRST inbox splice, not its later surface
        // commit. Follow both genuine identities, including copied fork nodes.
        const starts = new Set<number>(
          surface.events
            .filter((event) => deriveEventMessage(event)?.id === ref.messageId)
            .map((event) => event.seq),
        );
        for (const row of db()
          .prepare(
            "SELECT DISTINCT seq FROM evidence WHERE session_id=? AND message_id=? AND kind!='splice'",
          )
          .all(id, ref.messageId) as unknown as Array<{ seq: number }>)
          starts.add(row.seq);
        if (ref.sessionId === id) starts.add(ref.seq);
        for (const seq of starts) {
          forbiddenSeqs.add(seq);
          const trace = await ctx.sessionQuery.traceEvent({ sessionId: id, seq }, signal);
          check(epoch, signal);
          for (const derived of [...trace.replacementChain, ...trace.derivedEventSeqs])
            forbiddenSeqs.add(derived);
          chains.push({
            seq,
            replacement_chain: trace.replacementChain,
            derived_seqs: trace.derivedEventSeqs,
          });
        }
      }
    const sources: SourceLike[] = [];
    const sourceRefs = new Map<string, { seq: number; block_index: number; forbidden: boolean }>();
    const nodes = surface.events.map((event) => {
      const message = deriveEventMessage(event);
      if (management) evidence.observe(agent.session, event);
      const blocks: Array<{ block_index: number; text: string; source_ids: string[] }> = [];
      for (const [block_index, block] of asBlocks(message?.content).entries()) {
        if (block.type !== 'text' || typeof block.text !== 'string') continue;
        const ref = db()
          .prepare(
            `SELECT * FROM evidence WHERE session_id=? AND message_id=? AND seq=?
                    AND block_index=? AND start=0 AND end=? AND kind!='splice'`,
          )
          .get(id, message?.id ?? '', event.seq, block_index, block.text.length) as unknown as
          | { id: string; actor: string; kind: string; at: number }
          | undefined;
        // Primary identity comes ONLY from the genuine observed evidence row.
        // Roles absent from the evidence index remain canonical context refs.
        const sourceId =
          ref?.id ??
          `surface:${Buffer.from(JSON.stringify([id, event.seq, block_index])).toString('base64url')}`;
        const source = {
          id: sourceId,
          actor: ref?.actor ?? 'context',
          kind: ref?.kind ?? 'context',
          at: new Date(ref?.at ?? event.time).toISOString(),
          text: block.text,
        };
        sources.push(source);
        sourceRefs.set(sourceId, {
          seq: event.seq,
          block_index,
          forbidden: forbiddenSeqs.has(event.seq),
        });
        blocks.push({ block_index, text: block.text, source_ids: [sourceId] });
      }
      return {
        seq: event.seq,
        type: event.type,
        role: message?.role,
        source_kind: message?.source?.kind,
        blocks,
        unsupported: asBlocks(message?.content).some((block) => block.type !== 'text'),
      };
    });
    let result: RedactResult = { nodes: [], uncertain_seqs: [] };
    if (management && nodes.length) {
      try {
        const byId = new Map(sources.map((source) => [source.id, source] as const));
        const readContext = async (
          ids: string[],
          { signal: readSignal }: { signal: AbortSignal },
        ): Promise<{ sources: SourceLike[]; excluded: Array<{ id: string; code: string }> }> => {
          check(epoch, readSignal);
          if (requestIds.some((id) => request(id)?.status === 'local_isolated'))
            throw new Error(BLOCKED);
          const face = await ctx.sessionQuery.readSurface(id);
          check(epoch, readSignal);
          if (
            hash(face.events) !== hash(surface.events) ||
            requestIds.some((id) => request(id)?.status === 'local_isolated')
          )
            throw new Error(BLOCKED);
          return {
            sources: ids
              .map((id) => byId.get(id))
              .filter((source): source is SourceLike => Boolean(source)),
            excluded: ids.filter((id) => !byId.has(id)).map((id) => ({ id, code: BLOCKED })),
          };
        };
        result = await processor.redactHistory(
          {
            agent,
            request_id: requestIds[0],
            candidate_ids: candidateIds,
            targets,
            nodes,
            sources,
          },
          { signal, readContext },
        );
      } catch {
        check(epoch, signal);
      } // No semantic proof means conservative removal.
    }
    check(epoch, signal);
    const decisions = new Map(result.nodes.map((node) => [node.seq, node] as const));
    const uncertain = new Set(result.uncertain_seqs ?? []);
    const safe = new Map<number, SafeNode>();
    const reusable = new Map<number, string>();
    if (!management) {
      const lineage = await ctx.sessionQuery.traceSession(id, signal);
      check(epoch, signal);
      for (const sessionId of [id, ...lineage.ancestors.map((record) => record.header.id)]) {
        const prior = allRows(sessionId).at(-1);
        if (
          prior &&
          prior.epoch >= (latestScope()?.epoch ?? 0) &&
          (sessionId === id || prior.status === 'applied')
        )
          for (const item of parse(prior).proof ?? []) reusable.set(item.seq, item.hash);
      }
    }
    for (const node of nodes) {
      if (
        !management &&
        reusable.get(node.seq) === hash(surface.events.find((event) => event.seq === node.seq))
      ) {
        safe.set(node.seq, { keep: true, text: node.blocks.map((block) => block.text).join('\n') });
        continue;
      }
      const decision = decisions.get(node.seq);
      const spans = decision?.keep_spans ?? [];
      const blocks = new Map(node.blocks.map((block) => [block.block_index, block.text] as const));
      const valid =
        management &&
        !uncertain.has(node.seq) &&
        !forbiddenSeqs.has(node.seq) &&
        decision?.decision !== 'remove' &&
        spans.length > 0 &&
        spans.every(
          (span) =>
            span.end > span.start &&
            span.start >= 0 &&
            span.end <= (blocks.get(span.block_index)?.length ?? -1) &&
            span.source_ids.length > 0 &&
            span.source_ids.every((id) => sourceRefs.has(id) && !sourceRefs.get(id)!.forbidden),
        );
      if (!valid) {
        safe.set(node.seq, { keep: false, text: NOTICE });
        continue;
      }
      const ordered = [...spans].sort((a, b) => a.block_index - b.block_index || a.start - b.start);
      const full =
        !node.unsupported &&
        node.blocks.every((block) => {
          let end = 0;
          for (const span of ordered.filter((span) => span.block_index === block.block_index)) {
            if (span.start !== end) return false;
            end = span.end;
          }
          return end === block.text.length;
        });
      safe.set(node.seq, {
        keep: decision!.decision === 'keep' && full,
        text: ordered
          .map((span) => blocks.get(span.block_index)!.slice(span.start, span.end))
          .join('\n'),
      });
    }
    const again = await ctx.sessionQuery.readSurface(id);
    check(epoch, signal);
    if (hash(again.events) !== hash(surface.events)) throw new Error(BLOCKED);
    const prepared: Prepared = { epoch, rows, surface, safe, chains, requestIds };
    store.transaction(() => {
      for (const row of rows)
        record(row, 'pending', {
          ...parse(row),
          fence_seq: parse(row).fence_seq ?? surface.capturedThroughSeq ?? -1,
          captured_hash: hash(surface.events),
        });
    });
    return prepared;
  }
  function prepareOnce(agent: MaintenanceAgent, signal: AbortSignal): Promise<Prepared | null> {
    const existing = preparing.get(sid(agent));
    if (existing) return existing;
    const work = own(prepare(agent, signal));
    preparing.set(sid(agent), work);
    work.then(
      () => preparing.delete(sid(agent)),
      () => preparing.delete(sid(agent)),
    );
    return work;
  }

  async function materialize(
    agent: MaintenanceAgent,
    prepared: Prepared,
    signal: AbortSignal | undefined,
    frame?: { turn?: number; step?: number },
  ): Promise<boolean> {
    check(prepared.epoch, signal);
    const current = await ctx.sessionQuery.readSurface(sid(agent));
    check(prepared.epoch, signal);
    if (hash(current.events) !== hash(prepared.surface.events)) throw new Error(BLOCKED);
    const events = current.events;
    // dsh-compaction 的 pairing 判定要求完整 Session；本模块只持有实际读取成员构成的窄面，
    // 运行时两者是同一 live session 对象（结构相同，推断无法统一）。
    const pairingSession = agent.session as unknown as Parameters<
      typeof toolPairingBalancedBefore
    >[0];
    const roles = events.filter(roleNode);
    if (roles.length && !frame) return false;
    const intervals: Array<{ start: number; end: number }> = [];
    for (let index = 0; index < events.length; index++) {
      if (roleNode(events[index]!) || prepared.safe.get(events[index]!.seq)?.keep) continue;
      let start = index;
      let end = index;
      while (start > 0 && !toolPairingBalancedBefore(pairingSession, events[start]!.seq)) start--;
      while (end + 1 < events.length && !toolPairingBalancedAfter(pairingSession, events[end]!.seq))
        end++;
      if (
        events.slice(start, end + 1).some(roleNode) ||
        !toolPairingBalancedBefore(pairingSession, events[start]!.seq) ||
        !toolPairingBalancedAfter(pairingSession, events[end]!.seq)
      )
        throw new Error(BLOCKED);
      const previous = intervals.at(-1);
      if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, end);
      else intervals.push({ start, end });
      index = end;
    }
    let freshPrompt: string | undefined;
    if (roles.length) {
      freshPrompt = renderPrompt(await ctx.systemPrompt.assemble({ agent, scope: agent, signal }));
      check(prepared.epoch, signal);
    }
    for (const range of intervals) {
      const shadowed = events.slice(range.start, range.end + 1);
      const text = [
        NOTICE,
        ...shadowed
          .map((event) => prepared.safe.get(event.seq)?.text)
          .filter((text) => text && text !== NOTICE),
      ].join('\n\n');
      agent.session.append('user/message', notice(text), {
        surfaceOp: { op: 'replace', startSeq: shadowed[0]!.seq, endSeq: shadowed.at(-1)!.seq },
        sourceEventSeqs: shadowed.map((event) => event.seq),
      });
    }
    for (const event of roles) {
      const text =
        event === events[0] && event.type === 'system/message'
          ? freshPrompt!
          : (prepared.safe.get(event.seq)?.text ?? NOTICE);
      const message =
        event.type === 'system/message'
          ? createSystemMessage(text)
          : createDeveloperMessage({
              content: [{ type: 'text', text }],
              source: { kind: 'lepimemory-redacted' },
            });
      agent.session.append(
        event.type,
        { turn: frame!.turn, step: frame!.step, message },
        {
          surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq },
          sourceEventSeqs: [event.seq],
        },
      );
    }
    if (!(await ctx.sessions.flush(agent.session))) throw new Error(UNAVAILABLE);
    check(prepared.epoch, signal);
    const face = await ctx.sessionQuery.readSurface(sid(agent));
    check(prepared.epoch, signal);
    const replaced = new Set([
      ...intervals.flatMap((range) =>
        events.slice(range.start, range.end + 1).map((event) => event.seq),
      ),
      ...roles.map((event) => event.seq),
    ]);
    if (face.events.some((event) => replaced.has(event.seq))) throw new Error(BLOCKED);
    store.transaction(() => {
      for (const row of prepared.rows)
        record(row, 'applied', {
          ...parse(row),
          proof: face.events.map((event) => ({ seq: event.seq, hash: hash(event) })),
          replaced_seqs: [...replaced],
          source_chains: prepared.chains,
        });
      store.audit({
        type: 'forget.history',
        status: 'applied',
        session_id: sid(agent),
        data: { epoch: prepared.epoch, replaced_seqs: [...replaced] },
      });
    });
    return true;
  }

  async function applyPending(agent: MaintenanceAgent): Promise<boolean> {
    if (disposed || enumerating()) return false;
    ensureEnrolled(agent);
    if (workRows(sid(agent)).length) {
      try {
        const face = await ctx.sessionQuery.readSurface(sid(agent));
        if (face.events.length) return false;
        // Empty history needs no replacement window or model material. Prove it
        // here so the first independent input in a new session is not discarded.
        const prepared = await prepareOnce(agent, lifetime.signal);
        if (prepared && !(await materialize(agent, prepared, lifetime.signal))) return false;
      } catch {
        return false;
      }
    }
    const epoch = store.policyEpoch;
    if (latestScope()) {
      try {
        if (!(await ctx.sessions.flush(agent.session))) return false;
        const face = await ctx.sessionQuery.readSurface(sid(agent));
        check(epoch, lifetime.signal);
        const rows = allRows(sid(agent));
        const proof = new Map(
          (parse(rows.at(-1)).proof ?? []).map((item) => [item.seq, item.hash] as const),
        );
        const fence = Math.max(-1, ...rows.map((row) => parse(row).fence_seq ?? -1));
        const unsafe = face.events.some(
          (event) =>
            (proof.has(event.seq) && proof.get(event.seq) !== hash(event)) ||
            (!proof.has(event.seq) &&
              (event.sourceEventSeqs ?? []).some((seq) => seq <= fence && !proof.has(seq))),
        );
        if (unsafe) {
          const row = rows.at(-1)!;
          record(row, 'pending', parse(row), BLOCKED);
          return false;
        }
      } catch {
        return false;
      }
    }
    if (epoch !== store.policyEpoch || enumerating() || workRows(sid(agent)).length) return false;
    permits.set(agent.id, epoch);
    return true;
  }
  async function beforeStep(frame: HookFrame, next: NextFn): Promise<Decision> {
    const ticket = tickets.get(frame.agent.id);
    if (ticket) {
      const exact = frame.messages.length === 1 && frame.messages[0]!.id === ticket.message.id;
      if (exact && ticket.epoch === store.policyEpoch && !enumerating()) {
        ticket.frame = { turn: frame.turn, step: frame.step };
        // A nonempty decision is REQUIRED to open the first native step.
        // agent/request cancels before this claimed notice can be committed.
        return { kind: 'enter', messages: [ticket.message] };
      }
      ticket.rejected = true;
      store.audit({
        type: 'control',
        status: 'resubmit_required',
        session_id: sid(frame.agent),
        turn: frame.turn,
        step: frame.step,
        data: {
          code: BLOCKED,
          message_ids: frame.messages
            .filter((message) => message.id !== ticket.message.id)
            .map((message) => message.id),
        },
      });
      return { kind: 'reject' };
    }
    if (!(await applyPending(frame.agent))) return { kind: 'reject' };
    const epoch = store.policyEpoch;
    const result = await next();
    return epoch === store.policyEpoch && !workRows(sid(frame.agent)).length && !enumerating()
      ? result
      : { kind: 'reject' };
  }
  async function beforeRequest(frame: HookFrame, next: NextFn): Promise<Decision> {
    const epoch = store.policyEpoch;
    const ticket = tickets.get(frame.agent.id);
    if (ticket) {
      try {
        if (!ticket.frame || ticket.frame.turn !== frame.turn || ticket.frame.step !== frame.step)
          throw new Error(BLOCKED);
        ticket.applied = await materialize(frame.agent, ticket.prepared, frame.signal, frame);
      } finally {
        // Abort BEFORE prepareCall/project/commit/buildRequest. In-history assembly
        // was captured before pre-step and cannot be repaired in that same step.
        frame.agent.cancel(
          { kind: 'hook', reason: 'lepimemory-history-window' },
          { keepInbox: true },
        );
      }
    } else if (
      disposed ||
      enumerating() ||
      workRows(sid(frame.agent)).length ||
      permits.get(frame.agent.id) !== store.policyEpoch
    ) {
      frame.agent.cancel({ kind: 'hook', reason: 'lepimemory-history-fence' }, { keepInbox: true });
    }
    const config = await next();
    if (
      !ticket &&
      (disposed ||
        epoch !== store.policyEpoch ||
        enumerating() ||
        workRows(sid(frame.agent)).length)
    )
      frame.agent.cancel({ kind: 'hook', reason: 'lepimemory-history-fence' }, { keepInbox: true });
    return config;
  }
  async function cleanAgent(agent: MaintenanceAgent): Promise<boolean> {
    ensureEnrolled(agent);
    if (!workRows(sid(agent)).length) return true;
    if (agent.status !== 'idle') return false; // Never wait for our own turn/tool/created listener.
    let prepared: Prepared | null;
    try {
      prepared = await agent.runMaintenance((signal) =>
        prepareOnce(agent, AbortSignal.any([signal, lifetime.signal])),
      );
      if (!prepared) return true;
      if (!prepared.surface.events.some(roleNode))
        return await agent.runMaintenance((signal) =>
          materialize(agent, prepared!, AbortSignal.any([signal, lifetime.signal])),
        );
      // Restored ordinary claims must first be rejected by the native barrier.
      // Only then can a new, exclusively owned notice open the legal role window.
      for (let stage = 0; stage < 2; stage++) {
        const message = notice(NOTICE);
        const ticket: Ticket = {
          message,
          epoch: prepared.epoch,
          prepared,
          frame: null,
          applied: false,
          rejected: false,
        };
        tickets.set(agent.id, ticket);
        try {
          agent.send(message, 'next-turn', true);
          await agent.whenIdle(); // Only the external sweeper owns this wait.
          if (ticket.applied) return true;
          if (!ticket.rejected) break;
        } finally {
          tickets.delete(agent.id);
        }
      }
      throw new Error(BLOCKED);
    } catch {
      for (const row of workRows(sid(agent))) record(row, 'blocked', parse(row), BLOCKED);
      return false;
    }
  }
  function finish(requestId: string): boolean {
    if (enumerating()) return false;
    const row = request(requestId);
    const epochs = row
      ? (JSON.parse(row.payload_json) as { history_epochs?: number[] }).history_epochs
      : undefined;
    if (
      !epochs?.length ||
      epochs.some((epoch) =>
        db()
          .prepare("SELECT 1 FROM history_work WHERE epoch=? AND status!='applied' LIMIT 1")
          .get(epoch),
      )
    )
      return false;
    if (row!.status === 'local_isolated') return true;
    store.transaction(() => {
      db()
        .prepare(
          "UPDATE requests SET status='local_isolated',error_code=NULL,updated_at=? WHERE id=?",
        )
        .run(store.now(), requestId);
      store.audit({
        type: 'forget',
        status: 'local_isolated',
        request_id: requestId,
        data: { remote_status: 'remote_curating' },
      });
    });
    return true;
  }
  function sweep(_requestId?: string): Promise<boolean> {
    // A single owner prevents overlapping cold resumes and management tickets.
    const key = '*';
    const running = sweeping.get(key);
    if (running) return running;
    const work = own(
      (async (): Promise<boolean> => {
        if (disposed) return false;
        const pendingEnumeration = enumerating();
        if (pendingEnumeration)
          for (const epoch of JSON.parse(pendingEnumeration.value) as number[]) {
            const ids = (
              db()
                .prepare(
                  `SELECT id FROM requests WHERE EXISTS
                    (SELECT 1 FROM json_each(requests.payload_json,'$.history_epochs') WHERE value=?)`,
                )
                .all(epoch) as unknown as Array<{ id: string }>
            ).map((row) => row.id);
            await enumerate(epoch, ids, lifetime.signal);
          }
        const rows = db()
          .prepare("SELECT * FROM history_work WHERE status!='applied' ORDER BY epoch,session_id")
          .all() as unknown as WorkRow[];
        for (const id of [...new Set(rows.map((row) => row.session_id))]) {
          if (disposed) return false;
          const live = liveAgent(id);
          if (live) {
            await cleanAgent(live);
            continue;
          }
          let handle: { agent: MaintenanceAgent; dispose(): Promise<void> } | undefined;
          try {
            handle = await ctx.agents.resume({
              resumeSessionId: id,
              signal: lifetime.signal,
              setup: async (agentCtx, agent) => {
                const preset = ctx.sessionProjections.stateOf(agent.session, 'agentPreset');
                if (preset !== null && preset !== undefined)
                  await ctx.agentPresets.mount(agentCtx, preset);
              },
            });
            await cleanAgent(handle.agent);
          } catch {
            for (const row of workRows(id)) record(row, 'blocked', parse(row), BLOCKED);
          } finally {
            if (handle) await handle.dispose();
          }
        }
        const ids = (
          db().prepare('SELECT DISTINCT request_id FROM forget_scopes').all() as unknown as Array<{
            request_id: string;
          }>
        ).map((row) => row.request_id);
        return ids.map(finish).every(Boolean);
      })(),
    );
    sweeping.set(key, work);
    work.then(
      () => sweeping.delete(key),
      () => sweeping.delete(key),
    );
    return work;
  }
  async function dispose(): Promise<void> {
    disposed = true;
    lifetime.abort();
    for (const [id] of tickets)
      ctx.agents.get(id)?.cancel({ kind: 'hook', reason: 'lepimemory-history-disposed' });
    await Promise.allSettled([...owned]);
    permits.clear();
    tickets.clear();
  }
  return {
    plan: (requestId: string, candidateIds: string[]) => own(plan(requestId, candidateIds)),
    applyPending,
    sweep,
    isReadable,
    beforeStep,
    beforeRequest,
    dispose,
  };
}
