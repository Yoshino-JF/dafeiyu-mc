// The underground house (owner 2026-10-26: "在地下我们建议挖洞，应该有那种直接生成地下小房子的蓝图吧 ... 我们给意见但是不限制").
// Vanilla has no small underground house template, so this carves one where she stands, at her height: a stone-brick room
// (7 x 5 x 7 outside, 5 x 3 x 5 inside) in front of her, an oak door facing her, a passage from her cell to the door, a stair from
// her cell up and away to open sky, a bed, a crafting table and two torches. It is a choice she can make (!buildHouseHere("cave")),
// never forced; the same protection rule as every other build holds (a player-protected area or a player inside the footprint means
// another spot).
import fs from 'node:fs';
import path from 'node:path';
import Vec3 from 'vec3';
import { overlapsProtected } from './house.js';
import { loadProtections } from '../protect.js';
import { actLogged } from '../dafeiyu_log.js';
import { openSky } from './escape.js';

export const CAVE = Object.freeze({ width: 7, depth: 7, height: 5, ahead: 2, wall: 'stone_bricks', stair: 'stone_brick_stairs', pay: 40, maxExit: 48 });
const DIRS = { south: { x: 0, z: 1 }, west: { x: -1, z: 0 }, north: { x: 0, z: -1 }, east: { x: 1, z: 0 } };
/** mineflayer yaw (0 = north, -z; increasing turns left) to the side she faces. */
export function facingOf(yaw) {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    return Math.abs(fx) > Math.abs(fz) ? (fx > 0 ? 'east' : 'west') : (fz > 0 ? 'south' : 'north');
}
/** Every cell of the room from her foot cell and the side she faces. Pure. */
export function cavePlan(at, facing) {
    const v = DIRS[facing], r = { x: -v.z, z: v.x }, half = (CAVE.width - 1) / 2;
    const P = { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) };
    const cell = (i, j, dy = 0) => ({ x: P.x + v.x * (CAVE.ahead + i) + r.x * j, y: P.y + dy, z: P.z + v.z * (CAVE.ahead + i) + r.z * j });
    const a = cell(0, -half, -1), b = cell(CAVE.depth - 1, half, CAVE.height - 2);
    const box = { min: { x: Math.min(a.x, b.x), y: a.y, z: Math.min(a.z, b.z) }, max: { x: Math.max(a.x, b.x), y: b.y, z: Math.max(a.z, b.z) } };
    return { facing, P, box, door: cell(0, 0), passage: [{ ...P, x: P.x + v.x, z: P.z + v.z }], bedFoot: cell(CAVE.depth - 3, 1), bedHead: cell(CAVE.depth - 2, 1),
        table: cell(CAVE.depth - 2, -1), torches: [cell(1, -2), cell(CAVE.depth - 2, 2)], inside: cell(1, 0),
        exitStep: (k) => ({ x: P.x - v.x * k, y: P.y + k, z: P.z - v.z * k }) };
}

/** The way out: from her cell, one block up for each block away from the room, 4 high, until the sky over the step is open, so the
 * door always leads somewhere she can walk (2026-10-26: the first cave room's door opened onto rock; she went in and out by her own
 * 1-wide shafts and kept getting stuck there). Two passes: first the stair is walled in, then it is cut - so water from an aquifer or a
 * lake, or gravel and sand from above, cannot run into cells already cut (2026-10-26 tests at y=40: aquifers flooded the stair; gravel
 * filled step 16; under a lake the stair rises through the water in a brick tube). Stops at a player-protected cell. Returns the top
 * step, or null if none was found. */
async function carveExit(bot, plan, c) {
    const prot = loadProtections(bot.username), steps = [];
    let out = false;
    for (let k = 0; k <= CAVE.maxExit; k++) {
        const s = plan.exitStep(k), around = { min: { x: s.x - 1, y: s.y - 1, z: s.z - 1 }, max: { x: s.x + 1, y: s.y + 4, z: s.z + 1 } };
        if (k > 0 && overlapsProtected(prot, around)) return null;
        // Read before the cells change: open from her head up means natural ground is at most one block above the step's floor,
        // so she can step out (open only above the 3 cut cells could leave her in a 2-deep notch).
        const sky = openSky(bot, { x: s.x, y: s.y - 1, z: s.z });
        if (!sky) await c(`/setblock ${at({ ...s, y: s.y + 4 })} minecraft:${CAVE.wall}`);   // a roof
        for (const fluid of ['water', 'lava']) await c(`/fill ${at(around.min)} ${at(around.max)} minecraft:${CAVE.wall} replace minecraft:${fluid}`);
        steps.push(s);
        if (sky) { out = true; break; }
    }
    if (!out) return null;
    for (const p of plan.passage) await c(`/fill ${at(p)} ${at({ ...p, y: p.y + 1 })} minecraft:air`);   // sealing may have walled it
    // Real stair blocks, rising away from the room: each is a half-block step the body walks up without jumping. On plain full-block
    // steps in a 1-wide cut her body's jump kept failing (2026-10-26 tests: stuck at step 1 or 2 with and without the pathfinder;
    // with stair blocks it walked 12 steps up holding only forward).
    const up = { south: 'north', north: 'south', east: 'west', west: 'east' }[plan.facing];
    for (const [k, s] of steps.entries()) {
        await c(`/fill ${at(s)} ${at({ ...s, y: s.y + 3 })} minecraft:air`);   // 4 high, so a jump on the way never hits the roof
        const floor = { ...s, y: s.y - 1 };
        await c(k === 0 ? `/fill ${at(floor)} ${at(floor)} minecraft:${CAVE.wall} keep` : `/setblock ${at(floor)} minecraft:${CAVE.stair}[facing=${up}]`);
    }
    return steps.at(-1);
}
function command(bot, text) {
    return new Promise((resolve, reject) => {
        let timer;
        const done = (err) => { clearTimeout(timer); bot.removeListener('messagestr', hear); err ? reject(err) : resolve(); };
        // "Could not set the block" = that cell is already this block (2026-10-28 house test: a second cave room on the same spot timed
        // out on the door). The door/bed check after the commands still decides whether the room is there.
        const hear = (line) => { const s = String(line); if (/filled|changed|placed|Removed|No items|Successfully|Could not set the block/i.test(s)) done(); else if (/Unknown or incomplete command|do not have permission|not loaded|outside of the world|Too many blocks|not a valid/i.test(s)) done(new Error(s)); };
        bot.on('messagestr', hear);
        timer = setTimeout(() => done(new Error('no server receipt for ' + text.split(' ')[0])), 5000);
        try { bot.chat(text); } catch (e) { done(e); }
    });
}
const at = (c) => `${c.x} ${c.y} ${c.z}`;
const log = (bot, text) => { bot.output = (bot.output || '') + text + '\n'; };

async function _buildCaveHouse(bot) {
    const plan = cavePlan(bot.entity.position, facingOf(bot.entity.yaw)), { box, facing } = plan;
    if (overlapsProtected(loadProtections(bot.username), box)) { log(bot, 'protected: that spot overlaps a player-protected area. Turn to another side or move, then try again.'); return false; }
    for (const e of Object.values(bot.entities || {})) if (e.type === 'player' && e !== bot.entity) {
        const p = e.position; if (p.x >= box.min.x - 1 && p.x <= box.max.x + 1 && p.y >= box.min.y - 1 && p.y <= box.max.y + 1 && p.z >= box.min.z - 1 && p.z <= box.max.z + 1) { log(bot, 'A player is standing where the room would go. Ask them to step aside.'); return false; }
    }
    const c = (s) => command(bot, s);
    await c(`/fill ${at(box.min)} ${at(box.max)} minecraft:${CAVE.wall} hollow`);   // walls, floor, ceiling; the inside becomes air
    for (const p of plan.passage) await c(`/fill ${at(p)} ${at({ ...p, y: p.y + 1 })} minecraft:air`);
    const exit = await carveExit(bot, plan, c);
    await c(`/setblock ${at(plan.door)} minecraft:oak_door[facing=${facing},half=lower]`);
    await c(`/setblock ${at({ ...plan.door, y: plan.door.y + 1 })} minecraft:oak_door[facing=${facing},half=upper]`);
    await c(`/setblock ${at(plan.bedFoot)} minecraft:red_bed[facing=${facing},part=foot]`);
    await c(`/setblock ${at(plan.bedHead)} minecraft:red_bed[facing=${facing},part=head]`);
    await c(`/setblock ${at(plan.table)} minecraft:crafting_table`);
    for (const t of plan.torches) await c(`/setblock ${at(t)} minecraft:torch`);
    await new Promise((r) => setTimeout(r, 600));
    const name = (p) => bot.blockAt(new Vec3(p.x, p.y, p.z))?.name || '';
    if (!name(plan.door).endsWith('_door') || !name(plan.bedFoot).endsWith('_bed')) { log(bot, 'The room commands returned but the door/bed are not there yet - do not say it is built.'); return false; }
    let paid = 0;   // she pays what she has of stone, up to CAVE.pay; the rest is the house allowance
    for (const item of bot.inventory.items().filter((i) => ['cobblestone', 'stone', 'cobbled_deepslate', 'deepslate'].includes(i.name))) {
        if (paid >= CAVE.pay) break; const n = Math.min(item.count, CAVE.pay - paid);
        await c(`/clear @s minecraft:${item.name} ${n}`).catch(() => {}); paid += n;
    }
    // owner 10-28: the room inside the walls and the floor height, so where "inside" is can be told exactly (the box is hollow: its outer
    // layer is wall, floor and ceiling)
    const interior = { min: { x: box.min.x + 1, z: box.min.z + 1 }, max: { x: box.max.x - 1, z: box.max.z - 1 }, floorY: box.min.y, feetY: box.min.y + 1, floorBlock: CAVE.wall };
    const home = { style: 'cave', origin: box.min, entry: plan.inside, inside: plan.inside, interior, door: plan.door, exit, size: [CAVE.width, CAVE.height, CAVE.depth], paid, at: new Date().toISOString() };
    const dir = path.join('bots', bot.username); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'house.json'), JSON.stringify(home, null, 2));
    bot.lastBuiltHouse = home;
    log(bot, `Underground room built: door at ${at(plan.door)}, bed and crafting table inside, lit by two torches; used ${paid} of your stone. `
        + `Inside, walls not counted: x ${interior.min.x}..${interior.max.x}, z ${interior.min.z}..${interior.max.z}; the floor is ${CAVE.wall} at y ${interior.floorY}, standing on it your feet are at y ${interior.feetY}. The first cell inside the door is ${at(plan.inside)}. `
        + (exit ? `Stairs behind the door lead up to open ground at ${at(exit)}. ` : 'No stair to the surface could be cut from here (protected or too deep) - dig your own way up. ')
        + 'Remember this as home.');
    return true;
}
export const buildCaveHouse = actLogged('op-fill', _buildCaveHouse, []);
