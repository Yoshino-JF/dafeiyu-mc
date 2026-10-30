// D1 tests (#3265/#3269): world-scoped memory with her triage.
// The two properties that matter most: A->B->A restores exactly, and a merge marker never separates from its target.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorldStore, classifyTaughtRow, rowGroups, sanitizeKey } from './worlds.js';

const T0 = 1_800_000_000_000;
const mk = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsworld-'));
    const w = new WorldStore(dir, { now: () => T0 });
    return { dir, w };
};
const write = (dir, file, rows) => fs.writeFileSync(path.join(dir, file), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('a key is safe as a folder name', () => {
    assert.equal(sanitizeKey('seed:1234'), 'seed_1234', 'a colon cannot appear in a Windows folder name');
    assert.ok(!sanitizeKey('a/b\\c').includes('/'));
    assert.equal(sanitizeKey(''), 'unknown-world');
});

test('owner preferences stay global, places go with the world', () => {
    assert.equal(classifyTaughtRow({ who: 'JFors', what: '觉得应该住在上面' }), 'global');
    assert.equal(classifyTaughtRow({ who: 'JFors', what: '家大约在 (-5,61,0)' }), 'world');
    assert.equal(classifyTaughtRow({ who: '箱子', what: '里面有面包' }), 'world');
    assert.equal(classifyTaughtRow({ who: '我', what: '在 protected 格子上反复卡住' }), 'global');
    assert.equal(classifyTaughtRow({ _mergeMarker: true }), 'marker');
});

test('a merge marker and its target land in one group', () => {
    const rows = [
        { who: 'JFors', what: '住在上面' },
        { _mergeMarker: true, mergedOut: { who: 'JFors', what: '住地面更好' }, into: { who: 'JFors', what: '住在上面' } },
        { who: 'JFors', what: '住地面更好' }
    ];
    const groups = rowGroups(rows);
    assert.equal(groups.length, 1, 'all three belong together');
});

test('first setWorld only registers; a second call with the same key is a no-op', () => {
    const { w } = mk();
    const a = w.setWorld('seed:aaa', { seed: 1 });
    assert.equal(a.changed, true);
    assert.equal(a.worldCount, 1);
    assert.equal(a.archived, 0, 'nothing to archive on the first world');
    const again = w.setWorld('seed:aaa', { seed: 2 });
    assert.equal(again.changed, false);
    assert.equal(w.current().parts.seed, 2, 'the later, better seed is kept');
});

test('A -> B moves nothing by itself and marks what belongs to the old world', () => {
    const { dir, w } = mk();
    write(dir, 'taught.jsonl', [
        { who: 'JFors', what: '觉得应该住在上面', at: T0 },
        { who: 'JFors', what: '家大约在 (-5,61,0)', at: T0 },
        { who: '洞屋口', what: '箱子在这里', at: T0 }
    ]);
    w.setWorld('seed:aaa', { seed: 1 });
    const r = w.setWorld('seed:bbb', { seed: 2 });
    assert.equal(r.previous, 'seed:aaa');
    assert.equal(r.archived, 0, 'a switch never archives: she decides');
    const live = read(dir, 'taught.jsonl');
    assert.equal(live.length, 3, 'every row is still visible, nothing hidden or deleted');
});

test('rows put away while in another world come back when she returns to their world', () => {
    const { dir, w } = mk();
    write(dir, 'taught.jsonl', [
        { who: 'JFors', what: '家大约在 (-5,61,0)', at: T0 },
        { who: 'JFors', what: '觉得应该住在上面', at: T0 }
    ]);
    w.setWorld('seed:aaa', {});
    w.setWorld('seed:bbb', {});                       // now she is in B, the coordinate row is stamped A
    const archived = w.archive('家大约在', { confirm: true });
    assert.equal(archived.moved, 1, 'she put the old coordinate away while standing in B');
    const back = w.setWorld('seed:aaa', {});
    assert.equal(back.restored, 1, 'returning to A brings her own archived row back');
    const live = read(dir, 'taught.jsonl').map((r) => r.what);
    assert.ok(live.includes('家大约在 (-5,61,0)'));
});

test('a row hidden inside its own world stays hidden (no silent return)', () => {
    const { dir, w } = mk();
    write(dir, 'taught.jsonl', [{ who: 'JFors', what: '家大约在 (-5,61,0)', at: T0 }]);
    w.setWorld('seed:aaa', {});
    const a = w.archive('家大约在', { confirm: true });     // archived while standing in A, in A's own folder
    assert.equal(a.moved, 1);
    w.setWorld('seed:bbb', {});
    const back = w.setWorld('seed:aaa', {});
    assert.equal(back.restored, 0, 'what she put away here stays away');
    assert.equal(read(dir, 'taught.jsonl').length, 0);
    const arch = read(path.join(w.worldDir('seed:aaa')), 'taught.jsonl');
    assert.equal(arch.length, 1);
    assert.equal(arch[0].archivedInWorld, 'seed:aaa');
});

test('restore moves the row out of the archive (the bug Claude found)', () => {
    const { dir, w } = mk();
    write(dir, 'taught.jsonl', [{ who: 'JFors', what: '家大约在 (-5,61,0)', at: T0 }]);
    w.setWorld('seed:aaa', {});
    w.setWorld('seed:bbb', {});
    w.archive('家大约在', { confirm: true });
    const liveBefore = read(dir, 'taught.jsonl').length;
    const archBefore = read(path.join(w.worldDir('seed:aaa')), 'taught.jsonl').length;
    assert.equal(archBefore, 1);
    const r = w.restore('家大约在', { confirm: true });
    assert.equal(r.restored, 1);
    const liveAfter = read(dir, 'taught.jsonl').length;
    const archAfter = fs.existsSync(path.join(w.worldDir('seed:aaa'), 'taught.jsonl'))
        ? read(path.join(w.worldDir('seed:aaa')), 'taught.jsonl').length : 0;
    assert.equal(liveAfter + archAfter, liveBefore + archBefore, 'nothing duplicated and nothing lost');
    assert.equal(archAfter, 0, 'the archive no longer holds the restored row');
    assert.equal(liveAfter, liveBefore + 1);
});

test('the triage offer is capped per world-day and never appears when it is unsafe', () => {
    let clock = T0;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsworld-cap-'));
    const w = new WorldStore(dir, { now: () => clock });
    write(dir, 'taught.jsonl', [{ who: 'JFors', what: '家大约在 (-5,61,0)', at: T0 }]);
    w.setWorld('seed:aaa', {});
    w.setWorld('seed:bbb', {});                        // one foreign row is now visible
    assert.equal(w.triageOffer('day-1').allowed, true);
    w.noteTriageOffered('day-1');
    // right after an offer it is too soon, which is the bug #3296 reported
    assert.equal(w.triageOffer('day-1').reason, 'too-soon');
    clock += 11 * 60 * 1000;
    assert.equal(w.triageOffer('day-1').allowed, true, 'after the gap it may offer again');
    w.noteTriageOffered('day-1');
    clock += 11 * 60 * 1000;
    w.noteTriageOffered('day-1');
    clock += 11 * 60 * 1000;
    assert.equal(w.triageOffer('day-1').allowed, false, 'three offers is the daily maximum');
    assert.equal(w.triageOffer('day-1').reason, 'daily-cap');
    assert.equal(w.triageOffer('day-2').allowed, true, 'a new day starts the count again');
    assert.equal(w.triageOffer('day-2', { safe: false }).reason, 'unsafe');
    // the gap can be waived by the caller (tests, or an explicit user nudge)
    assert.equal(w.triageOffer('day-2', { minGapMs: 0 }).allowed, true);
});

test('a marker never separates from its target when she archives', () => {
    const { dir, w } = mk();
    write(dir, 'taught.jsonl', [
        { who: 'JFors', what: '家大约在 (-5,61,0)', at: T0 },
        { who: 'JFors', what: '家地面附近', at: T0 },
        { _mergeMarker: true, mergedOut: { who: 'JFors', what: '家地面附近' }, into: { who: 'JFors', what: '家大约在 (-5,61,0)' } }
    ]);
    w.setWorld('seed:aaa', {});
    const res = w.archive('家大约在', { confirm: true });
    assert.equal(res.ok, true);
    const live = read(dir, 'taught.jsonl');
    const archived = read(path.join(w.worldDir('seed:aaa')), 'taught.jsonl');
    const bothOrNeither = (rows) => {
        const marker = rows.some((r) => r._mergeMarker);
        const target = rows.some((r) => String(r.what || '').includes('家大约在'));
        assert.equal(marker, target, 'a marker and its target are in the same file');
    };
    bothOrNeither(live);
    bothOrNeither(archived);
    assert.equal(live.length + archived.length, 3, 'nothing vanished');
});

test('she decides: archive previews when several match, then moves them', () => {
    const { dir, w } = mk();
    write(dir, 'taught.jsonl', [
        { who: 'JFors', what: '水边有溺尸', at: T0 },
        { who: 'JFors', what: '水边别站', at: T0 },
        { who: 'JFors', what: '水边要小心', at: T0 },
        { who: 'JFors', what: '水边真的危险', at: T0 },
        { who: 'JFors', what: '觉得应该住在上面', at: T0 }
    ]);
    w.setWorld('seed:aaa', {});
    const preview = w.archive('水边');
    assert.equal(preview.needConfirm, true);
    assert.equal(preview.matched, 4);
    assert.equal(preview.preview.length, 3, 'she sees at most three to decide');
    const done = w.archive('水边', { confirm: true });
    assert.equal(done.ok, true);
    assert.equal(done.moved, 4);
    assert.equal(read(dir, 'taught.jsonl').length, 1, 'the unrelated fact stays');
    const archived = read(path.join(w.worldDir('seed:aaa')), 'taught.jsonl');
    assert.ok(archived.every((r) => r.archivedBy === 'her'), 'the record says she chose it');
});

test('restore brings rows back without deleting the archive copy of anything else', () => {
    const { dir, w } = mk();
    write(dir, 'taught.jsonl', [{ who: 'JFors', what: '水边有溺尸', at: T0 }]);
    w.setWorld('seed:aaa', {});
    w.archive('水边', { confirm: true });
    const r = w.restore('溺尸');
    assert.equal(r.ok, true);
    assert.equal(r.restored, 1);
    assert.equal(read(dir, 'taught.jsonl').length, 1);
});

test('a batch never exceeds eight items', () => {
    const { dir, w } = mk();
    const rows = Array.from({ length: 20 }, (_, i) => ({ who: 'JFors', what: `地点 ${i} 在 (${i},64,0)`, world: 'seed:old', at: T0 }));
    write(dir, 'taught.jsonl', rows);
    w.setWorld('seed:new', {});
    const b = w.showBatch(1);
    assert.equal(b.items.length, 8);
    assert.equal(b.hasMore, true);
    assert.ok(b.items.every((x) => x.world === 'seed:old'));
});

test('nothing is ever deleted: counts add up after two switches', () => {
    const { dir, w } = mk();
    write(dir, 'taught.jsonl', [
        { who: 'JFors', what: '家大约在 (-5,61,0)', at: T0 },
        { who: 'JFors', what: '觉得应该住在上面', at: T0 }
    ]);
    const start = read(dir, 'taught.jsonl').length;
    w.setWorld('seed:aaa', {});
    w.setWorld('seed:bbb', {});
    w.setWorld('seed:aaa', {});
    const live = read(dir, 'taught.jsonl').length;
    const archiveA = fs.existsSync(path.join(w.worldDir('seed:aaa'), 'taught.jsonl')) ? read(path.join(w.worldDir('seed:aaa')), 'taught.jsonl').length : 0;
    const archiveB = fs.existsSync(path.join(w.worldDir('seed:bbb'), 'taught.jsonl')) ? read(path.join(w.worldDir('seed:bbb')), 'taught.jsonl').length : 0;
    assert.equal(live + archiveA + archiveB, start, 'no row vanished');
});
