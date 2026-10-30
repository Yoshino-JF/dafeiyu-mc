// #3176: the day-29 dawn promoted two things it should not have. These tests lock both fixes with the live sentences.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isOneOffRequest, normalizeOwner } from './promises.js';
import { MemoryS } from './index.js';

const T0 = 1_800_000_000_000;
const mk = (ownerName = 'JFors') => new MemoryS({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsalias-')), now: () => T0, ownerName });

test('the day-29 sentence is a one-off want, not a fact', () => {
    assert.equal(isOneOffRequest('要四块白桦木板，人不在线时先留着。'), true);
    assert.equal(isOneOffRequest('要5个橡木原木'), true);
    assert.equal(isOneOffRequest('需要3块面包'), true);
});

test('preferences and standing rules are still facts', () => {
    assert.equal(isOneOffRequest('老大觉得应该住在上面'), false);
    assert.equal(isOneOffRequest('我觉得应该住在上面。'), false);
    assert.equal(isOneOffRequest('以后每天要5个橡木原木'), false, 'a standing rule keeps its marker');
    assert.equal(isOneOffRequest('建议跳起来往脚下放方块来往上走'), false);
});

test('every alias of the owner is normalized to one name', () => {
    assert.equal(normalizeOwner('老大', 'JFors'), 'JFors');
    assert.equal(normalizeOwner('主人', 'JFors'), 'JFors');
    assert.equal(normalizeOwner('老板', 'JFors'), 'JFors');
    assert.equal(normalizeOwner('JFors', 'JFors'), 'JFors');
    assert.equal(normalizeOwner('HouseTest', 'JFors'), 'HouseTest', 'a test bot is not the owner');
    assert.equal(normalizeOwner('老大', 'SomeOwner'), 'SomeOwner', 'the configured name wins');
});

test('the promote path refuses the day-29 want and normalizes the alias for real facts', () => {
    const m = mk();
    assert.equal(m.rememberTaught({ who: '老大', what: '要四块白桦木板，人不在线时先留着。', source: 'consolidate' }), null,
        'a want with a count never becomes a fact');
    const kept = m.rememberTaught({ who: '老大', what: '觉得应该住在上面', source: 'consolidate' });
    assert.ok(kept);
    assert.equal(kept.who, 'JFors', 'the alias is stored as the owner name, so the count check sees it');
    assert.equal(m.taughtFacts().length, 1);
});

test('an alias row merges with the owner row instead of becoming a twin', () => {
    const m = mk();
    m.rememberTaught({ who: 'JFors', what: '认为我应该住在上面，不要在地下找房子', at: T0 });
    m.rememberTaught({ who: '老大', what: '觉得应该住在上面，别在地下找', at: T0 + 1000 });
    assert.equal(m.taughtFacts().length, 1, 'one owner, one fact');
    assert.equal(m.taughtFacts()[0].who, 'JFors');
});

test('the promise path normalizes the alias too', () => {
    const m = mk();
    const row = m.notePromise({ request: '帮我把四块木板送来', reply: '好，我这就去', who: '老大', at: T0 });
    assert.ok(row);
    assert.equal(row.who, 'JFors');
});
