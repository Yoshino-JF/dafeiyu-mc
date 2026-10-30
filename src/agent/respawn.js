// Owner 10-28 (MEETING-5): where she will wake up after a death, as facts with their source - the world spawn, the last bed the server
// confirmed (she slept in it, or it said "Respawn point set"), and where she actually woke last time. Nothing here moves her or
// decides for her; what is not known is said as not known. Kept in bots/<name>/respawn.json so it outlives a restart.
import fs from 'fs';
import path from 'path';

const file = (name) => path.join('./bots', name, 'respawn.json');
const round = (p) => p && { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
const at = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function loadRespawn(name) {
    try { return JSON.parse(fs.readFileSync(file(name), 'utf8')) || {}; } catch { return {}; }
}
function save(name, data) {
    try { fs.mkdirSync(path.dirname(file(name)), { recursive: true }); fs.writeFileSync(file(name), JSON.stringify(data, null, 2)); } catch { /* a lost note must not break her */ }
}

/** The server confirmed this bed (slept in it, or "Respawn point set"). */
export function noteBed(name, pos, how) {
    save(name, { ...loadRespawn(name), bed: { ...round(pos), how, at: Date.now() } });
}
/** Where she woke after a death. Returns the line she is told. */
// 10-28 new save: a bed or a wake-up recorded before she arrived in the current world belongs to an earlier world - not a fact about this one
const inThisWorld = (row, worldSince) => !!row && !(Number.isFinite(worldSince) && row.at < worldSince);
export function noteRespawn(name, pos, worldSpawn, worldSince = null) {
    const data = { ...loadRespawn(name), lastRespawn: { ...round(pos), at: Date.now() } };
    save(name, data);
    const p = round(pos), bed = inThisWorld(data.bed, worldSince) ? data.bed : null, near = (a, b) => a && b && Math.hypot(a.x - b.x, a.z - b.z) <= 4 && Math.abs(a.y - b.y) <= 3;
    if (bed && near(p, bed)) return `（你在你的床边复活了：(${p.x}, ${p.y}, ${p.z})。）`;
    if (bed) return `（你在 (${p.x}, ${p.y}, ${p.z}) 复活了，不在你最近确认过的那张床 (${bed.x}, ${bed.y}, ${bed.z})（${at(bed.at)}）边上——那张床可能被拆了、被挡住了，或者换了世界。）`;
    const sp = round(worldSpawn);
    return `（你在 (${p.x}, ${p.y}, ${p.z}) 复活了${sp && near(p, sp) ? '，这里是世界出生点' : ''}。还没有一张床被服务器确认成你的复活点：在一张床上睡着一次（或者服务器说 "Respawn point set"），之后死了就会在那张床边复活。）`;
}
/** One line for !stats. */
export function respawnLine(name, worldSpawn, worldSince = null) {
    const d = loadRespawn(name), sp = round(worldSpawn);
    const bed = inThisWorld(d.bed, worldSince) ? `last bed the server confirmed: (${d.bed.x}, ${d.bed.y}, ${d.bed.z}) at ${at(d.bed.at)}`
        : d.bed ? `no bed confirmed in this world yet (the last one, (${d.bed.x}, ${d.bed.y}, ${d.bed.z}), was in an earlier world)` : 'no bed confirmed as your respawn point yet';
    const last = inThisWorld(d.lastRespawn, worldSince) ? `; last time you woke at (${d.lastRespawn.x}, ${d.lastRespawn.y}, ${d.lastRespawn.z})` : '';
    return `- Respawn: ${bed}${sp ? `; world spawn (${sp.x}, ${sp.y}, ${sp.z})` : ''}${last} (a bed that is broken or blocked stops working - then you wake at world spawn)`;
}
