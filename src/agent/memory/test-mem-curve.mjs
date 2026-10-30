// Regressions for dev/mem-curve.mjs (GPT #3455). They pin the two shapes the report must never confuse:
// a spike that falls back (transient) versus a climb that stays (retention).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSamples, slopePerMinute, analyse } from '../../../dev/mem-curve.mjs';

const T = 1_800_000_000_000;
const MIN = 60_000;
const line = (i, heapUsed, action = 'action:stay', extra = {}) =>
    `[lifecycle] ${JSON.stringify({ at: T + i * MIN, event: 'mem', rss: heapUsed + 100, heapUsed, heapTotal: heapUsed + 20, external: 14, action, entities: 150, ...extra })}`;

test('only mem lines are parsed, and they come back in time order', () => {
    const lines = [line(1, 110), '[lifecycle] {"at":1,"event":"spawn","name":"DaFeiYu"}', line(0, 100), '[act] {"at":2,"kind":"chat"}'];
    const s = parseSamples(lines);
    assert.equal(s.length, 2);
    assert.equal(s[0].heapUsed, 100);
    assert.equal(s[1].heapUsed, 110);
});

test('a sawtooth that always falls back is a transient, not retention', () => {
    const lines = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => line(i, i % 2 ? 130 : 100));
    const out = analyse(parseSamples(lines));
    assert.match(out.retention.note, /transient/);
    assert.equal(out.retention.peaks > 0, true);
});

test('a climb that never comes back down is reported as retained', () => {
    const lines = [0, 1, 2, 3, 4, 5].map((i) => line(i, 100 + i * 10));
    const out = analyse(parseSamples(lines));
    assert.equal(out.retention.recovered, 0);
    assert.match(out.retention.note, /did not return/);
});

test('the slope is positive for a climb and near zero for a flat series', () => {
    const up = parseSamples([0, 1, 2, 3].map((i) => line(i, 100 + i * 10)));
    assert.equal(slopePerMinute(up, 'heapUsed') > 5, true);
    const flat = parseSamples([0, 1, 2, 3].map((i) => line(i, 100)));
    assert.equal(Math.abs(slopePerMinute(flat, 'heapUsed')) < 0.001, true);
});

test('big moves are listed with the action that was running', () => {
    const lines = [line(0, 100), line(1, 140, 'action:viewChest'), line(2, 100)];
    const out = analyse(parseSamples(lines));
    const first = out.deltas.big[0];
    assert.equal(first.d, 40);
    assert.equal(first.action, 'action:viewChest');
});

test('per-action peaks point at the biggest allocator', () => {
    const lines = [line(0, 100, 'action:stay'), line(1, 144, 'action:viewChest'), line(2, 120, 'action:collectBlocks')];
    const out = analyse(parseSamples(lines));
    assert.equal(out.actions[0].action, 'action:viewChest');
    assert.equal(out.actions[0].max, 144);
});
