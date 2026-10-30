// Tests for the new-world counters (Claude #3706). The point of these is that every number the owner asked for has a
// definition someone can re-run, and that the two easy ways to be wrong are locked out:
//   (a) reading only one raw file, so a death that crosses midnight disappears;
//   (b) mixing two code versions into one "eat" or "combat" number.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    boatActs, classifyWouldSpeak, deathDayNight, foodSources, hunting, oldWorldEntries,
    readRawDeaths, sleepStats, witchChoices, wouldSpeakLines
} from '../../../dev/newworld-report.mjs';

const T0 = Date.parse('2026-10-27T20:00:00+08:00');
const MIN = 60000;

test('raw reader takes every date file, because a night can span two UTC dates', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-'));
    const day1 = Date.parse('2026-10-27T23:50:00+08:00');
    const day2 = Date.parse('2026-10-28T00:20:00+08:00');
    fs.writeFileSync(path.join(dir, '2026-10-27.jsonl'), JSON.stringify({ type: 'death', at: day1, cause: 'was slain by Zombie' }) + '\n');
    fs.writeFileSync(path.join(dir, '2026-10-28.jsonl'), JSON.stringify({ type: 'death', at: day2, cause: 'was shot by Skeleton' }) + '\n');
    const out = readRawDeaths(dir);
    assert.equal(out.files.length, 2);
    assert.equal(out.deaths.length, 2, 'both files must be read, or the midnight death vanishes');
});

test('a torn last line does not lose the rest of the raw file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-'));
    fs.writeFileSync(path.join(dir, '2026-10-27.jsonl'),
        JSON.stringify({ type: 'death', at: T0, cause: 'creeper' }) + '\n' + '{"type":"death","at":');
    const out = readRawDeaths(dir);
    assert.equal(out.deaths.length, 1);
});

test('eat separare ok from failed, and keep the item names', () => {
    const acts = [
        { tag: 'act', kind: 'eat', at: T0, ok: true, args: { itemName: 'cooked_cod' } },
        { tag: 'act', kind: 'eat', at: T0 + MIN, ok: false, reason: 'timeout', args: { itemName: 'brown_mushroom' } },
        { tag: 'act', kind: 'eat', at: T0 + 2 * MIN, ok: true, args: { itemName: 'cooked_cod' } }
    ];
    const f = foodSources(acts);
    assert.equal(f.eat.n, 3);
    assert.equal(f.eat.ok, 2);
    assert.equal(f.eat.byItem.cooked_cod.n, 2);
    assert.equal(f.eat.byItem.brown_mushroom.ok, 0);
});

test('fishing reports casts, catches and the reels that were never classified', () => {
    const acts = [
        { tag: 'act', kind: 'fish', at: T0, casts: 3, caught: 3, noBite: 0, dry: 0, empty: 0 },
        { tag: 'act', kind: 'fish', at: T0 + MIN, casts: 3, caught: 0, noBite: 2, dry: 0, empty: 3 }
    ];
    const f = foodSources(acts);
    assert.equal(f.fish.casts, 6);
    assert.equal(f.fish.caught, 3);
    assert.equal(f.fish.noBite, 2);
    assert.equal(f.fish.unclassified, 1, 'one reel is neither a bite nor dry and must be shown, not dropped');
});

test('planting is detected from the seedType on use, not from a guess', () => {
    const acts = [
        { tag: 'act', kind: 'use', at: T0, args: { x: 1, y: 2, z: 3, seedType: 'wheat_seeds' } },
        { tag: 'act', kind: 'place', at: T0 + MIN, args: { blockType: 'oak_sapling' } },
        { tag: 'act', kind: 'goto', at: T0 + 2 * MIN, args: { x: 0, z: 0 } }
    ];
    const f = foodSources(acts);
    assert.equal(f.planted.n, 2);
    assert.equal(f.planted.bySeed.wheat_seeds, 1);
    assert.equal(f.planted.bySeed.oak_sapling, 1);
});

test('hunting counts only passive mobs, hostile kills are combat', () => {
    const combats = [
        { tag: 'combat', at: T0, result: 'killed', target: { name: 'chicken' } },
        { tag: 'combat', at: T0 + MIN, result: 'killed', target: { name: 'zombie' } },
        { tag: 'combat', at: T0 + 2 * MIN, result: 'disengaged', target: { name: 'cow' } }
    ];
    const h = hunting(combats);
    assert.equal(h.n, 1);
    assert.equal(h.byMob.chicken, 1);
});

test('death day/night borrows isNight when it is close, and says unknown when it is not', () => {
    const deaths = [{ at: T0, cause: 'zombie' }, { at: T0 + 10 * MIN, cause: 'skeleton' }];
    const combats = [{ tag: 'combat', at: T0 + 5000, isNight: true }, { tag: 'combat', at: T0 + 10 * MIN + 5 * MIN, isNight: false }];
    const out = deathDayNight(deaths, combats);
    assert.equal(out[0].night, true);
    assert.equal(out[0].evidenceGapMs, 5000);
    assert.equal(out[1].night, null, 'a fact five minutes away must not be borrowed');
});

test('boat detection says which rule matched, and that it matched nothing', () => {
    assert.equal(boatActs([]).detected, 'none');
    assert.equal(boatActs([{ tag: 'act', kind: 'place', at: T0, args: { blockType: 'oak_boat' } }]).detected, 'item');
    assert.equal(boatActs([{ tag: 'act', kind: 'boat_ride', at: T0 }]).detected, 'kind');
});

test('sleep counts successes and keeps the rejection reasons apart', () => {
    const s = sleepStats([
        { tag: 'act', kind: 'sleep', at: T0, ok: true },
        { tag: 'act', kind: 'sleep', at: T0 + MIN, ok: false, reason: 'blocked' },
        { tag: 'act', kind: 'sleep', at: T0 + 2 * MIN, ok: false, reason: 'not_found' }
    ]);
    assert.equal(s.n, 3);
    assert.equal(s.ok, 1);
    assert.equal(s.reasons.blocked, 1);
    assert.equal(s.reasons.not_found, 1);
});

test('the witch prompt is joined to what she did in the next minute', () => {
    const notices = [{ tag: 'decision', gate: 'danger', at: T0, why: '女巫在 12 格外投药水' }];
    const acts = [
        { tag: 'act', kind: 'goto', at: T0 + 3000 },
        { tag: 'act', kind: 'retreat', at: T0 + 5000 },
        { tag: 'act', kind: 'chat', at: T0 + 6000, args: { text: '先拉开距离' } },
        { tag: 'act', kind: 'mine', at: T0 + 5 * MIN }
    ];
    const out = witchChoices(notices, acts, acts.filter((a) => a.kind === 'chat'));
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].firstActions, ['goto', 'retreat']);
    assert.match(out[0].words[0], /拉开距离/);
});

test('old-world entries are listed with what followed them', () => {
    const events = [
        { tag: 'act', kind: 'chat', at: T0, args: { text: '这条（旧世界）记的是老家位置，没什么用了' } },
        { tag: 'act', kind: 'chest', at: T0 + 5000, args: { itemName: 'cobblestone', num: 8 } },
        { tag: 'act', kind: 'chat', at: T0 + 10 * MIN, args: { text: '普通一句话' } }
    ];
    const out = oldWorldEntries(events);
    assert.equal(out.length, 1);
    assert.equal(out[0].verdict, 'dropped-or-stored');
});

test('would-speak hygiene catches each of the four things the owner asked about', () => {
    assert.deepEqual(classifyWouldSpeak('我把门口的石头补上了。').problems, []);
    assert.ok(classifyWouldSpeak('!fight(zombie) 先打它').problems.includes('bang-command'));
    assert.ok(classifyWouldSpeak('**重要**：先撤回去').problems.includes('markup'));
    assert.ok(classifyWouldSpeak('```js\nconst x = 1;\n```').problems.includes('code'));
    assert.ok(classifyWouldSpeak('I think we should go back to the base now.').problems.includes('english-sentence'));
});

test('a would-speak line with several problems reports all of them', () => {
    const rows = wouldSpeakLines([{ tag: 'would-speak', at: T0, text: '!goto(1,2,3) **向前** Go north now please' }]);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].problems.sort(), ['bang-command', 'english-sentence', 'markup']);
});
