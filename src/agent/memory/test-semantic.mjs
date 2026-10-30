// #3168: semantic dedupe via embeddings, with the offline rules as fallback.
// The fake embedder is deterministic so the test does not depend on a network model, but the THRESHOLD comes from the
// real calibration on the live pairs (see dev/calibrate-embed-dedupe.mjs and semantic.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cosine, semanticSame, SEMANTIC_THRESHOLD, EmbedCache } from './semantic.js';
import { TaughtStore, sameFact } from './taught.js';
import { MemoryS } from './index.js';

const T0 = 1_800_000_000_000;
const mk = () => new TaughtStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dssem-')), 'taught.jsonl'));

/** A tiny fake embedder: each text is a bag of its characters, so similar wording gives similar vectors. */
const fakeEmbed = async (text) => {
    const v = new Array(32).fill(0);
    for (const ch of String(text)) v[ch.codePointAt(0) % 32] += 1;
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / n);
};

test('cosine is 1 for equal vectors and 0 for orthogonal ones', () => {
    assert.equal(cosine([1, 0], [1, 0]), 1);
    assert.equal(cosine([1, 0], [0, 1]), 0);
    assert.equal(cosine([], [1]), 0);
});

test('semanticSame reports no decision when there is no embedder', async () => {
    assert.equal(await semanticSame({ a: 'x', b: 'y' }), null);
});

test('semanticSame survives an embedder that throws', async () => {
    const boom = async () => { throw new Error('no network'); };
    assert.equal(await semanticSame({ embed: boom, a: 'x', b: 'y' }), null);
});

test('the threshold is the one chosen on the labelled set', () => {
    // dev/pick-dedupe-threshold.mjs: with the place guard, 0.64 gives precision 1.0 and recall 1.0 on 24 real pairs
    assert.equal(SEMANTIC_THRESHOLD, 0.64);
});

test('a high cosine merges even when the character and topic rules would not', async () => {
    const s = mk();
    const FIRST = '希望我住在地面上';
    const SECOND = '屋子该建在南头那片空地';
    s.remember({ who: 'JFors', what: FIRST, at: T0 });
    // the offline rules genuinely miss this pair: no shared count, and no topic keyword pairs with a place word
    assert.equal(sameFact('JFors', FIRST, 'JFors', SECOND), false);
    // a semantic embedder sees them as one thing
    const samevec = async () => [1, 0, 0];
    const merged = await s.rememberSemantic({ who: 'JFors', what: SECOND, at: T0 + 1000, embed: samevec });
    assert.equal(merged.merged, true, 'the embedder saw the same meaning');
    assert.equal(s.size, 1);
});

test('the place guard beats a high cosine: two chests are two facts', async () => {
    const s = mk();
    s.remember({ who: 'JFors', what: '旁边箱子里有面包和铁锭。', at: T0 });
    // this pair shares almost every character, so the embedder would happily merge it
    const res = await s.rememberSemantic({ who: 'JFors', what: '熔炉边箱子里会放面包，缺吃的可以拿。', at: T0 + 1000, embed: fakeEmbed });
    assert.equal(res.merged, undefined, 'different places stay different facts');
    assert.equal(s.size, 2);
});

test('a different speaker never merges, whatever the cosine', async () => {
    const s = mk();
    s.remember({ who: 'JFors', what: '觉得房子应该建在上面', at: T0 });
    const res = await s.rememberSemantic({ who: 'HouseTest', what: '觉得房子应该建在上面', at: T0 + 1000, embed: fakeEmbed });
    assert.equal(res.merged, undefined);
    assert.equal(s.size, 2);
});

test('without an embedder the dawn path falls back to the offline rules', async () => {
    const m = new MemoryS({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'dssem2-')), now: () => T0 });
    m.rememberTaught({ who: 'JFors', what: '认为我应该住在上面，不要在地下找房子', at: T0 });
    const row = await m.rememberTaughtAsync({ who: 'JFors', what: '希望我住在地面上，而不是在地下找房子', at: T0 + 1000, source: 'consolidate' });
    assert.equal(row.merged, true, 'the character rules still catch this paraphrase');
    assert.equal(m.taughtFacts().length, 1);
});

test('the dawn path uses the embedder when one is set', async () => {
    const m = new MemoryS({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'dssem3-')), now: () => T0 });
    m.setEmbedder(fakeEmbed);
    m.rememberTaught({ who: 'JFors', what: '认为我应该住在上面，不要在地下找房子', at: T0 });
    const row = await m.rememberTaughtAsync({ who: 'JFors', what: '住在上面比地下好', at: T0 + 1000, source: 'consolidate' });
    assert.equal(row.merged, true);
    assert.equal(m.taughtFacts().length, 1);
});

test('a broken embedder does not break the dawn', async () => {
    const m = new MemoryS({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'dssem4-')), now: () => T0 });
    m.setEmbedder(async () => { throw new Error('down'); });
    const row = await m.rememberTaughtAsync({ who: 'JFors', what: '说我可以去睡觉，不用硬撑。', at: T0, source: 'consolidate' });
    assert.ok(row, 'the fact is still recorded via the fallback');
    assert.equal(m.taughtFacts().length, 1);
});

test('the cache does not change the answer', async () => {
    const cache = new EmbedCache(4);
    const a = await cache.get(fakeEmbed, '住在上面');
    const b = await cache.get(fakeEmbed, '住在上面');
    assert.deepEqual(a, b);
});
