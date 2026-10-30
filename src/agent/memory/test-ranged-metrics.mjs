// Ranged/shield metric regressions (#3339/#3394). These pin the two corrections I made to my own earlier caveat, because
// both of them change what the numbers mean.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bandOf, shootFact, blockFact, summariseRanged } from '../../../dev/ranged-metrics.mjs';

const T = 1_800_000_000_000;
const shoot = (o = {}) => ({ kind: 'shoot', at: T, args: { target: 'zombie', lead: 1 }, result: 'released', ok: true, targetHpBefore: 20, targetHpAfter: 14, arrowsSpent: 1, flightMs: 700, lead: 1, ...o });
const block = (o = {}) => ({ kind: 'block', at: T, args: { facing: 'skeleton' }, result: 'held', heldSeconds: 2, startHp: 20, endHp: 20, wearBefore: 0, wearAfter: 1, ...o });

test('distance bands are half open and unknown stays unknown', () => {
    assert.equal(bandOf(9.99), '0-10');
    assert.equal(bandOf(10), '10-15');
    assert.equal(bandOf(15), '15-20');
    assert.equal(bandOf(22), '20-33');
    assert.equal(bandOf(undefined), 'unknown');
});

test('a hit is judged by the target losing health, not by the arrow leaving', () => {
    assert.equal(shootFact(shoot()).hit, true);
    assert.equal(shootFact(shoot({ targetHpAfter: 20 })).hit, false);
});

test('a shot whose target could not be observed is unknown, never a miss', () => {
    const f = shootFact(shoot({ targetHpBefore: null, targetHpAfter: null }));
    assert.equal(f.hit, null);
    const out = summariseRanged([{ kind: 'shoot', at: T, result: 'released', ok: true, targetHpBefore: null, targetHpAfter: null }]);
    assert.equal(out.unobservableShots, 1);
    assert.equal(out.hitRate, null, 'no observable shots means no hit rate');
});

test('a death counts as a hit even without a health reading', () => {
    assert.equal(shootFact(shoot({ targetDeathObserved: true, targetHpAfter: null })).hit, true);
});

test('shield wear is positive evidence that the block was processed', () => {
    const held = blockFact(block());
    assert.equal(held.wearDelta, 1);
    assert.equal(held.absorbedSomething, true);
    const missed = blockFact(block({ wearAfter: 0 }));
    assert.equal(missed.absorbedSomething, false, 'no wear means nothing hit the shield');
});

test('blocking reports damage per second while holding, not "damage blocked"', () => {
    const f = blockFact(block({ startHp: 20, endHp: 16, heldSeconds: 4 }));
    assert.equal(f.damageWhileHolding, 4);
    assert.equal(f.damagePerSecond, 1);
});

test('arrows per hit is only computed when hits are observable', () => {
    const out = summariseRanged([
        { kind: 'shoot', at: T, result: 'released', targetHpBefore: 20, targetHpAfter: 14, arrowsSpent: 1 },
        { kind: 'shoot', at: T + 1, result: 'released', targetHpBefore: 20, targetHpAfter: 20, arrowsSpent: 1 },
        { kind: 'shoot', at: T + 2, result: 'released', targetDeathObserved: true, arrowsSpent: 1 }
    ]);
    assert.equal(out.shoots, 3);
    assert.equal(out.hitRate, 66.7);
    // 3 arrows for 2 hits overall: the cost of accuracy, not a per shot constant
    assert.equal(out.arrowsPerHit, 1.5);
});

test('a refusal is not counted as a shot that missed', () => {
    const out = summariseRanged([{ kind: 'shoot', at: T, result: 'refused', reason: 'no_bow', ok: false }]);
    assert.equal(out.releasedShare, 0);
    assert.equal(out.hitRate, null);
});

test('the caveats travel with the numbers so they cannot be dropped in a report', () => {
    const out = summariseRanged([block()]);
    assert.ok(out.caveats.some((c) => /durability/.test(c)));
    assert.ok(out.caveats.some((c) => /rough baseline/.test(c)));
});
