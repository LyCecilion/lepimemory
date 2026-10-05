import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { resolveConfig, migrateLegacyEnv, applyDerivedEnv } from '../lib/config.js';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { HindsightClient } from '../lib/hindsight.js';
import { openStore } from '../lib/store.js';
import { createProcessor } from '../lib/processor.js';
import { validateResult } from '../lib/contracts.js';
import { createControl } from '../lib/control.js';
import { createEvidenceIndex } from '../lib/evidence.js';
import { createAdmission } from '../lib/admission.js';
import { createMemoryRuntime } from '../lib/memory.js';
import { rawVersion, rawMatches, documentMatches, loadSource } from '../lib/raw-source.js';
import { createWriteWorker } from '../lib/write-worker.js';
import { createCurateWorker } from '../lib/curate-worker.js';
import { candidateExclusion } from '../lib/trust.js';

const configModule = fileURLToPath(new URL('../lib/config.js', import.meta.url));
const connection = { LEPI_LLM_BASE_URL: 'https://example.invalid/v1', LEPI_LLM_API_KEY: 'synthetic-key' };

test('incomplete connections never send a key to an inferred endpoint', () => {
    assert.throws(() => resolveConfig({ LEPI_LLM_API_KEY: 'synthetic-key' }), { code: 'LEPI_CONNECTION_INCOMPLETE', field: 'LEPI_LLM_BASE_URL' });
    assert.throws(() => resolveConfig({ LEPI_LLM_BASE_URL: connection.LEPI_LLM_BASE_URL }), { code: 'LEPI_CONNECTION_INCOMPLETE', field: 'LEPI_LLM_API_KEY' });
    const empty = resolveConfig({});
    assert.equal(empty.configured, false);
    assert.equal(empty.llm.process.baseUrl, '');
    assert.equal(empty.llm.role.apiKey, '');
});

test('a route override is atomic and processing does not follow role model selection', () => {
    assert.throws(() => resolveConfig({ ...connection, LEPI_PROCESS_API_KEY: 'other-key' }), { code: 'LEPI_CONNECTION_INCOMPLETE', field: 'LEPI_PROCESS_BASE_URL' });
    const cfg = resolveConfig({ ...connection, LEPI_ROLE_MODEL: 'role-model', LEPI_PROCESS_MODEL: 'processing-model', LEPI_PROCESS_BASE_URL: 'https://processor.invalid/v1', LEPI_PROCESS_API_KEY: 'processing-key' });
    assert.equal(cfg.llm.process.baseUrl, 'https://processor.invalid/v1');
    assert.equal(cfg.llm.process.apiKey, 'processing-key');
    assert.equal(cfg.llm.role.baseUrl, connection.LEPI_LLM_BASE_URL);
    assert.equal(cfg.llm.controlFallback.model, 'role-model');
    assert.equal(cfg.llm.process.model, 'processing-model');
    assert.equal(cfg.services.laya.apiKey, '');
});

test('child-process derived credentials keep inherited URL/key pairs complete', () => {
    const startup = resolveConfig(connection);
    const childEnv = applyDerivedEnv({ ...connection }, startup);
    const child = resolveConfig(childEnv);
    assert.equal(child.llm.process.baseUrl, connection.LEPI_LLM_BASE_URL);
    assert.equal(child.llm.process.apiKey, connection.LEPI_LLM_API_KEY);
    assert.equal(child.llm.controlFallback.baseUrl, connection.LEPI_LLM_BASE_URL);
    assert.equal(child.llm.hindsight.apiKey, connection.LEPI_LLM_API_KEY);
});

test('unsafe policy inputs fail before the runtime can start', () => {
    for (const env of [
        { LEPI_BANK: 'lepimemory' },
        { LEPI_ADMISSION_BACKEND: 'automatic' },
        { LEPI_TIME_ZONE: 'not-a-time-zone' },
        { LEPI_CONSENT_TIMEOUT_MS: '0' },
        { LEPI_TASK_TTL_MS: '9007199254740992' },
        { LEPI_LAYA_ACCEPT_DURABLE: '0.2', LEPI_LAYA_REJECT_DURABLE: '0.2' },
        { LEPI_LAYA_ACCEPT_TRANSIENT: 'NaN' },
    ]) assert.throws(() => resolveConfig(env), { code: 'LEPI_CONFIG_INVALID' });
});

test('legacy migration preserves connections with a private backup and is one-shot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lepi-env-'));
    try {
        const file = path.join(dir, '.env');
        const original = 'GEEK_TECH_CLUB_API_KEY=old-key\nLEPI_LLM_BASE_URL=https://example.invalid/v1\nHINDSIGHT_API_LLM_API_KEY=memory-key\nHINDSIGHT_API_LLM_BASE_URL=https://memory.invalid/v1\nHINDSIGHT_API_LLM_MODEL=memory-model\nHF_ENDPOINT=https://mirror.invalid\n';
        fs.writeFileSync(file, original);
        const result = migrateLegacyEnv({ envFile: file, now: 1 });
        assert.equal(fs.statSync(result.backupPath).mode & 0o777, 0o600);
        assert.equal(fs.readFileSync(result.backupPath, 'utf8'), original);
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {loadEnvFile,resolveConfig} from ${JSON.stringify(configModule)};loadEnvFile({envFile:process.argv[1]});const c=resolveConfig();if(c.llm.role.apiKey!=='old-key'||c.llm.hindsight.apiKey!=='memory-key'||c.llm.hindsight.model!=='memory-model'||c.retrieval.hfEndpoint!=='https://mirror.invalid')process.exit(1);`, file], { env: { PATH: process.env.PATH } });
        assert.equal(child.status, 0, child.stderr.toString());
        assert.deepEqual(migrateLegacyEnv({ envFile: file }), { migrated: false, backupPath: null, missingFields: [] });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a missing legacy endpoint is reported by field name, not repaired by fallback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lepi-env-missing-'));
    try {
        const file = path.join(dir, '.env');
        fs.writeFileSync(file, 'GEEK_TECH_CLUB_API_KEY=secret-for-test\n');
        const result = migrateLegacyEnv({ envFile: file });
        assert.deepEqual(result.missingFields, ['LEPI_LLM_BASE_URL']);
        assert.throws(() => resolveConfig({ LEPI_LLM_API_KEY: 'secret-for-test' }), { code: 'LEPI_CONNECTION_INCOMPLETE' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('explicit process environment wins over the optional file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lepi-env-precedence-'));
    try {
        const file = path.join(dir, '.env');
        fs.writeFileSync(file, 'LEPI_BANK=from-file\nPORT=3181\n');
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {loadEnvFile,resolveConfig} from ${JSON.stringify(configModule)};loadEnvFile({envFile:process.argv[1]});const c=resolveConfig();if(c.bank!=='explicit-bank'||c.home.port!==3181)process.exit(1);`, file], { env: { PATH: process.env.PATH, LEPI_BANK: 'explicit-bank' } });
        assert.equal(child.status, 0, child.stderr.toString());
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

async function withHttp(handler, run) {
    const server = createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try { await run(`http://127.0.0.1:${server.address().port}`); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('a lost write acknowledgement never triggers another retain submission', async () => {
    let accepted = 0;
    await withHttp((req, res) => {
        req.resume();
        req.on('end', () => { accepted += 1; res.destroy(); });
    }, async baseUrl => {
        const client = new HindsightClient({ baseUrl, bank: 'synthetic-http-write' });
        await assert.rejects(client.retainAsync({ content: 'synthetic' }, { operationId: randomUUID() }), { code: 'LEPI_HINDSIGHT_UNAVAILABLE' });
        assert.equal(accepted, 1);
    });
});

test('safe read retries are bounded and never expose a server error body', async () => {
    let attempts = 0;
    await withHttp((req, res) => {
        attempts += 1;
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: 'SENSITIVE_SERVER_BODY' }));
    }, async baseUrl => {
        const client = new HindsightClient({ baseUrl, bank: 'synthetic-http-read' });
        await assert.rejects(client.document('missing'), error => {
            assert.equal(error.code, 'LEPI_HINDSIGHT_UNAVAILABLE');
            assert.equal(error.status, 503);
            assert.equal(error.message.includes('SENSITIVE_SERVER_BODY'), false);
            return true;
        });
        assert.equal(attempts, 3);
    });
});

test('document units include the boundary and final partial page without gaps', async () => {
    const expected = Array.from({ length: 205 }, (_, i) => ({ id: `raw-${i}`, document_id: 'doc', state: 'valid' }));
    await withHttp((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const offset = Number(url.searchParams.get('offset'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ items: expected.slice(offset, offset + 100), total: expected.length }));
    }, async baseUrl => {
        const rows = await new HindsightClient({ baseUrl, bank: 'synthetic-http-pages' }).units('doc');
        assert.deepEqual(rows.map(row => row.id), expected.map(row => row.id));
    });
});

test('invalid legacy state remains untouched and can be corrected before retry', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lepi-state-invalid-'));
    try {
        const file = path.join(dir, 'state.json'), dbFile = path.join(dir, 'runtime.sqlite');
        const invalid = '{"mood":{"valence":"invalid"}}';
        fs.writeFileSync(file, invalid);
        assert.throws(() => openStore({ dbFile }), { code: 'LEPI_STATE_INVALID' });
        assert.equal(fs.readFileSync(file, 'utf8'), invalid);
        assert.equal(fs.existsSync(dbFile), false);
        const state = { mood: { valence: 0.8, arousal: 0.4, updatedAt: '2026-10-05T00:00:00Z' }, relation: { trust: 0.3, closeness: 0.2, familiarity: 0.1 }, reasons: [] };
        fs.writeFileSync(file, JSON.stringify(state));
        const store = openStore({ dbFile });
        try { assert.deepEqual(store.readState(), state); } finally { store.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an existing corrupt SQLite file is never replaced by JSON or an initial state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lepi-db-corrupt-'));
    try {
        const dbFile = path.join(dir, 'runtime.sqlite');
        fs.writeFileSync(dbFile, 'not a database');
        assert.throws(() => openStore({ dbFile }), { code: 'LEPI_STORE_UNAVAILABLE' });
        assert.equal(fs.readFileSync(dbFile, 'utf8'), 'not a database');
        fs.writeFileSync(dbFile, '');
        assert.throws(() => openStore({ dbFile }), { code: 'LEPI_STORE_UNAVAILABLE' });
        assert.equal(fs.statSync(dbFile).size, 0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const source = { id: 'real-user-source', actor: 'user', kind: 'user_message', at: '2026-10-05T00:00:00.000Z', text: '我偏好安静，不喜欢突然来访。' };
const extracted = { candidates: [{ text: source.text, content_kind: 'preference', origin: 'user', sensitivity: 'ordinary', subject_key: 'user', facet_key: 'visits', source_ids: [source.id], valid_from: null, valid_until: null, occurred_start: null, occurred_end: null, occurrence: 'reported' }], unresolved_source_ids: [] };
function resultChunks(value, { finish = true, id = 'actual-call', duplicate = false, reason = 'tool-calls' } = {}) {
    const chunks = [{ type: 'tool-call-delta', index: 0, id, name: 'submit_result', argumentsDelta: JSON.stringify(value) }];
    if (duplicate) chunks.push({ type: 'tool-call-delta', index: 1, id: 'actual-second-call', name: 'submit_result', argumentsDelta: JSON.stringify(value) });
    chunks.push({ type: 'usage', usage: { inputTokens: 100, outputTokens: 100 } });
    if (finish) chunks.push({ type: 'finish', reason: { kind: reason } });
    return chunks;
}
function processorFixture(responses, store = { policyEpoch: 0 }) {
    let calls = 0;
    const llm = { async *stream(options) {
        const response = responses[calls++];
        for (const chunk of typeof response === 'function' ? await response(options) : response) yield chunk;
    } };
    return { processor: createProcessor({ llm, routes: { process: { model: 'fixed-process' }, controlFallback: { model: 'fixed-fallback' } }, evidence: { async read() { return { sources: [source] }; } }, store }), calls: () => calls };
}

test('a future plan is current from its actual source instant, not a model-shifted timezone clock', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lep-plan-time-test-'));
    const store = openStore({ dbFile: path.join(dir, 'runtime.sqlite') });
    t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const draft = { ...extracted.candidates[0], content_kind: 'plan', occurrence: 'planned',
        valid_from: '2026-10-05T00:00:00+08:00', valid_until: '2026-10-12T23:59:59.999+08:00',
        occurred_start: '2026-10-12T15:00:00+08:00' };
    const { processor } = processorFixture([resultChunks({ candidates: [draft], unresolved_source_ids: [] })], store);
    const [candidate] = (await processor.extract({ source_ids: [source.id] })).candidates;
    const json = JSON.stringify(candidate);
    store.transaction(() => {
        store.db.prepare('INSERT INTO snapshots(candidate_id,json,payload_hash,created_at) VALUES (?,?,?,?)')
            .run(candidate.candidate_id, json, createHash('sha256').update(json).digest('hex'), Date.parse(source.at));
        store.db.prepare("INSERT INTO lifecycle(candidate_id,status,purpose,policy_epoch,updated_at) VALUES (?,'active','current',?,?)")
            .run(candidate.candidate_id, store.policyEpoch, Date.parse(source.at));
    });
    assert.equal(candidateExclusion({ candidate }, store, 'current', Date.parse(source.at) - 1), 'LEPI_MEMORY_SUPPRESSED');
    assert.equal(candidateExclusion({ candidate }, store, 'current', Date.parse(source.at)), null);
    assert.equal(candidateExclusion({ candidate }, store, 'current', Date.parse(draft.occurred_start)), null);
    assert.equal(candidateExclusion({ candidate }, store, 'current', Date.parse(draft.valid_until) + 1), 'LEPI_MEMORY_SUPPRESSED');
});

test('closed JSON cannot make a truncated, aborted, max-token or duplicate submission valid', async () => {
    for (const options of [{ finish: false }, { reason: 'aborted' }, { reason: 'max-tokens' }, { duplicate: true }, { id: undefined }]) {
        const chunks = resultChunks(extracted, options);
        if (Object.hasOwn(options, 'id')) delete chunks[0].id;
        const { processor } = processorFixture([chunks]);
        await assert.rejects(processor.extract({ sources: [source] }), error => ['LEPI_CONTROL_UNAVAILABLE', 'LEPI_INCOMPLETE_STREAM'].includes(error.code));
    }
});

test('a policy change while streaming cannot create a candidate using the old policy', async () => {
    const store = { policyEpoch: 0 };
    const { processor } = processorFixture([() => { store.policyEpoch++; return resultChunks(extracted); }], store);
    await assert.rejects(processor.extract({ sources: [source] }), { code: 'LEPI_INPUT_RESUBMIT_REQUIRED' });
});

test('one structural repair excludes invalid values and binds original source clock itself', async () => {
    const invalid = { ...extracted, private_property_FORBIDDEN: 'NEVER_ECHO_THIS_VALUE' };
    const { processor, calls } = processorFixture([
        resultChunks(invalid),
        options => {
            const serialized = JSON.stringify(options.messages);
            assert.equal(serialized.includes('NEVER_ECHO_THIS_VALUE'), false);
            assert.equal(serialized.includes('private_property_FORBIDDEN'), false);
            return resultChunks(extracted);
        },
    ]);
    const value = await processor.extract({ sources: [source], explicit: true, request_id: 'request-from-controller' });
    assert.equal(calls(), 2);
    assert.equal(value.candidates[0].formed_at, source.at);
    assert.equal(value.candidates[0].explicit, true);
    assert.equal(value.candidates[0].request_id, 'request-from-controller');
    assert.match(value.candidates[0].candidate_id, /^[0-9a-f-]{36}$/);
});

test('foreign citations and unexecuted actions cannot become user or verified facts', () => {
    const sources = new Map([[source.id, source]]);
    for (const patch of [{ source_ids: ['invented-source'] }, { origin: 'action', occurrence: 'verified' }, { origin: 'inference' }, { occurrence: 'verified' }]) {
        assert.throws(() => validateResult('extract', { ...extracted, candidates: [{ ...extracted.candidates[0], ...patch }] }, { sources }), { code: 'LEPI_CONTROL_UNAVAILABLE' });
    }
});

test('control repair then fallback is bounded and never follows a UI role model', async () => {
    const invalid = { requests: [], recall_purpose: 'invented', context_guards: [] };
    const valid = { ...invalid, recall_purpose: 'current' };
    const { processor, calls } = processorFixture([
        resultChunks(invalid), resultChunks(invalid),
        options => { assert.equal(options.model, 'fixed-fallback'); return resultChunks(valid); },
    ]);
    assert.equal((await processor.checkControl({ sources: [source] })).recall_purpose, 'current');
    assert.equal(calls(), 3);
    const failure = processorFixture([resultChunks(invalid), resultChunks(invalid), resultChunks(invalid)]);
    await assert.rejects(failure.processor.checkControl({ sources: [source] }), { code: 'LEPI_CONTROL_UNAVAILABLE' });
    assert.equal(failure.calls(), 3);
});

test('active forgetting requires guards for every current user expression before control can pass', async () => {
    const second = { ...source, id: 'second-current-source', text: '现在简单打个招呼。' };
    const firstGuard = { source_ids: [source.id], subject_key: 'user', facet_key: 'visits' };
    const secondGuard = { source_ids: [second.id], subject_key: 'user', facet_key: 'greeting' };
    const input = { sources: [source, second], active_forget_selectors: [{ subject_key: 'user', facet_key: 'visits' }] };
    const complete = { requests: [], recall_purpose: 'current', context_guards: [firstGuard, secondGuard] };
    for (const context_guards of [[], [firstGuard]]) {
        const incomplete = { ...complete, context_guards };
        const repaired = processorFixture([resultChunks(incomplete), resultChunks(complete)]);
        const result = await repaired.processor.checkControl(input);
        assert.ok(result.context_guards.some(guard => guard.source_ids.includes(second.id)));
        assert.equal(repaired.calls(), 2);
        const failed = processorFixture([resultChunks(incomplete), resultChunks(incomplete), resultChunks(incomplete)]);
        await assert.rejects(failed.processor.checkControl(input), { code: 'LEPI_CONTROL_UNAVAILABLE' });
        assert.equal(failed.calls(), 3);
    }
});

test('tool arguments are rejected before evidence access, with no coercion or raw local fallback', async () => {
    const badTool = [{ type: 'tool-call-delta', index: 0, id: 'actual-fetch', name: 'fetch_context', argumentsDelta: '{"source_ids":123}' }, { type: 'usage', usage: { inputTokens: 100, outputTokens: 100 } }, { type: 'finish', reason: { kind: 'tool-calls' } }];
    const { processor } = processorFixture([badTool, badTool]);
    await assert.rejects(processor.extract({ sources: [source] }), { code: 'LEPI_CONTROL_UNAVAILABLE' });
    const memoryTool = [{ ...badTool[0], name: 'fetch_memory', argumentsDelta: '{"query":"allowed query","purpose":"current"}' }, ...badTool.slice(1)];
    const missingPolicy = processorFixture([memoryTool]);
    await assert.rejects(missingPolicy.processor.extract({ sources: [source] }), { code: 'LEPI_HINDSIGHT_UNAVAILABLE' });
});

test('grant matching keeps normalized candidates separate from primary evidence and rejects changed evidence', async () => {
    const primary = { ...source, text: '1:y,2:y,3:n' };
    const candidate = { ...extracted.candidates[0], text: '用户喜欢安静。', facet_key: 'quiet', formed_at: primary.at };
    const grant = { scope: { kind: 'topic', subject_key: 'user', topic: 'map_preference', session_id: null, allow_inference: false } };
    for (const changed of [null, { text: '1:n,2:y,3:n' }, { actor: 'assistant' }]) {
        let reads = 0;
        let calls = 0;
        const processor = createProcessor({ store: { policyEpoch: 0 },
            routes: { process: { model: 'fixed-process' }, controlFallback: { model: 'fixed-fallback' } },
            evidence: { async read() { return { sources: [{ ...primary, ...(reads++ > 0 ? changed : null) }] }; } },
            llm: { async *stream() {
                if (calls++ === 0) {
                    yield { type: 'tool-call-delta', index: 0, id: 'actual-fetch', name: 'fetch_context', argumentsDelta: JSON.stringify({ source_ids: [primary.id] }) };
                    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 100 } };
                    yield { type: 'finish', reason: { kind: 'tool-calls' } };
                } else {
                    yield* resultChunks({ match: 'not_covered', source_ids: [primary.id], reason_code: 'not_covered' });
                }
            } },
        });
        const result = await processor.matchGrant(candidate, grant);
        assert.equal(result.match, changed ? 'uncertain' : 'not_covered');
    }
});

test('a foreign fetch reference is never read or echoed and gets only one structural repair', async () => {
    const foreign = 'NEVER_ECHO_FOREIGN_REFERENCE';
    const badFetch = [{ type: 'tool-call-delta', index: 0, id: 'actual-fetch', name: 'fetch_context', argumentsDelta: JSON.stringify({ source_ids: [foreign] }) },
        { type: 'usage', usage: { inputTokens: 100, outputTokens: 100 } }, { type: 'finish', reason: { kind: 'tool-calls' } }];
    for (const repeated of [false, true]) {
        let calls = 0;
        let reads = 0;
        const processor = createProcessor({ store: { policyEpoch: 0 },
            routes: { process: { model: 'fixed-process' } },
            evidence: { async read() { reads++; return { sources: [] }; } },
            llm: { async *stream(options) {
                if (calls++ === 0) { yield* badFetch; return; }
                const envelope = JSON.stringify(options.messages);
                assert.equal(envelope.includes(foreign), false);
                assert.equal(JSON.parse(options.messages.at(-1).content[0].text).repair.issue, 'source');
                yield* repeated ? badFetch : resultChunks({ match: 'not_covered', source_ids: [source.id], reason_code: 'not_covered' });
            } },
        });
        const result = await processor.matchGrant(extracted.candidates[0], { scope: { kind: 'topic', subject_key: 'user', topic: 'unrelated' } }, { sources: [source] });
        assert.equal(result.match, repeated ? 'uncertain' : 'not_covered');
        assert.equal(reads, 0);
        assert.equal(calls, 2);
    }
});

test('historical context cannot become the primary source of a new user fact or assistant inference', () => {
    for (const actor of ['user', 'assistant']) {
        const auxiliary = { ...source, id: 'older-context', actor, kind: actor === 'user' ? 'user_message' : 'assistant_message' };
        const candidate = { ...extracted.candidates[0], origin: actor === 'user' ? 'user' : 'inference', source_ids: [auxiliary.id] };
        assert.throws(() => validateResult('extract', { candidates: [candidate], unresolved_source_ids: [] }, {
            sources: new Map([[source.id, source], [auxiliary.id, auxiliary]]), primarySourceIds: new Set([source.id]),
        }), { code: 'LEPI_CONTROL_UNAVAILABLE', issue: 'actor' });
    }
});

test('historical users and recalled context cannot authorize a new control operation or enter its current guard', () => {
    for (const actor of ['user', 'context']) {
        const auxiliary = { ...source, id: 'older-control-context', actor, kind: actor === 'user' ? 'user_message' : 'context' };
        const options = { sources: new Map([[source.id, source], [auxiliary.id, auxiliary]]), primarySourceIds: new Set([source.id]) };
        for (const source_ids of [[auxiliary.id], [source.id, auxiliary.id]]) {
            assert.throws(() => validateResult('control', {
                requests: [{ kind: 'remember', source_ids, candidate_ids: [], scope: null }],
                recall_purpose: 'current', context_guards: [],
            }, options), { code: 'LEPI_CONTROL_UNAVAILABLE', issue: 'actor' });
            assert.throws(() => validateResult('control', {
                requests: [], recall_purpose: 'current', context_guards: [{ source_ids, subject_key: 'user', facet_key: 'quiet' }],
            }, options), { code: 'LEPI_CONTROL_UNAVAILABLE', issue: 'actor' });
        }
    }
});

test('a policy change while reading preceding questions prevents understanding from using the old context', async () => {
    const store = { policyEpoch: 0 };
    const processor = createProcessor({ store,
        routes: { process: { model: 'fixed-process' }, controlFallback: { model: 'fixed-fallback' } },
        evidence: {
            async read() { return { sources: [source] }; },
            async recent() { store.policyEpoch++; return { sources: [] }; },
        },
        llm: { async *stream() { throw new Error('A changed policy cannot reach the understanding model'); } },
    });
    await assert.rejects(processor.extract({ agent: {}, source_ids: [source.id] }), { code: 'LEPI_INPUT_RESUBMIT_REQUIRED' });
});

test('unqualified or impossible dates and assistant-only permission fail closed', () => {
    const sources = new Map([[source.id, source]]);
    for (const valid_until of ['2026-10-11', '2026-02-30T23:59:59+08:00', '2026-10-11T23:59:59']) {
        assert.throws(() => validateResult('extract', { ...extracted, candidates: [{ ...extracted.candidates[0], valid_until }] }, { sources }), { code: 'LEPI_CONTROL_UNAVAILABLE' });
    }
    const assistant = { ...source, actor: 'assistant', kind: 'assistant_message' };
    assert.throws(() => validateResult('control', { requests: [{ kind: 'grant', source_ids: [source.id], candidate_ids: [], scope: null }], recall_purpose: 'current', context_guards: [] }, { sources: new Map([[source.id, assistant]]) }), { code: 'LEPI_CONTROL_UNAVAILABLE' });
});

test('a failed primary stream still consumes the bounded output budget before fallback', async () => {
    const valid = { requests: [], recall_purpose: 'current', context_guards: [] };
    let calls = 0;
    const llm = { async *stream() { for (const chunk of resultChunks(valid, { reason: calls++ === 0 ? 'error' : 'tool-calls' })) yield chunk; } };
    const processor = createProcessor({ llm, routes: { process: { model: 'primary' }, controlFallback: { model: 'fallback' }, limits: { processMaxTokens: 150 } }, evidence: {}, store: { policyEpoch: 0 } });
    await assert.rejects(processor.checkControl({ sources: [source] }), { code: 'LEPI_CONTROL_UNAVAILABLE' });
    assert.equal(calls, 2);
});

// Resolve all native services from the pinned CLI graph, not incidental pnpm directory hashes.
const rootRequire = createRequire(new URL('../../../../package.json', import.meta.url));
const nativeRequire = createRequire(rootRequire.resolve('@deepseek-ai/dsh/package.json'));
const { Context } = nativeRequire('@deepseek-ai/cordis');
const { AgentRegistry } = nativeRequire('@deepseek-ai/dsh-agent');
const { UserQuestionService } = nativeRequire('@deepseek-ai/dsh-user-questions');
const { Session, foldSurface } = nativeRequire('@deepseek-ai/dsh-session');
const { createUserMessage } = nativeRequire('@deepseek-ai/dsh-llm');

async function nativeControlFixture(t, env = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lep-control-test-'));
    let af, qf, detach, store, evidence, control;
    const listeners = [];
    const runtimes = [];
    let queuedRuntime;
    t.after(async () => {
        for (const remove of listeners) remove();
        await control?.dispose();
        await Promise.all(runtimes.map(runtime => runtime.dispose()));
        detach?.();
        evidence?.dispose();
        store?.close();
        await qf?.dispose();
        await af?.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const ctx = new Context();
    af = ctx.plugin(AgentRegistry); await af.await();
    qf = ctx.plugin(UserQuestionService); await qf.await();
    store = openStore({ dbFile: path.join(dir, 'runtime.sqlite') });
    const session = new Session(randomUUID());
    const steering = [];
    const agent = { id: session.id, session, ctx, status: 'idle', steer: message => steering.push(message) };
    detach = ctx.agents.enter(agent, undefined);
    evidence = createEvidenceIndex({ store, sessionQuery: { async readSurface(id) {
        assert.equal(id, session.id);
        return { events: foldSurface(session.log).nodes.map(seq => session.eventAt(seq)) };
    } } });
    const processor = { async checkControl() { return { requests: [], recall_purpose: 'current', context_guards: [] }; } };
    control = createControl({ ctx, store, processor, evidence, history: {}, enqueue: input => queuedRuntime?.enqueue(input), config: resolveConfig(env) });
    function input(text) {
        const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
        evidence.observe(session, session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [message] }));
        const source_ids = evidence.claimed(agent, [message], 1, 1);
        return { message, candidate: { candidate_id: randomUUID(), text, sensitivity: 'private', subject_key: 'user',
            facet_key: 'synthetic-sleep', origin: 'user', request_id: null, source_ids } };
    }
    return { ctx, agent, session, store, evidence, processor, control, input, steering,
        ownMemory(runtime) { runtimes.push(runtime); queuedRuntime = runtime; },
        onQuestion(fn) { const remove = ctx.on('user-questions/request', fn); listeners.push(remove); return remove; } };
}

test('native private consent binds the displayed item without persisting its body or committing a conversation message', async t => {
    const f = await nativeControlFixture(t);
    const privateText = 'SYNTHETIC_PRIVATE_' + randomUUID();
    const { candidate } = f.input(privateText);
    const originalId = candidate.candidate_id;
    let resolve;
    let request;
    f.onQuestion(value => { request = value; return new Promise(done => { resolve = done; }); });
    const before = f.session.log.length;
    const pending = f.control.askPrivate(candidate, f.agent);
    await new Promise(done => setImmediate(done));
    for (const table of ['snapshots', 'grants', 'requests', 'tasks', 'audit']) {
        assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM ' + table).all()).includes(privateText), false);
    }
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM grants').get().n, 0);
    candidate.candidate_id = randomUUID();
    const card = request.questions[0];
    resolve({ answers: [{ id: card.id, selected: [card.options[0].label] }] });
    const result = await pending;
    assert.equal(result.outcome, 'allowed');
    const grant = f.store.db.prepare('SELECT * FROM grants WHERE id=?').get(result.grant_id);
    assert.equal(JSON.parse(grant.scope_json).candidate_id, originalId);
    assert.equal(grant.session_id, f.session.id);
    assert.equal(f.session.log.length, before);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM snapshots').get().n, 0);
});

test('negative, custom and ambiguous native answers never grant private memory permission', async t => {
    const f = await nativeControlFixture(t);
    let choice = 'negative';
    f.onQuestion(({ questions: [card] }) => ({ answers: [{ id: card.id,
        selected: choice === 'negative' ? [card.options[1].label] : choice === 'many' ? card.options.map(option => option.label) : [],
        ...(choice === 'custom' ? { custom: card.options[0].label } : {}) }] }));
    for (choice of ['negative', 'many', 'custom']) {
        const { candidate } = f.input('合成敏感材料');
        const result = await f.control.askPrivate(candidate, f.agent);
        assert.equal(result.outcome, choice === 'negative' ? 'rejected' : 'unavailable');
        assert.equal(result.grant_id, null);
    }
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM grants').get().n, 0);
    assert.equal(f.store.db.prepare("SELECT status FROM audit WHERE type='consent' AND status='rejected'").get().status, 'rejected');
});

test('timeout, intervening policy changes and disposal invalidate late native consent answers', async t => {
    const f = await nativeControlFixture(t, { LEPI_CONSENT_TIMEOUT_MS: '25' });
    let resolve;
    let card;
    f.onQuestion(request => { card = request.questions[0]; return new Promise(done => { resolve = done; }); });
    const answer = () => resolve({ answers: [{ id: card.id, selected: [card.options[0].label] }] });
    const timeout = await f.control.askPrivate(f.input('合成超时材料').candidate, f.agent);
    assert.deepEqual(timeout, { outcome: 'expired', grant_id: null });
    answer();
    const race = f.control.askPrivate(f.input('合成政策变化材料').candidate, f.agent);
    await new Promise(done => setImmediate(done));
    f.store.transaction(() => f.store.bumpPolicyEpoch());
    answer();
    assert.deepEqual(await race, { outcome: 'cancelled', grant_id: null });
    const dispose = f.control.askPrivate(f.input('合成销毁材料').candidate, f.agent);
    await new Promise(done => setImmediate(done));
    await f.control.dispose();
    assert.deepEqual(await dispose, { outcome: 'cancelled', grant_id: null });
    const sourceId = f.store.db.prepare('SELECT id FROM evidence LIMIT 1').get().id;
    assert.deepEqual(await f.control.requestFromTool({ kind: 'grant', source_ids: [sourceId], candidate_ids: [] }, { agent: f.agent }),
        { request_id: null, status: 'unavailable', code: 'LEPI_NO_INITIATOR' });
    answer();
    await new Promise(done => setImmediate(done));
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM grants').get().n, 0);
});

test('parked input needs an operator retry and cannot evade a later forget fence by merging a new message', async t => {
    const f = await nativeControlFixture(t);
    const { message } = f.input('合成待检查输入');
    const frame = { agent: f.agent, messages: [message], turn: 1, step: 1, signal: new AbortController().signal };
    const next = async () => ({ kind: 'enter', messages: frame.messages });
    f.processor.checkControl = async () => { throw new Error('synthetic outage'); };
    assert.deepEqual(await f.control.beforeStep(frame, next), { kind: 'reject' });
    const parked = f.store.db.prepare("SELECT * FROM requests WHERE kind='check'").get();
    f.processor.checkControl = async () => ({ requests: [], recall_purpose: 'current', context_guards: [] });
    assert.deepEqual(await f.control.beforeStep(frame, next), { kind: 'reject' });
    assert.equal(f.control.retry(parked.id).status, 'retry_pending');
    assert.equal((await f.control.beforeStep(frame, next)).kind, 'enter');
    assert.equal(f.store.db.prepare('SELECT status FROM requests WHERE id=?').get(parked.id).status, 'checked');
    f.processor.checkControl = async () => { throw new Error('synthetic outage'); };
    await f.control.beforeStep(frame, next);
    f.store.transaction(() => {
        const epoch = f.store.bumpPolicyEpoch();
        f.store.db.prepare('INSERT INTO forget_scopes(id,request_id,candidate_ids_json,selector_json,active,epoch) VALUES (?,?,?,?,?,?)')
            .run(randomUUID(), parked.id, '[]', '{}', 1, epoch);
    });
    f.processor.checkControl = async () => ({ requests: [], recall_purpose: 'current', context_guards: [] });
    const fresh = f.input('新的合成消息').message;
    assert.deepEqual(await f.control.beforeStep({ ...frame, messages: [message, fresh] }, next), { kind: 'reject' });
    assert.equal(f.store.db.prepare('SELECT error_code FROM requests WHERE id=?').get(parked.id).error_code, 'LEPI_INPUT_RESUBMIT_REQUIRED');
});

test('an evidence fence requires fresh input rather than parking or requeuing the rejected body', async t => {
    const f = await nativeControlFixture(t);
    const { message } = f.input('合成已被隔离的待检查输入');
    f.evidence.setReadableGate(() => false);
    const frame = { agent: f.agent, messages: [message], turn: 1, step: 1, signal: new AbortController().signal };
    const next = async () => { throw new Error('Fenced input cannot enter the role'); };
    assert.deepEqual(await f.control.beforeStep(frame, next), { kind: 'reject' });
    const row = f.store.db.prepare("SELECT * FROM requests WHERE kind='check'").get();
    assert.equal(row.status, 'resubmit_required');
    assert.equal(row.error_code, 'LEPI_INPUT_RESUBMIT_REQUIRED');
    assert.deepEqual(f.steering, []);
    assert.equal(f.control.retry(row.id).status, 'resubmit_required');
});

function admissionFixture(t, layaUrl) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lep-admission-test-'));
    const store = openStore({ dbFile: path.join(dir, 'runtime.sqlite') });
    t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const config = resolveConfig({ LEPI_LAYA_URL: layaUrl });
    const candidate = { ...extracted.candidates[0], candidate_id: randomUUID(), formed_at: source.at, explicit: false, request_id: null };
    return { store, config, candidate };
}

test('the same laya probability respects content-specific inclusive admission boundaries', async t => {
    let score = 0.65;
    await withHttp((req, res) => {
        req.resume();
        res.end(JSON.stringify({ answers: { should_store: { type: 'noul', noul: score } }, usage: { truncated: false } }));
    }, async url => {
        const f = admissionFixture(t, url);
        const admission = createAdmission(f);
        assert.equal((await admission.evaluate(f.candidate)).verdict, 'accept');
        assert.equal((await admission.evaluate({ ...f.candidate, content_kind: 'temporary_state' })).verdict, 'defer');
        score = 0.35;
        assert.equal((await admission.evaluate(f.candidate)).verdict, 'defer');
        assert.equal((await admission.evaluate({ ...f.candidate, content_kind: 'temporary_state' })).verdict, 'reject');
    });
});

test('a high probability cannot authorize memory when clipping is reported or its evidence is missing', async t => {
    let usage;
    await withHttp((req, res) => {
        req.resume();
        res.end(JSON.stringify({ answers: { should_store: { type: 'noul', noul: 0.99 } }, usage }));
    }, async url => {
        const f = admissionFixture(t, url);
        const admission = createAdmission(f);
        const unavailable = await admission.evaluate(f.candidate);
        assert.equal(unavailable.verdict, 'defer');
        assert.equal(unavailable.reason_code, 'backend_unavailable');
        assert.equal(unavailable.score, null);
        usage = { truncated: false, state_tokens_dropped: 17, truncated_questions: ['should_store'] };
        const clipped = await admission.evaluate(f.candidate);
        assert.equal(clipped.verdict, 'defer');
        assert.equal(clipped.reason_code, 'input_truncated');
        assert.equal(clipped.truncated, true);
        assert.equal(clipped.score, null);
    });
});

async function waitUntil(condition) {
    const deadline = Date.now() + 5000;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('Scheduler did not reach the required state');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

async function schedulerFixture(t, sensitivity = 'ordinary') {
    const f = await nativeControlFixture(t);
    const input = f.input('SYNTHETIC_SCHEDULER_' + randomUUID());
    const candidate = { ...extracted.candidates[0], ...input.candidate, sensitivity, formed_at: source.at, explicit: false };
    f.processor.extract = async () => ({ candidates: [candidate], unresolved_source_ids: [] });
    const admission = { async evaluate() { return { verdict: 'accept', reason_code: 'value_accept', backend: 'generative', score: null, truncated: false }; } };
    const memory = createMemoryRuntime({ ctx: f.ctx, config: resolveConfig({}), store: f.store, processor: f.processor,
        admission, evidence: f.evidence, history: {}, hindsight: new HindsightClient({ baseUrl: 'http://127.0.0.1:1', deadlineMs: 30 }),
        askPrivate: (...args) => f.control.askPrivate(...args) });
    f.ownMemory(memory);
    return { ...f, ...input, candidate, admission, memory };
}

test('scheduler refuses a private candidate whose admission crossed a policy epoch', async t => {
    const f = await schedulerFixture(t, 'private');
    let questions = 0;
    f.onQuestion(request => {
        questions++;
        return { answers: [{ id: request.questions[0].id, selected: ['不保存'] }] };
    });
    f.admission.evaluate = async () => {
        f.store.transaction(() => f.store.bumpPolicyEpoch());
        return { verdict: 'accept', reason_code: 'value_accept' };
    };
    const { task_id } = f.memory.enqueue({ session_id: f.session.id, source_ids: f.candidate.source_ids });
    f.memory.start();
    await waitUntil(() => f.store.db.prepare('SELECT status FROM tasks WHERE id=?').get(task_id).status !== 'running' && !f.memory.health().running);
    assert.equal(questions, 0);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM snapshots').get().n, 0);
});

test('a confirmed topic admits new private material only while its live policy stays unchanged', async t => {
    for (const policyChanges of [false, true]) await t.test(policyChanges ? 'policy changes during matching' : 'existing topic permission', async t => {
        const f = await schedulerFixture(t, 'private');
        const grantId = randomUUID();
        const expiresAt = Date.now() + 60000;
        const scope = { kind: 'topic', subject_key: 'user', topic: f.candidate.facet_key,
            session_id: f.session.id, expires_at: new Date(expiresAt).toISOString(), allow_inference: false };
        f.store.db.prepare('INSERT INTO grants(id,scope_json,source_ids_json,session_id,expires_at) VALUES (?,?,?,?,?)')
            .run(grantId, JSON.stringify(scope), '[]', f.session.id, expiresAt);
        f.processor.matchGrant = async () => {
            if (policyChanges) f.store.transaction(() => f.store.bumpPolicyEpoch());
            return { match: 'covered' };
        };
        let questions = 0;
        f.onQuestion(request => {
            questions++;
            return { answers: [{ id: request.questions[0].id, selected: ['不保存'] }] };
        });
        const { task_id } = f.memory.enqueue({ session_id: f.session.id, source_ids: f.candidate.source_ids, explicit: true });
        f.memory.start();
        await waitUntil(() => f.store.db.prepare('SELECT status FROM tasks WHERE id=?').get(task_id).status === 'reconciled');
        const snapshot = f.store.db.prepare('SELECT json FROM snapshots WHERE candidate_id=?').get(f.candidate.candidate_id);
        assert.equal(questions, 0);
        if (policyChanges) assert.equal(snapshot, undefined);
        else {
            assert.equal(JSON.parse(snapshot.json).text, f.candidate.text);
            assert.equal(f.store.db.prepare('SELECT grant_id FROM lifecycle WHERE candidate_id=?').get(f.candidate.candidate_id).grant_id, grantId);
        }
    });
});

test('scheduler retry cannot revive an ordinary draft after its canonical source was replaced', async t => {
    const f = await schedulerFixture(t);
    f.evidence.observe(f.session, f.session.append('user/message', f.message, { surfaceOp: 'append' }));
    f.admission.evaluate = async () => ({ verdict: 'defer', reason_code: 'value_uncertain' });
    f.memory.enqueue({ session_id: f.session.id, source_ids: f.candidate.source_ids });
    f.memory.start();
    await waitUntil(() => f.store.db.prepare("SELECT 1 FROM tasks WHERE kind='admit' AND status='deferred'").get());
    const task = f.store.db.prepare("SELECT * FROM tasks WHERE kind='admit'").get();
    const seq = foldSurface(f.session.log).nodes[0];
    f.evidence.observe(f.session, f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Source removed' }] }),
        { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] }));
    f.admission.evaluate = async () => ({ verdict: 'accept', reason_code: 'value_accept' });
    f.memory.retry(task.id);
    await waitUntil(() => ['unknown', 'cancelled', 'reconciled'].includes(f.store.db.prepare('SELECT status FROM tasks WHERE id=?').get(task.id).status));
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM snapshots').get().n, 0);
    assert.equal(f.store.db.prepare('SELECT draft_json FROM tasks WHERE id=?').get(task.id).draft_json, null);
});

test('scheduler disposal cancels its native private card and drains without a late grant', async t => {
    const f = await schedulerFixture(t, 'private');
    let request;
    let resolve;
    f.onQuestion(value => { request = value; return new Promise(done => { resolve = done; }); });
    f.memory.enqueue({ session_id: f.session.id, source_ids: f.candidate.source_ids, explicit: true });
    f.memory.start();
    await waitUntil(() => request);
    let drained = false;
    const disposing = f.memory.dispose().then(() => { drained = true; });
    try {
        await new Promise(done => setImmediate(done));
        assert.equal(drained, true);
        resolve({ answers: [{ id: request.questions[0].id, selected: ['允许这条'] }] });
        await new Promise(done => setImmediate(done));
        assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM grants').get().n, 0);
    } finally { await f.control.dispose(); await disposing; }
});

test('an aborted turn with only committed user input is not a delivered memory result', async t => {
    const f = await schedulerFixture(t);
    f.memory.afterTurn(f.session, f.session.append('turn/start', { turn: 1 }));
    f.evidence.observe(f.session, f.session.append('user/message', f.message, { surfaceOp: 'append' }));
    f.memory.afterTurn(f.session, f.session.append('turn/end', { turn: 1, reason: { kind: 'aborted' } }));
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0);
});

test('a rejected native control step hands off only its exact request sources to the worker', async t => {
    const f = await schedulerFixture(t, 'private');
    f.processor.checkControl = async () => ({ requests: [{ kind: 'remember', source_ids: f.candidate.source_ids, candidate_ids: [], scope: null }], recall_purpose: 'current', context_guards: [] });
    f.processor.extract = async input => ({ candidates: [{ ...f.candidate, explicit: input.explicit, request_id: input.request_id }], unresolved_source_ids: [] });
    f.onQuestion(request => ({ answers: [{ id: request.questions[0].id, selected: ['允许这条'] }] }));
    assert.deepEqual(await f.control.beforeStep({ agent: f.agent, messages: [f.message], turn: 1, step: 1 },
        async () => { throw new Error('A pure memory operation cannot enter the role'); }), { kind: 'reject' });
    f.evidence.observe(f.session, f.session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } }));
    assert.equal((await f.evidence.read(f.candidate.source_ids, { agent: f.agent })).sources.length, 0);
    f.memory.start();
    await waitUntil(() => f.store.db.prepare("SELECT 1 FROM tasks WHERE kind='normalize' AND status IN ('reconciled','unknown','cancelled')").get());
    const snapshot = f.store.db.prepare('SELECT json FROM snapshots WHERE candidate_id=?').get(f.candidate.candidate_id);
    assert.equal(JSON.parse(snapshot?.json ?? 'null')?.text, f.candidate.text,
        JSON.stringify({ tasks: f.store.db.prepare('SELECT kind,status,error_code FROM tasks').all(),
            audit: f.store.db.prepare("SELECT type,status,data_json FROM audit WHERE type IN ('consent','grant','retain')").all()
                .map(row => ({ type: row.type, status: row.status, code: JSON.parse(row.data_json).reason_code })) }));
});

test('a private value defer does not leave a durable body or an automatic consent retry', async t => {
    const f = await schedulerFixture(t, 'private');
    f.admission.evaluate = async () => ({ verdict: 'defer', reason_code: 'value_uncertain' });
    let questions = 0;
    f.onQuestion(() => { questions++; });
    f.memory.enqueue({ session_id: f.session.id, source_ids: f.candidate.source_ids });
    f.memory.start();
    await waitUntil(() => f.store.db.prepare("SELECT 1 FROM tasks WHERE kind='normalize' AND status='reconciled'").get());
    for (const table of ['tasks', 'snapshots', 'grants', 'audit'])
        assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM ' + table).all()).includes(f.candidate.text), false);
    f.memory.wake();
    await new Promise(done => setImmediate(done));
    assert.equal(questions, 0);
});

test('semantic admission defer stays parked until an operator retries the same candidate', async t => {
    const f = await schedulerFixture(t);
    f.evidence.observe(f.session, f.session.append('user/message', f.message, { surfaceOp: 'append' }));
    let attempts = 0;
    f.admission.evaluate = async () => { attempts++; return { verdict: 'defer', reason_code: 'value_uncertain' }; };
    f.memory.enqueue({ session_id: f.session.id, source_ids: f.candidate.source_ids });
    f.memory.start();
    await waitUntil(() => f.store.db.prepare("SELECT 1 FROM tasks WHERE kind='admit' AND status='deferred'").get());
    const task = f.store.db.prepare("SELECT id FROM tasks WHERE kind='admit'").get();
    f.memory.wake();
    await new Promise(done => setTimeout(done, 20));
    assert.equal(attempts, 1);
    f.admission.evaluate = async () => ({ verdict: 'accept', reason_code: 'value_accept' });
    f.memory.retry(task.id);
    await waitUntil(() => f.store.db.prepare('SELECT status FROM tasks WHERE id=?').get(task.id).status === 'reconciled');
    assert.equal(f.store.db.prepare('SELECT candidate_id FROM snapshots').get().candidate_id, f.candidate.candidate_id);
});

test('curation state changes preserve semantic source versions but altered content cannot restore', () => {
    const raw = { id: randomUUID(), document_id: 'lepi-source', fact_type: 'world', text: 'Approved statement',
        metadata: { candidate_id: 'source', payload_hash: 'hash', nested: { a: 1, b: 2 } },
        state: 'valid', date: source.at, mentioned_at: source.at, occurred_start: null, occurred_end: null };
    assert.equal(rawVersion({ ...raw, state: 'invalidated', updated_at: 'later', scores: { semantic: 0.9 },
        metadata: { nested: { b: 2, a: 1 }, payload_hash: 'hash', candidate_id: 'source' } }), rawVersion(raw));
    for (const changed of [{ text: 'Externally changed' }, { mentioned_at: '2026-10-06T00:00:00Z' },
        { metadata: { ...raw.metadata, origin: 'external' } }, { document_id: 'foreign-doc' }])
        assert.notEqual(rawVersion({ ...raw, ...changed }), rawVersion(raw));
});

test('raw proof cannot borrow authority from an observation, foreign document or text-only content hash', () => {
    const approved = { candidate: { candidate_id: 'source', text: 'Approved original' }, documentId: 'lepi-source', payloadHash: 'snapshot-hash' };
    const document = { id: approved.documentId, bank_id: 'demo', original_text: approved.candidate.text,
        content_hash: 'different-text-hash', document_metadata: { candidate_id: 'source', payload_hash: approved.payloadHash } };
    const raw = { id: randomUUID(), document_id: approved.documentId, fact_type: 'world', state: 'valid',
        text: 'Backend paraphrase', metadata: document.document_metadata };
    assert.equal(documentMatches(document, approved, 'demo'), true);
    assert.equal(rawMatches(raw, approved), true);
    assert.equal(rawMatches({ ...raw, fact_type: 'observation' }, approved), false);
    assert.equal(rawMatches({ ...raw, metadata: { ...raw.metadata, payload_hash: 'content-hash' } }, approved), false);
    assert.equal(documentMatches({ ...document, original_text: 'Foreign original' }, approved, 'demo'), false);
    assert.equal(documentMatches({ ...document, bank_id: 'foreign' }, approved, 'demo'), false);
});

function remoteWorkerFixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lep-worker-test-'));
    const store = openStore({ dbFile: path.join(dir, 'runtime.sqlite') });
    t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    let clock = Date.now();
    const candidate = { ...extracted.candidates[0], candidate_id: randomUUID(), formed_at: source.at, explicit: true, request_id: null };
    const json = JSON.stringify(candidate);
    const task = randomUUID();
    store.transaction(() => {
        store.db.prepare('INSERT INTO snapshots(candidate_id,json,payload_hash,created_at) VALUES (?,?,?,?)')
            .run(candidate.candidate_id, json, createHash('sha256').update(json).digest('hex'), clock);
        store.db.prepare("INSERT INTO lifecycle(candidate_id,status,purpose,policy_epoch,updated_at) VALUES (?,'pending','current',?,?)")
            .run(candidate.candidate_id, store.policyEpoch, clock);
        store.db.prepare("INSERT INTO tasks(id,kind,candidate_id,status,payload_json,next_at,expires_at) VALUES (?,'write',?,'pending','{}',?,?)")
            .run(task, candidate.candidate_id, clock, clock + 604800000);
    });
    const approved = loadSource(store, candidate.candidate_id);
    const document = { id: approved.documentId, bank_id: 'demo', original_text: candidate.text,
        document_metadata: { candidate_id: candidate.candidate_id, payload_hash: approved.payloadHash } };
    const raw = { id: randomUUID(), document_id: approved.documentId, text: 'Verified backend statement',
        fact_type: 'world', state: 'valid', metadata: document.document_metadata, date: source.at };
    let posts = 0;
    const hindsight = { bank: 'demo', async retainAsync(item, { operationId }) { posts++; return { operation_id: operationId }; },
        async operation(operationId) { return { operation_id: operationId, status: 'completed' }; },
        async document() { return document; }, async units(id, { state = 'valid' } = {}) { return state === raw.state ? [raw] : []; },
        async cancel() {}, async invalidate() { raw.state = 'invalidated'; }, async revert() { raw.state = 'valid'; } };
    const checkPolicy = async (input, row, { restore = false } = {}) => ({
        allowed: restore ? loadSource(store, input.candidate.candidate_id).lifecycle.status === 'unknown'
            : ['pending', 'unknown'].includes(loadSource(store, input.candidate.candidate_id).lifecycle.status),
        epoch: store.policyEpoch, code: 'LEPI_MEMORY_SUPPRESSED',
    });
    const deps = { store, hindsight, checkPolicy, now: () => clock };
    return { ...deps, task, candidate, document, raw, source: approved,
        advance(ms = 10000) { clock += ms; }, posts: () => posts,
        row() { return store.db.prepare('SELECT * FROM tasks WHERE id=?').get(task); },
        curate(kind) {
            const id = randomUUID();
            store.db.prepare("INSERT INTO tasks(id,kind,request_id,status,payload_json,next_at,expires_at) VALUES (?,'curate',?,'pending',?,?,?)")
                .run(id, randomUUID(), JSON.stringify({ kind, candidate_ids: [candidate.candidate_id] }), clock, clock + 604800000);
            return id;
        },
    };
}

test('lost acknowledgements and explicit unknown rechecks retain identity and recover current truth without resubmission', async t => {
    const f = remoteWorkerFixture(t);
    let seen;
    f.hindsight.retainAsync = async (item, { operationId }) => { seen = operationId; throw new Error('Lost acknowledgement'); };
    let worker = createWriteWorker(f);
    await worker.runNext();
    assert.equal(f.row().operation_id, seen);
    const submitted = f.row().submitted_at;
    f.hindsight.operation = async operationId => ({ operation_id: operationId, status: 'not_found' });
    f.hindsight.document = async () => null;
    f.advance();
    worker = createWriteWorker(f);
    await worker.runNext();
    assert.equal(f.row().status, 'unknown');
    assert.equal(loadSource(f.store, f.candidate.candidate_id).lifecycle.status, 'unknown');
    f.hindsight.document = async () => f.document;
    f.hindsight.retainAsync = async () => { throw new Error('An explicit recheck must never submit again'); };
    f.store.db.prepare("UPDATE tasks SET status='submitted',next_at=? WHERE id=?").run(f.now(), f.task);
    await worker.runNext();
    assert.equal(f.row().status, 'reconciled');
    assert.equal(f.row().operation_id, seen);
    assert.equal(f.row().submitted_at, submitted);
    assert.equal(loadSource(f.store, f.candidate.candidate_id).lifecycle.status, 'active');
});

test('completed without usable raw never produces a written receipt or current snapshot', async t => {
    const f = remoteWorkerFixture(t);
    f.hindsight.units = async () => [];
    const worker = createWriteWorker(f);
    await worker.runNext(); f.advance(); await worker.runNext();
    assert.equal(f.row().status, 'failed');
    assert.equal(f.row().error_code, 'LEPI_RETAIN_EMPTY');
    assert.equal(loadSource(f.store, f.candidate.candidate_id).lifecycle.status, 'audit_only');
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM raw_links').get().n, 0);
});

test('submitted retention remains recoverable after the unsent-task TTL has passed', async t => {
    const f = remoteWorkerFixture(t);
    const worker = createWriteWorker(f);
    await worker.runNext();
    const operation = f.row().operation_id;
    f.advance(604800001);
    await worker.runNext();
    assert.equal(f.row().status, 'written');
    assert.equal(f.row().operation_id, operation);
    assert.equal(f.posts(), 1);
    const visible = f.store.history({ kind: 'task', limit: 1 }).items[0];
    assert.deepEqual({ task_id: visible?.task_id, operation_id: visible?.operation_id, status: visible?.status },
        { task_id: f.task, operation_id: operation, status: 'written' });
});

test('forget during a write never invalidates observations or a foreign payload sharing the document', async t => {
    const f = remoteWorkerFixture(t);
    const foreign = { ...f.raw, id: randomUUID(), metadata: { ...f.raw.metadata, candidate_id: randomUUID() } };
    const observation = { ...f.raw, id: randomUUID(), fact_type: 'observation' };
    const raws = [f.raw, foreign, observation];
    f.hindsight.units = async (id, { state = 'valid' } = {}) => raws.filter(raw => raw.state === state);
    f.hindsight.invalidate = async id => { raws.find(raw => raw.id === id).state = 'invalidated'; };
    const worker = createWriteWorker(f);
    await worker.runNext();
    f.store.transaction(() => {
        const epoch = f.store.bumpPolicyEpoch();
        f.store.db.prepare("UPDATE lifecycle SET status='forgotten',policy_epoch=? WHERE candidate_id=?").run(epoch, f.candidate.candidate_id);
    });
    f.advance(); await worker.runNext();
    assert.equal(f.raw.state, 'invalidated');
    assert.equal(foreign.state, 'valid');
    assert.equal(observation.state, 'valid');
    assert.equal(loadSource(f.store, f.candidate.candidate_id).lifecycle.status, 'forgotten');
});

test('curation does not declare cleanup complete while a cancelled operation can still produce late raw', async t => {
    const f = remoteWorkerFixture(t);
    const writer = createWriteWorker(f);
    await writer.runNext();
    f.store.db.prepare("UPDATE lifecycle SET status='forgotten' WHERE candidate_id=?").run(f.candidate.candidate_id);
    f.hindsight.cancel = async () => ({ status: 'processing' });
    f.hindsight.operation = async operationId => ({ operation_id: operationId, status: 'processing' });
    const task = f.curate('forget');
    const curator = createCurateWorker(f);
    await curator.runNext();
    assert.equal(f.raw.state, 'invalidated');
    assert.equal(f.store.db.prepare('SELECT status FROM tasks WHERE id=?').get(task).status, 'pending');
    f.raw.state = 'valid';
    f.hindsight.cancel = async () => ({ status: 'completed' });
    f.hindsight.operation = async operationId => ({ operation_id: operationId, status: 'completed' });
    f.advance(); await curator.runNext();
    assert.equal(f.raw.state, 'invalidated');
    assert.equal(f.store.db.prepare('SELECT status FROM tasks WHERE id=?').get(task).status, 'reconciled');
});

test('selected restore refuses external source changes instead of overwriting from its local snapshot', async t => {
    const f = remoteWorkerFixture(t);
    f.store.db.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(f.task);
    f.store.db.prepare("UPDATE lifecycle SET status='unknown' WHERE candidate_id=?").run(f.candidate.candidate_id);
    f.store.db.prepare('INSERT INTO raw_links(raw_id,candidate_id,document_id,version_hash,state,verified_at) VALUES (?,?,?,?,?,?)')
        .run(f.raw.id, f.candidate.candidate_id, f.source.documentId, rawVersion(f.raw), 'invalidated', f.now());
    f.raw.state = 'invalidated';
    f.raw.text = 'Changed outside this runtime';
    const task = f.curate('restore');
    await createCurateWorker(f).runNext();
    assert.equal(f.raw.state, 'invalidated');
    assert.equal(f.store.db.prepare('SELECT status FROM tasks WHERE id=?').get(task).status, 'failed');
    assert.equal(loadSource(f.store, f.candidate.candidate_id).lifecycle.status, 'unknown');
    assert.equal(f.posts(), 0);
});

test('unavailable operation reads defer visibly and an operator recheck never allocates another operation', async t => {
    const f = remoteWorkerFixture(t);
    const worker = createWriteWorker(f);
    await worker.runNext();
    const op = f.row().operation_id;
    f.hindsight.operation = async () => { throw Object.assign(new Error('Offline'), { code: 'LEPI_HINDSIGHT_UNAVAILABLE' }); };
    for (let i = 0; i < 4; i++) { f.advance(); await worker.runNext(); }
    assert.equal(f.row().status, 'deferred');
    assert.equal(f.row().operation_id, op);
    const memory = createMemoryRuntime({ ctx: {}, config: resolveConfig({}), store: f.store, hindsight: f.hindsight, now: f.now });
    assert.equal(memory.retry(f.task).status, 'submitted');
    f.hindsight.operation = async operationId => ({ operation_id: operationId, status: 'completed' });
    await worker.runNext();
    assert.equal(f.row().status, 'written');
    assert.equal(f.posts(), 1);
    await memory.dispose();
});

test('a missing operation is not proof that forbidden lost-ack work cannot produce late raw', async t => {
    const f = remoteWorkerFixture(t);
    const worker = createWriteWorker(f);
    await worker.runNext();
    f.store.db.prepare("UPDATE lifecycle SET status='forgotten' WHERE candidate_id=?").run(f.candidate.candidate_id);
    f.hindsight.operation = async operationId => ({ operation_id: operationId, status: 'not_found' });
    f.advance(); await worker.runNext();
    assert.equal(f.row().status, 'cancelled');
    assert.equal(JSON.parse(f.row().payload_json).cleanup, 'required');
    f.raw.state = 'valid';
    f.hindsight.operation = async operationId => ({ operation_id: operationId, status: 'completed' });
    f.advance(); await worker.runNext();
    assert.equal(f.raw.state, 'invalidated');
    assert.equal(JSON.parse(f.row().payload_json).cleanup, 'done');
    assert.equal(loadSource(f.store, f.candidate.candidate_id).lifecycle.status, 'forgotten');
});

test('the integrated worker rereads lifecycle after document awaits instead of activating a forgotten snapshot', async t => {
    const f = remoteWorkerFixture(t);
    let forgotten = false;
    f.hindsight.document = async () => {
        if (!forgotten) {
            forgotten = true;
            f.store.transaction(() => {
                const epoch = f.store.bumpPolicyEpoch();
                f.store.db.prepare("UPDATE lifecycle SET status='forgotten',policy_epoch=? WHERE candidate_id=?").run(epoch, f.candidate.candidate_id);
            });
        }
        return f.document;
    };
    const memory = createMemoryRuntime({ ctx: {}, config: resolveConfig({}), store: f.store, hindsight: f.hindsight });
    t.after(() => memory.dispose());
    memory.start();
    await waitUntil(() => JSON.parse(f.row().payload_json).cleanup === 'done');
    assert.equal(f.row().status, 'cancelled');
    assert.equal(f.raw.state, 'invalidated');
    assert.equal(loadSource(f.store, f.candidate.candidate_id).lifecycle.status, 'forgotten');
    assert.equal(f.store.history({ kind: 'retain', limit: 100, offset: 0 }).items.some(row => row.status === 'written'), false);
});

test('observation verification cannot expand its approved source set through either evidence tool', async () => {
    for (const name of ['fetch_context', 'fetch_memory']) {
        let accessed = 0;
        const processor = createProcessor({ store: { policyEpoch: 0 },
            routes: { process: { model: 'fixed' }, controlFallback: { model: 'fixed-fallback' } },
            evidence: { async read() { accessed++; return { sources: [source] }; } },
            llm: { async *stream() {
                yield { type: 'tool-call-delta', index: 0, id: 'unapproved-source-call', name,
                    argumentsDelta: JSON.stringify(name === 'fetch_context' ? { source_ids: [source.id] } : { query: 'other material', purpose: 'current' }) };
                yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 100 } };
                yield { type: 'finish', reason: { kind: 'tool-calls' } };
            } } });
        processor.setMemoryReader(async () => { accessed++; return { sources: [source] }; });
        const result = await processor.verifyObservation({ sources: [source], observation: { text: source.text } });
        assert.deepEqual(result, { safe: false, used_source_ids: [], reason_code: 'source_unavailable' });
        assert.equal(accessed, 0);
    }
});
