// Ways out when she is stuck (owner 2026-10-26: "卡住几分钟 ... 建议她搭方块/挖出来/迫不得已传送至地表"). Same order the owner set for
// the old project: walk, then dig / pillar through natural blocks, a teleport only as the last resort and said aloud first. These are
// abilities she may use; stuck_hints.js only suggests them as time goes by - nothing here is triggered for her.
import Vec3 from 'vec3';
import { actLogged } from '../dafeiyu_log.js';

const log = (bot, text) => { bot.output = (bot.output || '') + text + '\n'; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const solid = (b) => !!b && b.boundingBox === 'block';
const liquid = (b) => !!b && /water|lava/.test(b.name);
const PILLAR_BLOCKS = ['dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff', 'gravel', 'sand'];

/** Nothing solid over her head up to the build limit (or the loaded world): she is out. */
export function openSky(bot, from = bot.entity.position) {
    const top = (bot.game.minY ?? -64) + (bot.game.height ?? 384) - 1;
    for (let y = Math.floor(from.y) + 2; y <= top; y++) {
        const b = bot.blockAt(new Vec3(Math.floor(from.x), y, Math.floor(from.z)), false);
        if (!b) return true;          // not loaded that high: nothing seen in the way
        if (solid(b) || liquid(b)) return false;
    }
    return true;
}

/**
 * Owner 10-28: back at "林地小屋" she was told only "头顶是露天的" and took it as "inside, the roof is missing" - she has a roofless hut,
 * so open sky alone does not say in or out. What is around her: sky, which of the four sides has a wall within 6 blocks at head
 * height, the nearest door; in or out only from the record of a house of hers (owner 10-29).
 */
export function surroundingsFact(bot) {
    const p = bot.entity.position.floored(), head = p.y + 1;
    const sky = openSky(bot);
    const sides = [['东', 1, 0], ['南', 0, 1], ['西', -1, 0], ['北', 0, -1]].map(([name, dx, dz]) => {
        for (let d = 1; d <= 6; d++) if (solid(bot.blockAt(new Vec3(p.x + dx * d, head, p.z + dz * d), false))) return { name, d };
        return { name, d: 0 };
    });
    const walled = sides.filter((s) => s.d);
    const wallText = walled.length ? walled.map((s) => `${s.name}边 ${s.d} 格`).join('、') + '有墙或方块' : '四面 6 格内都没有墙';
    // owner 10-29 ("永远不要把周围的形态当成什么判断条件，周围环境是不可能完全涵盖的"; "记录内部范围，进去就是家出去就不是"): in or out
    // is said only from the record of a house of hers. The roof and walls around her are told as facts and never turned into a verdict.
    let verdict = '。';
    const at = bot.ownHousePlace?.(p), nm = at ? `「${at.house.name}」` : '';
    if (at?.where === 'inside') verdict = `——你在你的${nm}屋里。`;
    else if (at?.where === 'door') verdict = `——你正站在${nm}的门口（门那一格），往屋里是 ${at.house.inside ? `(${at.house.inside.x}, ${at.house.inside.y}, ${at.house.inside.z})` : '门的另一侧'}。`;
    else if (at?.where === 'outside') {
        // owner 10-29 ("现在又站在门口了，回不去家"): she walked to the door cell itself with min_distance 1 and stopped outside it. Where
        // inside is, and the walk that ends there, are part of the fact.
        const d = at.house.door, i = at.house.inside;
        verdict = `——你在${nm}外面（屋檐下、墙边都不算屋里）${d ? `，它的门在 (${d.x}, ${d.y}, ${d.z})` : ''}${i ? `，进门后屋里第一格是 (${i.x}, ${i.y}, ${i.z})（走到那一格才算进屋；!goToRememberedPlace("home") 就走到那儿）` : ''}。`;
    }
    let door = '';
    let best = null;
    for (let dx = -8; dx <= 8; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -8; dz <= 8; dz++) {
        const b = bot.blockAt(new Vec3(p.x + dx, p.y + dy, p.z + dz), false);
        if (!b || !/_door$/.test(b.name) || b.getProperties?.().half === 'upper') continue;
        const dist = Math.hypot(dx, dz);
        if (!best || dist < best.dist) best = { b, dx, dz, dist };
    }
    if (best) {
        const dir = (Math.abs(best.dx) >= Math.abs(best.dz) ? (best.dx > 0 ? '东' : '西') : (best.dz > 0 ? '南' : '北'));
        const pos = best.b.position;
        door = `最近的门在你${best.dist < 1 ? '脚下这格' : `${dir}边约 ${Math.round(best.dist)} 格`} (${pos.x}, ${pos.y}, ${pos.z})，${best.b.getProperties?.().open ? '开着' : '关着'}。`;
    }
    return `（头顶${sky ? '露天' : '有东西遮着'}；${wallText}${verdict}${door}）`;
}

/** Dig the block over her head and stand on a block placed where her feet were, until the sky is open. */
async function climb(bot, max_blocks) {
    const end = Date.now() + 3 * 60 * 1000;
    let climbed = 0;
    for (let i = 0; i < Math.min(128, max_blocks); i++) {
        if (bot.interrupt_code) { log(bot, 'Pillaring up interrupted.'); return false; }
        if (Date.now() > end) { log(bot, `Pillaring up timed out after climbing ${climbed}.`); return false; }
        if (openSky(bot)) {
            // 3-day run 10-26: she used it to wall herself in at night while already outside, read "after climbing 0 blocks" and
            // concluded "没往上走反而往下了一点……这地方有古怪". Say plainly that there was nothing to climb.
            if (climbed === 0) log(bot, `Already under open sky (y=${Math.floor(bot.entity.position.y)}): nothing to climb, nothing was placed. pillarUp only gets you out from underground - to wall yourself in, place blocks around you (!placeHere or your own code).`);
            else log(bot, `Out in the open after climbing ${climbed} blocks (y=${Math.floor(bot.entity.position.y)}).`);
            return true;
        }
        const p = bot.entity.position.floored();
        // A jump needs two free cells over her head (2026-10-26: in a 3-high room the ceiling at +3 capped the jump and nothing could be placed).
        const over = [bot.blockAt(p.offset(0, 2, 0)), bot.blockAt(p.offset(0, 3, 0))];
        const wet = over.find(liquid);
        if (wet && /lava/.test(wet.name)) { log(bot, 'There is lava right above - stopped pillaring.'); return false; }
        if (wet) {   // water is no danger: swim up through it (2026-10-26: she stopped 14 blocks up under a lake)
            bot.setControlState('jump', true);
            const until = Date.now() + 20000;
            while (Date.now() < until && liquid(bot.blockAt(bot.entity.position.floored().offset(0, 1, 0)))) await wait(100);
            await wait(400); bot.setControlState('jump', false);
            continue;
        }
        const blocking = over.find(solid);
        if (blocking) {
            try { await bot.dig(blocking, true); } catch (e) { log(bot, `Could not dig the block above (${blocking.name}): ${e.message}`); return false; }
            continue;
        }
        const item = bot.inventory.items().find((it) => PILLAR_BLOCKS.includes(it.name));
        if (!item) { log(bot, 'No dirt or stone to stand on - dig some first, or dig a staircase up instead.'); return false; }
        await bot.equip(item, 'hand');
        const below = bot.blockAt(p.offset(0, -1, 0));
        if (!solid(below)) {
            // Diagnostic only: retain the original p/below decision, including any movement during equip.
            const feet=bot.entity.position,cell=p.offset(0,-1,0);
            log(bot, `Nothing solid under me to build on. [pillarUp诊断] 同帧脚位=(${feet.x},${feet.y},${feet.z})；本次判定脚格=(${p.x},${p.y},${p.z})；支撑格=(${cell.x},${cell.y},${cell.z})；块型=${below?.name??'未知'}；boundingBox=${below?.boundingBox??'未知'}。`);
            return false;
        }
        const startY = bot.entity.position.y;
        bot.setControlState('jump', true);
        const until = Date.now() + 1500;
        // 2026-10-26 (owner's session): at exactly +1.00 the server still had her in the cell and refused the block - wait near the top
        // of the jump (+1.15), and try once more while she is still in the air.
        while (bot.entity.position.y < startY + 1.15 && Date.now() < until) await wait(20);
        let placeError = '', jumpedTo = bot.entity.position.y;
        // final-99 01:39-01:41 (DeepSeek #3946, "脚下这块地有鬼，老是拒"): jumps that rose only 0.12-0.2 still tried to place - sure to be refused,
        // and she was never told the jump itself had failed. A jump short of the block's top places nothing and says what was around her.
        if (jumpedTo < startY + 1.0) {
            bot.setControlState('jump', false);
            const name = (dy) => bot.blockAt(p.offset(0, dy, 0))?.name || '?';
            log(bot, `跳不起来：这一跳只升高了 ${(jumpedTo - startY).toFixed(2)} 格（要 1 格以上才放得下脚下的方块），所以没放。`
                + `脚下 ${name(-1)}、站的这格 ${name(0)}、头顶 ${name(1)}/${name(2)}/${name(3)}——水、台阶、蜘蛛网或者头顶太矮都会让人跳不高。换个地方，或者先挖开头顶。`);
            return false;
        }
        for (let attempt = 0; attempt < 2; attempt++) {
            // ...and full jumps (+1.17, +1.25) were refused while the server still had her old position (GPT #3923, the same fix in pathfinder)
            bot.flushPositionForItemUse?.();
            try { await bot.placeBlock(below, new Vec3(0, 1, 0)); placeError = ''; break; } catch (e) { placeError = e.message; }
            if (bot.entity.position.y < startY + 1.0) break;   // already falling: no second try this jump
        }
        bot.setControlState('jump', false);
        await wait(350);
        if (bot.entity.position.y >= startY + 0.9) climbed++;
        else { log(bot, `The block under my feet did not take (jumped from y=${startY.toFixed(2)} to y=${jumpedTo.toFixed(2)}, feet cell ${bot.blockAt(p)?.name}${placeError ? ', place error: ' + placeError : ''}).`); return false; }
    }
    log(bot, `Climbed ${climbed} blocks but still no open sky.`);
    return false;
}

/** The last resort: say it, then /tp straight up to the open ground over her. */
async function _teleportToSurface(bot) {
    const p = bot.entity.position, top = (bot.game.minY ?? -64) + (bot.game.height ?? 384) - 1;
    let ground = null;
    for (let y = Math.min(top, Math.floor(p.y) + 200); y > Math.floor(p.y); y--) {
        const b = bot.blockAt(new Vec3(Math.floor(p.x), y, Math.floor(p.z)), false);
        if (b && (solid(b) || liquid(b)) && !/leaves/.test(b.name)) { ground = y; break; }
    }
    if (ground === null) { log(bot, 'Could not see the surface above me (not loaded) - try climbing instead.'); return false; }
    bot.chat('我实在出不去了，先传送到上面地面上。');   // owner rule: a teleport is never silent
    await wait(400);
    const x = Math.floor(p.x) + 0.5, z = Math.floor(p.z) + 0.5, y = ground + 1;
    bot.chat(`/tp @s ${x} ${y} ${z}`);
    const until = Date.now() + 4000;
    while (Date.now() < until && Math.abs(bot.entity.position.y - y) > 1.5) await wait(100);
    if (Math.abs(bot.entity.position.y - y) > 1.5) { log(bot, 'The teleport did not take (no permission?).'); return false; }
    log(bot, `Teleported up to the surface at y=${y}.`);
    return true;
}

/** Nothing else may steer her while she climbs (2026-10-26: in her own process the step failed while the same step worked alone -
 * a leftover pathfinder goal and the unstuck/elbow_room modes were moving her between the jump and the placement). */
async function _pillarUp(bot, max_blocks = 64) {
    const paused = ['unstuck', 'elbow_room', 'item_collecting'];
    try { bot.pathfinder?.stop?.(); bot.pathfinder?.setGoal?.(null); } catch { /* none */ }
    bot.clearControlStates();
    for (const m of paused) bot.modes?.pause?.(m);
    try { return await climb(bot, max_blocks); }
    finally { bot.clearControlStates(); for (const m of paused) bot.modes?.unpause?.(m); }
}
export const pillarUp = actLogged('goto', _pillarUp, ['max_blocks']);
export const teleportToSurface = actLogged('op-tp', _teleportToSurface, []);

/** Owner 10-28 "增加一个传送到玩家身边的指令": to an online player, said aloud first like every teleport of hers. */
async function _teleportToPlayer(bot, name) {
    const target = Object.keys(bot.players || {}).find((n) => n.toLowerCase() === String(name || '').trim().toLowerCase());
    if (!target || target === bot.username) { log(bot, `${name} is not online. Online: ${Object.keys(bot.players || {}).filter((n) => n !== bot.username).join(', ') || 'nobody else'}.`); return false; }
    bot.chat(`我传送到 ${target} 身边。`);   // owner rule: a teleport is never silent
    await wait(400);
    const from = bot.entity.position.clone();
    bot.chat(`/tp @s ${target}`);
    const until = Date.now() + 4000;
    while (Date.now() < until && bot.entity.position.distanceTo(from) < 2) await wait(100);
    const there = bot.players[target]?.entity?.position;
    if (bot.entity.position.distanceTo(from) < 2) { log(bot, 'The teleport did not take (no permission, or you were already beside them).'); return false; }
    log(bot, `Teleported to ${target}` + (there ? ` (${Math.round(bot.entity.position.distanceTo(there))} blocks from them now).` : '.'));
    return true;
}
export const teleportToPlayer = actLogged('op-tp', _teleportToPlayer, ['name']);
