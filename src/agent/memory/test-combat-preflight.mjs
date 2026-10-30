import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCombatRecord } from './combat-record.mjs';
import { summarise } from '../../../dev/combat-metrics.mjs';

// These pin the pre-flight conformance fixes against Claude's actual call site (actions.js fightCommand): isNight can be
// null when the clock is unknown, and a refusal is not an encounter.
const base = () => ({
    at: 1_800_000_000_000, caller: 'her', target: { name: 'zombie', id: 3 }, tactic: 'melee', result: 'killed',
    hits: 6, swings: 8, startHp: 18, endHp: 13, damageTaken: 5, seconds: 12,
    armed: true, weapon: 'stone_sword', hadFood: true, hostileCount: 1,
    dimension: 'overworld', startY: 64, isNight: false, styleVersion: 'v1', style: { zombie: { tactic: 'melee' } }
});

test('an unknown game clock is information, not a problem', () => {
    const { ok, record, problems } = normalizeCombatRecord({ ...base(), isNight: null });
    assert.equal(ok, true);
    assert.deepEqual(problems, []);
    assert.equal(record.isNight, null);
});

test('a refusal does not create a per-mob cell', () => {
    const killed = normalizeCombatRecord(base()).record;
    const refused = normalizeCombatRecord({ ...base(), result: 'refused', reason: 'no_target', target: { name: 'nearest', id: null }, hits: 0, swings: 0, seconds: 0, damageTaken: 0 }).record;
    const out = summarise([killed, refused], []);
    assert.equal(out.encounters, 1);
    assert.equal(out.refusalsNotCounted, 1);
    assert.equal(out.byMob.length, 1);
    assert.equal(out.byMob[0].mob, 'zombie', 'the refusal must not appear as a mob called nearest');
});

test('missing engine fields are reported as advice, not hidden', () => {
    const out = summarise([normalizeCombatRecord(base()).record], []);
    assert.equal(out.advisory.missingEngineMs, 1);
    assert.equal(out.advisory.missingTargetHpBefore, 1);
});

test('a missing interruptedBy on an interrupted record is flagged', () => {
    const rec = normalizeCombatRecord({ ...base(), result: 'interrupted' }).record;
    assert.equal(summarise([rec], []).advisory.missingInterruptedBy, 1);
});

test('records with engine fields present produce no advice', () => {
    const rec = normalizeCombatRecord({ ...base(), engineMs: 9400, targetHpBefore: 20 }).record;
    const out = summarise([rec], []);
    assert.equal(out.advisory.missingEngineMs, 0);
    assert.equal(out.advisory.missingTargetHpBefore, 0);
});

test('a reflex fight is not counted as her choice to fight while hurt', () => {
    const hurt = (o = {}) => normalizeCombatRecord({
        at: 1_800_000_000_000, caller: 'her', target: { name: 'zombie', id: 1 }, tactic: 'melee', result: 'killed',
        hits: 4, swings: 6, startHp: 9, endHp: 7, damageTaken: 2, seconds: 6,
        armed: true, weapon: 'stone_sword', hadFood: true, hostileCount: 1,
        dimension: 'overworld', startY: 40, isNight: true, styleVersion: 1, style: { tactic: 'melee' },
        ...o
    }).record;
    const out = summarise([hurt(), hurt({ caller: 'self_defense', styleVersion: 'reflex' })], []);
    assert.equal(out.herEncounters, 1, 'one call was hers');
    assert.equal(out.reflexEncounters, 1, 'one was the reflex');
    assert.equal(out.foughtWhenShouldFlee.count, 1, 'only her own call counts as choosing to fight hurt');
    assert.equal(out.foughtWhenShouldFlee.of, 1);
});
