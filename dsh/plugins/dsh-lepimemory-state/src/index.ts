/** Unified SQLite-backed runtime. State follows persona prefix (0), before policy (500). */
import path from 'node:path';
import { createRequire } from 'node:module';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
// Type-only service augmentations (no runtime requires). Each package augments `@deepseek-ai/cordis`'s Context
// with the service this plugin declares in `inject`; loading them is what makes `ctx.<service>` well-typed.
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-session-query';
import type {} from '@deepseek-ai/dsh-session-projection';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-user-questions';
import type {} from '@deepseek-ai/dsh-user-approval';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-tools';
import { installAction } from './action.js';
import { installPanel } from './panel.js';
import { resolveConfig, applyDerivedEnv, expandHome } from './config.js';
import { openStore } from './store.js';
import { createStateRuntime } from './state-runtime.js';
import { createEvidenceIndex } from './evidence.js';
import { createProcessor } from './processor.js';
import { createAdmission } from './admission.js';
import { createHistoryCoordinator } from './history.js';
import { createMemoryRuntime } from './memory.js';
import { createControl } from './control.js';
import { HindsightClient } from './hindsight.js';
import { NODE_VERSION, DSH_VERSION } from './shared/pins.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'lepimemory-receipt': { kind: 'lepimemory-receipt' } & ContextFormed;
    'lepimemory-recall': { kind: 'lepimemory-recall' } & ContextFormed;
  }
}

export const name = 'lepimemory-state';
export const RUNTIME_CONTRACT = 1;
export const STATE_SECTION_ORDER = 50;
export const inject = [
  'systemPrompt',
  'tools',
  'llm',
  'agents',
  'sessions',
  'sessionQuery',
  'sessionPersistence',
  'sessionProjections',
  'agentPresets',
  'userQuestions',
];

const require = createRequire(import.meta.url);
function assertRuntime(): void {
  if (process.version !== NODE_VERSION) throw new Error('LEPI_NODE_VERSION_MISMATCH');
  for (const dependency of [
    '@deepseek-ai/dsh',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-compaction',
    '@deepseek-ai/dsh-system-prompt',
  ]) {
    const manifest = require(`${dependency}/package.json`) as { version?: string };
    if (manifest.version !== DSH_VERSION) throw new Error('LEPI_CORE_VERSION_MISMATCH');
  }
}

type NoticeKind = 'lepimemory-receipt' | 'lepimemory-recall';
const RECEIPT_LABELS = new Map<string, string>([
  ['pending', '待处理'],
  ['deferred', '待判定'],
  ['written', '已核实入库'],
  ['unknown', '结果不明'],
  ['failed', '处理失败'],
  ['rejected', '已拒绝'],
  ['cancelled', '已取消'],
  ['expired', '已过期'],
  ['local_isolating', '正在停止使用'],
  ['local_isolated', '已停止使用'],
  ['remote_pending', '后端清理待完成'],
  ['submitted', '后端处理中'],
  ['reconciled', '处理完成'],
  ['revoked', '授权已撤销'],
  ['restoring', '恢复待核实'],
  ['queued', '已排队'],
  ['parked', '暂停待重试'],
  ['resubmit_required', '请重新发起输入'],
  ['unavailable', '处理不可用'],
]);
const notice = (text: string, kind: NoticeKind): UserMessage =>
  createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind, form: 'notice', summary: kind },
  }) as UserMessage;

/** 回执行（receipts 查询的只读投影）。 */
interface ReceiptRow {
  id: number;
  request_id: string | null;
  task_id: string | null;
  candidate_id: string | null;
  status: string;
}
/** 回执声明的游标。 */
interface ReceiptClaim {
  key: string;
  cursor: number;
}
/** control 门面在 index 里实际使用的成员（循环构造需要前置声明）。 */
interface ControlHandle {
  askPrivate(
    candidate: unknown,
    agent: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<{ outcome: string; grant_id: string | null }>;
  tool: unknown;
  beforeStep(frame: unknown, next: () => Promise<unknown>): Promise<unknown>;
  contextFor(agent: unknown): { result: object } | null;
  retry(id: string): { status?: unknown; code?: unknown } | null;
  dispose(): Promise<void>;
}

export interface LepiOptions {
  dataRoot?: string;
  databaseFile?: string;
}

export function apply(ctx: Context, options: LepiOptions = {}): void {
  assertRuntime();
  const config = resolveConfig();
  // Launcher sets these before pi-ai starts; also make the independently selected routes explicit here.
  applyDerivedEnv(process.env, config);
  const logger = ctx.logger(name);
  const dataRoot = expandHome(options.dataRoot ?? path.join(config.home.dshHome, 'lepimemory'));
  const dbFile = expandHome(options.databaseFile ?? path.join(dataRoot, 'runtime.sqlite'));
  const store = openStore({ dbFile, legacyDir: dataRoot });
  let disposed = false;
  let sweepTimer: NodeJS.Timeout | undefined;
  const receiptClaims = new Map<string, ReceiptClaim>();
  const evidence = createEvidenceIndex({ store, sessionQuery: ctx.sessionQuery });
  const processor = createProcessor({
    llm: ctx.llm,
    store,
    evidence,
    routes: {
      process: config.llm.process,
      controlFallback: config.llm.controlFallback,
      limits: config.limits,
      timeZone: config.timeZone,
    },
  });
  const admission = createAdmission({
    config,
    processor: processor as unknown as NonNullable<
      Parameters<typeof createAdmission>[0]
    >['processor'],
    store,
  });
  const history = createHistoryCoordinator({
    ctx: ctx as unknown as Parameters<typeof createHistoryCoordinator>[0]['ctx'],
    store,
    processor: processor as unknown as Parameters<typeof createHistoryCoordinator>[0]['processor'],
    evidence,
  });
  const controlRef: { askPrivate?: ControlHandle['askPrivate'] } = {};
  const memory = createMemoryRuntime({
    ctx,
    config,
    store,
    processor,
    admission,
    evidence,
    hindsight: new HindsightClient({
      baseUrl: config.services.hindsight.url,
      bank: config.bank,
    }),
    askPrivate: (candidate, agent, options) => controlRef.askPrivate!(candidate, agent, options),
  });
  const control = createControl({
    ctx: ctx as unknown as Parameters<typeof createControl>[0]['ctx'],
    config,
    store,
    processor: processor as unknown as Parameters<typeof createControl>[0]['processor'],
    evidence,
    history,
    enqueue: async (input) => memory.enqueue(input),
  });
  controlRef.askPrivate = control.askPrivate;
  processor.setMemoryReader(memory.readMemory);
  evidence.setReadableGate(history.isReadable);
  const state = createStateRuntime({ store });

  // Creation/status callbacks run inside native maintenance. A timer gives the sweeper
  // an external owner; never await whenIdle or re-enter append from an event callback.
  function scheduleSweep(): void {
    if (disposed || sweepTimer) return;
    sweepTimer = setTimeout(() => {
      sweepTimer = undefined;
      if (!disposed) history.sweep().catch(() => logger.error('LEPI_HISTORY_BLOCKED'));
    }, 0);
    sweepTimer.unref?.();
  }

  function receipts(sessionId: string): UserMessage | null {
    const key = `receipts:${sessionId}`;
    const cursorRow = store.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as
      | { value?: unknown }
      | undefined;
    const cursor = Number(cursorRow?.value ?? 0);
    const rows = store.db
      .prepare(
        `SELECT a.id,a.request_id,a.task_id,a.candidate_id,
            CASE WHEN a.task_id IS NOT NULL THEN t.status ELSE r.status END AS status
            FROM audit a LEFT JOIN tasks t ON t.id=a.task_id LEFT JOIN requests r ON r.id=a.request_id
            LEFT JOIN lifecycle l ON l.candidate_id=coalesce(a.candidate_id,t.candidate_id)
            WHERE a.id>? AND (a.session_id=? OR r.session_id=?)
            AND (t.kind IN ('write','curate') OR (r.kind<>'check' AND a.task_id IS NULL))
            AND (l.status IS NULL OR l.status NOT IN ('forgotten','audit_only','superseded'))
            ORDER BY a.id LIMIT 32`,
      )
      .all(cursor, sessionId, sessionId) as unknown as ReceiptRow[];
    const unique = new Map<string, ReceiptRow>();
    for (const row of rows) {
      if (!RECEIPT_LABELS.has(row.status)) continue;
      unique.set(row.task_id ?? row.request_id ?? '', row);
    }
    if (!unique.size) return null;
    const message = notice(
      `【系统回执；仅描述实际处理状态，不补全记忆正文】\n${[...unique.values()]
        .map(
          (row) =>
            `${row.task_id ? 'task' : 'request'}=${row.task_id ?? row.request_id}: ${RECEIPT_LABELS.get(row.status)}`,
        )
        .join('\n')}`,
      'lepimemory-receipt',
    );
    const last = rows.at(-1);
    receiptClaims.set(message.id, { key, cursor: last ? last.id : cursor });
    return message;
  }

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    evidence.observe(session, event);
    memory.afterTurn(session, event);
    state.observe(session, event as unknown as Parameters<typeof state.observe>[1]);
    if (event.type === 'user/message') {
      const receipt = receiptClaims.get(event.data.id);
      if (receipt) {
        store.db
          .prepare(
            `INSERT INTO meta(key,value) VALUES (?,?)
                    ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
          )
          .run(receipt.key, String(receipt.cursor));
        receiptClaims.delete(event.data.id);
      }
    }
    if (event.type === 'turn/end') scheduleSweep();
  });
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'lepimemory:state',
        order: STATE_SECTION_ORDER,
        text: (context) => state.text(context),
      }),
    'lepimemory-state.section()',
  );
  ctx.effect(
    () => ctx.tools.register(control.tool as unknown as ToolDefinition),
    'lepimemory.manage_memory',
  );
  installAction(
    ctx,
    config as unknown as Parameters<typeof installAction>[1],
    { logger, store, dataRoot, evidence } as unknown as Parameters<typeof installAction>[2],
  );
  state.reconcileActions();
  installPanel(ctx, config, { logger, store, coordinator: memory, control, dataRoot });

  ctx.on(
    'agent/pre-step',
    (frame, next) => {
      const run = () =>
        control.beforeStep(frame, async () => {
          const epoch = store.policyEpoch;
          const decision = await next();
          if (decision.kind === 'reject' || frame.signal.aborted || disposed)
            return { kind: 'reject' };
          const users = frame.messages.filter((message) => message.source?.kind === 'user');
          if (!users.length) return decision;
          const query = users
            .flatMap((message) => message.content ?? [])
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n');
          const messages: UserMessage[] = [...decision.messages];
          if (query.trim()) {
            const entry = control.contextFor(frame.agent);
            const purpose =
              entry &&
              'recall_purpose' in entry.result &&
              typeof entry.result.recall_purpose === 'string'
                ? entry.result.recall_purpose
                : 'current';
            const recalled = await memory.recall({
              query,
              agent: frame.agent,
              signal: frame.signal,
              epoch,
              purpose,
            });
            if (recalled.text) messages.push(notice(recalled.text, 'lepimemory-recall'));
          }
          if (epoch !== store.policyEpoch || frame.signal.aborted || disposed)
            return { kind: 'reject' };
          const receipt = receipts(frame.agent.session.id);
          if (receipt) messages.push(receipt);
          return { ...decision, messages };
        });
      return history.beforeStep(frame as never, run as never) as never;
    },
    { prepend: true },
  );
  ctx.on(
    'agent/request',
    (frame, next) => history.beforeRequest(frame as never, next as never) as never,
    { prepend: true },
  );
  ctx.on('agent/created', () => {
    scheduleSweep();
    return undefined;
  });
  ctx.on('agent/status', ({ status }) => {
    if (status === 'idle') scheduleSweep();
  });
  ctx.effect(
    () => async () => {
      disposed = true;
      clearTimeout(sweepTimer);
      await Promise.allSettled([control.dispose(), history.dispose(), memory.dispose()]);
      evidence.dispose();
      receiptClaims.clear();
      store.close();
    },
    'lepimemory.dispose()',
  );
  memory.start();
  scheduleSweep();
}
