// D3 (#3251): the dedupe threshold is a measured choice, not a guess. This test replays the labelled set with the
// cosines recorded by dev/pick-dedupe-threshold.mjs (so it needs no network) and asserts the production rule's
// precision and recall, plus the regression that made the change necessary: the old 0.78 missed real twins.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mergeByCosine, placeGuardBlocks, sameFact } from './taught.js';
import { SEMANTIC_THRESHOLD } from './semantic.js';

const data = JSON.parse(fs.readFileSync(new URL('../../../dev/labelled-dedupe-pairs.json', import.meta.url), 'utf8'));
const pairs = data.pairs.filter((p) => typeof p.cosine === 'number');

test('the labelled set is big enough and has both classes', () => {
    assert.ok(pairs.length >= 20, `need 20+ labelled pairs, have ${pairs.length}`);
    assert.ok(pairs.filter((p) => p.same).length >= 10);
    assert.ok(pairs.filter((p) => !p.same).length >= 8);
});

test('the chosen threshold reaches precision 1.0 and recall 1.0 with the place guard', () => {
    let tp = 0, fp = 0, fn = 0;
    for (const p of pairs) {
        const merged = mergeByCosine(p.cosine, p.a, p.b, SEMANTIC_THRESHOLD);
        if (merged && p.same) tp++;
        else if (merged && !p.same) fp++;
        else if (!merged && p.same) fn++;
    }
    const precision = tp / (tp + fp || 1);
    const recall = tp / (tp + fn || 1);
    assert.equal(fp, 0, `no different pair may merge (violations: ${pairs.filter((p) => !p.same && mergeByCosine(p.cosine, p.a, p.b, SEMANTIC_THRESHOLD)).map((p) => p.b.slice(0, 20)).join(' | ')})`);
    assert.equal(fn, 0, 'no same pair may be missed');
    assert.equal(precision, 1);
    assert.equal(recall, 1);
});

test('the old 0.78 threshold really did miss twins (this is why it changed)', () => {
    const missed = pairs.filter((p) => p.same && !mergeByCosine(p.cosine, p.a, p.b, 0.78));
    assert.ok(missed.length >= 3, `expected several misses at 0.78, got ${missed.length}`);
});

test('the place guard still decides the two-chests pair', () => {
    const chest = data.pairs.find((p) => !p.same && p.a.includes('旁边箱子里有面包'));
    assert.ok(chest, 'the chest pair must be in the set');
    assert.equal(placeGuardBlocks(chest.a, chest.b), true);
    assert.equal(mergeByCosine(chest.cosine, chest.a, chest.b, SEMANTIC_THRESHOLD), false);
});

test('the offline fallback catches the strongest twins without any embedding', () => {
    // containment alone is weaker by design; it must at least catch an exact duplicate and a near duplicate
    assert.equal(sameFact('JFors', '说卡住不动就直接挖。', 'JFors', '说卡住不动就直接挖。'), true);
    assert.equal(sameFact('JFors', '希望我住在地面上，而不是在地下找房子', 'JFors', '认为我应该住在上面，不要在地下找房子'), true);
});

test('the recorded measurement is stored with the set, so the choice is auditable', () => {
    assert.ok(data.measurement, 'dev/pick-dedupe-threshold.mjs must write its measurement back');
    assert.equal(typeof data.measurement.recommended.threshold, 'number');
    assert.equal(data.measurement.recommended.precision, 1);
});
