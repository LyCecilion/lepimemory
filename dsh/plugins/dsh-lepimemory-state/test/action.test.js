import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { openStore } from '../lib/store.js';
import { installAction, recoverActions, toolResultInfo } from '../lib/action.js';
import { initialState, renderState } from '../lib/shared/state.js';
import { createStateRuntime } from '../lib/state-runtime.js';
import { createEvidenceIndex } from '../lib/evidence.js';

const nr = createRequire(createRequire(new URL('../../../../package.json', import.meta.url)).resolve('@deepseek-ai/dsh/package.json'));
const { Context } = nr('@deepseek-ai/cordis');
const { LlmAdapter, ToolCallId, createUserMessage } = nr('@deepseek-ai/dsh-llm');
const textChunks = () => [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Synthetic completion.' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Synthetic completion.' } },
    { type: 'finish', reason: { kind: 'stop' } },
];

async function fixture(t, { approval = true } = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lep-action-test-'));
    const ctx = new Context(), fibers = [], handles = [], removers = [], captures = [];
    let clock = Date.parse('2026-10-05T00:00:00Z'), answer = 'allowed-once', pending = null;
    const store = openStore({ dbFile: path.join(home, 'runtime.sqlite'), legacyDir: home, now: () => clock });
    const state = createStateRuntime({ store, now: () => clock });
    const boot = async (name, config) => { const f = ctx.plugin(nr(name).default, config); fibers.push(f); await f.await(); };
    for (const name of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-session-projection']) await boot(name);
    await boot('@deepseek-ai/dsh-session-persistence-jsonl', { root: path.join(home, 'sessions') });
    if (approval) await boot('@deepseek-ai/dsh-user-approval');
    await boot('@deepseek-ai/dsh-agent-loop');
    class Transport extends LlmAdapter {
        async resolveModel(p, m, s) { return { ...await super.resolveModel(p, m, s), systemPromptUpdate: 'in-history' }; }
        async *stream(options) {
            captures.push(structuredClone(options.messages));
            if (!pending) { yield* textChunks(); return; }
            const requests = pending.calls ?? [pending]; pending = null;
            for (const [index, request] of requests.entries()) {
                const { args, name = 'write_note', id = randomUUID() } = request;
                const callId = ToolCallId(id), raw = JSON.stringify(args);
                yield* [
                    { type: 'block-start', index, blockType: 'tool-call' },
                    { type: 'tool-call-delta', index, id: callId, name, argumentsDelta: raw },
                    { type: 'block-end', index, block: { type: 'tool-call', id: callId, name, arguments: raw } },
                ];
            }
            yield { type: 'finish', reason: { kind: 'tool-calls' } };
        }
    }
    removers.push(ctx.llm.registerAdapter(['synthetic-action'], new Transport()));
    removers.push(ctx.on('approval/request', () => Promise.resolve(answer)));
    const evidence = createEvidenceIndex({ store });
    removers.push(ctx.on('session/event', (session, event) => { evidence.observe(session, event); state.observe(session, event); }));
    removers.push(ctx.systemPrompt.section({ name: 'lepimemory-action-state-test', order: 0, text: context => state.text(context) }));
    installAction(ctx, {}, { logger: ctx.logger, store, dataRoot: home, evidence });
    const handle = await ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider: 'synthetic-action', model: 'fixture' } });
    handles.push(handle);
    t.after(async () => {
        for (const h of handles.reverse()) await h.dispose();
        for (const remove of removers.reverse()) remove();
        for (const f of fibers.reverse()) await f.dispose();
        store.close(); fs.rmSync(home, { recursive: true, force: true });
    });
    const say = async (args, options = {}) => {
        pending = args === null ? null : { args, ...options };
        handle.agent.send(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Independent synthetic user request.' }] }), 'next-turn', true);
        await handle.agent.whenIdle();
        return handle.agent.session.snapshotEvents().filter(e => e.type === 'tool/result').at(-1);
    };
    return { home, ctx, store, state, evidence, handle, captures, say,
        setAnswer: value => { answer = value; }, setClock: value => { clock = value; },
        actions: () => store.db.prepare('SELECT * FROM actions ORDER BY rowid').all(),
        notes: () => fs.existsSync(path.join(home, 'notes')) ? fs.readdirSync(path.join(home, 'notes')).filter(p => p.endsWith('.md')) : [],
    };
}

test('native rejected, cancelled and unavailable notes create neither file nor successful-action state or evidence', async t => {
    for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
        await t.test(outcome, async t => {
            const f = await fixture(t, { approval: outcome !== 'unavailable' });
            f.setAnswer(outcome);
            const event = await f.say({ title: 'Synthetic note', body: 'Independent body.' });
            const info = toolResultInfo(event.data.message, event.data.meta);
            assert.equal(info.metadata.outcome, outcome);
            assert.equal(info.metadata.executed, false);
            assert.equal(f.actions()[0].status, outcome);
            assert.deepEqual(f.notes(), []);
            assert.equal(f.store.readState().mood.valence, 0);
            assert.equal(f.store.readState().relation.closeness, 0.2);
            assert.equal(f.store.readState().relation.trust, 0.3);
            assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM evidence WHERE actor='action'").get().n, 0);
        });
    }
});

test('allowed native notes with the same title preserve both bodies and settle each real turn only once', async t => {
    const f = await fixture(t);
    for (const body of ['First independent body.', 'Second independent body.']) {
        const result = await f.say({ title: 'Same synthetic title', body });
        const info = toolResultInfo(result.data.message, result.data.meta);
        assert.equal(info.metadata.executed, true);
        assert.equal(info.metadata.outcome, 'allowed-once');
        assert.equal(path.basename(info.metadata.path), `${info.metadata.action_id}.md`);
    }
    const files = f.notes();
    assert.equal(files.length, 2);
    const bodies = files.map(p => fs.readFileSync(path.join(f.home, 'notes', p), 'utf8'));
    assert.equal(bodies.some(body => body.includes('First independent body.')), true);
    assert.equal(bodies.some(body => body.includes('Second independent body.')), true);
    const after = f.store.readState();
    assert.equal(after.mood.valence, 0.24);
    assert.equal(after.relation.closeness, 0.26);
    assert.equal(after.relation.familiarity, 0.16);
    const ended = f.handle.agent.session.snapshotEvents().filter(e => e.type === 'turn/end');
    const reopened = createStateRuntime({ store: f.store });
    for (const event of ended) reopened.observe(f.handle.agent.session, event);
    assert.deepEqual(f.store.readState(), after);
    assert.equal(f.actions().every(row => row.state_applied === 1), true);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM settled_turns').get().n, 2);
});

test('native schema and whitespace rejection cannot create a note or lower relationship trust', async t => {
    const f = await fixture(t);
    for (const args of [{ title: 123, body: 'No coercion.' }, { title: ' ', body: 'No empty title.' }, { title: 'valid', body: '\n\t' }]) {
        const result = await f.say(args);
        assert.equal(result.data.message.isError, true);
    }
    assert.deepEqual(f.notes(), []);
    assert.equal(f.actions().some(row => row.status === 'executed'), false);
    assert.equal(f.store.readState().relation.trust, 0.3);
    assert.equal(f.store.readState().mood.valence, -0.36);
});

test('diagnostic effective state is read-only while actual native assembly persists exactly one elapsed decay before pre-step', async t => {
    const f = await fixture(t);
    const start = Date.parse('2026-10-05T00:00:00Z');
    const seeded = initialState(new Date(start).toISOString());
    seeded.mood.valence = 0.4;
    seeded.reasons = [{ dimension: 'mood', text: '先前操作已完成。', at: new Date(start).toISOString() }];
    f.store.commitState(seeded, { type: 'state', status: 'seeded' });
    f.setClock(start + 6 * 3600_000 + 1);
    assert.equal(f.state.readEffective().mood.valence, 0.2);
    assert.deepEqual(f.store.readState(), seeded);
    let atPreStep;
    const remove = f.ctx.on('agent/pre-step', (frame, next) => { atPreStep = f.store.readState(); return next(frame); });
    try { await f.say(null); } finally { remove(); }
    assert.equal(atPreStep.mood.valence, 0.2);
    assert.equal(atPreStep.relation.trust, seeded.relation.trust);
    assert.equal(atPreStep.relation.closeness, seeded.relation.closeness);
    assert.equal(JSON.stringify(f.captures[0]).includes('先前操作已完成。'), false);
    const decays = f.store.db.prepare("SELECT data_json FROM audit WHERE type='mood.decay'").all();
    assert.equal(decays.length, 1);
    const audit = JSON.parse(decays[0].data_json);
    assert.equal(audit.before.mood.valence, 0.4);
    assert.equal(audit.after.mood.valence, 0.2);
    const baseline = initialState();
    baseline.reasons = seeded.reasons;
    assert.equal(renderState(baseline).includes('先前操作已完成。'), false);
});

test('prepared recovery accepts only the matching final hash and never rewrites a missing or changed file', async t => {
    const f = await fixture(t);
    fs.mkdirSync(path.join(f.home, 'notes'), { recursive: true });
    const hash = text => createHash('sha256').update(text).digest('hex');
    const rows = [];
    for (const [kind, actual] of [['matching', '# Synthetic\n\nOriginal body.\n'], ['changed', 'Externally changed body.'], ['missing', null]]) {
        const actionId = randomUUID(), file = path.join(f.home, 'notes', `${actionId}.md`);
        if (actual !== null) fs.writeFileSync(file, actual);
        f.store.db.prepare(`INSERT INTO actions(action_id,session_id,turn,step,call_id,title,path,body_hash,status) VALUES (?,?,?,?,?,?,?,?,'prepared')`)
            .run(actionId, String(f.handle.agent.session.id), 10, 1, `recovery-${kind}`, 'Synthetic', file, hash('# Synthetic\n\nOriginal body.\n'));
        rows.push({ kind, actionId, file, actual });
    }
    recoverActions({ store: f.store, dataRoot: f.home });
    for (const row of rows) {
        assert.equal(f.store.db.prepare('SELECT status FROM actions WHERE action_id=?').get(row.actionId).status, row.kind === 'matching' ? 'executed' : 'unknown');
        if (row.actual === null) assert.equal(fs.existsSync(row.file), false);
        else assert.equal(fs.readFileSync(row.file, 'utf8'), row.actual);
    }
    recoverActions({ store: f.store, dataRoot: f.home });
    assert.equal(f.notes().length, 2);
});

test('an existing destination wins the atomic link race and is never overwritten or removed', async t => {
    const f = await fixture(t);
    const originalLink = fs.linkSync;
    let destination;
    fs.linkSync = (source, target) => {
        destination = target;
        fs.writeFileSync(target, 'Existing independent note must survive.', { flag: 'wx' });
        return originalLink(source, target);
    };
    let result;
    try { result = await f.say({ title: 'Collision', body: 'Must not replace another file.' }); }
    finally { fs.linkSync = originalLink; }
    assert.equal(result.data.message.isError, true);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'Existing independent note must survive.');
    assert.equal(f.actions()[0].status === 'executed', false);
    assert.equal(f.actions()[0].state_applied, 0);
    assert.equal(f.store.readState().relation.closeness, 0.2);
    assert.deepEqual(fs.readdirSync(path.join(f.home, 'notes')), [path.basename(destination)]);
});

test('a renderer error after a real file commit cannot negate the journal or count as a second failed action', async t => {
    const f = await fixture(t);
    const definition = f.ctx.tools.get('write_note');
    const render = definition.output.render;
    definition.output.render = () => { throw new Error('Synthetic downstream renderer failure.'); };
    let result;
    try { result = await f.say({ title: 'Committed note', body: 'The side effect is already real.' }); }
    finally { definition.output.render = render; }
    assert.equal(result.data.message.isError, true);
    assert.equal(f.actions()[0].status, 'executed');
    assert.equal(f.actions()[0].state_applied, 1);
    assert.equal(fs.readFileSync(f.actions()[0].path, 'utf8').includes('The side effect is already real.'), true);
    assert.equal(f.store.readState().mood.valence, 0.12);
    assert.equal(f.store.readState().relation.closeness, 0.23);
    assert.equal(f.store.readState().relation.trust, 0.3);
});

test('a repeated native call identity cannot create another file or count the original action twice', async t => {
    const f = await fixture(t);
    const id = randomUUID();
    await f.say({ title: 'Original', body: 'Original independent body.' }, { id });
    const after = f.store.readState();
    await f.say({ title: 'Different', body: 'A repeated identity must not cause a new write.' }, { id });
    assert.equal(f.actions().length, 1);
    assert.equal(f.notes().length, 1);
    assert.equal(fs.readFileSync(f.actions()[0].path, 'utf8').includes('Original independent body.'), true);
    assert.equal(f.store.readState().relation.closeness, after.relation.closeness);
    assert.equal(f.store.readState().mood.valence, after.mood.valence);
});

test('failed state audit commits no numeric delta, settlement or action application, and the same real end can be retried', async t => {
    const f = await fixture(t);
    const originalAudit = f.store.audit.bind(f.store);
    let fail = true;
    f.store.audit = event => {
        if (fail && event.type === 'state' && event.status === 'settled') throw new Error('Synthetic storage failure.');
        return originalAudit(event);
    };
    await f.say({ title: 'Real file, deferred state', body: 'The state transaction must be atomic.' });
    assert.equal(f.actions()[0].status, 'executed');
    assert.equal(f.actions()[0].state_applied, 0);
    assert.equal(f.store.readState().mood.valence, 0);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM settled_turns').get().n, 0);
    fail = false;
    const end = f.handle.agent.session.snapshotEvents().find(e => e.type === 'turn/end');
    f.state.observe(f.handle.agent.session, end);
    assert.equal(f.actions()[0].state_applied, 1);
    assert.equal(f.store.readState().mood.valence, 0.12);
    assert.equal(f.store.readState().relation.familiarity, 0.13);
    const row = f.store.db.prepare("SELECT data_json FROM audit WHERE type='state' AND status='settled'").get();
    const audit = JSON.parse(row.data_json);
    assert.equal(audit.before.mood.valence, 0);
    assert.equal(audit.after.mood.valence, 0.12);
    assert.deepEqual(audit.after, f.store.readState());
});

test('a failed decay audit rejects native prompt assembly rather than returning a cached state cause', async t => {
    const f = await fixture(t);
    const seeded = f.store.readState();
    seeded.mood.valence = 0.4;
    seeded.reasons = [{ dimension: 'mood', text: 'Previous cause that must not be cached.', at: seeded.mood.updatedAt }];
    f.store.commitState(seeded, { type: 'state', status: 'seeded' });
    const { assembleContextFor } = nr('@deepseek-ai/dsh-agent');
    await f.ctx.systemPrompt.assemble(assembleContextFor(f.handle.agent));
    f.setClock(Date.parse(seeded.mood.updatedAt) + 6 * 3600_000);
    const originalAudit = f.store.audit.bind(f.store);
    f.store.audit = event => {
        if (event.type === 'mood.decay') throw new Error('Synthetic audit failure.');
        return originalAudit(event);
    };
    await assert.rejects(() => f.ctx.systemPrompt.assemble(assembleContextFor(f.handle.agent)));
    assert.deepEqual(f.store.readState(), seeded);
    assert.equal(f.captures.length, 0);
});

test('an old settled end replay cannot erase the current real turn facts across a runtime restart', async t => {
    const f = await fixture(t);
    await f.say(null);
    const oldEnd = f.handle.agent.session.snapshotEvents().find(e => e.type === 'turn/end');
    const restarted = createStateRuntime({ store: f.store });
    const remove = f.ctx.on('session/event', (session, event) => {
        if (event.type === 'user/message') restarted.observe(session, oldEnd);
    });
    try { await f.say(null); } finally { remove(); }
    assert.equal(f.store.readState().relation.familiarity, 0.16);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM settled_turns').get().n, 2);
});

test('two real files committed before journal failure recover as one successful turn, without rewriting or double brighten', async t => {
    const f = await fixture(t);
    const audit = f.store.audit.bind(f.store);
    f.store.audit = event => {
        if (event.type === 'action' && event.status === 'executed') throw new Error('Synthetic post-file audit failure.');
        return audit(event);
    };
    await f.say({}, { calls: [
        { args: { title: 'First recovered', body: 'First committed body.' } },
        { args: { title: 'Second recovered', body: 'Second committed body.' } },
    ] });
    assert.equal(f.notes().length, 2);
    assert.equal(f.actions().every(row => row.status === 'prepared'), true);
    assert.equal(f.store.readState().mood.valence, 0);
    const originals = f.actions().map(row => fs.readFileSync(row.path, 'utf8'));
    f.store.audit = audit;
    recoverActions({ store: f.store, dataRoot: f.home });
    const restarted = createStateRuntime({ store: f.store });
    restarted.reconcileActions();
    assert.equal(f.actions().every(row => row.status === 'executed' && row.state_applied === 1), true);
    assert.equal(f.store.readState().mood.valence, 0.12);
    assert.equal(f.store.readState().relation.closeness, 0.23);
    assert.deepEqual(f.actions().map(row => fs.readFileSync(row.path, 'utf8')), originals);
    const settled = f.store.readState();
    restarted.reconcileActions();
    assert.deepEqual(f.store.readState(), settled);
});
