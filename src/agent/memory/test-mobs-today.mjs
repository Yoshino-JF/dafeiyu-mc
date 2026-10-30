// Regression for #3327: raw events are keyed by DATE while her game day is a number, so "mobs met today" read a
// nonexistent file and every mob looked unmet. That is why a lesson about 苦力怕 got tagged as old-world on a day she was
// blown up by creepers twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryS } from './index.js';

const T0 = Date.parse('2026-10-26T11:50:00+08:00');
const today = '2026-10-26';
function mkRaw(rows) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsmob7-'));
    fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'raw', `${today}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return new MemoryS({ dir, now: () => T0 });
}

test('a death by Creeper in raw means creepers were met today', () => {
    const m = mkRaw([
        { type: 'death', cause: 'DaFeiYu was blown up by Creeper', at: T0 - 3600_000 },
        { type: 'death', cause: 'DaFeiYu was blown up by Creeper', at: T0 - 1800_000 }
    ]);
    assert.deepEqual(m.encounteredMobs(today), ['苦力怕']);
});

test('a lesson about 苦力怕 is not tagged when she was blown up by creepers today', () => {
    const m = mkRaw([{ type: 'death', cause: 'DaFeiYu was blown up by Creeper', at: T0 - 3600_000 }]);
    assert.deepEqual(m._mobNotes('苦力怕有时不出声就炸，听见嘶声要立刻退。', { mobs: m.encounteredMobs(today) }), []);
});

test('a lesson about 掠夺者 is still tagged when no pillager existed today', () => {
    const m = mkRaw([{ type: 'death', cause: 'DaFeiYu was blown up by Creeper', at: T0 - 3600_000 }]);
    const notes = m._mobNotes('附近有掠夺者转悠', { mobs: m.encounteredMobs(today) });
    assert.equal(notes.length, 1);
    assert.match(notes[0], /掠夺者/);
});

test('a game day number resolves to the date-keyed raw file', () => {
    const m = mkRaw([{ type: 'death', cause: 'was slain by Zombie', at: T0 - 3600_000 }]);
    assert.deepEqual(m.encounteredMobs(41), ['僵尸'], 'the number must not silently read nothing');
});

test('both name languages are understood in the same scan', () => {
    const m = mkRaw([
        { type: 'death', cause: 'was shot by Pillager', at: T0 - 3600_000 },
        { type: 'failure', reason: '溺尸 too close', at: T0 - 3000_000 },
        { type: 'death', cause: 'slain by skeleton', at: T0 - 2000_000 }
    ]);
    const met = m.encounteredMobs(today);
    for (const zh of ['掠夺者', '溺尸', '骷髅']) assert.ok(met.includes(zh), `${zh} should be recognised`);
});

test('a danger notice inside the same window also counts as met', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsmob8-'));
    fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
    const at = T0 - 600_000;
    fs.writeFileSync(path.join(dir, 'raw', `${today}.jsonl`), JSON.stringify({ type: 'say', text: 'today', at }) + '\n');
    // a log beside the memory dir, as in the project layout
    const logDir = path.resolve(dir, '../../../logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'agent.ndjson'), `[decision] ${JSON.stringify({ at: at + 1000, chosen: 'attack', gate: 'danger', why: 'zombie 1m hurt' })}\n`);
    const m = new MemoryS({ dir, now: () => T0 });
    assert.ok(m.encounteredMobs(today).includes('僵尸'), 'the danger notice names a zombie she met');
});
