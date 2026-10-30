// What an action really changed, measured from her inventory - not what the action's own log says (docs/minebot-diff.md, item C and
// revision ③: the goal, the starting count, the measured count and when it was sampled; "未知" when it cannot be read). The lines are
// appended to the action's result, so they are in her next model input.
import * as mc from '../utils/mcdata.js';
import { inventorySnapshot, inventoryDelta } from './learned_skills.js';
import { logAct } from './dafeiyu_log.js';
import { isCancelledAction } from './action_manager.js';

/** Block names collectBlock(type) will break for this type - the one list both collectBlock and the facts use. */
export function collectTargets(blockType) {
    const types = [blockType];
    if (['coal', 'diamond', 'emerald', 'iron', 'gold', 'lapis_lazuli', 'redstone'].includes(blockType))
        types.push(blockType + '_ore');
    if (blockType.endsWith('ore'))
        types.push('deepslate_' + blockType);
    if (blockType === 'dirt')
        types.push('grass_block');
    if (blockType === 'cobblestone')
        types.push('stone');
    return types;
}

/** Item names breaking those blocks can give, or null when the game data cannot tell. */
export function collectDrops(blockType) {
    if (blockType === 'water' || blockType === 'lava') return [blockType + '_bucket'];
    const targets = collectTargets(blockType), names = new Set();
    try {
        for (const block of mc.getAllBlocks()) {
            if (!targets.includes(block.name)) continue;
            for (const d of block.drops || []) {
                const name = mc.getItemName(typeof d === 'object' ? (d.drop?.id ?? d.id) : d);
                if (name) names.add(name);
            }
        }
    } catch { return null; }
    return names.size ? [...names] : null;
}

const count = (inv, names) => names.reduce((n, name) => n + (inv[name] || 0), 0);
const clock = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

/** One line for !collectBlocks: 目标 +4；起始 0；实测 3；尚差 1；采样 12:00:00. The same numbers go to the log as an [act] line of
 * kind 'facts' (DeepSeek #3010) - with "met", not "ok", so a shortfall is not counted a second time as a failed primitive. */
export function collectFactsLine(blockType, num, before, after, { full = false } = {}) {
    const drops = collectDrops(blockType);
    if (!drops || !before || !after) {
        logAct({ kind: 'facts', action: 'collectBlocks', args: { type: blockType, num }, met: null, unknown: true });
        return `[实测] 收集 ${blockType}：目标 +${num}；背包里对应物品数未知；采样 ${clock()}`;
    }
    const start = count(before, drops), now = count(after, drops), gained = now - start, missing = Math.max(0, num - gained);
    logAct({ kind: 'facts', action: 'collectBlocks', args: { type: blockType, num }, drops, start, now, missing, met: missing === 0, full });
    const what = drops.length === 1 && drops[0] === blockType ? blockType : `${blockType}（掉落物 ${drops.join('/')}）`;
    return `[实测] 收集 ${what}：目标 +${num}；起始 ${start}；实测 ${now}（${gained >= 0 ? '+' : ''}${gained}）；尚差 ${missing}；${fullNote(missing > 0, full)}采样 ${clock()}`;
}

/** How many items one craft gives, from the recipes she had the ingredients for (sticks: 4 from planks, 1 from bamboo); null when
 * those disagree, none fits, or the data cannot tell. */
export function craftYield(itemName, inv = null) {
    try {
        const fits = ([need]) => !inv || Object.entries(need).every(([name, n]) => (inv[name] || 0) >= n);
        const counts = new Set((mc.getItemCraftingRecipes(itemName) || []).filter(fits).map(([, r]) => r.craftedCount));
        return counts.size === 1 ? [...counts][0] : null;
    } catch { return null; }
}

/** One line for !craftRecipe (DeepSeek #3021: "石镐到手" could not be checked - no craft facts): 目标 +4；起始 0；实测 4；尚差 0. */
// 2026-10-26 multiday1: a full inventory made crafted copper leggings and a stone pickaxe drop on the ground by the table. She only
// saw "实测 0" and learned "合成铜护腿会白扣七块铜锭，别再试". When the count falls short and the bag is full, say where it probably went.
const fullNote = (short, full) => (short && full ? '背包已满：做出/挖到的东西可能掉在附近地上，腾出位置再捡；' : '');

export function craftFactsLine(itemName, num, before, after, { full = false } = {}) {
    const per = craftYield(itemName, before), want = per ? per * num : null;
    if (!before || !after) {
        logAct({ kind: 'facts', action: 'craftRecipe', args: { item: itemName, num }, met: null, unknown: true });
        return `[实测] 制作 ${itemName} ×${num} 次：背包里对应物品数未知；采样 ${clock()}`;
    }
    const start = before[itemName] || 0, now = after[itemName] || 0, gained = now - start;
    const missing = want === null ? null : Math.max(0, want - gained);
    const met = want === null ? gained > 0 : missing === 0;
    // GPT #3078: a full bag now refuses the craft before anything is used; "可能掉在地上" would then teach her a loss that never happened.
    const used = Object.entries(inventoryDelta(before, after)).some(([k, d]) => k !== itemName && d < 0);
    const note = !met && full ? (used ? fullNote(true, true) : '背包已满，还没开始做，材料没扣；先腾出位置；') : '';
    logAct({ kind: 'facts', action: 'craftRecipe', args: { item: itemName, num }, per, start, now, missing, met, full, used });
    return `[实测] 制作 ${itemName} ×${num} 次：目标 ${want === null ? '每次产出未知' : '+' + want}；起始 ${start}；实测 ${now}（${gained >= 0 ? '+' : ''}${gained}）；`
        + `${missing === null ? '' : `尚差 ${missing}；`}${note}采样 ${clock()}`;
}

/** Every action: how her inventory changed while it ran - everything, so items picked up on the way count too (she read "+1
 * stone_bricks" from placing cobblestone as the game's books being wrong, DeepSeek #3573). */
/** GPT #3771: "帮我再砍5块" arrived while her !collectBlocks had already gone 18 -> 22; she counted the whole action (+7) and said "5根任务完成，
 * 还多两根" after +3. When someone spoke during the action, the change since that moment is its own line. */
export function heardChangeLine(heard, after) {
    if (!heard?.inv || !after) return null;
    const parts = Object.entries(inventoryDelta(heard.inv, after)).map(([k, d]) => `${d > 0 ? '+' : ''}${d} ${k}`);
    return `[实测] 其中 ${heard.who} 在这个动作进行中说话之后，到结束时背包又变化了：${parts.length ? parts.join('，') : '没有变化'}`;
}

export function inventoryChangeLine(before, after) {
    if (!before || !after) return '[实测] 背包变化未知';
    const delta = inventoryDelta(before, after), parts = Object.entries(delta).map(([k, d]) => `${d > 0 ? '+' : ''}${d} ${k}`);
    return parts.length ? `[实测] 背包变化（这个动作从开始到结束，顺路捡到的也算在内）：${parts.join('，')}` : '[实测] 背包变化：无';
}

// Worn armor and the off hand count too: a crafted piece of armor is equipped at once (armor manager) and would read as "实测 0"
// from the bag alone (GPT #3072). Player window slots 5-8 are head/chest/legs/feet, 45 the off hand.
const WORN = [5, 6, 7, 8, 45];
export const snapshot = (bot) => {
    try {
        const inv = inventorySnapshot(bot);
        for (const i of WORN) { const it = bot.inventory?.slots?.[i]; if (it) inv[it.name] = (inv[it.name] || 0) + it.count; }
        // An item being moved between slots (equip) sits on the cursor and is in no slot: 2026-10-27 she read "-1 stone_pickaxe，-11
        // cobblestone" and then "+11 cobblestone" on the next action (DeepSeek #3573).
        // With a chest open the cursor belongs to that window, not to bot.inventory (GPT #3581) - read the one in use, never both.
        const held = (bot.currentWindow || bot.inventory)?.selectedItem;
        if (held) inv[held.name] = (inv[held.name] || 0) + held.count;
        return inv;
    } catch { return null; }
};

const same = (a, b) => !!a && !!b && Object.keys(inventoryDelta(a, b)).length === 0;
/** The bag once the server's slot updates have stopped arriving: two equal readings 200 ms apart, the first one 200 ms after the
 * action ended (an update can still be on its way then), at most ~1.4 s. Call it inside the action, so the next action cannot start
 * while it waits (GPT #3581); if this action is cancelled meanwhile, the last reading is returned at once. */
export async function settledSnapshot(bot) {
    await new Promise((r) => setTimeout(r, 200));
    let last = snapshot(bot);
    for (let i = 0; i < 6; i++) {
        if (isCancelledAction(bot)) return last;
        await new Promise((r) => setTimeout(r, 200));
        const now = snapshot(bot);
        if (same(last, now)) return now;
        last = now;
    }
    return last;
}
