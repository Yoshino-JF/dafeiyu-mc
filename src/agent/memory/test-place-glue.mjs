// Regression for #3305: restoring a place onto a places.md that lacks a trailing newline glued two places into one line,
// and place() then answered with the neighbour's coordinates. The real file ended without a newline, so this fixture is
// written the same way on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryS } from './index.js';

const T0 = 1_800_000_000_000;
const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsglue-'));

test('a file without a trailing newline does not glue the restored place onto the last line', () => {
    const dir = mkDir();
    // exactly the shape from the run: one line, no trailing newline
    fs.writeFileSync(path.join(dir, 'places.md'), '- 出生点附近 ： (2, 64, -5)');
    const m = new MemoryS({ dir, now: () => T0 });
    m.setWorld('name:A', {});
    m.appendPlace('新洞屋', { x: 251, y: 63, z: 251 });
    const before = fs.readFileSync(path.join(dir, 'places.md'), 'utf8');
    const beforeLines = before.split('\n').filter((l) => l.startsWith('- ')).length;

    m.setWorld('name:B', {});
    const res = m.archiveWorldRows('新洞屋', { confirm: true });
    assert.equal(res.moved, 1);
    m.setWorld('name:A', {});

    const after = fs.readFileSync(path.join(dir, 'places.md'), 'utf8');
    const afterLines = after.split('\n').filter((l) => l.startsWith('- ')).length;
    assert.equal(afterLines, beforeLines, 'the count is unchanged: one place left, the same one came back');
    assert.equal(after.includes('- 出生点附近 ： (2, 64, -5)- '), false, 'no two places on one line');

    assert.deepEqual(m.place('出生点附近'), { x: 2, y: 64, z: -5 });
    assert.deepEqual(m.place('新洞屋'), { x: 251, y: 63, z: 251 }, 'the restored place keeps its own coordinates');
});

test('restoring a place adds exactly one line when the place is new', () => {
    const dir = mkDir();
    fs.writeFileSync(path.join(dir, 'places.md'), '- 出生点附近 ： (2, 64, -5)');   // no trailing newline
    const m = new MemoryS({ dir, now: () => T0 });
    m.setWorld('name:A', {});
    m.appendPlace('河边', { x: 3, y: 64, z: 9 });
    m.setWorld('name:B', {});
    m.archiveWorldRows('河边', { confirm: true });
    const mid = fs.readFileSync(path.join(dir, 'places.md'), 'utf8').split('\n').filter((l) => l.startsWith('- ')).length;
    m.setWorld('name:A', {});
    const end = fs.readFileSync(path.join(dir, 'places.md'), 'utf8').split('\n').filter((l) => l.startsWith('- ')).length;
    assert.equal(end, mid + 1, 'one line came back');
    assert.deepEqual(m.place('河边'), { x: 3, y: 64, z: 9 });
});

test('a glued or malformed line answers null instead of the neighbour coordinates', () => {
    const dir = mkDir();
    fs.writeFileSync(path.join(dir, 'places.md'), '- 出生点附近 ： (2, 64, -5)- 新洞屋 ： (251, 63, 251)\n');
    const m = new MemoryS({ dir, now: () => T0 });
    assert.deepEqual(m.place('出生点附近'), { x: 2, y: 64, z: -5 }, 'the anchored name still parses');
    assert.equal(m.place('新洞屋'), null, 'a name in the middle of a line is not a place');
});

test('restored rows say restored, and keep the archive facts under one field', () => {
    const dir = mkDir();
    const m = new MemoryS({ dir, now: () => T0 });
    m.setWorld('name:A', {});
    m.appendPlace('白桦林新家', { x: 12, y: 66, z: -16 });
    m.setWorld('name:B', {});
    m.archiveWorldRows('白桦林新家', { confirm: true });
    m.setWorld('name:A', {});
    const side = fs.readFileSync(path.join(dir, 'places.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const row = side.find((r) => r.name === '白桦林新家');
    assert.ok(row, 'the place is back in the sidecar');
    assert.equal(row.restoredFrom, 'name:A', 'the raw world key, not the sanitized folder name');
    assert.ok(row.restoredAt, 'it records when it came back');
});

test('the archive folder keeps a newline so its own file stays one place per line', () => {
    const dir = mkDir();
    fs.writeFileSync(path.join(dir, 'places.md'), '- 出生点附近 ： (2, 64, -5)');
    const m = new MemoryS({ dir, now: () => T0 });
    m.setWorld('name:A', {});
    m.appendPlace('新洞屋', { x: 251, y: 63, z: 251 });
    m.setWorld('name:B', {});
    m.archiveWorldRows('新洞屋', { confirm: true });
    const arch = fs.readFileSync(path.join(dir, 'worlds', 'name_A', 'places.md'), 'utf8');
    assert.ok(arch.endsWith('\n'), 'the archive file is newline terminated');
    assert.equal(arch.split('\n').filter((l) => l.startsWith('- ')).length, 1);
});
