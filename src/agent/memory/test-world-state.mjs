// Regression for #3289: the world record must survive MemoryS's own state writes.
// The real run showed the key gone within a minute because both stores shared memory/state.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryS } from './index.js';

const T0 = 1_800_000_000_000;
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsstate-'));

test('a MemoryS state save does not erase the world record', () => {
    const dir = mk();
    const m = new MemoryS({ dir, now: () => T0 });
    const r1 = m.setWorld('name:A', { name: 'A' });
    assert.equal(r1.changed, true);

    // this is the write that wiped it in the real run
    m.noteSaid('我先看看箱子', { at: T0 });
    m.noteFailure({ kind: 'mine', reason: 'refused' });

    // a fresh process reading the same memory must still know the world
    const again = new MemoryS({ dir, now: () => T0 + 1000 });
    assert.equal(again.worldStatus().key, 'name:A', 'the world key survived the save');

    const r2 = again.setWorld('name:B', { name: 'B' });
    assert.equal(r2.changed, true);
    assert.equal(r2.previous, 'name:A', 'the switch is detected across processes');
    assert.equal(r2.worldCount, 2);
});

test('the world record lives in its own file, not in MemoryS state', () => {
    const dir = mk();
    const m = new MemoryS({ dir, now: () => T0 });
    m.setWorld('name:A', {});
    m.noteSaid('测试一句', { at: T0 });
    const shared = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(shared.world, undefined, 'MemoryS state stays clean');
    const worldState = path.join(dir, 'worlds', 'state.json');
    assert.equal(fs.existsSync(worldState), true);
    assert.equal(JSON.parse(fs.readFileSync(worldState, 'utf8')).world.key, 'name:A');
});

test('an old record inside the shared file is migrated once', () => {
    const dir = mk();
    // simulate the previous build: world inside MemoryS's state file, no worlds/state.json yet
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ day: 7, world: { key: 'name:OLD', parts: {}, since: T0, worldCount: 3 } }));
    const m = new MemoryS({ dir, now: () => T0 });
    assert.equal(m.worldStatus().key, 'name:OLD', 'the old record is picked up');
    assert.equal(m.worldStatus().worldCount, 3);
    m.setWorld('name:NEW', {});
    const worldState = JSON.parse(fs.readFileSync(path.join(dir, 'worlds', 'state.json'), 'utf8'));
    assert.equal(worldState.world.key, 'name:NEW');
    assert.equal(worldState.world.worldCount, 4, 'the counter continues rather than restarting');
});
