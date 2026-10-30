// Owner 10-28: "水里会淹死，我们需要给她上浮下潜的能力，给她氧气值，她以后会自己慢慢学会氧气没了就一直上浮……但也不会因为氧气值
// 打断她去探索水下". These are abilities she calls; nothing here runs on its own. Her air is in !stats and in airLine() below.
import { actLogged } from '../dafeiyu_log.js';

const log = (bot, text) => { bot.output = (bot.output || '') + text + '\n'; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const headBlock = (bot) => bot.blockAt(bot.entity.position.offset(0, 1.62, 0));
// 10-29 lab run 4: kelp, seagrass and bubble columns are always in water but are not named "water" - with her head in kelp she was
// told she had reached the shore under open sky, and drowned a second later
export const WATERY = /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/;
export const isWatery = (b) => !!b && (WATERY.test(b.name) || !!b.getProperties?.().waterlogged);
export const headInWater = (bot) => isWatery(headBlock(bot));

/** Owner 10-28 "可以告诉": the nearest cell she could stand on out of the water (solid ground, two free non-water cells above it) within 16
* blocks, as direction, distance and coordinates - a fact; whether and how to go there is hers. '' when none is seen. */
export function nearestShore(bot, r = 16) {
    const p = bot.entity?.position;
    if (!p || !bot.blockAt) return '';
    const free = (b) => !!b && b.boundingBox === 'empty' && !isWatery(b) && b.name !== 'lava';   // a kelp cell is not out of the water
    let best = null;
    const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = 4; dy >= -4; dy--) {
        const d = Math.hypot(dx, dz);
        if (d > r || (best && d >= best.d)) continue;
        const g = bot.blockAt(p.offset(dx, dy, dz).floored());
        if (!g || g.boundingBox !== 'block') continue;
        if (!free(bot.blockAt(g.position.offset(0, 1, 0))) || !free(bot.blockAt(g.position.offset(0, 2, 0)))) continue;
        best = { d, x: fx + dx, y: g.position.y + 1, z: fz + dz, dx, dz };
        break;
    }
    if (!best) return `${r} 格内看不到能站的岸。`;
    const dir = (best.dx > 0 ? '东' : best.dx < 0 ? '西' : '') + (best.dz < 0 ? '北' : best.dz > 0 ? '南' : '') || '脚下';
    return `最近能站的岸在你${dir} ${Math.round(best.d)} 格，(${best.x}, ${best.y}, ${best.z})。`;
}

/** Her air as a fact, or '' when her head is out of the water with full air. 20 = full; each point is about 0.75 s under water. */
export function airLine(bot) {
    const air = bot.oxygenLevel;
    if (!Number.isFinite(air) || (air >= 20 && !headInWater(bot))) return '';
    return `- Air: ${Math.round(air)} / 20` + (headInWater(bot)
        ? ` (your head is under water: air drops about 1 every 0.75 s, so about ${Math.max(0, Math.round(air * 0.75))} s left; at 0 you lose health every second until your head is out. !swimUp swims up)`
        : ' (head out of the water: it refills)');
}

/** Hold jump until her head is out of the water, she hits something above, or max_seconds pass. */
async function _swimUp(bot, max_seconds = 10) {
    if (!headInWater(bot) && !bot.entity.isInWater) { log(bot, 'You are not in water.'); return false; }
    const y0 = bot.entity.position.y, air0 = bot.oxygenLevel, end = Date.now() + max_seconds * 1000;
    bot.pathfinder?.setGoal(null);
    bot.setControlState('sneak', false);
    let lastY = y0, stillSince = Date.now();
    try {
        while (Date.now() < end && headInWater(bot) && !bot.interrupt_code) {
            bot.setControlState('jump', true);
            await wait(100);
            const y = bot.entity.position.y;
            if (y > lastY + 0.05) { lastY = y; stillSince = Date.now(); }
            else if (Date.now() - stillSince > 1500) break;     // not rising: something is over her head
        }
    } finally { bot.setControlState('jump', false); }
    const up = Math.round((bot.entity.position.y - y0) * 10) / 10, above = bot.blockAt(bot.entity.position.offset(0, 2.2, 0))?.name || 'nothing';
    // final-112b 13:4x: the head broke the surface for one bob, this said "out of the water, it refills now", she let go, sank back in
    // water deeper than she is tall and drowned standing still. Out counts only if it is still out after she stops swimming.
    if (!headInWater(bot)) {
        await wait(700);
        // final-113 14:0x: 0.7 s after a jump the head was still up from the momentum, this said "stays out", she said "上岸了" and sank
        // in the 20 s she rested. Out means standing on something, or water under her feet only (wading) - not floating on deep water.
        const feet = bot.blockAt(bot.entity.position.floored());
        const under = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
        const floating = !bot.entity.onGround && /water/.test(feet?.name || '') && /water/.test(under?.name || '');
        if (headInWater(bot) || floating) {
            log(bot, (headInWater(bot)
                ? `Your head came up for a moment but went back under as soon as you stopped swimming (air ${Math.round(bot.oxygenLevel)} / 20): the water here is deeper than you are tall. `
                : `Your head is above the water for now, but you are floating on deep water with nothing under your feet (air ${Math.round(bot.oxygenLevel)} / 20) - you are NOT on land. When you stop swimming you sink. `)
                + 'Standing still here you drown - keep swimming up (!swimUp), swim to a shore or a block you can stand on, or place a block under you. ' + nearestShore(bot));
            // DeepSeek #4073: floating with the head up is the swim-up done (ok in the record); only a head back under is a failure
            return !headInWater(bot);
        }
        log(bot, `Swam up ${up} blocks; your head is out of the water and stays out (air ${Math.round(air0)} -> ${Math.round(bot.oxygenLevel)} / 20, it refills now).`);
        return true;
    }
    log(bot, `Swam up ${up} blocks but your head is still under water (air ${Math.round(bot.oxygenLevel)} / 20).`
        + (Date.now() < end ? ` You stopped rising: above your head is ${above}. Swim sideways to open water, or dig it.` : ` ${max_seconds} s were not enough; keep swimming up.`));
    return false;
}

/** Hold sneak (sinks in water) for the given seconds, or until she stands on the bottom. */
async function _swimDown(bot, seconds = 3) {
    if (!bot.entity.isInWater && !headInWater(bot)) { log(bot, 'You are not in water.'); return false; }
    const y0 = bot.entity.position.y, end = Date.now() + seconds * 1000;
    bot.pathfinder?.setGoal(null);
    bot.setControlState('jump', false);
    try {
        while (Date.now() < end && !bot.interrupt_code) {
            bot.setControlState('sneak', true);
            await wait(100);
            if (bot.entity.onGround) break;
        }
    } finally { bot.setControlState('sneak', false); }
    const down = Math.round((y0 - bot.entity.position.y) * 10) / 10;
    log(bot, `Sank ${down} blocks${bot.entity.onGround ? ' and reached the bottom' : ''}. ${airLine(bot).replace(/^- /, '') || 'Air 20 / 20.'}`);
    return true;
}

export const swimUp = actLogged('swim_up', _swimUp, ['max_seconds']);
export const swimDown = actLogged('swim_down', _swimDown, ['seconds']);

/** Owner 10-28: once per dive, at half air, she is told - whether or not an action runs (final-113 14:0x: she rested 20 s after a
* turn with no command and sank in that time with nothing telling her). Told only; nothing is stopped or moved. */
export function attachAirWatch(agent) {
    const bot = agent.bot;
    if (bot._airWatch) return;
    let told = false;
    bot._airWatch = setInterval(() => {
        if (!bot.entity) return;
        if (!headInWater(bot)) { told = false; return; }
        if (told || !(bot.oxygenLevel <= 10)) return;
        told = true;
        const air = Math.round(bot.oxygenLevel), label = String(agent.actions?.currentActionLabel || '').replace(/^action:/, '!');
        console.warn(`Head under water, air ${air}/20${label ? ` during ${label}` : ''} - told, not stopped.`);
        agent.handleMessage('system', `（提醒）（你现在头在水下：氧气 ${air}/20，大约还有 ${Math.max(0, Math.round(air * 0.75))} 秒，到 0 开始掉血。!swimUp 往上游。）`
            + nearestShore(bot) + (label ? `你正在做的 ${label} 没有停，` : '') + '要不要上去你自己定。', 1)?.catch?.(() => {});
    }, 1000);
}
