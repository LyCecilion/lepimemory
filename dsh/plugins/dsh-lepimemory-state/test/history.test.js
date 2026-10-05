/**
 * Step 9 canonical-history consumer regressions.
 *
 * These tests drive the *released* native graph — real `Session` log, JSONL
 * persistence, SQLite session query, the real agent driver from
 * `@deepseek-ai/dsh-agent-loop`, and the *public* synthetic `LlmAdapter`
 * transport registered through `ctx.llm.registerAdapter`. They assert
 * consumer-visible behaviour (durable surface, next provider request, evidence
 * reads, store rows), never registration strings, wire names or mock echoes.
 *
 * A small fake `redactHistory` supplies deterministic semantic judgements so
 * the coordinator's native windows can be isolated; everything around it
 * (SQLite fence, evidence references, JSONL surface, provider request) is real.
 *
 * Synthetic material only. No credentials, no cloud model.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { openStore } from '../lib/store.js';
import { createEvidenceIndex } from '../lib/evidence.js';
import { createHistoryCoordinator } from '../lib/history.js';
import { createProcessor } from '../lib/processor.js';

const rootRequire = createRequire(new URL('../../../../package.json', import.meta.url));
const nativeRequire = createRequire(rootRequire.resolve('@deepseek-ai/dsh/package.json'));
const { Context } = nativeRequire('@deepseek-ai/cordis');
const { LlmAdapter, ToolCallId, createUserMessage } = nativeRequire('@deepseek-ai/dsh-llm');
const { toolPairingBalancedBefore, toolPairingBalancedAfter } = nativeRequire('@deepseek-ai/dsh-compaction');
const { defineContentToolFixture } = nativeRequire('@deepseek-ai/dsh-tools');

// Stable synthetic markers. TOKEN stands in for forgotten private material; the
// others let the fake processor declare "keep only the non-target span",
// "uncertain", "missing span proof", and "paired tool material".
const TOKEN = 'FORGET_DEMO_TOKEN';
const KEEP = 'KEEP_SPAN_MARKER';
const UNCERTAIN = 'UNCERTAIN_MARKER';
const BOGUS = 'BOGUS_SPAN_MARKER';
const TOOL = 'SYNTHETIC_TOOL_MARKER';

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fullSpans = node => node.blocks.map(block => ({ block_index: block.block_index,
    start: 0, end: block.text.length, source_ids: block.source_ids }));

/** Deterministic semantic judgement over the real surface nodes. */
function defaultDecide({ nodes }) {
    const decisions = [];
    const uncertain_seqs = [];
    for (const node of nodes) {
        const text = node.blocks.map(block => block.text).join('\n');
        if (text.includes(UNCERTAIN)) uncertain_seqs.push(node.seq);
        if (text.includes(KEEP)) {
            decisions.push({ seq: node.seq, decision: 'keep',
                keep_spans: node.blocks.filter(block => !block.text.includes(TOKEN))
                    .map(block => ({ block_index: block.block_index, start: 0, end: block.text.length, source_ids: block.source_ids })) });
        } else if (text.includes(TOKEN) || text.includes(BOGUS) || text.includes(UNCERTAIN) || text.includes(TOOL)) {
            decisions.push({ seq: node.seq, decision: 'remove', keep_spans: [] });
        } else {
            decisions.push({ seq: node.seq, decision: 'keep', keep_spans: fullSpans(node) });
        }
    }
    return { nodes: decisions, uncertain_seqs };
}

const textChunks = (text = 'Synthetic transport response.') => [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 20, outputTokens: 8 } },
    { type: 'finish', reason: { kind: 'stop' } },
];

const toolCallChunks = () => {
    const id = ToolCallId('synthetic-call-1');
    return [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'Calling the synthetic tool.' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'Calling the synthetic tool.' } },
        { type: 'block-start', index: 1, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 1, id, name: 'synthetic-echo', argumentsDelta: '{}' },
        { type: 'block-end', index: 1, block: { type: 'tool-call', id, name: 'synthetic-echo', arguments: '{}' } },
        { type: 'usage', usage: { inputTokens: 20, outputTokens: 8 } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
    ];
};

/** One processor tool call round (fetch_context / submit_result), finish=tool-calls. */
const processorToolCall = (name, args) => {
    const id = ToolCallId(`proc-${randomUUID()}`);
    const raw = JSON.stringify(args);
    return [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } },
        { type: 'usage', usage: { inputTokens: 30, outputTokens: 20 } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
    ];
};

async function nativeHistoryFixture(t, { real = false } = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lep-history-test-'));
    const ctx = new Context();
    const fibers = [];
    const handles = new Set();
    const removers = [];
    const captures = [];
    let respond = () => textChunks();
    let decide = defaultDecide;

    const boot = async (name, config) => {
        const fiber = ctx.plugin(nativeRequire(name).default, config);
        fibers.push(fiber);
        await fiber.await();
    };
    for (const name of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-session-projection'])
        await boot(name);
    await boot('@deepseek-ai/dsh-session-persistence-jsonl', { root: path.join(home, 'sessions') });
    await boot('@deepseek-ai/dsh-session-query-sqlite', { path: ':memory:', openAt: 'never' });
    await boot('@deepseek-ai/dsh-agent-loop');

    class SyntheticTransport extends LlmAdapter {
        async resolveModel(provider, model, signal) {
            return { ...await super.resolveModel(provider, model, signal), systemPromptUpdate: 'in-history' };
        }
        async *stream(options) {
            captures.push({ provider: options.provider, model: options.model, sessionId: options.sessionId,
                frozen: Object.isFrozen(options) && Object.isFrozen(options.messages),
                messages: structuredClone(options.messages) });
            yield* respond(captures.length - 1, options);
        }
    }
    const detachAdapter = ctx.llm.registerAdapter(['synthetic-history'], new SyntheticTransport());

    const store = openStore({ dbFile: path.join(home, 'runtime.sqlite'), legacyDir: home });
    const evidence = createEvidenceIndex({ store, sessionQuery: ctx.sessionQuery });
    removers.push(ctx.on('session/event', (session, event) => evidence.observe(session, event)));
    removers.push(ctx.systemPrompt.section({ name: 'lep-history-test-state', order: 0,
        text: () => `Synthetic static persona. ${store.readState().reasons.map(reason => reason.text).join(' ')}` }));

    const processor = real
        ? createProcessor({ llm: ctx.llm,
            routes: { process: { provider: 'synthetic-history', model: 'fixture', configured: true },
                controlFallback: { provider: 'synthetic-history', model: 'fixture', configured: true },
                limits: {}, timeZone: 'Asia/Shanghai' },
            evidence, store })
        : { redactHistory: input => Promise.resolve(decide(input)) };
    const coordinator = createHistoryCoordinator({ ctx, store, processor, evidence });
    removers.push(ctx.on('agent/pre-step', (frame, next) => coordinator.beforeStep(frame, next), { prepend: true }));
    removers.push(ctx.on('agent/request', (frame, next) => coordinator.beforeRequest(frame, next), { prepend: true }));
    evidence.setReadableGate(coordinator.isReadable);

    async function create() {
        const handle = await ctx.agents.create({ sessionId: randomUUID(),
            agentOptions: { provider: 'synthetic-history', model: 'fixture' } });
        handles.add(handle);
        return handle;
    }
    async function say(agent, content) {
        const blocks = (Array.isArray(content) ? content : [content]).map(text => ({ type: 'text', text }));
        const message = createUserMessage({ source: { kind: 'user' }, content: blocks });
        agent.send(message, 'next-turn', true);
        await agent.whenIdle();
        return message;
    }
    function evidenceIdFor(messageId) {
        return store.db.prepare("SELECT id FROM evidence WHERE message_id=? AND kind='user_message' ORDER BY seq LIMIT 1")
            .get(String(messageId))?.id;
    }
    function seedCandidate({ text, sourceIds, subject_key = 'user', facet_key = 'synthetic' }) {
        const candidate_id = randomUUID();
        const json = JSON.stringify({ candidate_id, text, subject_key, facet_key, source_ids: sourceIds });
        store.transaction(() => {
            store.db.prepare('INSERT INTO snapshots(candidate_id,json,payload_hash,created_at) VALUES (?,?,?,?)')
                .run(candidate_id, json, sha(json), store.now());
            store.db.prepare("INSERT INTO lifecycle(candidate_id,status,purpose,policy_epoch,updated_at) VALUES (?,'active','current',?,?)")
                .run(candidate_id, store.policyEpoch, store.now());
        });
        return candidate_id;
    }
    function seedRequest(sessionId, kind = 'forget') {
        const id = randomUUID();
        store.transaction(() => store.db.prepare(`INSERT INTO requests
            (id,source_key,session_id,kind,status,source_ids_json,payload_json,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)`)
            .run(id, `test:${id}`, sessionId, kind, 'confirmed', '[]', '{}', store.now(), store.now()));
        return id;
    }
    function seedReason(text) {
        store.transaction(() => store.commitState({ ...store.readState(),
            reasons: [{ dimension: 'mood', text, at: new Date().toISOString() }] },
        { type: 'test.seed', status: 'seeded' }));
    }

    t.after(async () => {
        for (const remove of removers) remove();
        await coordinator.dispose();
        for (const handle of handles) await handle.dispose();
        detachAdapter();
        evidence.dispose();
        store.close();
        for (const fiber of fibers.reverse()) await fiber.dispose();
        fs.rmSync(home, { recursive: true, force: true });
    });

    return { ctx, store, evidence, coordinator, captures, create, say, evidenceIdFor,
        seedCandidate, seedRequest, seedReason, handles, home,
        setDecide(fn) { decide = fn; }, setRespond(fn) { respond = fn; } };
}

// ── 1. atomic forget: policy + state reasons cleared, numerics untouched ──────
test('forget advances the policy epoch and clears state reasons atomically without touching mood or relation', async t => {
    const f = await nativeHistoryFixture(t);
    f.seedReason(`${TOKEN} stale synthetic reason`);
    const handle = await f.create();
    const target = await f.say(handle.agent, `My private codeword is ${TOKEN}.`);
    const before = f.store.readState();
    const beforeEpoch = f.store.policyEpoch;
    const candidateId = f.seedCandidate({ text: `My private codeword is ${TOKEN}.`, sourceIds: [f.evidenceIdFor(target.id)] });
    const requestId = f.seedRequest(handle.agent.session.id);
    const lastOffset = handle.agent.session.seq - 1;

    const result = await f.coordinator.plan(requestId, [candidateId]);
    assert.equal(result.status, 'local_isolating');
    assert.equal(result.request_id, requestId);
    assert.equal(result.epoch, beforeEpoch + 1);

    // One durable cutover: epoch, lifecycle, scope, immutable pointer and audit.
    assert.equal(f.store.policyEpoch, beforeEpoch + 1);
    const lifecycle = f.store.db.prepare('SELECT * FROM lifecycle WHERE candidate_id=?').get(candidateId);
    assert.equal(lifecycle.status, 'forgotten');
    assert.equal(lifecycle.policy_epoch, beforeEpoch + 1);
    const scopes = f.store.db.prepare('SELECT * FROM forget_scopes WHERE request_id=?').all(requestId);
    assert.equal(scopes.length, 1);
    assert.equal(scopes[0].active, 1);
    assert.equal(scopes[0].epoch, beforeEpoch + 1);
    assert.deepEqual(JSON.parse(f.store.db.prepare("SELECT value FROM meta WHERE key='history:last'").get().value),
        { epoch: beforeEpoch + 1, request_id: requestId });
    assert.deepEqual(JSON.parse(f.store.db.prepare('SELECT payload_json FROM requests WHERE id=?').get(requestId).payload_json).history_epochs,
        [beforeEpoch + 1]);

    // Reasons are cleared, but the numeric mood/relation values are unchanged.
    const after = f.store.readState();
    assert.deepEqual(after.reasons, []);
    assert.deepEqual(after.mood, before.mood);
    assert.deepEqual(after.relation, before.relation);

    // The approved snapshot body is retained for audit, not mutated.
    assert.equal(JSON.parse(f.store.db.prepare('SELECT json FROM snapshots WHERE candidate_id=?').get(candidateId).json).text,
        `My private codeword is ${TOKEN}.`);
    assert.ok(f.store.db.prepare("SELECT 1 AS n FROM audit WHERE type='forget' AND status='local_isolating' AND request_id=?").get(requestId));
    assert.ok(f.store.db.prepare("SELECT 1 AS n FROM audit WHERE type='forget.state' AND status='local_isolating'").get());
    // The live session is enrolled for canonical-history cleanup; the durable
    // enumeration flag is cleared by the same transaction that enrolled it.
    assert.equal(f.store.db.prepare("SELECT status FROM history_work WHERE session_id=?").get(handle.agent.session.id).status, 'pending');
    // The selection fence is the last existing log offset (seq is the NEXT offset).
    assert.equal(JSON.parse(f.store.db.prepare('SELECT plan_json FROM history_work WHERE session_id=?').get(handle.agent.session.id).plan_json).fence_seq,
        lastOffset);
    assert.equal(f.store.db.prepare("SELECT value FROM meta WHERE key='history:enumerating'").get(), undefined);
});

// ── 2. pending fence rejects ordinary input; no stream, no committed message ──
test('a pending canonical-history fence rejects ordinary input before the provider and keeps only the inbox splice', async t => {
    const f = await nativeHistoryFixture(t);
    const handle = await f.create();
    const target = await f.say(handle.agent, `My codeword is ${TOKEN}.`);
    const candidateId = f.seedCandidate({ text: `My codeword is ${TOKEN}.`, sourceIds: [f.evidenceIdFor(target.id)] });
    const requestId = f.seedRequest(handle.agent.session.id);
    await f.coordinator.plan(requestId, [candidateId]);

    const captured = f.captures.length;
    const mark = handle.agent.session.seq;
    const pendingText = 'ORDINARY_PENDING_INPUT';
    const message = await f.say(handle.agent, pendingText);

    assert.equal(f.captures.length, captured, 'fenced input must not reach the provider');
    const events = handle.agent.session.snapshotEvents(mark);
    assert.equal(events.some(event => event.type === 'user/message' && event.data?.id === message.id), false);
    assert.equal(events.some(event => event.type === 'step/start'), false);
    assert.equal(events.some(event => event.type === 'turn/end' && event.data?.reason?.kind === 'blocked'), true);
    assert.equal(JSON.stringify(handle.agent.session.deriveMessages()).includes(pendingText), false);
    // The blocked input remains traceable to its real first inbox splice.
    assert.equal(events.some(event => event.type === 'agent/inbox/spliced' && JSON.stringify(event).includes(pendingText)), true);
});

// ── 3. release isolates a live and a cold session, keeping proof-safe material ─
test('release replaces the forgotten target across a live and a cold session while the safe statement survives and the original log stays auditable', async t => {
    const f = await nativeHistoryFixture(t);
    f.seedReason(`${TOKEN} session reason`);
    const a = await f.create();
    const aTarget = await f.say(a.agent, `My private codeword is ${TOKEN}.`);
    await f.say(a.agent, [`My codeword is ${TOKEN}.`, `${KEEP} I enjoy quiet mornings and jasmine tea.`]);
    await f.say(a.agent, 'I prefer gentle mornings.');
    await f.say(a.agent, `${UNCERTAIN} repeated material must be removed.`);
    await f.say(a.agent, `${BOGUS} material without span proof must be removed.`);

    const b = await f.create();
    const bTarget = await f.say(b.agent, `Cold session codeword is ${TOKEN}.`);
    await f.say(b.agent, 'Cold safe statement about jasmine.');
    const bId = b.agent.session.id;
    await f.ctx.sessions.flush(b.agent.session);
    await b.dispose();
    f.handles.delete(b);

    // The cold session is still enumerable and its real evidence reference resolves.
    const listed = await f.ctx.sessionQuery.listSessions();
    assert.equal(listed.some(record => record.header.id === bId), true);

    const candidateId = f.seedCandidate({ text: `private codeword`,
        sourceIds: [f.evidenceIdFor(aTarget.id), f.evidenceIdFor(bTarget.id)].filter(Boolean) });
    const requestId = f.seedRequest(a.agent.session.id);

    const captured = f.captures.length;
    assert.equal((await f.coordinator.plan(requestId, [candidateId])).status, 'local_isolating');
    assert.equal(await f.coordinator.sweep(requestId), true);
    assert.equal(f.captures.length, captured, 'the release window is cancelled before any provider request');

    const faceA = await f.ctx.sessionQuery.readSurface(a.agent.session.id);
    const wireA = JSON.stringify(faceA.events);
    assert.equal(wireA.includes(TOKEN), false);
    assert.equal(wireA.includes(UNCERTAIN), false);
    assert.equal(wireA.includes(BOGUS), false);
    assert.equal(wireA.includes('jasmine tea'), true, 'the span-preserved non-target statement survives');
    assert.equal(wireA.includes('gentle mornings'), true, 'an independent safe statement survives');
    assert.equal(JSON.stringify(a.agent.session.deriveMessages()).includes(TOKEN), false);
    assert.equal(JSON.stringify(a.agent.session.snapshotEvents()).includes(TOKEN), true, 'the original log remains auditable');

    const faceB = await f.ctx.sessionQuery.readSurface(bId);
    assert.equal(JSON.stringify(faceB.events).includes(TOKEN), false);
    assert.equal(JSON.stringify(faceB.events).includes('Cold safe statement'), true);

    const epochs = JSON.parse(f.store.db.prepare('SELECT payload_json FROM requests WHERE id=?').get(requestId).payload_json).history_epochs;
    for (const epoch of epochs)
        assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM history_work WHERE epoch=? AND status!='applied'").get(epoch).n, 0);
    assert.equal(f.store.db.prepare('SELECT status FROM requests WHERE id=?').get(requestId).status, 'local_isolated');
    assert.ok(f.store.db.prepare("SELECT 1 AS n FROM audit WHERE type='forget.history' AND status='applied'").get());
});

// ── 4. reload + next provider request exclude the target, restore cannot rebuild it
test('a reload and the next provider request exclude the isolated target while restoring the lifecycle keeps the replaced surface', async t => {
    const f = await nativeHistoryFixture(t);
    f.seedReason(`${TOKEN} session reason`);
    const a = await f.create();
    const target = await f.say(a.agent, `My codeword is ${TOKEN}.`);
    await f.say(a.agent, 'A safe retained statement.');
    const targetSourceId = f.evidenceIdFor(target.id);
    const candidateId = f.seedCandidate({ text: `codeword`, sourceIds: [targetSourceId] });
    const requestId = f.seedRequest(a.agent.session.id);
    await f.coordinator.plan(requestId, [candidateId]);
    await f.coordinator.sweep(requestId);

    // Next real provider request after the cutover.
    const captured = f.captures.length;
    await f.say(a.agent, 'Fresh input after the cutover.');
    assert.equal(f.captures.length, captured + 1);
    assert.equal(JSON.stringify(f.captures.at(-1).messages).includes(TOKEN), false);
    assert.equal(f.captures.at(-1).frozen, true);

    // Reload the same durable session: the isolated target stays absent and the
    // fresh request must not carry it, while the original events survive.
    const aId = a.agent.session.id;
    await a.dispose();
    f.handles.delete(a);
    const beforeResume = f.captures.length;
    const resumed = await f.ctx.agents.resume({ resumeSessionId: aId,
        agentOptions: { provider: 'synthetic-history', model: 'fixture' } });
    f.handles.add(resumed);
    assert.equal(f.captures.length, beforeResume, 'resume never auto-requests');
    assert.equal(JSON.stringify(resumed.agent.session.deriveMessages()).includes(TOKEN), false);
    assert.equal(JSON.stringify(resumed.agent.session.snapshotEvents()).includes(TOKEN), true);
    const beforeReloadRequest = f.captures.length;
    await f.say(resumed.agent, 'Fresh input after reload.');
    assert.equal(f.captures.length, beforeReloadRequest + 1, 'the post-reload input is not fenced');
    assert.equal(JSON.stringify(f.captures.at(-1).messages).includes(TOKEN), false);

    // Restoring the durable lifecycle raw does NOT reconstruct the old surface.
    f.store.transaction(() => {
        const epoch = f.store.bumpPolicyEpoch();
        f.store.db.prepare("UPDATE lifecycle SET status='active',policy_epoch=? WHERE candidate_id=?").run(epoch, candidateId);
        f.store.db.prepare('UPDATE forget_scopes SET active=0,epoch=? WHERE request_id=?').run(epoch, requestId);
    });
    const restored = await f.ctx.sessionQuery.readSurface(aId);
    assert.equal(JSON.stringify(restored.events).includes(TOKEN), false);
    const read = await f.evidence.read([targetSourceId], { agent: resumed.agent });
    assert.equal(read.sources.length, 0);
    assert.equal(read.excluded[0].code, 'LEPI_INPUT_RESUBMIT_REQUIRED');
    const beforeRestoreRequest = f.captures.length;
    await f.say(resumed.agent, 'Fresh input after selective long-term restoration.');
    assert.equal(f.captures.length, beforeRestoreRequest + 1);
    assert.equal(JSON.stringify(f.captures.at(-1).messages).includes(TOKEN), false);
    assert.equal(JSON.stringify(f.captures.at(-1).messages).includes('A safe retained statement.'), true);
});

// ── 5. epoch race during proof rejects the stale assembly ─────────────────────
test('a policy epoch change while the proof is being assembled rejects the stale proof and leaves the fence', async t => {
    const f = await nativeHistoryFixture(t);
    const handle = await f.create();
    const target = await f.say(handle.agent, `My codeword is ${TOKEN}.`);
    const candidateId = f.seedCandidate({ text: `codeword`, sourceIds: [f.evidenceIdFor(target.id)] });
    const requestId = f.seedRequest(handle.agent.session.id);
    const { epoch } = await f.coordinator.plan(requestId, [candidateId]);

    // A concurrent forget lands *while* the proof is being assembled, so the
    // stale assembly must be rejected rather than committed.
    f.setDecide(() => {
        f.store.transaction(() => f.store.bumpPolicyEpoch());
        return { nodes: [], uncertain_seqs: [] };
    });
    const captured = f.captures.length;
    assert.equal(await f.coordinator.sweep(requestId), false);
    assert.equal(f.captures.length, captured);
    const row = f.store.db.prepare('SELECT * FROM history_work WHERE session_id=? AND epoch=?')
        .get(handle.agent.session.id, epoch);
    assert.equal(row.status, 'blocked');
    assert.equal(row.error_code, 'LEPI_INPUT_RESUBMIT_REQUIRED');
    // No partial replacement was committed; the target body survives the fence.
    const face = await f.ctx.sessionQuery.readSurface(handle.agent.session.id);
    assert.equal(JSON.stringify(face.events).includes(TOKEN), true);
    assert.equal(f.store.db.prepare('SELECT status FROM requests WHERE id=?').get(requestId).status, 'confirmed');
});

// ── 6. balanced tool-pair expansion ───────────────────────────────────────────
test('a forgotten tool call and its result are replaced as one balanced pair with no orphan result', async t => {
    const f = await nativeHistoryFixture(t);
    const disposeTool = f.ctx.tools.register(defineContentToolFixture({
        name: 'synthetic-echo',
        description: 'Synthetic echo fixture.',
        parameters: {},
        execute: async () => [{ type: 'text', text: `${TOOL} synthetic tool result` }],
    }));
    f.setRespond(index => (index === 0 ? toolCallChunks() : textChunks('Synthetic follow-up.')));
    try {
        const handle = await f.create();
        const target = await f.say(handle.agent, `Tool target ${TOKEN}.`);
        const session = handle.agent.session;
        // The loop really produced the pair before the coordinator runs.
        assert.equal(JSON.stringify(session.snapshotEvents()).includes(TOOL), true);
        const candidateId = f.seedCandidate({ text: `codeword`, sourceIds: [f.evidenceIdFor(target.id)] });
        const requestId = f.seedRequest(session.id);
        await f.coordinator.plan(requestId, [candidateId]);
        await f.coordinator.sweep(requestId);

        const face = await f.ctx.sessionQuery.readSurface(session.id);
        const wire = JSON.stringify(face.events);
        assert.equal(wire.includes(TOKEN), false);
        assert.equal(wire.includes(TOOL), false);
        for (const event of face.events) {
            assert.equal(toolPairingBalancedBefore(session, event.seq), true);
            assert.equal(toolPairingBalancedAfter(session, event.seq), true);
        }
        assert.equal(JSON.stringify(session.snapshotEvents()).includes(TOOL), true, 'the original tool pair stays auditable');
    } finally { disposeTool(); }
});

// ── 7. real processor: fetch_context reuses genuine evidence identities ──────
test('the real processor fetches a genuine evidence reference and keeps an independent span through submit_result', async t => {
    const f = await nativeHistoryFixture(t, { real: true });
    f.seedReason(`${TOKEN} session reason`);
    const handle = await f.create();
    const target = await f.say(handle.agent, `My private codeword is ${TOKEN}.`);
    const safeMessage = await f.say(handle.agent, 'I prefer gentle mornings.');
    const candidateId = f.seedCandidate({ text: 'codeword', sourceIds: [f.evidenceIdFor(target.id)] });
    const requestId = f.seedRequest(handle.agent.session.id);

    let fetchedSourceId = null;
    let safeNode = null;
    let round = -1;
    const processorStream = options => String(options.system ?? '').includes('中性记忆处理器');
    f.setRespond((index, options) => {
        if (!processorStream(options)) return textChunks();
        round += 1;
        const envelope = JSON.parse(options.messages[0].content[0].text);
        if (round === 0) {
            const source = envelope.sources.find(item => !item.text.includes(TOKEN) && item.text.includes('gentle'));
            const node = envelope.nodes.find(item => item.blocks.some(block => block.text.includes('gentle')));
            fetchedSourceId = source.id;
            safeNode = { seq: node.seq, text: node.blocks[0].text };
            return processorToolCall('fetch_context', { source_ids: [source.id] });
        }
        return processorToolCall('submit_result', { nodes: [{ seq: safeNode.seq, decision: 'keep',
            keep_spans: [{ block_index: 0, start: 0, end: safeNode.text.length, source_ids: [fetchedSourceId] }] }],
        uncertain_seqs: [] });
    });

    await f.coordinator.plan(requestId, [candidateId]);
    assert.equal(await f.coordinator.sweep(requestId), true);
    // The processor consumed the *actual* evidence row for the retained user
    // expression — a genuine source identity, never a fabricated one.
    const safeSourceId = f.evidenceIdFor(safeMessage.id);
    assert.equal(fetchedSourceId, safeSourceId);
    assert.equal(f.store.db.prepare('SELECT actor,kind FROM evidence WHERE id=?').get(safeSourceId).actor, 'user');
    const face = await f.ctx.sessionQuery.readSurface(handle.agent.session.id);
    assert.equal(JSON.stringify(face.events).includes(TOKEN), false);
    assert.equal(JSON.stringify(face.events).includes('gentle mornings'), true);
    // The preserved independent span is still readable through its genuine source.
    const kept = await f.evidence.read([safeSourceId], { agent: handle.agent });
    assert.equal(kept.sources.length, 1);
    assert.equal(kept.sources[0].text, 'I prefer gentle mornings.');
    assert.equal(f.store.db.prepare('SELECT status FROM history_work WHERE session_id=?').get(handle.agent.session.id).status, 'applied');
});

// ── 8. real processor: invalidation after the fetch prevents the commit ───────
test('a policy change after the real fetch_context prevents the history commit and keeps the fence', async t => {
    const f = await nativeHistoryFixture(t, { real: true });
    f.seedReason(`${TOKEN} session reason`);
    const handle = await f.create();
    const target = await f.say(handle.agent, `My private codeword is ${TOKEN}.`);
    await f.say(handle.agent, 'I prefer gentle mornings.');
    const candidateId = f.seedCandidate({ text: 'codeword', sourceIds: [f.evidenceIdFor(target.id)] });
    const requestId = f.seedRequest(handle.agent.session.id);
    const { epoch } = await f.coordinator.plan(requestId, [candidateId]);

    let round = -1;
    const processorStream = options => String(options.system ?? '').includes('中性记忆处理器');
    f.setRespond((index, options) => {
        if (!processorStream(options)) return textChunks();
        round += 1;
        const envelope = JSON.parse(options.messages[0].content[0].text);
        if (round === 0) {
            const source = envelope.sources.find(item => !item.text.includes(TOKEN) && item.text.includes('gentle'));
            return processorToolCall('fetch_context', { source_ids: [source.id] });
        }
        // The policy changes after the fetch was served but before any commit.
        f.store.transaction(() => f.store.bumpPolicyEpoch());
        return processorToolCall('submit_result', { nodes: [], uncertain_seqs: [] });
    });

    assert.equal(await f.coordinator.sweep(requestId), false);
    const row = f.store.db.prepare('SELECT * FROM history_work WHERE session_id=? AND epoch=?')
        .get(handle.agent.session.id, epoch);
    assert.equal(row.status, 'blocked');
    const face = await f.ctx.sessionQuery.readSurface(handle.agent.session.id);
    assert.equal(JSON.stringify(face.events).includes(TOKEN), true);
    assert.equal(f.store.db.prepare('SELECT status FROM requests WHERE id=?').get(requestId).status, 'confirmed');
});

test('restored pending inbox is consumed by the mandatory fence and never enters the maintenance or later provider request', async t => {
    const f = await nativeHistoryFixture(t);
    const handle = await f.create();
    const target = await f.say(handle.agent, `My codeword is ${TOKEN}.`);
    const candidateId = f.seedCandidate({ text: 'codeword', sourceIds: [f.evidenceIdFor(target.id)] });
    const requestId = f.seedRequest(handle.agent.session.id);
    const pending = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `Old queued ${TOKEN}.` }] });
    handle.agent.inject(pending);
    await f.ctx.sessions.flush(handle.agent.session);
    const id = handle.agent.session.id;
    await handle.dispose();
    f.handles.delete(handle);
    await f.coordinator.plan(requestId, [candidateId]);
    const before = f.captures.length;
    assert.equal(await f.coordinator.sweep(requestId), true);
    assert.equal(f.captures.length, before);
    const reload = await f.ctx.agents.resume({ resumeSessionId: id,
        agentOptions: { provider: 'synthetic-history', model: 'fixture' } });
    f.handles.add(reload);
    assert.equal(reload.agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === pending.id), false);
    await f.say(reload.agent, 'Fresh input after consuming the obsolete queued input.');
    assert.equal(f.captures.length, before + 1);
    assert.equal(JSON.stringify(f.captures.at(-1).messages).includes(TOKEN), false);
});

test('a later replacement occupying an earlier position keeps sourceEventSeqs in canonical order rather than log order', async t => {
    const f = await nativeHistoryFixture(t);
    const handle = await f.create();
    const first = await f.say(handle.agent, 'Earlier unrelated statement.');
    const target = await f.say(handle.agent, `Later target ${TOKEN}.`);
    const candidateId = f.seedCandidate({ text: 'codeword', sourceIds: [f.evidenceIdFor(target.id)] });
    const requestId = f.seedRequest(handle.agent.session.id);
    const initial = await f.ctx.sessionQuery.readSurface(handle.agent.session.id);
    const firstSeq = initial.events.find(event => event.type === 'user/message' && event.data.id === first.id).seq;
    await handle.agent.runMaintenance(async () => {
        handle.agent.session.append('user/message', createUserMessage({ source: { kind: 'fixture-context', form: 'notice' },
            content: [{ type: 'text', text: 'Replacement occupying the earlier position.' }] }),
        { surfaceOp: { op: 'replace', startSeq: firstSeq, endSeq: firstSeq }, sourceEventSeqs: [firstSeq] });
        await f.ctx.sessions.flush(handle.agent.session);
    });
    const before = await f.ctx.sessionQuery.readSurface(handle.agent.session.id);
    const ordinary = before.events.filter(event => !['system/message', 'developer/message'].includes(event.type)).map(event => event.seq);
    assert.notDeepEqual(ordinary, [...ordinary].sort((a, b) => a - b));
    f.setDecide(({ nodes }) => ({ nodes: nodes.map(node => ({ seq: node.seq, decision: 'remove', keep_spans: [] })), uncertain_seqs: [] }));
    await f.coordinator.plan(requestId, [candidateId]);
    assert.equal(await f.coordinator.sweep(requestId), true);
    const face = await f.ctx.sessionQuery.readSurface(handle.agent.session.id);
    const replacement = face.events.find(event => event.type === 'user/message');
    assert.deepEqual(replacement.sourceEventSeqs, ordinary);
    assert.equal(JSON.stringify(handle.agent.session.deriveMessages()).includes(TOKEN), false);
});

test('a fork after isolation reuses only the proved prefix and an obsolete inherited prefix never reaches a processor again', async t => {
    const f = await nativeHistoryFixture(t);
    const parent = await f.create();
    const target = await f.say(parent.agent, `Inherited target ${TOKEN}.`);
    await f.say(parent.agent, 'Independent inherited safe statement.');
    const obsoleteSeed = parent.agent.session.snapshotEvents();
    const candidateId = f.seedCandidate({ text: 'codeword', sourceIds: [f.evidenceIdFor(target.id)] });
    const requestId = f.seedRequest(parent.agent.session.id);
    await f.coordinator.plan(requestId, [candidateId]);
    assert.equal(await f.coordinator.sweep(requestId), true);
    f.setDecide(() => { assert.fail('isolated target must never be sent to history processing again'); });
    for (const [clean, seed] of [[true, parent.agent.session.snapshotEvents()], [false, obsoleteSeed]]) {
        const child = await f.ctx.agents.create({ sessionId: randomUUID(), seed,
            inheritedEventCount: seed.length, meta: { parentSession: parent.agent.session.id, isSeeded: true },
            agentOptions: { provider: 'synthetic-history', model: 'fixture' } });
        f.handles.add(child);
        const before = f.captures.length;
        await f.say(child.agent, 'First attempt must pass the inherited-history fence.');
        assert.equal(f.captures.length, before);
        assert.equal(await f.coordinator.sweep(requestId), true);
        await f.say(child.agent, 'Fresh independent input after inherited-history proof.');
        assert.equal(f.captures.length, before + 1);
        const wire = JSON.stringify(f.captures.at(-1).messages);
        assert.equal(wire.includes(TOKEN), false);
        if (clean) assert.equal(wire.includes('Independent inherited safe statement.'), true);
    }
});
