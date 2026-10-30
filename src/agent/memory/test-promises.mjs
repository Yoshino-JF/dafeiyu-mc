// #3132: an accepted owner request must survive an interruption chain. These tests lock the conservative rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PromiseStore, ACCEPT_RE, PROMISE_TTL_MS, isTestBot } from './promises.js';

const mk = () => new PromiseStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsprom-')), 'promises.jsonl'));
const T0 = 1_800_000_000_000;

test('an explicit yes records a promise; anything else does not', () => {
    assert.ok(ACCEPT_RE.test('好，我这就去把箱子里的铁锭拿给你'));
    assert.ok(ACCEPT_RE.test('马上'));
    assert.ok(ACCEPT_RE.test('没问题，交给我'));
    assert.equal(ACCEPT_RE.test('我现在在砍树，等一下'), false, 'a deferral is not an acceptance');
    assert.equal(ACCEPT_RE.test('箱子在哪儿？'), false, 'a question is not an acceptance');
    assert.equal(ACCEPT_RE.test(''), false);
});

test('the promise carries what the owner asked and how late it is', () => {
    const s = mk();
    const row = s.add({ text: '箱子里的铁锭帮我拿过来', who: 'JFors', at: T0 });
    assert.ok(row);
    assert.equal(row.status, 'open');
    const block = s.lines(T0 + 60_000)[0];
    assert.match(block, /【答应老大还没做完的事】/);
    assert.match(block, /箱子里的铁锭帮我拿过来/);
    assert.match(block, /答应于 16:00/);        // local clock, UTC+8 from T0
    assert.match(block, /你可以接着做、改期，或者跟老大说一声不做了/);
});

test('test bots never arm a promise, the real owner does', () => {
    const s = mk();
    assert.equal(isTestBot('HouseTest'), true);
    assert.equal(isTestBot('FakeOwner'), true);
    assert.equal(isTestBot('JFors'), false);
    assert.equal(s.add({ text: '帮我砍五根木头', who: 'FakeOwner', at: T0 }), null);
    assert.equal(s.add({ text: '帮我砍五根木头', who: 'HouseTest', at: T0 }), null);
    assert.ok(s.add({ text: '帮我砍五根木头', who: 'JFors', at: T0 }));
});

test('the same request twice in a row is one promise', () => {
    const s = mk();
    s.add({ text: '箱子里的铁锭帮我拿过来', who: 'JFors', at: T0 });
    assert.equal(s.add({ text: '箱子里的铁锭帮我拿过来', who: 'JFors', at: T0 + 5000 }), null);
    assert.equal(s.open(T0 + 5000).length, 1);
});

test('she closes it herself, with done or dropped + reason', () => {
    const s = mk();
    s.add({ text: '箱子里的铁锭帮我拿过来', who: 'JFors', at: T0 });
    const done = s.close({ match: '铁锭', at: T0 + 60_000 });
    assert.equal(done.status, 'done');
    assert.equal(s.open(T0 + 60_000).length, 0);

    s.add({ text: '帮我砍五根橡木', who: 'JFors', at: T0 });
    const dropped = s.close({ match: '橡木', status: 'dropped', reason: '天黑了先回家', at: T0 + 90_000 });
    assert.equal(dropped.status, 'dropped');
    assert.equal(dropped.reason, '天黑了先回家');
    assert.equal(s.open(T0 + 90_000).length, 0);
});

test('30 minutes closes it with a note, and nothing is auto-completed', () => {
    const s = mk();
    s.add({ text: '箱子里的铁锭帮我拿过来', who: 'JFors', at: T0 });
    assert.equal(s.lines(T0 + PROMISE_TTL_MS - 1000).length, 1, 'still shown just before the deadline');
    assert.equal(s.lines(T0 + PROMISE_TTL_MS + 1000).length, 0, 'gone after it');
    const n = s.expire(T0 + PROMISE_TTL_MS + 2000);
    assert.equal(n, 1);
    const disk = fs.readFileSync(s.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const expired = disk.find((r) => r.status === 'expired');
    assert.match(expired.note, /过了30分钟没做，已从清单移除/);
    // nothing was marked done: a missed promise is not a completed one
    assert.equal(disk.some((r) => r.status === 'done'), false);
});

test('the live list is a replay, so history is never rewritten', () => {
    const s = mk();
    s.add({ text: '帮我挖六块泥土', who: 'JFors', at: T0 });
    s.close({ match: '泥土', at: T0 + 1000 });
    const reloaded = new PromiseStore(s.file);
    assert.equal(reloaded.open(T0 + 2000).length, 0, 'a closed promise stays closed after reload');
    assert.equal(reloaded.rows.length, 2, 'both lines are on disk');
});

test('the prompt block is empty when nothing is open', () => {
    const s = mk();
    assert.deepEqual(s.lines(T0), []);
});
