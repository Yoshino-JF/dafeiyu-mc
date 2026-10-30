// #3195: the promise must not expire while the owner is away, and she must be nudged to close it when it is done.
// Tonight's exact case: 4 birch planks requested, 21 made and 4 kept, owner offline the whole time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PromiseStore, PROMISE_TTL_MS, promiseWanted, promiseLooksDone } from './promises.js';
import { MemoryS } from './index.js';

const T0 = 1_800_000_000_000;
const mk = () => new PromiseStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsnudge-')), 'promises.jsonl'));
const ASK = '大肥鱼，帮我去出生点旁边（-2，64，-3）的箱子里拿4块白桦木板，拿到了送到我这儿。';
// what actually happened tonight
const HER_EVIDENCE = '21块白桦木板做好了，留4块等老大上线，剩下的放箱子里。';

test('what was asked is read out of the request', () => {
    const w = promiseWanted(ASK);
    assert.equal(w.count, 4);
    assert.match(w.noun, /白桦木板/);
    assert.equal(promiseWanted('没有数量的一句话'), null);
});

test('her real evidence looks done (count at or above the ask)', () => {
    assert.ok(['count', 'word'].includes(promiseLooksDone(ASK, HER_EVIDENCE)), 'her real evidence counts as done');
    assert.equal(promiseLooksDone(ASK, '只做了2块白桦木板'), null, 'below the ask is not done');
    assert.equal(promiseLooksDone(ASK, '木头砍了一堆，还没做'), null, 'material is not the product');
    assert.equal(promiseLooksDone(ASK, '4块白桦木板已经做好了，留着呢'), 'word');
});

test('owner offline: the clock does not run, the line says so, and nothing expires', () => {
    const s = mk();
    s.add({ text: ASK, who: 'JFors', at: T0 });
    // 31 minutes later, still offline
    const later = T0 + PROMISE_TTL_MS + 60_000;
    const open = s.open(later, { ownerOnline: false });
    assert.equal(open.length, 1, 'still open, he was never there to deliver to');
    assert.equal(s.expire(later, { ownerOnline: false }), 0);
    const block = s.lines(later, { ownerOnline: false, evidence: HER_EVIDENCE })[0];
    assert.match(block, /老大不在线，等他上线再交/);
    assert.equal(/!promiseDone/.test(block), false, 'no delivery nudge while he is away');
    assert.match(block, /别因为等他而丢下这件事/);
});

test('owner online again after a pause: the clock resumes, not restarts', () => {
    const s = mk();
    s.add({ text: ASK, who: 'JFors', at: T0 });
    // 25 minutes online, then he leaves for 2 hours, then comes back
    const leave = T0 + 25 * 60_000;
    s.syncClock(leave, { ownerOnline: false });
    const back = leave + 120 * 60_000;
    s.syncClock(back, { ownerOnline: true });
    // only 5 minutes of online time were left, so it is still open right after he returns
    assert.equal(s.open(back + 60_000, { ownerOnline: true }).length, 1);
    // ...and expires once those 5 minutes pass
    assert.equal(s.open(back + 6 * 60_000, { ownerOnline: true }).length, 0);
});

test('owner online the whole time: expiry behaves exactly as before', () => {
    const s = mk();
    s.add({ text: ASK, who: 'JFors', at: T0 });
    assert.equal(s.open(T0 + PROMISE_TTL_MS - 1000, { ownerOnline: true }).length, 1);
    assert.equal(s.open(T0 + PROMISE_TTL_MS + 1000, { ownerOnline: true }).length, 0);
});

test('done + owner online: the prompt tells her to close it', () => {
    const s = mk();
    s.add({ text: ASK, who: 'JFors', at: T0 });
    const block = s.lines(T0 + 5 * 60_000, { ownerOnline: true, evidence: HER_EVIDENCE })[0];
    assert.match(block, /看起来已经做好了/);
    assert.match(block, /!promiseDone/);
    assert.match(block, /交不了就说一声/);
});

test('the memory prompt block carries the offline note, so it reaches every turn', () => {
    const m = new MemoryS({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsnudge2-')), now: () => T0 });
    m.notePromise({ request: ASK, reply: '好，我这就去', who: 'JFors' });
    m.setOwnerPresence(() => false);
    const block = m.promptBlock({ query: null });
    assert.match(block, /答应老大还没做完的事/);
    assert.match(block, /老大不在线，等他上线再交/);
    // and no expiry happened while he was away
    assert.equal(m.openPromises().length, 1);
});
