// PLAN D (#3028): deaths must be remembered WITH their conditions, so her lessons can mention rain.
// These tests use the real shapes from today's runs: a zombie death in a thunderstorm at noon, and a death whose
// weather the harness never reported - the second one must be recorded as unknown, not silently assumed sunny.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryS } from './index.js';

const T0 = Date.UTC(2026, 9, 25, 4, 0, 0);   // 12:00 local, i.e. daytime tod
const mk = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsmem5-'));
    return { dir, m: new MemoryS({ dir, now: () => T0 }) };
};

test('a death is recorded with cause, weather and time of day', () => {
    const { m } = mk();
    const rec = m.noteDeath({ cause: 'DaFeiYu was slain by Zombie', pos: { x: 9, y: 66, z: 7 }, weather: 'thunder', tod: 6000, at: T0 });
    assert.equal(rec.cause, 'was slain by Zombie');
    assert.equal(rec.weather, 'thunder');
    assert.equal(rec.night, false, 'tod 6000 is daytime');
    const [stored] = m.deaths();
    assert.equal(stored.type, 'death');
    assert.equal(stored.weather, 'thunder');
});

test('missing weather is recorded as unknown instead of guessed', () => {
    const { m } = mk();
    const rec = m.noteDeath({ cause: 'was slain by Zombie', at: T0 });
    assert.equal(rec.weather, 'unknown');
    assert.equal(rec.night, null);
    assert.match(m.deathLines()[0], /unknown/);
    assert.match(m.deathLines()[0], /时间未知/);
});

test('the lesson prompt carries the death list with weather and day/night', async () => {
    const { m } = mk();
    m.noteDeath({ cause: 'was slain by Zombie', weather: 'thunder', tod: 6000, at: T0 });
    m.noteDeath({ cause: 'suffocated in a wall', weather: 'clear', tod: 18000, at: T0 + 60_000 });
    let prompt = '';
    await m.nightlyConsolidate(async (p) => {
        prompt = p;
        return '① a\n\n② b\n\n③ 教训：\n- 雷雨天别出门\n\nFACTS: 无';
    });
    assert.match(prompt, /今天死了 2 次/);
    assert.match(prompt, /thunder·白天/);
    assert.match(prompt, /clear·夜里/);
    assert.match(prompt, /如果同一种天气或同一个时段反复出事/, 'the instruction to mention weather is present');
});

test('deaths are counted per day for the audit, and never leak into the machine lesson lines', () => {
    const { m, dir } = mk();
    m.noteDeath({ cause: 'was slain by Zombie', weather: 'thunder', tod: 6000, at: T0 });
    m.noteFailure({ kind: 'mine', reason: 'no_path', args: {}, at: T0 });
    const s = m.stats();
    const day = new Date(T0).toISOString().slice(0, 10);
    assert.equal(s.deathsByDay[day], 1);
    const lessons = fs.readFileSync(path.join(dir, 'lessons.md'), 'utf8');
    assert.match(lessons, /mine → no_path/);
    assert.doesNotMatch(lessons, /slain/, 'a death record is not a failure line; they are different facts');
});

test('the death prompt block stays small: at most eight lines', async () => {
    const { m } = mk();
    for (let i = 0; i < 25; i++) m.noteDeath({ cause: 'was slain by Zombie', weather: 'rain', tod: 6000, at: T0 + i * 1000 });
    assert.equal(m.deathLines().length, 8, 'only the newest eight reach the prompt');
    let prompt = '';
    await m.nightlyConsolidate(async (p) => { prompt = p; return '① a\n\n② b'; });
    assert.match(prompt, /今天死了 8 次/);
});

// #3038: deathLines printed UTC, so a test death at 17:48 local reached her as "09:48" and she wrote a lesson about it.
test('death lines render local time, the same clock the host logs use', () => {
    const { m } = mk();
    const at = 1792921707327;                       // 2026-10-25T09:48:27Z = 17:48 in UTC+8
    m.noteDeath({ cause: 'was killed', weather: '雷雨', tod: 12210, at });
    const [line] = m.deathLines(undefined, 8, { tzOffsetMinutes: 480 });
    assert.match(line, /^17:48 /, `expected local 17:48, got: ${line}`);
    assert.doesNotMatch(line, /09:48/, 'UTC must not leak into her clock');
    const utc = m.deathLines(undefined, 8, { tzOffsetMinutes: 0 })[0];
    assert.match(utc, /^09:48 /, 'an explicit offset still works for tests');
});

test('a scrubbed test death disappears from the prompt, not from the rest of her memory', async () => {
    const { m, dir } = mk();
    m.noteDeath({ cause: 'was slain by Zombie', weather: 'rain', tod: 6000, at: T0 });
    // simulate the scrub: remove the raw death record only
    const rawDir = path.join(dir, 'raw');
    const file = path.join(rawDir, fs.readdirSync(rawDir)[0]);
    const kept = fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.includes('"type":"death"'));
    fs.writeFileSync(file, kept.join('\n'));
    const fresh = new (await import('./index.js')).MemoryS({ dir, now: () => T0 });
    assert.equal(fresh.deathLines().length, 0, 'no death lines after the scrub');
    let prompt = '';
    await fresh.nightlyConsolidate(async (p) => { prompt = p; return '① a\n\n② b'; });
    assert.match(prompt, /\(今天没死\)/, 'the prompt says so instead of inventing one');
});

// #3083: a test bot's words are test data. The deny-list lives in memory, so it holds for both machine inputs.
test('facts and heard lines from a test bot are refused, her own writing is not affected', async () => {
    const { m, dir } = mk();
    assert.equal(m.rememberTaught({ who: 'HouseTest', what: '在 1279,64,1300 一带大量填方块' }), null);
    assert.equal(m.noteHeard({ who: 'HouseTest', text: 'Successfully filled 245 block(s)', at: T0 }), null);
    assert.equal(m.noteHeard({ who: 'FactsTest', text: 'Gave 32 [Dirt] to FactsTest', at: T0 }), null);
    assert.equal(m.noteHeard({ who: 'FakeOwner', text: '我来陪你玩一会', at: T0 }), null);
    assert.equal(m.taughtFacts().length, 0, 'no fact from a test bot');
    assert.equal(m.heardLines(10).length, 0, 'nothing heard from a test bot');
    // a real player still works
    assert.ok(m.rememberTaught({ who: 'JFors', what: '箱子在村庄西边' }));
    assert.ok(m.noteHeard({ who: 'JFors', text: '过来帮我挖两块' }));
    assert.equal(m.taughtFacts().length, 1);
    // and the regex must not swallow names that merely contain a test word
    assert.ok(m.rememberTaught({ who: 'HouseBuilder', what: '我在盖房' }), 'a normal name containing House is fine');
});

// #3114: a malformed "speaker" in the FACTS block must not become a name in her memory.
test('a bare sentence in FACTS does not turn into a speaker name', async () => {
    const { m } = await import('./index.js').then((mod) => ({ m: new mod.MemoryS({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsmem6-')), now: () => T0 }) }));
    const { looksLikeSpeaker } = await import('./index.js');
    assert.equal(looksLikeSpeaker('JFors'), true);
    assert.equal(looksLikeSpeaker('老大'), true);
    assert.equal(looksLikeSpeaker('system'), true);
    assert.equal(looksLikeSpeaker('出生点最高的白桦树下'), false, 'a location phrase is not a speaker');
    assert.equal(looksLikeSpeaker('家'), true, 'a short name is still acceptable');
    assert.equal(looksLikeSpeaker('僵尸说底下三层有钻石'), false, 'a sentence is not a speaker');

    const body = '① a\n\n② b\n\nFACTS:\n- 出生点最高的白桦树下：据说三格内有钻石';
    await m.nightlyConsolidate(async () => body);
    const facts = m.taughtFacts();
    assert.equal(facts.length, 1);
    assert.equal(facts[0].who, 'system', 'the sentence stays as content, not as a speaker');
    assert.match(facts[0].what, /白桦树下/);
});
