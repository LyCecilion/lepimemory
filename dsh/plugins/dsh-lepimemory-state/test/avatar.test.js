import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AVATAR_ASSETS } from '../lib/shared/avatar-assets.js';
import { initialState, toneOf, nearOf } from '../lib/shared/state.js';
import { deriveChatSignal, resolveActivity } from '../lib/shared/activity.js';

const AVATAR_DIR = fileURLToPath(new URL('../assets/avatar/', import.meta.url));
const KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;

test('清单键名形状合法', () => {
  for (const key of Object.keys(AVATAR_ASSETS)) assert.match(key, KEY_RE, `非法 key：${key}`);
});

test('assets/avatar/ 的文件集合与清单的值完全相等（无缺失、无多余）', () => {
  const onDisk = fs.readdirSync(AVATAR_DIR).sort();
  const declared = [...Object.values(AVATAR_ASSETS)].sort();
  assert.deepEqual(onDisk, declared);
});

test('每个素材都是 256x256 的 GIF89a', () => {
  for (const [key, file] of Object.entries(AVATAR_ASSETS)) {
    const buf = fs.readFileSync(path.join(AVATAR_DIR, file));
    assert.equal(buf.subarray(0, 6).toString('latin1'), 'GIF89a', `${key} 头部不是 GIF89a`);
    assert.equal(buf.readUInt16LE(6), 256, `${key} 宽度不是 256`);
    assert.equal(buf.readUInt16LE(8), 256, `${key} 高度不是 256`);
  }
});

test('toneOf 在 MILD 边界分档，nearOf 以 closeness 高出基线一档为准', () => {
  const at = (delta) => {
    const state = initialState();
    state.mood.valence = delta;
    return toneOf(state);
  };
  assert.equal(at(0.1), 'bright');
  assert.equal(at(0.05), 'plain');
  assert.equal(at(-0.1), 'low');

  const near = (closeness) => {
    const state = initialState();
    state.relation.closeness = closeness;
    return nearOf(state);
  };
  assert.equal(near(0.3), true);
  assert.equal(near(0.25), false);
});

/** 用 Map 充当 Chat 快照的 `nodes`（`values()` 迭代器形状）。 */
const snapshotOf = (nodes) => ({ nodes: new Map(nodes) });

test('活动优先级：审批/提问 > 工具/说话/思考 > 错误 > 待机', () => {
  // pending approval 压过 tool / running / error。
  assert.equal(
    resolveActivity({ pendingInteraction: { kind: 'approval' }, running: true }, 'tool', 'boom'),
    'approval',
  );
  // pending 非 approval → question。
  assert.equal(
    resolveActivity({ pendingInteraction: { kind: 'question' }, running: true }, 'tool', 'boom'),
    'question',
  );
  // running 且有工具 → tool。
  assert.equal(resolveActivity({ running: true }, 'tool', null), 'tool');
  // 无 running 但有 error → error。
  assert.equal(resolveActivity({ running: false }, null, 'boom'), 'error');
  // 空快照 → idle。
  assert.equal(resolveActivity(undefined, null, null), 'idle');
});

test('文本输出只在 running 的 assistant step 上算“说话”', () => {
  assert.equal(
    deriveChatSignal(
      snapshotOf([
        [
          'a',
          {
            kind: 'assistant-step',
            data: { status: 'running', blocks: [{ kind: 'text', text: 'hi' }] },
          },
        ],
      ]),
    ),
    'speak',
  );
  assert.equal(
    deriveChatSignal(
      snapshotOf([['a', { kind: 'assistant-step', data: { status: 'running', blocks: [] } }]]),
    ),
    'think',
  );
  assert.equal(
    deriveChatSignal(
      snapshotOf([
        [
          'a',
          {
            kind: 'assistant-step',
            data: { status: 'settled', blocks: [{ kind: 'text', text: 'hi' }] },
          },
        ],
      ]),
    ),
    null,
  );
  assert.equal(deriveChatSignal({ nodes: { values: () => [] } }), null);
});
