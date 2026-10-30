// Regression for #3307: the taught store is append-only, so every restatement of the same fact appended the whole
// survivor again and the file grew one identical line per night (11 -> 12 on her real file). The fixtures therefore
// build the disk state the store produces: several lines with the same who+what.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaughtStore } from './taught.js';

const T0 = 1_800_000_000_000;
const FACT = '认为我应该住在上面，不要在地下找房子；另说：建议我住地面，别老待地下';

function seeded(rows) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dscompact-'));
    const file = path.join(dir, 'taught.jsonl');
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return { dir, file, store: new TaughtStore(file) };
}
const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
const parse = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// the shape her file actually has: the same fact, one line per night, only the counters differ
const night = (n, what = FACT) => ({ who: 'JFors', what, at: T0, source: 'consolidate', seen: n, lastSeenAt: T0 + n * 86_400_000, paraphrases: Array.from({ length: n - 1 }, (_, i) => `换说法 ${i}`) });

test('a file with the same fact written twelve times compacts to one line plus one marker', () => {
    const { file, store } = seeded(Array.from({ length: 12 }, (_, i) => night(i + 1)));
    const before = store.duplication();
    assert.equal(before.extraCopies, 11, 'eleven superseded copies are on disk');

    const res = store.compact();
    assert.equal(res.folded, 11);
    const after = store.duplication();
    assert.equal(after.extraCopies, 0);

    const all = parse(file);
    const live = all.filter((r) => !r._duplicateMarker && !r._mergeMarker && !r._paraphraseMarker && !r.forgotten);
    assert.equal(live.length, 1, 'one live line');
    assert.equal(live[0].seen, 12, 'the newest line wins, so its counters are kept');
    // the fold is recorded on the surviving row, so no extra line is needed
    assert.equal(live[0].foldedCopies, 11, 'the surviving row says how many copies it absorbed');
    assert.equal(all.filter((r) => r._duplicateMarker).length, 0, 'no marker line was added');
});

test('two consecutive consolidations of the same input leave the line count unchanged', () => {
    const { file, store } = seeded([night(1), night(1, '建议跳起来往脚下放方块来往上走')]);
    store.compact();
    const afterFirst = lines(file);

    // second night: her dawn writes the same two facts again, which appends one more copy per fact
    fs.appendFileSync(file, [night(2), night(2, '建议跳起来往脚下放方块来往上走')].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const grewBeforeCompact = lines(file);
    assert.equal(grewBeforeCompact, afterFirst + 2, 'the append-only path does grow without compaction');

    const fresh = new TaughtStore(file);
    const res = fresh.compact();
    assert.equal(res.folded, 2);
    assert.equal(lines(file), afterFirst, 'the file is back to the same size');
});

test('the fold is visible on the surviving row (nothing is silently deleted)', () => {
    const { file, store } = seeded([night(1), night(2), night(3)]);
    store.compact();
    const all = parse(file);
    assert.equal(all.length, 1);
    assert.equal(all[0].foldedCopies, 2);
    assert.ok(all[0].foldedFrom, 'it keeps when the first copy was written');
    assert.ok(all[0].foldedAt, 'and when they were folded');
    assert.equal(all[0].seen, 3, 'the newest counters survive');
});

test('meaningful markers survive compaction untouched', () => {
    const { file, store } = seeded([
        night(1),
        { _mergeMarker: true, mergedOut: { who: 'X', what: 'Y' }, into: { who: 'JFors', what: FACT }, at: T0 }
    ]);
    store.compact();
    const all = parse(file);
    assert.equal(all.filter((r) => r._mergeMarker).length, 1);
});

test('compaction is a no-op on an already compact file', () => {
    const { file, store } = seeded([night(1)]);
    const first = store.compact();
    assert.equal(first.folded, 0);
    assert.equal(first.wrote, false);
    assert.equal(store.compact().folded, 0);
});

test('the live row is still readable through the store after compaction', () => {
    const { store } = seeded([night(1), night(2), night(3)]);
    store.compact();
    const live = [...store.byKey.values()].find((r) => r.what === FACT);
    assert.ok(live, 'the fact is still in memory');
    assert.equal(live.seen, 3);
});
