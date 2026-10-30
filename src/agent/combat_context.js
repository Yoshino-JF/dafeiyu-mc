// What else was true when an encounter began, the same for her own !fight and for the self_defense reflex (owner 10-26: she should be
// able to find out for herself whether striking first saves health; DeepSeek #3380 for the definitions). Facts only.
import fs from 'fs';
import path from 'path';
import * as mc from '../utils/mcdata.js';
import { isAlive } from './library/world.js';

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

// While the combat arena runs (dev/arena.mjs, owner 10-26: "战斗测试可以考虑走战斗场地专测") it writes bots/<name>/arena.json; fights
// recorded then carry context 'arena' and the round, so the arena is never counted as her natural play.
function arenaContext(name) {
    try {
        const p = path.join('./bots', name, 'arena.json'), a = JSON.parse(fs.readFileSync(p, 'utf8'));
        return a?.on && Date.now() - (a.at || 0) < 2 * 3600 * 1000 ? { context: 'arena', arenaRound: a.round ?? null } : { context: 'natural' };
    } catch { return { context: 'natural' }; }
}

/** Taken at the start: confounders plus the two "who struck first" facts. */
export function combatStart(bot, target) {
    const now = Date.now(), me = bot.entity.position, tod = bot.time?.timeOfDay;
    const before = (bot.recentDamage || []).filter((d) => now - d.at <= 3000);
    return {
        startedAt: now,
        hadFood: bot.inventory.items().some((i) => bot.registry.foodsByName?.[i.name]),
        hostileCount: Object.values(bot.entities || {}).filter((e) => e !== bot.entity && mc.isHostile(e) && isAlive(bot, e) && e.position?.distanceTo(me) < 16).length,
        dimension: bot.game?.dimension, startY: Math.round(me.y),
        isNight: Number.isFinite(tod) ? tod >= 13000 && tod < 23000 : null,
        // damage she really took in the 3 s before this encounter began (0 = she was not being hit: a first strike)
        hurtBeforeStart: Math.round(before.reduce((s, d) => s + d.amount, 0) * 10) / 10,
        openingDistance: target?.position ? Math.round(flat(target.position, me) * 10) / 10 : null,
        ...arenaContext(bot.username),
    };
}

/** ms from the start of the encounter to the first damage she took in it; null when she was never hit. */
export function firstHurtMs(bot, startedAt) {
    const first = (bot.recentDamage || []).find((d) => d.at >= startedAt);
    return first ? first.at - startedAt : null;
}
