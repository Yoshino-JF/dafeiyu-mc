// Regressions for the style metrics (#3334/#3369/#3380). Each test pins a rule that would otherwise be quietly broken:
// small samples must refuse to compare, refusals are not encounters, a kite pair is one adjustment, and a reflex fight is
// not hers to tune.
import test from 'node:test';
import assert from 'node:assert/strict';
import { styleSlice, cellKey, groupCells, initiativeByDay, strikeComparison, beforeAfterChange, oscillation, convergenceByDay } from '../../../dev/fight-style-metrics.mjs';

const T = 1_800_000_000_000;
const day = 86_400_000;
const rec = (o = {}) => ({
    at: T, caller: 'her', target: { name: 'zombie', id: 1 }, tactic: 'melee', result: 'killed',
    hits: 6, swings: 8, startHp: 18, endHp: 13, damageTaken: 5, seconds: 10,
    armed: true, weapon: 'iron_sword', hadFood: true, hostileCount: 1,
    dimension: 'overworld', startY: 64, isNight: false,
    styleVersion: 1, style: { tactic: 'melee', approachTo: 2.5, cadence: 1, disengageHp: 10, loot: true },
    hurtBeforeStart: 0, openingDistance: 6, firstHurtMs: 4000,
    ...o
});

test('only the fields that tactic uses are comparable', () => {
    assert.deepEqual(Object.keys(styleSlice(rec().style, 'melee')).sort(), ['approachTo', 'cadence', 'disengageHp', 'loot', 'tactic']);
    const kite = { tactic: 'kite', standoff: 8, retreatTo: 9, cadence: 1, approachTo: 2.5 };
    // kite also carries the break-off line and loot, which the engine does read for kiting
    assert.deepEqual(Object.keys(styleSlice(kite, 'kite')).sort(), ['cadence', 'disengageHp', 'loot', 'retreatTo', 'standoff', 'tactic']);
});

test('the reflex and her own fight never share a cell even with the same mob', () => {
    const mine = cellKey(rec());
    const reflex = cellKey(rec({ caller: 'self_defense', styleVersion: 'reflex', style: { tactic: 'melee', source: 'skills.defendSelf' } }));
    assert.notEqual(mine, reflex);
});

test('a cell reports medians, kill rate and first-strike share, and flags small samples', () => {
    const cells = groupCells([rec({ damageTaken: 4 }), rec({ damageTaken: 8 }), rec({ damageTaken: 12 })]);
    assert.equal(cells.length, 1);
    const c = cells[0];
    assert.equal(c.n, 3);
    assert.equal(c.damageMedian, 8);
    assert.equal(c.killRate, 100);
    assert.equal(c.hitRate, 75);
    assert.equal(c.small, false);
    assert.equal(groupCells([rec()])[0].small, true);
});

test('initiative is her share of all encounters, per game day', () => {
    const rows = initiativeByDay([
        rec({ at: T }),
        rec({ at: T + 1000 }),
        rec({ at: T + 2000, caller: 'self_defense', styleVersion: 'reflex' })
    ], (r) => (r.at < T + 1500 ? 41 : 42));
    assert.deepEqual(rows.map((r) => [r.day, r.her, r.reflex, r.initiativePct]), [[41, 2, 0, 100], [42, 0, 1, 0]]);
});

test('first strike versus reacting refuses to conclude below three samples', () => {
    const two = strikeComparison([rec({ hurtBeforeStart: 0 }), rec({ hurtBeforeStart: 3 })]);
    assert.equal(two.comparable, false);
    assert.match(two.note, /样本不足/);
    const six = strikeComparison([rec({ hurtBeforeStart: 0 }), rec({ hurtBeforeStart: 0 }), rec({ hurtBeforeStart: 0 }), rec({ hurtBeforeStart: 4 }), rec({ hurtBeforeStart: 5 }), rec({ hurtBeforeStart: 6 })]);
    assert.equal(six.comparable, true);
    assert.equal(six.firstStrike.n, 3);
    assert.equal(six.reacted.n, 3);
});

test('the strike comparison respects the strata (armed, one hostile, healthy)', () => {
    const out = strikeComparison([
        rec({ hurtBeforeStart: 0 }),
        rec({ hurtBeforeStart: 0, armed: false }),          // excluded: unarmed
        rec({ hurtBeforeStart: 0, hostileCount: 3 }),       // excluded: outnumbered
        rec({ hurtBeforeStart: 0, startHp: 9 })             // excluded: hurt already
    ]);
    assert.equal(out.firstStrike.n, 1);
});

test('before/after windows take the last 3 before and first 5 after', () => {
    const change = { at: T + 10 * day, day: 42, mob: 'zombie', key: 'cadence', from: 1, to: 0.7 };
    const records = [
        rec({ at: T + 8 * day, damageTaken: 4 }), rec({ at: T + 9 * day, damageTaken: 5 }), rec({ at: T + 9.5 * day, damageTaken: 6 }),
        rec({ at: T + 11 * day, damageTaken: 2 }), rec({ at: T + 11.5 * day, damageTaken: 3 })
    ];
    const ba = beforeAfterChange(change, records);
    assert.equal(ba.before.n, 3);
    assert.equal(ba.after.n, 2);
    assert.equal(ba.usable, false);
    assert.match(ba.note, /样本不足/);
});

test('a kite pair moving the same way counts as one adjustment, not two flip-flops', () => {
    const rows = oscillation([
        { day: 42, mob: 'creeper', key: 'standoff', from: 8, to: 9 },
        { day: 42, mob: 'creeper', key: 'retreatTo', from: 9, to: 10 }
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].adjustments, 1);
    assert.equal(rows[0].flipFlops, 0);
    assert.equal(rows[0].paired, true);
});

test('a kite pair moving opposite ways is genuine oscillation', () => {
    const rows = oscillation([
        { day: 42, mob: 'creeper', key: 'standoff', from: 8, to: 10 },
        { day: 42, mob: 'creeper', key: 'retreatTo', from: 12, to: 9 }
    ]);
    assert.equal(rows[0].flipFlops, 1);
});

test('independent settings count on their own', () => {
    const rows = oscillation([
        { day: 42, mob: 'zombie', key: 'cadence', from: 1, to: 0.7 },
        { day: 42, mob: 'zombie', key: 'cadence', from: 0.7, to: 1 },
        { day: 42, mob: 'zombie', key: 'disengageHp', from: 10, to: 12 }
    ]);
    assert.equal(rows[0].adjustments, 3);
    assert.equal(rows[0].flipFlops, 2);
});

test('convergence reports a per-day curve and never invents a day', () => {
    // records without a game day produce no row at all: nothing is attributed to a guessed day
    assert.equal(convergenceByDay([rec({ at: T }), rec({ at: T + day })], {}).length, 0);
    const rows = convergenceByDay([rec({ at: T, day: 41, damageTaken: 6 }), rec({ at: T + 1, day: 42, damageTaken: 2 }), rec({ at: T + 2, day: 42, damageTaken: 4 }), rec({ at: T + 3, day: 42, damageTaken: 8 })], {});
    assert.deepEqual(rows.map((r) => r.day), [41, 42]);
    assert.equal(rows[1].damageMedian, 4);
    assert.equal(rows[1].small, false);
});
