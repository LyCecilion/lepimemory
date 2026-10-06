/**
 * 面板历史「按主体分组」回归：`store.historyGroups()` 是 host 侧唯一的分组口径。
 *
 * 断言消费侧可见行为（组数、组键、组内阶段数/顺序、截断），不碰注册字符串、
 * 内部字段名或 mock 回显。用临时库造行，`t.after` 清理。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.js';

function fixture(t) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lep-groups-test-'));
    const store = openStore({ dbFile: path.join(home, 'runtime.sqlite'), legacyDir: home, now: () => Date.parse('2026-10-06T00:00:00Z') });
    t.after(() => { store.close(); fs.rmSync(home, { recursive: true, force: true }); });
    return store;
}

test('historyGroups 按主体归组、组序按各组最新一条', (t) => {
    const store = fixture(t);
    // control 先造（无主体 → 'i:'||id），使候选组成为最新一组。
    store.audit({ type: 'control', status: 'state_set' });
    const ids = [];
    for (let i = 0; i < 3; i += 1) ids.push(store.audit({ type: 'retain', status: 'submitted', candidate_id: 'c1', task_id: 't1' }));

    const page = store.historyGroups({ kind: 'audit' });
    assert.equal(page.total, 2);
    assert.equal(page.groups.length, 2);
    assert.equal(page.groups[0].key, 'c:c1');
    assert.equal(page.groups[0].items.length, 3);
    assert.deepEqual(page.groups[0].items.map((row) => row.id), [...ids].reverse());
    assert.equal(page.groups[0].truncated, false);
    assert.equal(page.groups[1].items.length, 1);
});

test('historyGroups 以组为单位分页', (t) => {
    const store = fixture(t);
    store.audit({ type: 'control', status: 'state_set' });
    for (let i = 0; i < 3; i += 1) store.audit({ type: 'retain', status: 'submitted', candidate_id: 'c1', task_id: 't1' });

    const first = store.historyGroups({ kind: 'audit', limit: 1 });
    assert.equal(first.total, 2);
    assert.equal(first.groups.length, 1);
    assert.equal(first.groups[0].key, 'c:c1');

    const second = store.historyGroups({ kind: 'audit', limit: 1, offset: 1 });
    assert.equal(second.total, 2);
    assert.equal(second.groups.length, 1);
    assert.equal(second.groups[0].key, 'i:1');
});

test('historyGroups 与 history 共用同一 kind 过滤口径', (t) => {
    const store = fixture(t);
    store.audit({ type: 'control', status: 'state_set' });
    for (let i = 0; i < 3; i += 1) store.audit({ type: 'retain', status: 'submitted', candidate_id: 'c1', task_id: 't1' });

    const page = store.historyGroups({ kind: 'retain' });
    assert.equal(page.total, 1);
    assert.equal(page.groups[0].key, 'c:c1');
    assert.equal(page.groups[0].items.length, 3);
});

test('historyGroups 截断超过 stages 的阶段并标记 truncated', (t) => {
    const store = fixture(t);
    for (let i = 0; i < 60; i += 1) store.audit({ type: 'retain', status: 'submitted', candidate_id: 'c2' });

    const page = store.historyGroups({ kind: 'audit' });
    assert.equal(page.groups.length, 1);
    assert.equal(page.groups[0].items.length, 50);
    assert.equal(page.groups[0].truncated, true);
});
