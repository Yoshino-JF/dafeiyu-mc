// D6 (#3282): the dawn summary must not invent inventory or coordinates. The prompt gets a hard facts block, and the
// generated text is audited against it: one stricter rewrite, then an appended correction. Nothing is deleted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryS } from './index.js';

const T0 = 1_800_000_000_000;
const FACTS = {
    day: 9,
    inventory: [{ item: 'iron_ingot', count: 0 }, { item: 'cobblestone', count: 16 }],
    places: [{ name: '家', x: -5, y: 61, z: 0 }],
    pos: { x: 3, y: 64, z: 7 }
};
const mk = () => {
    const m = new MemoryS({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsd6t-')), now: () => T0 });
    m.setFactsProvider(() => FACTS);
    return m;
};

test('without a provider nothing is invented and nothing breaks', () => {
    const m = new MemoryS({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsd6n-')), now: () => T0 });
    assert.equal(m._facts(), null);
    assert.deepEqual(m._auditSummary('她还有 5 个铁锭', null), []);
    assert.equal(m._factsBlock(null), '');
});

test('the facts block states inventory, places, position and the day', () => {
    const block = mk()._factsBlock(FACTS);
    assert.match(block, /截至 第9天/);
    assert.match(block, /iron_ingot×0/);
    assert.match(block, /家\(-5,61,0\)/);
    assert.match(block, /当前位置：\(3, 64, 7\)/);
});

test('a count that contradicts the facts is reported', () => {
    const m = mk();
    const complaints = m._auditSummary('她还有 5 个铁锭，圆石 16 块。', FACTS);
    assert.equal(complaints.length, 1);
    assert.match(complaints[0], /铁锭 实际 0 个，摘要写了 5 个/);
});

test('a correct count is not reported', () => {
    assert.deepEqual(mk()._auditSummary('圆石 16 块，铁锭 0 个。', FACTS), []);
});

test('a coordinate outside the place book and away from her is reported', () => {
    const complaints = mk()._auditSummary('她在 (99,64,99) 那里。', FACTS);
    assert.equal(complaints.length, 1);
    assert.match(complaints[0], /不在地点簿里/);
    assert.deepEqual(mk()._auditSummary('家在 (-5,61,0)，她在 (3,64,7)。', FACTS), []);
});

test('the dawn run rewrites once, then appends a correction when the model repeats the error', async () => {
    const m = mk();
    let calls = 0;
    const ask = async () => {
        calls++;
        // deliberately wrong every time, the way a model that trusts its memory behaves
        return '① 关于我自己：我带着 5 个铁锭过日子。\n② 今天的日记：平淡的一天。\n③ 今天学到的教训：\n- 早点睡\n④ 长远想做的事：\n- 造个房子（进行中）\nFACTS:\n- 我：喜欢高处';
    };
    await m.nightlyConsolidate(ask);
    assert.equal(calls, 2, 'one rewrite because the first answer disagreed with the facts');
    const self = fs.readFileSync(path.join(m.dir, 'self.md'), 'utf8');
    assert.match(self, /截至 第9天 修正/);
    assert.match(self, /铁锭 实际 0 个/);
    // her own writing is kept, the correction is appended
    assert.match(self, /我带着 5 个铁锭过日子/);
});

test('a faithful summary is stored unchanged and gets no correction line', async () => {
    const m = mk();
    let calls = 0;
    const ask = async () => {
        calls++;
        return '① 关于我自己：我带着 0 个铁锭。\n② 今天的日记：平淡的一天。\n③ 今天学到的教训：\n- 早点睡\n④ 长远想做的事：\n- 造个房子（进行中）\nFACTS:\n- 我：喜欢高处';
    };
    await m.nightlyConsolidate(ask);
    assert.equal(calls, 1, 'no rewrite when nothing contradicts');
    const self = fs.readFileSync(path.join(m.dir, 'self.md'), 'utf8');
    assert.equal(/截至 第9天 修正/.test(self), false);
    // the facts section becomes taught knowledge, not part of self.md
    assert.ok(m.taughtFacts().some((f2) => String(f2.what).includes('喜欢高处')), 'the FACTS line still lands in taught');
});
