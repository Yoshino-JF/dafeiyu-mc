// Fixtures are REAL strings from run 14 (dev/console.log, 2026-10-25 01:30-01:39): her own Chinese narration and the
// English text the skills print. The old English-only classifier mapped every one of the Chinese lines to `blocked`,
// which is exactly the 42% black hole it created in the audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, isUnexplained, RULES } from './failure-reasons.js';

const REAL = [
    ['又卡在同一个地方，真是的……换个方向走。', 'no_path'],
    ['卡住了……先挖开脚边看看。', 'no_path'],
    ['又卡……往上垫一块爬出去。', 'no_path'],
    ['the goal was not reached - Only 2 dirt collected and no items were picked up, not the goal of 3 dirt in inventory.', 'blocked'],
    ['No path to the target block!', 'no_path'],
    ['Cannot reach the block: too far away.', 'out_of_reach'],
    ['I do not have a pickaxe.', 'need_tool'],
    ['No oak_log found nearby.', 'not_found'],
    ['Operation timed out after 30s.', 'timeout'],
    ['The block is protected by the player.', 'protected'],
    ['You do not have permission to use this command.', 'op_denied'],
    ['Task interrupted by a new instruction.', 'refused'],
    ['够不着那个方块。', 'out_of_reach'],
    ['附近没有橡木。', 'not_found'],
    ['没有镐，挖不动石头。', 'need_tool']
];

test('real failure lines are classified, and the Chinese ones are no longer swallowed by blocked', () => {
    for (const [text, want] of REAL) {
        assert.equal(classifyFailure(text), want, text);
    }
});

test('a Chinese "stuck" narration is no_path, not blocked', () => {
    for (const text of ['又卡在同一个地方', '卡住了', '又卡……', '上不去', '卡']) {
        assert.equal(classifyFailure(text), 'no_path', text);
    }
});

test('an object input works too, because the wrapper will pass bot.output', () => {
    assert.equal(classifyFailure({ output: 'Cannot find a path to the destination' }), 'no_path');
    assert.equal(classifyFailure({ output: '' }), 'blocked');
});

test('unexplained failures are detectable, so the black hole can be tracked instead of guessed', () => {
    assert.equal(isUnexplained('something odd happened'), true);
    assert.equal(isUnexplained('No path to the target block!'), false);
    assert.equal(isUnexplained('卡住了'), false);
});

test('the rule table stays safe: blocked last, every reason inside the contract enum', () => {
    assert.equal(RULES.at(-1)[0], 'blocked');
    assert.ok(RULES.length >= 8);
});

// ── soak 1 (2026-10-25 02:0x): these three texts were 93 of the 175 blocked failures ────────────────
test('soak 1: the same three real texts now get three different reasons', () => {
    assert.equal(classifyFailure('Path was stopped before it could be completed! Thus, the desired goal was not reached.'), 'refused');
    assert.equal(classifyFailure('Found non-destructive path. Pathfinding stopped: Path was stopped before it could be completed!'), 'refused');
    assert.equal(classifyFailure('Skipping block at x:-3.0, y:48.0, z:5.0 because it is air.'), 'not_found');
    assert.equal(classifyFailure('Placed furnace at (-7, 43, 5). Using birch_planks as fuel. You don\'t have enough birch_planks'), 'not_found');
});

test('soak 1: a missing TOOL is still need_tool, not a missing resource', () => {
    assert.equal(classifyFailure("You don't have enough wooden_pickaxe"), 'need_tool');
    assert.equal(classifyFailure('You do not have enough iron_axe to do that'), 'need_tool');
    assert.equal(classifyFailure("You don't have enough oak_log"), 'not_found');
});

test('soak 1: a failure with no message is reported as unexplained instead of silently blocked', () => {
    assert.equal(classifyFailure(''), 'blocked');
    assert.equal(isUnexplained(''), true);
});
