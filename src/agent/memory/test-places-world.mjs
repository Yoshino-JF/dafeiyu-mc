// D1 gap (#3293): places must carry a world stamp, appear in triage, and be archivable/restorable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryS } from './index.js';

const T0 = 1_800_000_000_000;
const mk = () => new MemoryS({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsplace-')), now: () => T0 });

test('a saved place is stamped with the current world', () => {
    const m = mk();
    m.setWorld('name:A', {});
    m.appendPlace('白桦林新家', { x: 12, y: 66, z: -16 });
    assert.equal(m.placeWorld('白桦林新家'), 'name:A');
});

test('in another world the old place is marked in the prompt and reported as foreign', () => {
    const m = mk();
    m.setWorld('name:A', {});
    m.appendPlace('白桦林新家', { x: 12, y: 66, z: -16 });
    m.setWorld('name:B', {});
    assert.equal(m.placeWorld('白桦林新家'), 'name:A', 'the stamp survives the switch');
    const prompt = m.promptBlock({ query: null });
    assert.match(prompt, /白桦林新家/);
    assert.match(prompt, /旧世界/, 'a stale place is labelled, not hidden');
});

test('places written before this feature are stamped with the world she left', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsplace2-'));
    const m = new MemoryS({ dir, now: () => T0 });
    fs.writeFileSync(path.join(dir, 'places.md'), '- 白桦林新家 ： (12, 66, -16)\n- 洞屋 ： (-4, 64, -2)\n');
    m.setWorld('name:A', {});
    m.setWorld('name:B', {});
    assert.equal(m.placeWorld('白桦林新家'), 'name:A');
    assert.equal(m.placeWorld('洞屋'), 'name:A');
});

test('a foreign place shows up in the batch and she can archive it', () => {
    const m = mk();
    m.setWorld('name:A', {});
    m.appendPlace('白桦林新家', { x: 12, y: 66, z: -16 });
    m.setWorld('name:B', {});
    const batch = m.showWorldBatch(1);
    assert.ok(batch.items.some((i) => i.kind === 'place' && i.text === '白桦林新家'), 'the place is offered for triage');
    const res = m.archiveWorldRows('白桦林新家', { confirm: true });
    assert.equal(res.ok, true);
    assert.equal(res.moved, 1);
    const md = fs.readFileSync(path.join(m.dir, 'places.md'), 'utf8');
    assert.equal(md.includes('白桦林新家'), false, 'archiving removes it from the live place list');
    const archived = fs.readFileSync(path.join(m.dir, 'worlds', 'name_A', 'places.jsonl'), 'utf8');
    assert.match(archived, /白桦林新家/);
    assert.match(archived, /archivedInWorld/);
});

test('placeWorld returns null for a name she never saved', () => {
    const m = mk();
    m.setWorld('name:A', {});
    assert.equal(m.placeWorld('不存在的地方'), null);
});
