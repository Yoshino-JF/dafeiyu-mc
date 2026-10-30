// Tests for the three additions Claude asked for: taught facts never dropped, recall(query,k), rememberTaught.
// The scenario is the real one from PLAN S/R evidence item R1: the owner says something once and she must still have it days later.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryS } from './index.js';
import { tokenize, rank } from './recall.js';
import { TaughtStore } from './taught.js';

const T0 = Date.UTC(2026, 9, 24, 18, 0, 0);
const mk = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsmem2-'));
    return { dir, m: new MemoryS({ dir, now: () => T0 }) };
};

test('a taught fact survives 2000 later lessons: no cap, no eviction', () => {
    const { m, dir } = mk();
    m.rememberTaught({ who: 'JFors', what: '村庄西边的箱子是公共物资，可以随便拿' });
    for (let i = 0; i < 2000; i++) m.noteFailure({ kind: `k${i}`, reason: 'blocked', args: { i }, at: T0 + i * 60_000 });
    const file = fs.readFileSync(path.join(dir, 'taught.jsonl'), 'utf8');
    assert.equal(file.trim().split('\n').length, 1, 'the taught line is still the only taught line');
    assert.deepEqual(m.taughtFacts().map((r) => r.what), ['村庄西边的箱子是公共物资，可以随便拿']);
});

test('the same fact twice is one record; a different fact is two', () => {
    const { m } = mk();
    const a = m.rememberTaught({ who: 'JFors', what: '晚上别在外面待着' });
    const b = m.rememberTaught({ who: 'jfors', what: '  晚上别在外面待着 ' });
    assert.equal(b.duplicate, true);
    assert.equal(a.what, b.what);
    m.rememberTaught({ who: 'JFors', what: '下雨天不用浇水' });
    assert.equal(m.taughtFacts().length, 2);
});

test('recall picks the relevant taught fact out of many, and Chinese queries work', () => {
    const { m } = mk();
    m.rememberTaught({ who: 'JFors', what: '钻石在 Y 坐标 -58 附近最多' });
    m.rememberTaught({ who: 'JFors', what: '别去沼泽，那边晚上有史莱姆' });
    m.rememberTaught({ who: 'JFors', what: '公共箱子在村庄西边' });
    for (let i = 0; i < 50; i++) m.noteFailure({ kind: 'mine', reason: 'no_path', args: { i }, at: T0 - i * 60_000 });
    const hits = m.recall('我想去挖钻石，哪里多？', 3);
    assert.ok(hits.length > 0, 'something was recalled');
    assert.equal(hits[0].type, 'taught');
    assert.match(hits[0].text, /钻石/);
});

test('recall also finds lessons and places, and returns nothing for an unrelated question', () => {
    const { m } = mk();
    m.appendPlace('白桦林', { x: -120, y: 62, z: 140 });
    m.noteFailure({ kind: 'mine', reason: 'no_path', args: {} });
    assert.ok(m.recall('白桦林').some((h) => h.type === 'place'));
    assert.ok(m.recall('mine no_path').some((h) => h.type === 'lesson'));
    assert.deepEqual(m.recall('今天中午吃什么披萨'), []);
});

test('a query-aware prompt block carries the relevant memory and stays inside the cap', () => {
    const { m } = mk();
    m.setSelf('我是大肥鱼。'.repeat(40));
    m.rememberTaught({ who: 'JFors', what: '钻石在 Y -58 附近最多' });
    for (let i = 0; i < 100; i++) m.noteFailure({ kind: `k${i}`, reason: 'blocked', args: { i }, at: T0 + i * 60_000 });
    const block = m.promptBlock({ query: '挖钻石去哪' });
    assert.match(block, /钻石在 Y -58/, 'the relevant taught fact reached the prompt');
    assert.ok(block.length <= 12 * 1024 + 400, `block ${block.length} within budget`);
});

test('forget removes only what matches, and keeps a marker so the audit can tell told-to-forget from never-known', () => {
    const { m, dir } = mk();
    m.rememberTaught({ who: 'JFors', what: '钻石在 Y -58' });
    m.rememberTaught({ who: 'JFors', what: '别去沼泽' });
    assert.equal(m.forgetTaught('钻石'), 1);
    assert.deepEqual(m.taughtFacts().map((r) => r.what), ['别去沼泽']);
    assert.equal(m.recall('钻石').filter((h) => h.type === 'taught').length, 0);
    const lines = fs.readFileSync(path.join(dir, 'taught.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.forgotten === true), 'the forgotten row is still on disk');
});

test('the taught store is a plain append-only file a human can read', () => {
    const { dir } = mk();
    const store = new TaughtStore(path.join(dir, 'taught.jsonl'));
    store.remember({ who: 'JFors', what: '床放在屋里' });
    const line = fs.readFileSync(path.join(dir, 'taught.jsonl'), 'utf8').trim();
    const row = JSON.parse(line);
    assert.equal(row.who, 'JFors');
    assert.equal(row.what, '床放在屋里');
    assert.equal(typeof row.at, 'number');
});

test('tokenizer: chinese bigrams and latin words, punctuation dropped', () => {
    const t = tokenize('挖钻石 at Y=-58！');
    assert.ok(t.includes('挖钻'));
    assert.ok(t.includes('钻石'));
    assert.ok(t.includes('y'));
    assert.ok(!t.includes('！'));
});

test('rank is stable for empty input instead of throwing', () => {
    assert.deepEqual(rank('', [{ id: 'a', text: 'x', type: 'lesson' }]), []);
    assert.deepEqual(rank('钻石', []), []);
});
