// [combat] schema and metrics regressions (#3351). The purpose of these is not coverage for its own sake: each test pins a
// number that the owner will read, so a silent change in meaning shows up as a failure instead of a plausible report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCombatRecord, isValidCombatRecord, combatSummaryLine, REQUIRED } from './combat-record.mjs';
import { looksLikeFleeCase, looksLikeFightableNotice, summarise } from '../../../dev/combat-metrics.mjs';

const base = () => ({
    at: 1_800_000_000_000, caller: 'her', target: { name: 'zombie', id: 7 }, tactic: 'melee', result: 'killed',
    hits: 6, swings: 8, startHp: 18, endHp: 13, damageTaken: 5, seconds: 11,
    armed: true, weapon: 'stone_sword', hadFood: true, hostileCount: 1,
    dimension: 'overworld', startY: 64, isNight: false, styleVersion: 'v1', style: { zombie: { tactic: 'melee', standoff: 2 } }
});

test('a complete record normalises without problems and derives hit rate and hp delta', () => {
    const { ok, record, problems } = normalizeCombatRecord(base());
    assert.equal(ok, true);
    assert.deepEqual(problems, []);
    assert.equal(record.hitRate, 0.75);
    assert.equal(record.hpDelta, 5);
});

test('every required field is actually required', () => {
    for (const key of REQUIRED) {
        const raw = base();
        delete raw[key];
        const { ok, missing } = isValidCombatRecord(raw);
        assert.equal(ok, false, `${key} must be required`);
        assert.ok(missing.includes(key), `${key} reported missing`);
    }
});

test('a missing style snapshot is reported, not silently accepted', () => {
    const raw = base();
    delete raw.style;
    const { problems } = normalizeCombatRecord(raw);
    assert.ok(problems.some((p) => /style snapshot/.test(p)));
});

test('a missing styleVersion is reported because the snapshot cannot be attributed', () => {
    const raw = base();
    delete raw.styleVersion;
    const { problems, record } = normalizeCombatRecord(raw);
    assert.ok(problems.some((p) => /attribut/.test(p)));
    assert.equal(record.styleVersion, 'unknown');
});

test('bad enums fall back but are reported', () => {
    const { record, problems } = normalizeCombatRecord({ ...base(), result: 'won', caller: 'nobody', tactic: 'dance' });
    assert.equal(record.result, 'lost');
    assert.equal(record.caller, 'her');
    assert.equal(record.tactic, 'melee');
    assert.equal(problems.length, 3);
});

test('the fact sentence says facts and never advice', () => {
    const line = combatSummaryLine(base());
    assert.match(line, /zombie/);
    assert.match(line, /出手 8 次，命中 6 次/);
    assert.match(line, /血 18→13（掉 5）/);
    assert.equal(/应该|建议|最好|下次/.test(line), false, 'no advice in the receipt');
});

test('a refusal sentence carries the reason', () => {
    const line = combatSummaryLine({ ...base(), result: 'refused', reason: 'out_of_range' });
    assert.match(line, /没打/);
    assert.match(line, /out_of_range/);
});

test('flee-case rule pairs low health with multiple hostiles', () => {
    assert.equal(looksLikeFleeCase({ startHp: 12, hostileCount: 1 }), true);
    assert.equal(looksLikeFleeCase({ startHp: 20, hostileCount: 2 }), true);
    assert.equal(looksLikeFleeCase({ startHp: 20, hostileCount: 1 }), false);
});

test('a fightable notice requires being armed, healthy, alone and not attacking', () => {
    const note = { armed: true, startHp: 18, hostileCount: 1 };
    assert.equal(looksLikeFightableNotice(note, ['moveAway']), true);
    assert.equal(looksLikeFightableNotice(note, ['attack']), false, 'she did fight');
    assert.equal(looksLikeFightableNotice({ ...note, armed: false }, ['moveAway']), false);
    assert.equal(looksLikeFightableNotice({ ...note, startHp: 10 }, ['moveAway']), false);
    assert.equal(looksLikeFightableNotice({ ...note, hostileCount: 3 }, ['moveAway']), false);
});

test('per-mob cells report n, median damage, kill rate and flag small samples', () => {
    const records = [
        normalizeCombatRecord(base()).record,
        normalizeCombatRecord({ ...base(), damageTaken: 9 }).record,
        normalizeCombatRecord({ ...base(), target: { name: 'creeper', id: 9 }, result: 'disengaged', damageTaken: 14 }).record
    ];
    const out = summarise(records, []);
    const zombie = out.byMob.find((m) => m.mob === 'zombie');
    const creeper = out.byMob.find((m) => m.mob === 'creeper');
    assert.equal(zombie.n, 2);
    assert.equal(zombie.damageTakenMedian, 7);
    assert.equal(zombie.killRate, 100);
    assert.equal(zombie.sampleTooSmall, true);
    assert.equal(creeper.killRate, 0);
});

test('the two ratio metrics use different denominators and are not confused', () => {
    const fight = normalizeCombatRecord({ ...base(), startHp: 10, hostileCount: 1 }).record;   // fought while low: counts
    const safe = normalizeCombatRecord({ ...base(), startHp: 20, hostileCount: 1 }).record;
    const notices = [
        { note: { armed: true, startHp: 18, hostileCount: 1 }, nextChoices: ['moveAway'] },   // declined a fightable one
        { note: { armed: true, startHp: 18, hostileCount: 1 }, nextChoices: ['attack'] }
    ];
    const out = summarise([fight, safe], notices);
    assert.equal(out.foughtWhenShouldFlee.count, 1);
    assert.equal(out.foughtWhenShouldFlee.of, 1);
    assert.equal(out.couldHaveFoughtButDidNot.count, 1);
    assert.equal(out.couldHaveFoughtButDidNot.of, 2);
    assert.equal(out.attackedAfterNotice.count, 1);
});

test('confounders are counted so nobody reads damage as skill alone', () => {
    const records = [
        normalizeCombatRecord({ ...base(), hadFood: false }).record,
        normalizeCombatRecord({ ...base(), isNight: true, startY: 40 }).record
    ];
    const out = summarise(records, []);
    assert.equal(out.confounders.starving, 1);
    assert.equal(out.confounders.night, 1);
    assert.equal(out.confounders.underground, 1);
});
