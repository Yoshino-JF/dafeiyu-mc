// Owner rule (2026-10-25, PLAN D): she never breaks what a player marked as protected. Everything else in the world is hers to dig.
// The areas live in bots/<name>/play-protections.json, the same format as the old project ({center:{x,y,z}, radius, note, by, at}).
// The guard sits on bot.dig itself, the one choke point every skill and every piece of code she writes for herself goes through.
import fs from 'fs';
import path from 'path';

export const MAX_RADIUS = 64;   // a typo must not protect the whole world
const file = (name) => path.join('./bots', name, 'play-protections.json');

export function loadProtections(name) {
    try {
        const j = JSON.parse(fs.readFileSync(file(name), 'utf8'));
        return (Array.isArray(j) ? j : j?.areas || []).filter((a) => a?.center && Number.isFinite(a.center.x) && Number.isFinite(a.radius));
    } catch { return []; }
}
export function saveProtections(name, areas) {
    fs.mkdirSync(path.dirname(file(name)), { recursive: true });
    fs.writeFileSync(file(name), JSON.stringify({ areas }, null, 2));
}
/** The area covering this cell, or null. Areas are boxes of +-radius around the centre (same as the old project's protectedRect). */
export function protectedAreaAt(areas, p) {
    const c = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    return areas.find((a) => Math.abs(c.x - Math.floor(a.center.x)) <= a.radius && Math.abs(c.y - Math.floor(a.center.y)) <= a.radius
        && Math.abs(c.z - Math.floor(a.center.z)) <= a.radius) || null;
}
export function addProtection(name, center, radius, note, by) {
    const r = Math.max(1, Math.min(MAX_RADIUS, Math.round(Number(radius) || 8)));
    const areas = loadProtections(name);
    areas.push({ center: { x: Math.floor(center.x), y: Math.floor(center.y), z: Math.floor(center.z) }, radius: r, note: String(note || ''), by: by || null, at: new Date().toISOString() });
    saveProtections(name, areas);
    return areas.at(-1);
}
export function removeProtectionAt(name, p) {
    const areas = loadProtections(name), hit = protectedAreaAt(areas, p);
    if (!hit) return null;
    saveProtections(name, areas.filter((a) => a !== hit));
    return hit;
}
/** Wrap bot.dig: a protected block is refused with a message that names the area (reason "protected" in the [act] log). */
export function guardDig(bot, name) {
    if (bot._dafeiyuDigGuard) return;
    const dig = bot.dig.bind(bot);
    bot._dafeiyuDigGuard = true;
    bot.dig = async (block, ...rest) => {
        const hit = block?.position ? protectedAreaAt(loadProtections(name), block.position) : null;
        if (hit) {
            const msg = `That block is in a protected area (${hit.note || 'protected by ' + (hit.by || 'a player')}) - not allowed to break it.`;
            bot.output = (bot.output || '') + msg + '\n';
            throw new Error(msg);
        }
        // Owner 10-28: protect others, not her - what digging this block opens onto is told to her, and it is dug.
        const lava = block?.position ? lavaBeside(bot, block.position) : null;
        if (lava) bot.output = (bot.output || '') + `（挖的这块${lava}挨着岩浆，挖开后岩浆可能流进来。）\n`;
        const fall = block?.position ? unsupportedDrop(bot, block.position) : null;
        if (fall) bot.output = (bot.output || '') + `(That block was the only thing you stood on; below it is ${fall}.)\n`;
        return dig(block, ...rest);
    };
}

/** Which side of the block (four sides or the top) touches lava, in her words; null if none. Lava below cannot run up into the hole. */
export function lavaBeside(bot, target) {
    if (!bot.blockAt) return null;
    const t = target.floored ? target.floored() : target;
    const sides = [[1, 0, 0, '东边'], [-1, 0, 0, '西边'], [0, 0, 1, '南边'], [0, 0, -1, '北边'], [0, 1, 0, '上面']];
    for (const [dx, dy, dz, word] of sides) {
        const b = bot.blockAt(t.offset ? t.offset(dx, dy, dz) : { x: t.x + dx, y: t.y + dy, z: t.z + dz });
        if (b?.name === 'lava') return word;
    }
    return null;
}

/** GPT #3721: her own !newAction code called bot.dig on the block under her feet past !digDown's drop check; the copy fell to its death.
 * A fact at the same choke point: when the block is the last one holding her up and what lies below would hurt her (a drop of
 * more than 3 blocks, or lava), she is told (owner 10-28: it used to be refused). Water, or a drop of 3 or less, says nothing. Returns a description, or null. */
export function unsupportedDrop(bot, target) {
    const me = bot.entity?.position;
    if (!me || !bot.blockAt) return null;
    const t = target.floored ? target.floored() : target;
    if (Math.abs(me.y - (t.y + 1)) > 0.2) return null;                      // she is not standing on top of that layer
    // the blocks under her 0.6-wide body: is the target among them, and would any other still hold her?
    const under = [];
    for (const dx of [-0.299, 0.299]) for (const dz of [-0.299, 0.299]) {
        const p = { x: Math.floor(me.x + dx), y: t.y, z: Math.floor(me.z + dz) };
        if (!under.some((q) => q.x === p.x && q.z === p.z)) under.push(p);
    }
    if (!under.some((p) => p.x === t.x && p.z === t.z)) return null;
    const solid = (b) => b && b.boundingBox === 'block';
    if (under.some((p) => (p.x !== t.x || p.z !== t.z) && solid(bot.blockAt(t.offset ? t.offset(p.x - t.x, 0, p.z - t.z) : { ...p }))))
        return null;
    for (let d = 1; d <= 24; d++) {
        const b = bot.blockAt(t.offset ? t.offset(0, -d, 0) : { x: t.x, y: t.y - d, z: t.z });
        if (!b) return null;                                                 // not loaded: no claim
        if (b.name === 'lava') return 'lava';
        if (b.name === 'water') return null;
        if (solid(b)) return d - 1 > 3 ? `a ${d - 1}-block drop (fall damage)` : null;
    }
    return 'a drop of more than 24 blocks';
}
