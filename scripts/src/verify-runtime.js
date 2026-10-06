#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openStore } from '../../dsh/plugins/dsh-lepimemory-state/lib/store.js';
import { initialState } from '../../dsh/plugins/dsh-lepimemory-state/lib/shared/state.js';
import { NODE_VERSION } from '../../dsh/plugins/dsh-lepimemory-state/lib/shared/pins.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
assert.equal(process.version, NODE_VERSION);
assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(path.join(root, '.runtime/bin/node')));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lep-verify-'));
const dir = path.join(home, 'lepimemory');
fs.mkdirSync(dir);
const dbFile = path.join(dir, 'runtime.sqlite');
const time = Date.parse('2026-10-05T00:00:00.000Z');
const storeModule = fileURLToPath(
  new URL('../../dsh/plugins/dsh-lepimemory-state/lib/store.js', import.meta.url),
);
let store;
try {
    const legacy = initialState(new Date(time).toISOString());
    legacy.mood.valence = 0.6;
    legacy.relation.closeness = 0.7;
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(legacy));
    const legacyRows = {
        audit: { at: new Date(time).toISOString(), before: legacy, after: legacy, rules: [] },
        recall: { at: new Date(time).toISOString(), session: 'legacy-session', turn: 1, picked: [] },
        retain: { at: new Date(time).toISOString(), ok: false, error: 'synthetic unavailable' },
        forget: { at: new Date(time).toISOString(), ids: ['legacy-raw'], outcome: 'allowed-once' },
        action: { at: new Date(time).toISOString(), outcome: 'allowed-once' },
    };
    for (const [kind, record] of Object.entries(legacyRows)) {
        fs.writeFileSync(path.join(dir, `${kind}.jsonl`), JSON.stringify(record) + '\n');
    }
    store = openStore({ dbFile, now: () => time });
    assert.deepEqual(store.readState(), legacy);
    assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 2);
    assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    const imported = store.history({ kind: 'action' }).items[0];
    assert.equal(imported.session_id, null);
    assert.equal(imported.call_id, null);
    assert.equal(imported.status, 'unknown');
    assert.equal(imported.data.legacy, true);
    assert.equal(store.history().total, 5);
    assert.equal(store.history({ kind: 'retain' }).items[0].status, 'failed');
    const oldRecall = store.history({ kind: 'recall' }).items[0];
    assert.equal(oldRecall.session_id, 'legacy-session');
    assert.equal(oldRecall.turn, 1);
    assert.equal(oldRecall.call_id, null);
    const archive = store.db.prepare("SELECT value FROM meta WHERE key='legacy_archive'").get().value;
    assert.equal(fs.readFileSync(path.join(archive, 'state.json'), 'utf8'), JSON.stringify(legacy));
    for (const kind of Object.keys(legacyRows)) {
        assert.equal(fs.readFileSync(path.join(archive, `${kind}.jsonl`), 'utf8'), fs.readFileSync(path.join(dir, `${kind}.jsonl`), 'utf8'));
    }

    assert.throws(() => openStore({ dbFile }), { code: 'LEPI_STORE_OWNED' });
    const competing = spawnSync(process.execPath, ['--input-type=module', '-e', `import {openStore} from ${JSON.stringify(storeModule)};try{openStore({dbFile:process.argv[1]});process.exit(2)}catch(e){if(e.code!=='LEPI_STORE_OWNED')process.exit(3)}`, dbFile]);
    assert.equal(competing.status, 0, competing.stderr.toString());

    const before = store.readState();
    const changed = structuredClone(before);
    changed.mood.valence = -0.4;
    const auditCount = store.history().total;
    assert.throws(() => store.commitState(changed, { status: 'executed' }));
    assert.deepEqual(store.readState(), before);
    assert.equal(store.history().total, auditCount);
    const event = { type: 'state.operator', status: 'executed', session_id: 'synthetic-session', turn: 3, step: 2, call_id: null, data: { cause: '操作者调整演示状态' } };
    store.commitState(changed, event);
    const committed = store.history().items[0];
    assert.deepEqual(committed.data.before, before);
    assert.deepEqual(committed.data.after, changed);
    assert.equal(committed.session_id, 'synthetic-session');
    assert.equal(committed.turn, 3);
    assert.equal(committed.call_id, null);

    const candidate = randomUUID();
    store.db.prepare('INSERT INTO snapshots(candidate_id,json,payload_hash,created_at) VALUES (?,?,?,?)').run(candidate, JSON.stringify({ text: '合成获准偏好', origin: 'user' }), 'synthetic-hash', time);
    assert.throws(() => store.db.prepare('UPDATE snapshots SET json=? WHERE candidate_id=?').run('{}', candidate));
    assert.equal(JSON.parse(store.db.prepare('SELECT json FROM snapshots WHERE candidate_id=?').get(candidate).json).text, '合成获准偏好');
    const epoch = store.policyEpoch;
    assert.throws(() => store.transaction(() => { store.bumpPolicyEpoch(); throw new Error('rollback'); }));
    assert.equal(store.policyEpoch, epoch);
    store.transaction(() => store.bumpPolicyEpoch());
    assert.equal(store.policyEpoch, epoch + 1);
    let asyncExecuted = false;
    assert.throws(() => store.transaction(async () => { asyncExecuted = true; }));
    assert.equal(asyncExecuted, false);

    const taskId = randomUUID(), operationId = randomUUID();
    store.db.prepare(`INSERT INTO tasks(id,kind,status,operation_id,next_at,expires_at,lease_owner,submitted_at) VALUES (?,'write','running',?,?,?,?,?)`).run(taskId, operationId, time, time + 10000, 'dead-lease', time);
    // Release our actual owner, then install a demonstrably dead PID as a crash fixture.
    store.close(); store = null;
    const { DatabaseSync } = await import('node:sqlite');
    const fixture = new DatabaseSync(dbFile);
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
    const pid = Number(dead.stdout.toString());
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    fixture.prepare("INSERT INTO meta(key,value) VALUES ('owner',?)").run(JSON.stringify({ host: os.hostname(), pid, nonce: 'dead' }));
    fixture.close();
    fs.writeFileSync(path.join(dir, 'state.json'), 'now invalid legacy file must not be read again');
    store = openStore({ dbFile, now: () => time + 1 });
    assert.deepEqual(store.readState(), changed);
    assert.equal(store.history({ kind: 'action' }).total, 1);
    const recovered = store.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    assert.equal(recovered.status, 'submitted');
    assert.equal(recovered.operation_id, operationId);
    assert.equal(recovered.lease_owner, null);
    const reader = openStore({ dbFile, readOnly: true });
    try {
        assert.deepEqual(reader.readState(), changed);
        assert.throws(() => reader.db.prepare('UPDATE state SET json=? WHERE id=1').run('{}'));
    } finally { reader.close(); }
    assert.throws(() => store.history({ kind: 'constructor' }));
    console.log(JSON.stringify({ node: process.version, sqlite: 'rollback/reopen proven', legacy: 'preserved once', writer: 'second process refused', stateAudit: 'atomic full before/after', snapshot: 'immutable', recoveredOperationId: operationId, readonly: 'write refused' }));
} finally {
    store?.close();
    fs.rmSync(home, { recursive: true, force: true });
}
