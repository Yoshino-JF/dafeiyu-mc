// R2/R4: her OWN lessons and long-term goals, produced by the dawn consolidation.
// The stub answers are shaped the way the real model answered in run20 (Chinese, ①②③④ + a FACTS block).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryS } from './index.js';

const T0 = Date.UTC(2026, 9, 24, 20, 0, 0);
const mk = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsmem4-'));
    return { dir, m: new MemoryS({ dir, now: () => T0 }) };
};

const FULL = [
    '① 我知道白桦林夜里不安全，背后常有僵尸。',
    '',
    '② 今天在林子边挖了很久，天黑前躲进了洞里，没死。',
    '',
    '③ 今天学到的教训：',
    '- 夜里别在白桦林乱挖，背后常有僵尸',
    '- 天黑要躲进封闭空间，不要在半坡上停下',
    '',
    '④ 长远想做的事：',
    '- 攒够铁做一把铁镐（进行中）',
    '- 在出生点附近盖一间有床的屋子（未开始）',
    '- 找到村庄的铁匠铺（做到了）',
    '',
    'FACTS:',
    '- JFors：村庄在东边约五十格，有铁匠铺'
].join('\n');

test('dawn writes her own lessons apart from the machine lines', async () => {
    const { m } = mk();
    m.noteFailure({ kind: 'mine', reason: 'no_path', args: {} });
    const res = await m.nightlyConsolidate(async () => FULL);
    assert.equal(res.ok, true);
    assert.equal(res.insights, 2);
    const own = fs.readFileSync(path.join(m.dir, 'insights.md'), 'utf8');
    assert.match(own, /夜里别在白桦林乱挖/);
    assert.match(own, /^## day 1/m);
    const machine = fs.readFileSync(path.join(m.dir, 'lessons.md'), 'utf8');
    assert.match(machine, /mine → no_path/, 'the machine evidence is still its own file');
    assert.doesNotMatch(machine, /白桦林/, 'her sentence never lands in the machine file');
});

test('long-term goals land in goals.md with only the three allowed statuses', async () => {
    const { m } = mk();
    const res = await m.nightlyConsolidate(async () => FULL);
    assert.equal(res.goals, 3);
    assert.equal(res.goalsDone, 1);
    const goals = m.readGoals();
    assert.match(goals, /铁镐（进行中）/);
    assert.match(goals, /屋子（未开始）/);
    assert.match(goals, /铁匠铺（做到了）/);
    assert.equal(goals.trim().split('\n').length, 3);
});

test('the prompt puts her own lessons before the machine lines', async () => {
    const { m } = mk();
    await m.nightlyConsolidate(async () => FULL);
    m.noteFailure({ kind: 'place', reason: 'protected', args: {} });
    const block = m.promptBlock();
    const ownAt = block.indexOf('她自己总结的');
    const machineAt = block.indexOf('机器记录下来的事实');
    assert.ok(ownAt > 0 && machineAt > ownAt, 'her summary comes first, evidence second');
    assert.match(block.slice(ownAt), /白桦林/);
});

test('the counters for R2 and R4 move per day', async () => {
    const { m } = mk();
    await m.nightlyConsolidate(async () => FULL);
    const s1 = m.stats();
    assert.equal(s1.insightsByDay[1], 2);
    assert.equal(s1.goalsDoneByDay[1], 1);
    assert.equal(s1.goalsDoneTotal, 1);
    // second night: one new lesson, no goal reached
    const second = '① 同上。\n\n② 今天没死。\n\n③ 教训：\n- 别在雷雨天待在高处\n\n④ 目标：\n- 攒铁（进行中）';
    await m.nightlyConsolidate(async () => second);
    const s2 = m.stats();
    assert.equal(s2.insightsByDay[2], 1);
    assert.equal(s2.goalsDoneByDay[2], 0);
    assert.equal(s2.goalsDoneTotal, 1, 'a goal reached yesterday still counts once');
});

test('a night with only ① and ② still works and changes nothing about goals', async () => {
    const { m } = mk();
    m.setGoals('- 旧目标（进行中）');
    const res = await m.nightlyConsolidate(async () => '① 我还是老样子。\n\n② 今天没什么事。');
    assert.equal(res.insights, 0);
    assert.equal(res.goals, 0);
    assert.match(m.readGoals(), /旧目标/, 'goals are untouched when she wrote none');
    assert.equal(m.day(), 2);
});

test('her lessons are capped at three and newest survive', async () => {
    const { m } = mk();
    const many = ['① a', '', '② b', '', '③ 教训：', '- 一', '- 二', '- 三', '- 四', '- 五'].join('\n');
    const res = await m.nightlyConsolidate(async () => many);
    assert.equal(res.insights, 3);
    assert.match(fs.readFileSync(path.join(m.dir, 'insights.md'), 'utf8'), /- 一[\s\S]*- 三/);
});

test('an unknown status falls back to 未开始 instead of inventing a fourth state', () => {
    assert.deepEqual(MemoryS.parseGoal('挖到钻石（大概吧）'), { text: '挖到钻石（大概吧）', status: null });
    assert.deepEqual(MemoryS.parseGoal('- 挖到钻石（进行中）'), { text: '挖到钻石', status: '进行中' });
});

// ── #2997: insights.md is her record, not a cache: append-only, newest shown, old ones recalled ──────
test('insights are never dropped: 40 lessons over 20 days all stay on disk', async () => {
    const { m, dir } = mk();
    for (let day = 1; day <= 20; day++) {
        const body = ['① a', '② b', '③ 教训：', `- 第${day}天的教训甲`, `- 第${day}天的教训乙`].join('\n');
        await m.nightlyConsolidate(async () => body);
    }
    const file = fs.readFileSync(path.join(dir, 'insights.md'), 'utf8');
    const bullets = file.split('\n').filter((l) => l.startsWith('- '));
    assert.equal(bullets.length, 40, 'nothing was trimmed');
    assert.doesNotMatch(file, /dropped/, 'no drop marker, because nothing is dropped');
    assert.match(file, /第1天的教训甲/, 'the very first lesson is still there');
    assert.equal(m.stats().insightsTotal, 40);
});

test('the prompt shows the newest few, and recall can bring back an old one', async () => {
    const { m } = mk();
    const first = ['① a', '② b', '③ 教训：', '- 沼沢边上不要过夜，史莱姆会围过来', '- 白天砍树先看头顶有没有沙'].join('\n');
    await m.nightlyConsolidate(async () => first);
    for (let day = 2; day <= 5; day++) {
        await m.nightlyConsolidate(async () => ['① a', '② b', '③ 教训：', `- 第${day}天的琐事`, `- 第${day}天的琐事二`, '- 第三条'].join('\n'));
    }
    const newest = m.insights(3);
    assert.equal(newest.length, 3);
    assert.ok(newest.every((l) => !/沼沢/.test(l)), 'the newest three are the recent ones');
    const hits = m.recall('史莱姆', 3);
    assert.ok(hits.some((h) => h.type === 'insight' && /沼沢/.test(h.text)), 'an old lesson comes back by topic');
    const block = m.promptBlock({ query: '史莱姆' });
    assert.match(block, /沼沢/, 'the recalled old lesson reaches the prompt');
});
