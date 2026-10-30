// D1 gap 3 (#3315) tests: goals carry a world, are marked in the prompt, can be archived, and a lesson that blames a mob
// she never met today gets annotated without her words being touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryS } from './index.js';

const T0 = 1_800_000_000_000;
const RAW_DAY = new Date(T0).toISOString().slice(0, 10);   // raw files are named by date, not by game day
const mk = () => new MemoryS({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsgoals-')), now: () => T0 });
const GOALS = '- 家周围修挡箭墙（进行中）\n- 集中收好钻石镐贵重物（未开始）\n';

test('goals written by the dawn carry the current world', () => {
    const m = mk();
    m.setWorld('name:A', {});
    m.setGoals(GOALS);
    assert.equal(m.goalWorld('家周围修挡箭墙'), 'name:A');
});

test('after a switch the old goals are marked in the prompt, not hidden', () => {
    const m = mk();
    m.setWorld('name:A', {});
    m.setGoals(GOALS);
    m.setWorld('name:B', {});
    const prompt = m.promptBlock({ query: null });
    assert.match(prompt, /家周围修挡箭墙/);
    assert.match(prompt, /旧世界/);
    assert.equal(m.goalWorld('家周围修挡箭墙'), 'name:A');
});

test('old goals appear in the triage batch as their own kind', () => {
    const m = mk();
    m.setWorld('name:A', {});
    m.setGoals(GOALS);
    m.setWorld('name:B', {});
    const batch = m.showWorldBatch(1);
    assert.ok(batch.items.some((i) => i.kind === 'goal'), 'a goal is offered');
});

test('she can put an old goal away and it leaves the readable list', () => {
    const m = mk();
    m.setWorld('name:A', {});
    m.setGoals(GOALS);
    m.setWorld('name:B', {});
    const res = m.archiveWorldRows('挡箭墙', { confirm: true });
    assert.equal(res.ok, true);
    const md = fs.readFileSync(path.join(m.dir, 'goals.md'), 'utf8');
    assert.equal(md.includes('挡箭墙'), false, 'the archived goal is gone from her list');
    assert.match(md, /钻石镐/, 'the other goal stays');
});

test('a lesson naming a mob she never met is annotated, and the lesson survives verbatim', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsmob3-'));
    fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'raw', RAW_DAY + '.jsonl'), JSON.stringify({ type: 'death', cause: 'was blown up by Creeper', at: T0 }) + '\n');
    const m = new MemoryS({ dir, now: () => T0 });
    m.setWorld('seed:x', {});
    const ask = async () => '① 关于我自己：我在地下挖矿。\n② 今天的日记：被炸了一次。\n③ 今天学到的教训：\n- last_death_position(-13,43,-5)附近有掠夺者转悠，暂时别去。\n④ 长远想做的事：\n- 挖到铁（进行中）\nFACTS:\n- 地点：那里有掠夺者';
    return m.nightlyConsolidate(ask, { now: T0 }).then(() => {
        const insights = m.insights(3).join('\n');
        assert.match(insights, /掠夺者/, 'her lesson text is kept');
        assert.match(insights, /今天没遇到过掠夺者/, 'and the note says she never met one today');
        const facts = m.taughtFacts().map((f) => f.what).join('\n');
        assert.match(facts, /今天没遇到过掠夺者/);
    });
});

test('a lesson naming a mob she did meet gets no note', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsmob4-'));
    fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'raw', RAW_DAY + '.jsonl'), JSON.stringify({ type: 'death', cause: 'was slain by Zombie', at: T0 }) + '\n');
    const m = new MemoryS({ dir, now: () => T0 });
    m.setWorld('seed:x', {});
    const ask = async () => '① 关于我自己：小心。\n② 今天的日记：被僵尸打了。\n③ 今天学到的教训：\n- 僵尸在夜里很凶。\n④ 长远想做的事：\n- 挖到铁（进行中）\nFACTS:\n- 我：夜里要小心';
    return m.nightlyConsolidate(ask, { now: T0 }).then(() => {
        const insights = m.insights(3).join('\n');
        assert.equal(/今天没遇到过僵尸/.test(insights), false);
    });
});

test('the facts block lists the mobs met today', () => {
    const m = mk();
    const block = m._factsBlock({ day: 39, inventory: [], places: [], pos: null, mobs: ['僵尸', '苦力怕'] });
    assert.match(block, /今天在这个世界真正遇到的生物：僵尸、苦力怕/);
});
