/** Unified SQLite-backed runtime. State follows persona prefix (0), before policy (500). */
import path from 'node:path';
import { createRequire } from 'node:module';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { installAction } from './action.js';
import { installPanel } from './panel.js';
import { resolveConfig, applyDerivedEnv } from './config.js';
import { openStore } from './store.js';
import { expandHome } from './state.js';
import { createStateRuntime } from './state-runtime.js';
import { createEvidenceIndex } from './evidence.js';
import { createProcessor } from './processor.js';
import { createAdmission } from './admission.js';
import { createHistoryCoordinator } from './history.js';
import { createMemoryRuntime } from './memory.js';
import { createControl } from './control.js';
import { HindsightClient } from './hindsight.js';

export const name = 'lepimemory-state';
export const RUNTIME_CONTRACT = 1;
export const STATE_SECTION_ORDER = 50;
export const inject = ['systemPrompt', 'tools', 'llm', 'agents', 'sessions',
    'sessionQuery', 'sessionPersistence', 'sessionProjections', 'agentPresets', 'userQuestions'];

const require = createRequire(import.meta.url);
const DSH_VERSION = '0.1.7-rc.2';
function assertRuntime() {
    if (process.version !== 'v24.20.0') throw new Error('LEPI_NODE_VERSION_MISMATCH');
    for (const dependency of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-session',
        '@deepseek-ai/dsh-compaction', '@deepseek-ai/dsh-system-prompt']) {
        if (require(`${dependency}/package.json`).version !== DSH_VERSION)
            throw new Error('LEPI_CORE_VERSION_MISMATCH');
    }
}

const RECEIPT_LABELS = new Map([
    ['pending', '待处理'], ['deferred', '待判定'], ['written', '已核实入库'],
    ['unknown', '结果不明'], ['failed', '处理失败'], ['rejected', '已拒绝'],
    ['cancelled', '已取消'], ['expired', '已过期'], ['local_isolating', '正在停止使用'],
    ['local_isolated', '已停止使用'], ['remote_pending', '后端清理待完成'],
    ['submitted', '后端处理中'], ['reconciled', '处理完成'], ['revoked', '授权已撤销'],
    ['restoring', '恢复待核实'], ['queued', '已排队'], ['parked', '暂停待重试'],
    ['resubmit_required', '请重新发起输入'], ['unavailable', '处理不可用'],
]);
const notice = (text, kind) => createUserMessage({ content: [{ type: 'text', text }],
    source: { kind, form: 'notice', summary: kind } });

export function apply(ctx, options = {}) {
    assertRuntime();
    const config = resolveConfig();
    // Launcher sets these before pi-ai starts; also make the independently selected routes explicit here.
    applyDerivedEnv(process.env, config);
    const logger = ctx.logger(name);
    const dataRoot = expandHome(options.dataRoot ?? path.join(config.home.dshHome, 'lepimemory'));
    const dbFile = expandHome(options.databaseFile ?? path.join(dataRoot, 'runtime.sqlite'));
    const store = openStore({ dbFile, legacyDir: dataRoot });
    let disposed = false;
    let sweepTimer = null;
    const receiptClaims = new Map();
    const evidence = createEvidenceIndex({ store, sessionQuery: ctx.sessionQuery });
    const processor = createProcessor({ llm: ctx.llm, store, evidence, routes: {
        process: config.llm.process, controlFallback: config.llm.controlFallback,
        limits: config.limits, timeZone: config.timeZone,
    } });
    const admission = createAdmission({ config, processor, store });
    const history = createHistoryCoordinator({ ctx, store, processor, evidence });
    let control;
    const memory = createMemoryRuntime({ ctx, config, store, processor, admission,
        history, evidence, hindsight: new HindsightClient({
            baseUrl: config.services.hindsight.url, bank: config.bank,
        }), askPrivate: (candidate, agent, options) => control.askPrivate(candidate, agent, options) });
    control = createControl({ ctx, config, store, processor, evidence, history,
        enqueue: input => memory.enqueue(input) });
    processor.setMemoryReader(memory.readMemory);
    evidence.setReadableGate(history.isReadable);
    const state = createStateRuntime({ store });

    // Creation/status callbacks run inside native maintenance. A timer gives the sweeper
    // an external owner; never await whenIdle or re-enter append from an event callback.
    function scheduleSweep() {
        if (disposed || sweepTimer) return;
        sweepTimer = setTimeout(() => {
            sweepTimer = null;
            if (!disposed) history.sweep().catch(() => logger.error('LEPI_HISTORY_BLOCKED'));
        }, 0);
        sweepTimer.unref?.();
    }

    function receipts(sessionId) {
        const key = `receipts:${sessionId}`;
        const cursor = Number(store.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? 0);
        const rows = store.db.prepare(`SELECT a.id,a.request_id,a.task_id,a.candidate_id,
            CASE WHEN a.task_id IS NOT NULL THEN t.status ELSE r.status END AS status
            FROM audit a LEFT JOIN tasks t ON t.id=a.task_id LEFT JOIN requests r ON r.id=a.request_id
            LEFT JOIN lifecycle l ON l.candidate_id=coalesce(a.candidate_id,t.candidate_id)
            WHERE a.id>? AND (a.session_id=? OR r.session_id=?)
            AND (t.kind IN ('write','curate') OR (r.kind<>'check' AND a.task_id IS NULL))
            AND (l.status IS NULL OR l.status NOT IN ('forgotten','audit_only','superseded'))
            ORDER BY a.id LIMIT 32`).all(cursor, sessionId, sessionId);
        const unique = new Map();
        for (const row of rows) {
            if (!RECEIPT_LABELS.has(row.status)) continue;
            unique.set(row.task_id ?? row.request_id, row);
        }
        if (!unique.size) return null;
        const message = notice(`【系统回执；仅描述实际处理状态，不补全记忆正文】\n${[...unique.values()]
            .map(row => `${row.task_id ? 'task' : 'request'}=${row.task_id ?? row.request_id}: ${RECEIPT_LABELS.get(row.status)}`).join('\n')}`,
            'lepimemory-receipt');
        receiptClaims.set(message.id, { key, cursor: rows.at(-1).id });
        return message;
    }

    ctx.on('session/event', (session, event) => {
        evidence.observe(session, event);
        memory.afterTurn(session, event);
        state.observe(session, event);
        if (event.type === 'user/message') {
            const receipt = receiptClaims.get(event.data?.id);
            if (receipt) {
                store.db.prepare(`INSERT INTO meta(key,value) VALUES (?,?)
                    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(receipt.key, String(receipt.cursor));
                receiptClaims.delete(event.data.id);
            }
        }
        if (event.type === 'turn/end') scheduleSweep();
    });
    ctx.effect(() => ctx.systemPrompt.section({ name: 'lepimemory:state',
        order: STATE_SECTION_ORDER, text: context => state.text(context) }), 'lepimemory-state.section()');
    ctx.effect(() => ctx.tools.register(control.tool), 'lepimemory.manage_memory');
    installAction(ctx, config, { logger, store, dataRoot, evidence });
    state.reconcileActions();
    installPanel(ctx, config, { logger, store, coordinator: memory, control, dataRoot });

    ctx.on('agent/pre-step', (frame, next) => history.beforeStep(frame,
        () => control.beforeStep(frame, async () => {
            const epoch = store.policyEpoch;
            const decision = await next();
            if (decision.kind === 'reject' || frame.signal.aborted || disposed) return { kind: 'reject' };
            const users = frame.messages.filter(message => message.source?.kind === 'user');
            if (!users.length) return decision;
            const query = users.flatMap(message => message.content ?? [])
                .filter(block => block.type === 'text').map(block => block.text).join('\n');
            const messages = [...decision.messages];
            if (query.trim()) {
                const recalled = await memory.recall({ query, agent: frame.agent, signal: frame.signal,
                    epoch, purpose: control.contextFor(frame.agent)?.result.recall_purpose ?? 'current' });
                if (recalled.text) messages.push(notice(recalled.text, 'lepimemory-recall'));
            }
            if (epoch !== store.policyEpoch || frame.signal.aborted || disposed) return { kind: 'reject' };
            const receipt = receipts(frame.agent.session.id);
            if (receipt) messages.push(receipt);
            return { ...decision, messages };
        })), { prepend: true });
    ctx.on('agent/request', (frame, next) => history.beforeRequest(frame, next), { prepend: true });
    ctx.on('agent/created', () => { scheduleSweep(); });
    ctx.on('agent/status', ({ status }) => { if (status === 'idle') scheduleSweep(); });
    ctx.on('dispose', async () => {
        disposed = true;
        clearTimeout(sweepTimer);
        await Promise.allSettled([control.dispose(), history.dispose(), memory.dispose()]);
        evidence.dispose();
        receiptClaims.clear();
        store.close();
    });
    memory.start();
    scheduleSweep();
}
