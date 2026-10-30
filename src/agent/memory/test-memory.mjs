// Tests for Memory S. Run: node --test src/agent/memory/test-memory.mjs
// The fixtures are real conversation lines taken from the run that produced logs/agent.ndjson, so a shape change in the
// harness shows up here first rather than in the morning report.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryS, CAPS } from './index.js';

const T0 = Date.UTC(2026, 9, 24, 17, 0, 0);   // 2026-10-24T17:00:00Z
const mk = (now = () => T0) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsmem-'));
    return { m: new MemoryS({ dir, now }), dir };
};

test('a failure writes exactly one lesson line, and the same failure within 5 minutes is not repeated', () => {
    const { m } = mk();
    const first = m.noteFailure({ kind: 'mine', reason: 'no_path', args: { x: 1, y: 2, z: 3 } });
    assert.match(first, /mine → no_path/);
    const again = m.noteFailure({ kind: 'mine', reason: 'no_path', args: { x: 1, y: 2, z: 3 }, at: T0 + 60_000 });
    assert.equal(again, null, 'same failure inside the dedupe window must not pile up');
    const later = m.noteFailure({ kind: 'mine', reason: 'no_path', args: { x: 1, y: 2, z: 3 }, at: T0 + 6 * 60_000 });
    assert.ok(later, 'outside the window it is recorded again');
    assert.equal(m.lessons(10).length, 2);
});

test('lessons are capped and the oldest are dropped, not the newest', () => {
    const { m } = mk();
    for (let i = 0; i < 200; i++) {
        m.noteFailure({ kind: `k${i}`, reason: 'blocked', args: { i }, at: T0 + i * 10 * 60_000 });
    }
    const file = fs.readFileSync(path.join(m.dir, 'lessons.md'), 'utf8');
    assert.ok(file.length <= CAPS.lessons + 200, `lessons.md stayed near its cap (${file.length})`);
    assert.match(file, /older entries dropped/);
    const newest = m.lessons(1)[0];
    assert.match(newest, /k199/, 'the newest lesson survives');
});

test('a place can be found by name, and re-saving the same name replaces it', () => {
    const { m } = mk();
    m.appendPlace('家', { x: 42, y: 65, z: -18 });
    assert.deepEqual(m.place('家'), { x: 42, y: 65, z: -18 });
    m.appendPlace('家', { x: 43, y: 66, z: -19 });
    assert.deepEqual(m.place('家'), { x: 43, y: 66, z: -19 });
    assert.equal(fs.readFileSync(path.join(m.dir, 'places.md'), 'utf8').match(/家/g).length, 1);
    assert.equal(m.place('矿洞'), null);
});

test('the prompt block carries her own writing, her places and the newest lessons', () => {
    const { m } = mk();
    m.setSelf('我爱偷吃点心，怕黑。');
    m.setGoals('攒三个铁锭做镐。');
    m.setPeople('老大喜欢我先说结论。');
    m.appendPlace('村庄', { x: 10, y: 64, z: 10 });
    m.noteFailure({ kind: 'attack', reason: 'blocked', args: { entity: 'skeleton' } });
    const block = m.promptBlock();
    for (const needle of ['偷吃点心', '铁锭', '先说结论', '村庄', 'attack → blocked']) {
        assert.ok(block.includes(needle), `prompt block should mention ${needle}`);
    }
});

test('the prompt block is bounded and drops technique before identity', () => {
    const { m } = mk();
    m.setSelf('我是大肥鱼。'.repeat(50));
    for (let i = 0; i < 60; i++) m.noteFailure({ kind: 'k' + i, reason: 'blocked', args: { i }, at: T0 + i * 10 * 60_000 });
    const block = m.promptBlock();
    assert.ok(block.length <= CAPS.prompt, `block ${block.length} > cap ${CAPS.prompt}`);
    assert.ok(block.includes('大肥鱼'), 'identity is the last thing to be cut');
});

test('nightly consolidation asks once, splits into self and diary, and advances the day', () => {
    const { m } = mk();
    m.noteFailure({ kind: 'mine', reason: 'no_path', args: {} });
    let asked = 0;
    const ask = async (prompt) => {
        asked++;
        assert.match(prompt, /mine/);
        return '① 我知道茂密林子里直着走会卡住，要先走到开阔地。\n\n② 今天在树林里绕了很久，最后捡到几个苹果。';
    };
    return m.nightlyConsolidate(ask).then((res) => {
        assert.equal(asked, 1, 'exactly one model call per night');
        assert.equal(res.ok, true);
        assert.equal(m.day(), 2);
        assert.match(fs.readFileSync(path.join(m.dir, 'self.md'), 'utf8'), /茂密林子/);
        assert.match(m.readStory(1), /苹果/);
    });
});

test('a silent model leaves memory untouched and does not advance the day', async () => {
    const { m } = mk();
    m.setSelf('原样');
    const res = await m.nightlyConsolidate(async () => '');
    assert.equal(res.ok, false);
    assert.equal(m.day(), 1);
    assert.equal(fs.readFileSync(path.join(m.dir, 'self.md'), 'utf8'), '原样');
});

test('her diary and the machine raw log land in different files', () => {
    const { m, dir } = mk();
    m.writeStory('今天我捡了木头。');
    m.raw({ type: 'act', kind: 'mine', ok: true, at: T0 });
    assert.ok(fs.existsSync(path.join(dir, 'story', 'day-001.md')));
    assert.ok(fs.existsSync(path.join(dir, 'raw', `${new Date(T0).toISOString().slice(0, 10)}.jsonl`)));
    assert.notEqual(path.join(dir, 'story', 'day-001.md'), path.join(dir, 'raw', 'x.jsonl'));
});

test('spoken-line counters feed the canned share metric', () => {
    const { m } = mk();
    m.noteSaid('不是大肥鱼……', { canned: true });
    m.noteSaid('我在挖石头呢');
    assert.deepEqual(m.state.said, { total: 2, canned: 1 });
    m.noteOpUse('unstuck');
    m.noteOpUse('unstuck');
    assert.equal(m.state.opUses.unstuck, 2);
});
