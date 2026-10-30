// Regressions for dev/three-day-report.mjs (Claude #3493). The day segmentation is the part that must not be wrong:
// a report that mixes two game days, or that silently mixes arena records into natural play, is worse than no report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { daySpans, dayOf, buildReport, memoryDayOffset } from '../../../dev/three-day-report.mjs';

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const dawn = (day, at) => ({ tag: 'lifecycle', event: 'dawn', day, prevDay: day - 1, at });
const combat = (at, o = {}) => ({
    tag: 'combat', at, caller: 'her', target: { name: 'zombie', id: 1 }, tactic: 'melee', result: 'killed',
    hits: 4, swings: 5, startHp: 18, endHp: 16, damageTaken: 2, seconds: 4, armed: true, weapon: 'iron_sword',
    hostileCount: 1, startY: 64, isNight: false, context: 'natural', styleVersion: 1, style: { tactic: 'melee' }, ...o
});
const act = (at, kind, o = {}) => ({ tag: 'act', at, kind, ok: true, ...o });

test('days come from the dawn records, not from a 20 minute assumption', () => {
    const spans = daySpans([dawn(20, T0), dawn(21, T0 + 40 * MIN), dawn(22, T0 + 45 * MIN)]);
    assert.deepEqual(spans.map((s) => s.day), [20, 21, 22]);
    assert.equal(spans[0].to, T0 + 40 * MIN);
    assert.equal(dayOf(spans, T0 + 10 * MIN), 20);
    // a forty minute day (fast forwarded night) still segments correctly
    assert.equal(dayOf(spans, T0 + 41 * MIN), 21);
});

test('an event before the first dawn belongs to no day instead of the wrong one', () => {
    const spans = daySpans([dawn(20, T0)]);
    assert.equal(dayOf(spans, T0 - 1000), null);
});

test('arena records never reach the natural-play numbers', () => {
    const out = buildReport({
        events: [dawn(20, T0), combat(T0 + MIN, { context: 'natural' }), combat(T0 + 2 * MIN, { context: 'arena' }), combat(T0 + 3 * MIN, { context: 'arena', result: 'lost' })],
        deaths: [], styleChanges: [], memoryUpdates: [], since: T0
    });
    assert.equal(out.days[0].encounters.total, 1);
    assert.equal(out.arena.n, 2);
    assert.equal(out.arena.outcomes.lost, 1);
});

test('reflex fights and below-line retreats are counted, not folded into her own fights', () => {
    const out = buildReport({
        events: [dawn(20, T0),
            combat(T0 + MIN, { caller: 'her' }),
            combat(T0 + 2 * MIN, { caller: 'self_defense', trigger: 'hit' }),
            combat(T0 + 3 * MIN, { caller: 'her', result: 'disengaged', tactic: 'below_line' })],
        deaths: [], styleChanges: [], memoryUpdates: [], since: T0
    });
    const d = out.days[0];
    assert.equal(d.encounters.total, 3);
    assert.equal(d.encounters.her, 2);
    assert.equal(d.encounters.reflex, 1);
    assert.equal(d.belowLine, 1);
});

test('deaths are reported with cause and per minute', () => {
    const out = buildReport({
        events: [dawn(20, T0), dawn(21, T0 + 20 * MIN)],
        deaths: [{ at: T0 + 5 * MIN, cause: 'was shot by Skeleton' }, { at: T0 + 6 * MIN, cause: 'was shot by Skeleton' }, { at: T0 + 7 * MIN, cause: 'fell from a high place' }],
        styleChanges: [], memoryUpdates: [], since: T0
    });
    const d = out.days[0];
    assert.equal(d.deaths.n, 3);
    assert.equal(d.deaths.byCause['was shot by Skeleton'], 2);
    assert.equal(d.deaths.perMinute > 0, true);
});

test('her fight count comes from combat records because fight writes no act line', () => {
    const out = buildReport({
        events: [dawn(20, T0),
            combat(T0 + MIN, { result: 'killed' }),
            combat(T0 + 2 * MIN, { result: 'refused', reason: 'no_target' }),
            act(T0 + 3 * MIN, 'shoot', { targetHpBefore: 20, targetHpAfter: 12, arrowsSpent: 1 })],
        deaths: [], styleChanges: [], memoryUpdates: [], since: T0
    });
    const d = out.days[0];
    assert.equal(d.commands.fight.n, 2);
    assert.equal(d.commands.fight.ok, 1);
    assert.equal(d.commands.shoot.n, 1);
    assert.equal(d.commands.shoot.hits, 1);
});

test('an approach notice counts as verified only if something really closed or reacted', () => {
    const notice = (at, why) => ({ tag: 'decision', at, gate: 'approach', chosen: 'notice', why });
    const out = buildReport({
        events: [dawn(20, T0),
            notice(T0 + MIN, 'skeleton 24m approaching'),
            notice(T0 + MIN + 5000, 'skeleton 18m approaching'),        // closer: verified
            notice(T0 + 2 * MIN, 'zombie 20m approaching')],             // never confirmed
        deaths: [], styleChanges: [], memoryUpdates: [], since: T0
    });
    const d = out.days[0];
    // three notices in the day; only the first has a confirmed closer one after it
    assert.equal(d.approach.n, 3);
    assert.equal(d.approach.verified, 1);
    assert.equal(d.approach.rate, 33.3);
});

test('style changes are listed with the value she chose', () => {
    const out = buildReport({
        events: [dawn(20, T0)],
        deaths: [], memoryUpdates: [], since: T0,
        styleChanges: [{ at: T0 + MIN, mob: 'skeleton', key: 'disengageHp', from: 10, to: 8 }]
    });
    assert.deepEqual(out.days[0].styleChanges, ['skeleton.disengageHp: 10→8']);
});

test('memory rewrites are never attributed to a day from an untimestamped log', () => {
    const out = buildReport({ events: [dawn(20, T0)], deaths: [], styleChanges: [], memoryUpdates: [], since: T0 });
    assert.equal(out.days[0].memoryRewrites, null);
});

test('the memory day counter is offset from the dawn counter, and the offset is measured not assumed', () => {
    const spans = daySpans([dawn(17, T0), dawn(18, T0 + 20 * MIN)]);
    // her memory counted 54 on the first day and 55 on the second
    const stories = [{ at: T0 + MIN, day: 54 }, { at: T0 + 21 * MIN, day: 55 }];
    assert.equal(memoryDayOffset(stories, spans), 37);
    const out = buildReport({ events: [dawn(17, T0), dawn(18, T0 + 20 * MIN)], deaths: [], styleChanges: [], memoryUpdates: [], stories, since: T0 });
    assert.deepEqual(out.days.map((d) => [d.day, d.memoryDay]), [[17, 54], [18, 55]]);
});

test('with no story records the offset stays zero instead of inventing one', () => {
    assert.equal(memoryDayOffset([], daySpans([dawn(17, T0)])), 0);
});

test('below-line retreat is counted from the tactic and says so when it never happened', () => {
    const stayHit = (at) => ({ tag: 'decision', at, gate: 'danger', chosen: 'notice', options: ['notice'], why: 'zombie hit reflex' });
    const out = buildReport({
        events: [dawn(19, T0),
            combat(T0 + MIN, { tactic: 'below_line', result: 'disengaged', damageTaken: 3, seconds: 2 }),
            combat(T0 + 2 * MIN, { tactic: 'melee' })],
        deaths: [], styleChanges: [], memoryUpdates: [], since: T0
    });
    assert.equal(out.days[0].belowLine, 1);
    assert.equal(out.days[0].belowLineDetail[0].mob, 'zombie');
    assert.deepEqual(out.days[0].hidden.filter((h) => h.startsWith('below-line')), []);
    assert.equal(out.days[0].hidden.some((h) => h.startsWith('staying')), true, 'no stay evidence yet');
});

test('being hit while staying counts only inside a stay window', () => {
    const stay = (at, seconds) => ({ tag: 'act', at, kind: 'stay', ok: true, args: { seconds } });
    const hit = (at, why) => ({ tag: 'decision', at, gate: 'danger', chosen: 'notice', options: ['notice'], why });
    const out = buildReport({
        events: [dawn(19, T0),
            stay(T0 + MIN, 60),
            hit(T0 + MIN + 5000, 'zombie hit reflex'),        // inside the window: counts
            hit(T0 + MIN + 70000, 'zombie hit reflex')],       // after it ended: does not
        deaths: [], styleChanges: [], memoryUpdates: [], since: T0
    });
    const d = out.days[0];
    assert.equal(d.staying.windows, 1);
    assert.equal(d.staying.hitsWhileStaying, 1);
    assert.equal(d.staying.examples.length, 1);
    assert.deepEqual(d.hidden.filter((h) => h.startsWith('staying')), []);
});

test('a reflex fight inside a stay window also proves the counterattack happened', () => {
    const stay = { tag: 'act', at: T0 + MIN, kind: 'stay', ok: true, args: { seconds: 90 } };
    const out = buildReport({
        events: [dawn(19, T0), stay, combat(T0 + MIN + 9000, { caller: 'self_defense', trigger: 'hit' })],
        deaths: [], styleChanges: [], memoryUpdates: [], since: T0
    });
    assert.equal(out.days[0].staying.reflexWhileStaying, 1);
});

test('sleep attempts are counted with their failures, and waking is inferred from the next action', () => {
    const sleep = (at, ok = true, reason) => ({ tag: 'act', at, kind: 'sleep', ok, reason, args: {} });
    const out = buildReport({
        events: [dawn(23, T0),
            sleep(T0 + MIN, false, 'refused'),
            sleep(T0 + 3 * MIN, true),
            act(T0 + 3 * MIN + 20000, 'goto')],
        deaths: [], styleChanges: [], memoryUpdates: [], since: T0
    });
    const s = out.days[0].sleep;
    assert.equal(s.attempts, 2);
    assert.equal(s.ok, 1);
    assert.equal(s.failed.length, 1);
    assert.equal(s.failed[0].reason, 'refused');
    assert.equal(s.wokeUp, 1);
});

test('the four block creeper stop records what she chose next, including doing nothing', () => {
    const stop = (at) => ({ tag: 'decision', at, gate: 'danger', chosen: 'notice', options: ['notice'], why: 'creeper 4m close stop' });
    const out = buildReport({
        events: [dawn(23, T0),
            stop(T0 + MIN), act(T0 + MIN + 3000, 'retreat'),          // run
            stop(T0 + 5 * MIN), act(T0 + 5 * MIN + 2000, 'attack'),    // fight
            stop(T0 + 9 * MIN), act(T0 + 9 * MIN + 1000, 'place'),     // wall
            stop(T0 + 13 * MIN)],                                      // nothing
        deaths: [], styleChanges: [], memoryUpdates: [], since: T0
    });
    const c = out.days[0].closeStop;
    assert.equal(c.n, 4);
    assert.deepEqual(c.choices, { run: 1, fight: 1, wall: 1, nothing: 1 });
    assert.equal(c.examples[0].choice, 'run');
});

test('a chat line is not a choice: talking is not acting on the stop', () => {
    const stop = { tag: 'decision', at: T0 + MIN, gate: 'danger', chosen: 'notice', options: ['notice'], why: 'creeper 3m close stop' };
    const out = buildReport({
        events: [dawn(23, T0), stop, act(T0 + MIN + 1000, 'chat', { args: { text: '苦力怕贴脸了' } })],
        deaths: [], styleChanges: [], memoryUpdates: [], since: T0
    });
    assert.deepEqual(out.days[0].closeStop.choices, { nothing: 1 });
});

test('a stopped action is counted as stopped, and a failed choice is not reported as a clean response', () => {
    const stop = (at) => ({ tag: 'decision', at, gate: 'danger', chosen: 'notice', options: ['notice'], why: 'creeper 3m close stop' });
    const out = buildReport({
        events: [dawn(23, T0),
            stop(T0 + MIN), { tag: 'act', at: T0 + MIN + 500, kind: 'goto', ok: false, reason: 'refused' }],
        deaths: [], styleChanges: [], memoryUpdates: [], since: T0
    });
    const c = out.days[0].closeStop;
    assert.equal(c.n, 1);
    assert.equal(c.stoppedHer, 1);
    assert.equal(c.notStopped, 0);
    assert.deepEqual(c.choices, { run: 1 });
    assert.deepEqual(c.choicesFailed, { run: 1 }, 'her run was refused: that is not a clean response');
});

test('an adjudicated defect is labelled on the day it happened', () => {
    const out = buildReport({ events: [dawn(23, T0)], deaths: [], styleChanges: [], memoryUpdates: [], since: T0 });
    // KNOWN_DEFECTS covers the final-18 19:19 incident, which is not in this synthetic day
    assert.equal(Array.isArray(out.days[0].defects), true);
});

test('every reflex toggle is recorded with what she said around it', () => {
    const mode = (at, on) => ({ tag: 'act', at, kind: 'mode', ok: true, args: { mode: 'self_defense', on } });
    const chat = (at, text) => ({ tag: 'act', at, kind: 'chat', ok: true, args: { text } });
    const out = buildReport({
        events: [dawn(25, T0), mode(T0 + MIN, false), chat(T0 + MIN + 2000, '跟它硬碰纯送命')],
        deaths: [], styleChanges: [], memoryUpdates: [], since: T0
    });
    const t = out.days[0].toggles;
    assert.equal(t.length, 1);
    assert.equal(t[0].on, false);
    assert.match(t[0].said, /硬碰/);
});

test('each death records whether the reflex was on at that moment', () => {
    const mode = (at, on) => ({ tag: 'act', at, kind: 'mode', ok: true, args: { mode: 'self_defense', on } });
    const out = buildReport({
        events: [dawn(25, T0), mode(T0 + MIN, false)],
        deaths: [{ at: T0 + 5 * MIN, cause: 'was slain by Zombie' }, { at: T0 + 8 * MIN, cause: 'fell from a high place' }],
        styleChanges: [], memoryUpdates: [], since: T0
    });
    const d = out.days[0].deathsState;
    assert.equal(d.length, 2);
    assert.equal(d[0].reflexOn, false);
    assert.equal(d[1].reflexOn, false);
});

test('a self_preservation takeover records whether she ate and how far the mob was next', () => {
    const takeover = { tag: 'decision', at: T0 + MIN, gate: 'danger', chosen: 'self_preservation', options: ['self_preservation'], why: 'Respond to damage' };
    const out = buildReport({
        events: [dawn(25, T0), takeover,
            act(T0 + MIN + 5000, 'eat', { ok: true }), { tag: 'decision', at: T0 + MIN + 12000, gate: 'danger', chosen: 'notice', options: ['notice'], why: 'zombie 7m' }],
        deaths: [], styleChanges: [], memoryUpdates: [], since: T0
    });
    const t = out.days[0].takeovers;
    assert.equal(t.length, 1);
    assert.equal(t[0].ateWithin30s, true);
    assert.equal(t[0].nextDangerDistance, 7);
});

test('retargeting is counted from the receipt, and the interrupt rate sits beside it', () => {
    const fight = (at, o) => combat(at, o);
    const out = buildReport({
        events: [dawn(32, T0),
            fight(T0 + MIN, { retargets: 2, targets: [{ name: 'zombie' }, { name: 'creeper' }], threatTrigger: 'creeper_near_or_fuse', result: 'killed' }),
            fight(T0 + 2 * MIN, { retargets: 0, targets: [{ name: 'zombie' }], threatTrigger: null, result: 'interrupted' }),
            fight(T0 + 3 * MIN, { retargets: 1, targets: [{ name: 'skeleton' }], threatTrigger: 'confirmed_self_hurt', result: 'disengaged' })],
        deaths: [], styleChanges: [], memoryUpdates: [], since: T0
    });
    const d = out.days[0];
    assert.equal(d.retarget.recordsWithField, 3);
    assert.equal(d.retarget.withRetargets, 2);
    assert.equal(d.retarget.totalRetargets, 3);
    assert.equal(d.retarget.multiTarget, 1);
    assert.deepEqual(d.retarget.outcomes, { killed: 1, disengaged: 1 });
    assert.equal(d.retarget.threats.creeper_near_or_fuse, 1);
    assert.equal(d.retarget.threats.confirmed_self_hurt, 1);
    assert.equal(d.retarget.threats.none, 1);
    assert.equal(d.interruptRate, 33.3);
});

test('a day with no fights reports no interrupt rate instead of zero', () => {
    const out = buildReport({ events: [dawn(32, T0)], deaths: [], styleChanges: [], memoryUpdates: [], since: T0 });
    assert.equal(out.days[0].interruptRate, null);
    assert.equal(out.days[0].retarget.withRetargets, 0);
});

test('deaths are counted from lifecycle events, not from the raw file', () => {
    // The raw file stopped recording deaths at 07:19 while lifecycle kept emitting them. Counting only raw under-reported
    // seven deaths in one night and made a bad hour look clean. The count of record is the lifecycle event.
    const life = (at) => ({ tag: 'lifecycle', event: 'death', at });
    const out = buildReport({
        events: [dawn(89, T0), life(T0 + MIN), life(T0 + 2 * MIN), life(T0 + 3 * MIN)],
        deaths: [{ at: T0 + MIN, cause: 'was slain by Zombie' }],   // only one has a cause
        styleChanges: [], memoryUpdates: [], since: T0
    });
    const d = out.days[0];
    assert.equal(d.deaths.n, 3);
    assert.equal(d.deaths.byCause['was slain by Zombie'], 1);
    assert.equal(d.deaths.byCause.unknown, 2);
});

test('a death with no matching raw record still appears with an unknown cause', () => {
    const out = buildReport({
        events: [dawn(89, T0), { tag: 'lifecycle', event: 'death', at: T0 + MIN }],
        deaths: [], styleChanges: [], memoryUpdates: [], since: T0
    });
    assert.equal(out.days[0].deaths.n, 1);
    assert.equal(out.days[0].deathsState[0].cause, 'unknown');
});
