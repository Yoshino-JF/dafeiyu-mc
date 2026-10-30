// Regression for #3295: a warm MemoryS cache must not resurrect archived rows.
// Claude's repro, kept in that order: appendPlace on a live MemoryS (warming the cache), switch world, archive the place,
// then read it back. Before the fix place() still answered and the next appendPlace wrote the cached copy to disk again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryS } from './index.js';

const T0 = 1_800_000_000_000;
const mk = () => new MemoryS({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'dscache-')), now: () => T0 });

test('after archiving a place, place() no longer answers for it', () => {
    const m = mk();
    m.setWorld('name:A', {});
    m.appendPlace('白桦林新家', { x: 12, y: 66, z: -16 });
    assert.deepEqual(m.place('白桦林新家'), { x: 12, y: 66, z: -16 }, 'it is there before archiving');

    m.setWorld('name:B', {});
    const res = m.archiveWorldRows('白桦林新家', { confirm: true });
    assert.equal(res.moved, 1);

    assert.equal(m.place('白桦林新家'), null, 'the cached copy must be gone');
    // the stamp now lives in the archive, not in the live sidecar: placeWorld speaks for live places only
    assert.equal(m.placeWorld('白桦林新家'), null);
    assert.match(fs.readFileSync(path.join(m.dir, 'worlds', 'name_A', 'places.jsonl'), 'utf8'), /白桦林新家/);
});

test('a later appendPlace does not write the archived place back (no resurrection on disk)', () => {
    const m = mk();
    m.setWorld('name:A', {});
    m.appendPlace('白桦林新家', { x: 12, y: 66, z: -16 });
    m.setWorld('name:B', {});
    m.archiveWorldRows('白桦林新家', { confirm: true });

    m.appendPlace('河边', { x: 3, y: 64, z: 9 });
    const disk = fs.readFileSync(path.join(m.dir, 'places.md'), 'utf8');
    assert.equal(disk.includes('白桦林新家'), false, 'the archived place must not come back through a cache write-back');
    assert.match(disk, /河边/);

    const listed = fs.readFileSync(path.join(m.dir, 'places.md'), 'utf8').split('\n').filter((l) => l.startsWith('- '));
    assert.equal(listed.length, 1);
});

test('restoring a place brings it back into place() and into the readable list', () => {
    const m = mk();
    m.setWorld('name:A', {});
    m.appendPlace('白桦林新家', { x: 12, y: 66, z: -16 });
    m.setWorld('name:B', {});
    m.archiveWorldRows('白桦林新家', { confirm: true });
    assert.equal(m.place('白桦林新家'), null);

    const r = m.restoreWorldRows('白桦林新家');
    assert.equal(r.ok, true);
    assert.deepEqual(m.place('白桦林新家'), { x: 12, y: 66, z: -16 }, 'restore must be visible to the next read');
    const disk = fs.readFileSync(path.join(m.dir, 'places.md'), 'utf8');
    assert.match(disk, /白桦林新家/);
});

test('a switch that loads another world also clears the cache (rows become visible)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dscache2-'));
    // world A has an archived place waiting to be loaded when she returns
    const seed = new MemoryS({ dir, now: () => T0 });
    seed.setWorld('name:A', {});
    seed.appendPlace('白桦林新家', { x: 12, y: 66, z: -16 });
    seed.setWorld('name:B', {});
    seed.archiveWorldRows('白桦林新家', { confirm: true });

    // a fresh instance re-reads everything, then switches back to A
    const m = new MemoryS({ dir, now: () => T0 });
    assert.equal(m.place('白桦林新家'), null, 'not visible while in B');
    m.setWorld('name:A', {});
    assert.deepEqual(m.place('白桦林新家'), { x: 12, y: 66, z: -16 }, 'the switch must make the loaded rows visible');
});

test('the cache still works for files nobody else touches', () => {
    const m = mk();
    m.setWorld('name:A', {});
    m._write('lessons.md', '- 夜里别出门\n');
    const first = m.lessonLines();
    assert.equal(first.length, 1);
    // no world mutation in between: the cached value is fine to reuse
    assert.deepEqual(m.lessonLines(), first);
});
