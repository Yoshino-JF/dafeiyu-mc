// #3152: a one-off request must not become a never-delete owner fact. The exact sentence from the day-27 dawn is here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isOneOffRequest } from './promises.js';
import { MemoryS } from './index.js';

const T0 = 1_800_000_000_000;
const mkMemory = () => new MemoryS({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsonce-')), now: () => T0 });

test('the exact day-27 sentence is a task, not a fact', () => {
    assert.equal(isOneOffRequest('要我去出生点旁（-2，64，-3）箱子拿4块白桦木板送到他那儿。'), true);
});

test('preferences and techniques are still facts', () => {
    assert.equal(isOneOffRequest('我觉得应该住在上面。'), false);
    assert.equal(isOneOffRequest('建议跳起来往脚下放方块来往上走，不行就直接挖。'), false);
    assert.equal(isOneOffRequest('旁边箱子里有面包和铁锭。'), false);
    assert.equal(isOneOffRequest('老大把钻石藏在出生点旁边最高的白桦树底下，埋在下面三格。'), false,
        'a statement about where something is stays a fact');
});

test('a standing rule that names a count is still a fact', () => {
    assert.equal(isOneOffRequest('以后每天帮我砍5个橡木原木。'), false, 'long-term marker wins');
    assert.equal(isOneOffRequest('别忘了每周帮我挖6块泥土备着。'), false);
});

test('the promote path refuses it and keeps the real ones', () => {
    const m = mkMemory();
    const rejected = m.rememberTaught({ who: 'JFors', what: '要我去出生点旁（-2，64，-3）箱子拿4块白桦木板送到他那儿。', source: 'consolidate' });
    assert.equal(rejected, null, 'the errand never becomes a fact');
    const kept = m.rememberTaught({ who: 'JFors', what: '我觉得应该住在上面。', source: 'consolidate' });
    assert.ok(kept, 'the preference is kept');
    assert.equal(m.taughtFacts().length, 1);
    assert.equal(m.taughtFacts()[0].what, '我觉得应该住在上面。');
});

test('a rejected request leaves no raw record either', () => {
    const m = mkMemory();
    m.rememberTaught({ who: 'JFors', what: '帮我砍5个橡木原木，砍完报实际数量。', source: 'consolidate' });
    assert.equal(m.taughtFacts().length, 0);
    const rawDir = path.join(m.dir, 'raw');
    const files = fs.existsSync(rawDir) ? fs.readdirSync(rawDir) : [];
    const taught = files.length
        ? fs.readFileSync(path.join(rawDir, files[0]), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === 'taught')
        : [];
    assert.equal(taught.length, 0, 'nothing was written to her raw record for a refused fact');
});
