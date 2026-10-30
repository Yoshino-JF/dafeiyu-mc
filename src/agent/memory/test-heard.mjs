// Tests for the R1 fix: she does not take notes on purpose, she just hears, and the nightly pass keeps what mattered.
// The live scenario (run19): JFors mentions a village with a smithy ~50 blocks east; 2.5 minutes later he asks where to
// get iron and she answers from the 15-message short-term window. With a longer gap that window is gone, so the fact has
// to come back out of memory instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryS } from './index.js';
import { HeardStore } from './heard.js';

const T0 = Date.UTC(2026, 9, 24, 19, 0, 0);
const HOUR = 3600_000;
const mk = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsmem3-'));
    return { dir, m: new MemoryS({ dir, now: () => T0 }) };
};

test('a line heard three days ago still comes back when the question is about it', () => {
    const { m } = mk();
    m.noteHeard({ who: 'JFors', text: '往东走大概五十格有个村庄，村里有铁匠铺，以后要铁可以去那边看看', at: T0 - 3 * 24 * HOUR });
    m.noteHeard({ who: 'JFors', text: '今天天气不错', at: T0 - 3 * 24 * HOUR + 60_000 });
    const hits = m.recall('我们缺铁了，你说去哪儿能弄到铁？', 3);
    assert.ok(hits.length > 0, 'a heard line was recalled');
    assert.equal(hits[0].type, 'heard');
    assert.match(hits[0].text, /铁匠铺/);
});

test('heard lines are uncapped and never evicted', () => {
    const { m, dir } = mk();
    for (let i = 0; i < 3000; i++) m.noteHeard({ who: 'JFors', text: `第${i}句话`, at: T0 - (3000 - i) * 1000 });
    assert.equal(m.heardLines(5).length, 5);
    const file = fs.readFileSync(path.join(dir, 'heard.jsonl'), 'utf8').trim().split('\n');
    assert.equal(file.length, 3000, 'every heard line is still on disk');
    // A query identical to a stored line is deliberately excluded, so ask with a partial phrase.
    assert.match(m.recall('第1句')[0].text, /第1句话/);
});

test('the same line repeated within a minute is one row, so double delivery cannot bloat the transcript', () => {
    const { m } = mk();
    m.noteHeard({ who: 'JFors', text: '过来', at: T0 });
    m.noteHeard({ who: 'JFors', text: '过来', at: T0 + 5_000 });
    m.noteHeard({ who: 'JFors', text: '过来', at: T0 + 90_000 });
    assert.equal(m.heardLines(10).length, 2);
});

test('nightly consolidation promotes the facts she picks into the never-dropped store', async () => {
    const { m } = mk();
    m.noteHeard({ who: 'JFors', text: '往东五十格有村庄，村里有铁匠铺，要铁去那边', at: T0 - HOUR });
    m.noteHeard({ who: 'JFors', text: '晚上别在外面待着', at: T0 - HOUR });
    const ask = async (prompt) => {
        assert.match(prompt, /铁匠铺/, 'the heard transcript reached the model');
        return [
            '① 我知道东边五十格有村庄，村里有铁匠铺。',
            '',
            '② 今天有人告诉我铁匠铺在哪，我记下了。',
            '',
            'FACTS:',
            '- JFors：东边约五十格有村庄，村里有铁匠铺，要铁去那边',
            '- JFors：晚上别在外面待着'
        ].join('\n');
    };
    const res = await m.nightlyConsolidate(ask);
    assert.equal(res.ok, true);
    assert.equal(res.promoted.length, 2, 'both facts were promoted');
    assert.equal(m.taughtFacts().length, 2);
    assert.equal(m.taughtFacts()[0].source, 'consolidate');
    assert.match(fs.readFileSync(path.join(m.dir, 'self.md'), 'utf8'), /铁匠铺/, 'self text kept');
    assert.doesNotMatch(m.readStory(1), /FACTS:/, 'the FACTS block never leaks into her diary');
});

test('a night with no facts changes nothing but still writes the diary', async () => {
    const { m } = mk();
    const ask = async () => '① 我还是老样子。\n\n② 今天没发生什么事。\n\nFACTS: 无';
    const res = await m.nightlyConsolidate(ask);
    assert.deepEqual(res.promoted, []);
    assert.equal(m.taughtFacts().length, 0);
    assert.match(m.readStory(1), /没发生什么事/);
});

test('promoting the same fact twice does not duplicate it', async () => {
    const { m } = mk();
    m.rememberTaught({ who: 'JFors', what: '床放在屋里' });
    const ask = async () => '① 同上。\n\n② 同上。\n\nFACTS:\n- JFors：床放在屋里';
    const res = await m.nightlyConsolidate(ask);
    assert.deepEqual(res.promoted, []);
    assert.equal(m.taughtFacts().length, 1);
});

test('promotion is capped so one chatty night cannot dump fifty rows', async () => {
    const { m } = mk();
    const lines = Array.from({ length: 20 }, (_, i) => `- JFors：事实${i}`).join('\n');
    const res = await m.nightlyConsolidate(async () => `① a\n\n② b\n\nFACTS:\n${lines}`);
    assert.equal(res.promoted.length, 5);
});

test('the heard store is a readable append-only file', () => {
    const { dir } = mk();
    const store = new HeardStore(path.join(dir, 'heard.jsonl'));
    store.add({ who: 'JFors', text: '村庄在东边', at: T0 });
    const row = JSON.parse(fs.readFileSync(path.join(dir, 'heard.jsonl'), 'utf8').trim());
    assert.equal(row.who, 'JFors');
    assert.equal(row.text, '村庄在东边');
    assert.equal(row.at, T0);
});

// ── run20 bug: the question itself ranked first (heard:0 = 87, the real fact = 29) ────────────────
test('the line she is answering right now never outranks the fact it asks about', () => {
    const { m } = mk();
    m.rememberTaught({ who: 'JFors', what: '钻石藏在出生点旁边最高的白桦树底下，埋三格', at: T0 - 20 * 60_000 });
    m.noteHeard({ who: 'JFors', text: '我之前跟你说钻石藏哪儿了来着？', at: T0 - 5_000 });   // the question, 5 s ago
    const hits = m.recall('我之前跟你说钻石藏哪儿了来着？', 3);
    assert.ok(hits.length > 0, 'the taught fact came back');
    assert.equal(hits[0].type, 'taught', 'the fact outranks the question');
    assert.match(hits[0].text, /白桦树/);
    assert.ok(!hits.some((h) => h.type === 'heard' && /藏哪儿了来着/.test(h.text)), 'the question itself is gone');
});

test('the same question text is skipped however old it is', () => {
    const { m } = mk();
    m.noteHeard({ who: 'JFors', text: '铁在哪？', at: T0 - 3 * 24 * HOUR });
    assert.deepEqual(m.recall('铁在哪？'), [], 'a line identical to the query is never context');
});

test('a fact heard 30 s ago is skipped (it is still in the message window), but the same fact heard 2 min ago is used', () => {
    const { m } = mk();
    m.noteHeard({ who: 'JFors', text: '村庄在东边五十格', at: T0 - 30_000 });
    assert.equal(m.recall('村庄在哪边').filter((h) => h.type === 'heard').length, 0);
    m.noteHeard({ who: 'JFors', text: '村庄在东边五十格', at: T0 - 120_000 });
    assert.equal(m.recall('村庄在哪边').filter((h) => h.type === 'heard').length, 1);
});

test('excludeRecentMs can be turned off explicitly when a caller wants the raw view', () => {
    const { m } = mk();
    m.noteHeard({ who: 'JFors', text: '村庄在东边五十格', at: T0 - 5_000 });
    assert.equal(m.recall('村庄在哪边', 3, { excludeRecentMs: 0 }).filter((h) => h.type === 'heard').length, 1);
});
