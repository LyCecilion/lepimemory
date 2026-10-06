import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AVATAR_ASSETS } from '../lib/avatar-assets.js';

const AVATAR_DIR = fileURLToPath(new URL('../assets/avatar/', import.meta.url));
const KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * 客户端 `client.js` 里 `AVATAR_FRAMES` 出现的全部 key（去重排序）。
 * mirror of client.js AVATAR_FRAMES — 两边同时改；它只用于保证前端引用的键都能在素材清单里找到。
 */
const CLIENT_FRAME_KEYS = [
    'angry', 'bell', 'bubble', 'button', 'celebrate', 'cheer', 'cheers', 'clueless', 'clown', 'cry',
    'daze', 'dead', 'greet', 'idea', 'jailed', 'knock', 'loading', 'megaphone', 'nosetouch', 'press',
    'question', 'shades', 'sleep', 'trash', 'type', 'type-annoyed', 'work', 'work-angry', 'work-tired',
];

test('清单是 38 项且键名形状合法', () => {
    const keys = Object.keys(AVATAR_ASSETS);
    assert.equal(keys.length, 38);
    for (const key of keys) assert.match(key, KEY_RE, `非法 key：${key}`);
    assert.equal(new Set(keys).size, keys.length, '存在重复 key');
});

test('assets/avatar/ 的文件集合与清单的值完全相等（无缺失、无多余）', () => {
    const onDisk = fs.readdirSync(AVATAR_DIR).sort();
    const declared = [...Object.values(AVATAR_ASSETS)].sort();
    assert.deepEqual(onDisk, declared);
});

test('每个素材都是 112x112 的 GIF89a', () => {
    for (const [key, file] of Object.entries(AVATAR_ASSETS)) {
        const buf = fs.readFileSync(path.join(AVATAR_DIR, file));
        assert.equal(buf.subarray(0, 6).toString('latin1'), 'GIF89a', `${key} 头部不是 GIF89a`);
        assert.equal(buf.readUInt16LE(6), 112, `${key} 宽度不是 112`);
        assert.equal(buf.readUInt16LE(8), 112, `${key} 高度不是 112`);
    }
});

test('客户端 AVATAR_FRAMES 引用的每个 key 都在素材清单里', () => {
    for (const key of CLIENT_FRAME_KEYS) assert.ok(key in AVATAR_ASSETS, `客户端引用了未知 key：${key}`);
});
