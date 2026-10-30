// Owner 10-29 (TNT test: a creeper blew her east wall out while she was 25 blocks off, and coming home she was told only "像在屋檐下"):
// her houses, kept per save (memory/worlds/<world>/houses.json - another save never sees them), each with every block as built and as she
// changes it herself. A block gone that she did not take is told to her once: while she is near (block updates), or when she comes back
// and the chunk loads. She may give a house up (!abandonHouse); of the rest, the three she stayed in last are the ones told about.
// Facts only - whether and how to repair is hers.
import fs from 'node:fs';
import path from 'node:path';
import Vec3 from 'vec3';

const EMPTY = new Set(['air', 'cave_air', 'void_air']);
const OWN_MS = 2000;            // a change this close in time (and within a block) to her own dig or placement is hers
const BATCH_MS = 2500;          // an explosion's block updates arrive together: wait, then tell them as one
const TELL_GAP_MS = 20_000;     // fire eats a house a plank at a time: at most one notice per 20 s per house
const TOLD_HOUSES = 3;
const TELL_DAMAGE = false;    // owner 10-29: no damage notices at all (see _tell)
const at = (p) => `(${p.x}, ${p.y}, ${p.z})`;

export function houseBox(h) {
    const o = h.origin, s = h.size;
    return { min: { x: o.x, y: o.y, z: o.z }, max: { x: o.x + s[0] - 1, y: o.y + s[1] - 1, z: o.z + s[2] - 1 } };
}
const inBox = (b, p) => p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z;
const rel = (h, p) => `${p.x - h.origin.x},${p.y - h.origin.y},${p.z - h.origin.z}`;
const abs = (h, r) => { const [x, y, z] = r.split(',').map(Number); return { x: h.origin.x + x, y: h.origin.y + y, z: h.origin.z + z }; };

/** Which part of the house a cell is - a wall by its side, a corner, the floor, overhead, or in the room - judged against the room inside. */
export function housePart(h, p) {
    const r = h.interior;
    if (!r) return '房子';
    const ew = p.x > r.max.x ? '东' : p.x < r.min.x ? '西' : '', ns = p.z > r.max.z ? '南' : p.z < r.min.z ? '北' : '';
    if (ew && ns) return `${ew}${ns}墙角`;
    if (ew || ns) return `${ew || ns}墙`;
    if (p.y <= r.floorY) return '地板';
    if (p.y >= r.feetY + 2) return '屋顶或楼上';
    return '屋里';
}

export class Houses {
    constructor(agent) {
        this.agent = agent;
        this.own = [];              // her own digs and placements: {p, t}
        this.pending = new Map();   // block changes inside a house, waiting for the batch
        this.blasts = [];           // explosion centres the server sent: {c, t}
        this._file = undefined;
        this.data = { houses: [] };
    }

    // worldStatus() reads the world state file: block updates come many a second, so the answer is kept for 10 s
    file() {
        if (this._fileAt && Date.now() - this._fileAt < 10_000) return this._fileNow;
        const m = this.agent.memoryS, key = m?.worldStatus?.()?.key;
        this._fileAt = Date.now();
        return (this._fileNow = key && typeof m?.worlds?.worldDir === 'function' ? path.join(m.worlds.worldDir(key), 'houses.json') : null);
    }

    load() {
        const f = this.file();
        if (f === this._file) return this.data;
        this._file = f;
        try { this.data = f ? JSON.parse(fs.readFileSync(f, 'utf8')) : { houses: [] }; } catch { this.data = { houses: [] }; }
        this.data.houses ||= [];
        if (f && !this.data.migrated) {
            // the one house an older build kept in bots/<name>/house.json, if she built it in this world: its blocks are read the first
            // time its chunks are loaded, taken as it stands then
            this.data.migrated = true;
            try {
                const h = JSON.parse(fs.readFileSync(path.join('bots', this.agent.name, 'house.json'), 'utf8'));
                const since = this.agent.memoryS?.worldStatus?.()?.since;
                if (h?.origin && h?.size && !this.data.houses.length && !(Number.isFinite(since) && Date.parse(h.at) < since))
                    this.data.houses.push(this._record(h, 1, Date.parse(h.at) || Date.now()));
            } catch { /* none */ }
            this.save();
        }
        return this.data;
    }

    /** The block a house of hers she has not given up has at this world cell, as recorded - for the pathfinder, one Map lookup a call. */
    recordedAt(p) {
        const d = this.load();
        if (this._indexOf !== d || !this._index) {
            this._indexOf = d; this._index = new Map();
            for (const h of d.houses) if (!h.abandoned && h.blocks) for (const [r, name] of Object.entries(h.blocks)) {
                const [x, y, z] = r.split(',').map(Number);
                this._index.set(`${h.origin.x + x},${h.origin.y + y},${h.origin.z + z}`, name);
            }
        }
        return this._index.get(`${p.x},${p.y},${p.z}`);
    }

    /** The beds in a house of hers as recorded, one cell per bed (10-30 day-night test: the build receipt was cut short and she
     *  said "没床，睡不了" in a house with two beds). */
    bedsOf(h) {
        const cells = Object.entries(h?.blocks || {}).filter(([, n]) => /_bed$/.test(n)).map(([r]) => { const [x, y, z] = r.split(',').map(Number); return { x: h.origin.x + x, y: h.origin.y + y, z: h.origin.z + z }; });
        const beds = [];
        for (const c of cells) if (!beds.some((b) => b.y === c.y && Math.abs(b.x - c.x) + Math.abs(b.z - c.z) === 1)) beds.push(c);
        return beds;
    }

    /** Owner 10-29 ("又把室内外弄反了"): in or out of a house of hers from its record, not guessed from a roof and walls nearby (under
     *  the eaves at its corner she was told "围着" and went "out" through the door - into the house). Null away from her houses. */
    placeOf(p) {
        // 10-30 home-walk round 25: two houses 6 blocks apart one above the other - the first one near the cell answered "outside"
        // for a cell inside the second. Inside or at the door of any house wins over outside of another.
        let near = null;
        for (const h of this.active()) {
            const r = h.interior, b = houseBox(h);
            if (!r?.min || !r?.max) continue;
            if (p.x < b.min.x - 3 || p.x > b.max.x + 3 || p.z < b.min.z - 3 || p.z > b.max.z + 3 || p.y < b.min.y - 3 || p.y > b.max.y + 1) continue;
            const floor = r.floorY ?? b.min.y;
            if (h.door && p.x === h.door.x && p.z === h.door.z && (p.y === h.door.y || p.y === h.door.y + 1)) return { house: h, where: 'door' };
            const inside = p.x >= r.min.x && p.x <= r.max.x && p.z >= r.min.z && p.z <= r.max.z && p.y > floor && p.y <= b.max.y;
            if (inside) return { house: h, where: 'inside' };
            near ??= { house: h, where: 'outside' };
        }
        return near;
    }

    save() {
        this._index = null;   // records changed (built, repaired, damaged, given up)
        const f = this.file();
        if (!f || f !== this._file) return;
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f + '.tmp', JSON.stringify(this.data));
        fs.renameSync(f + '.tmp', f);
    }

    _record(home, n, builtAt) {
        // style: the template's own name without its folder path (minecraft:village/plains/houses/plains_small_house_1 -> plains_small_house_1)
        return { n, name: `房子${n}`, style: String(home.style || '').split('/').pop(), origin: home.origin, size: home.size, door: home.door || null, inside: home.inside || home.entry || null,
            interior: home.interior || null, builtAt, lastIn: builtAt, abandoned: false, blocks: null, damage: {} };
    }

    /** A house she just built: every block in it as it stands now. */
    add(home, bot = this.agent.bot) {
        const d = this.load();
        const h = this._record(home, d.houses.reduce((m, x) => Math.max(m, x.n || 0), 0) + 1, Date.now());
        h.blocks = this._snapshot(h, bot);
        d.houses.push(h);
        this.save();
        // 10-30 day-night test: taken the moment the build returned, part of the roof had not reached her client yet and read as air -
        // unrecorded, it cost nothing to dig, and at night she came in through the roof instead of the door. Cells still missing are
        // filled in a little later (only added, never counted as damage).
        for (const ms of [3000, 8000]) setTimeout(() => {
            try {
                const later = this._snapshot(h, bot);
                if (!later) return;
                let added = 0;
                h.blocks ||= {};
                for (const [r, n] of Object.entries(later)) if (!(r in h.blocks)) { h.blocks[r] = n; added++; }
                if (added) { this.save(); console.log(`[houses] ${h.name}: ${added} cells arrived after the build`); }
            } catch (e) { console.warn('[houses] late snapshot', e?.message); }
        }, ms).unref?.();
        return h;
    }

    _snapshot(h, bot = this.bot) {
        const b = houseBox(h), out = {};
        for (let x = b.min.x; x <= b.max.x; x++) for (let y = b.min.y; y <= b.max.y; y++) for (let z = b.min.z; z <= b.max.z; z++) {
            const bl = bot?.blockAt?.(new Vec3(x, y, z));
            if (!bl) return null;   // not loaded yet
            if (!EMPTY.has(bl.name)) out[rel(h, { x, y, z })] = bl.name;
        }
        return out;
    }

    active() { return this.load().houses.filter((h) => !h.abandoned); }
    /** The houses whose damage she is told about: the three she stayed in last. */
    told() { return this.active().sort((a, b) => (b.lastIn || b.builtAt) - (a.lastIn || a.builtAt)).slice(0, TOLD_HOUSES); }

    find(name) {
        const s = String(name ?? '').trim(), houses = this.load().houses;
        return houses.find((h) => h.name === s) || houses.find((h) => String(h.n) === s.replace(/^房子/, '')) || null;
    }

    abandon(name) {
        const h = this.find(name);
        if (!h) return null;
        h.abandoned = true; h.abandonedAt = Date.now();
        this.save();
        return h;
    }

    attach(bot) {
        if (this.bot === bot) return;
        this.bot = bot;
        bot.ownHouseBlock = (p) => this.recordedAt(p);   // goToGoal: only her own house costs extra to dig through
        bot.ownHousePlace = (p) => this.placeOf(p);      // surroundingsFact: in or out of her house, from its record
        const mine = (p) => { if (p) { this.own.push({ p: p.clone(), t: Date.now() }); if (this.own.length > 200) this.own.splice(0, 100); } };
        this._dug = (b) => mine(b?.position);
        bot.on('diggingCompleted', this._dug);
        // owner 10-29 ("把自己房子拆了说玩家拆的"): her own collectBlocks took 9 logs of her house and she was told "不是你挖的". Every dig
        // she makes goes through bot.dig - its block is hers when it starts and when it ends, whatever the events do.
        const dig = bot.dig;
        if (typeof dig === 'function' && !dig._houses) {
            bot.dig = async function (block, ...rest) {
                mine(block?.position);
                try { return await dig.call(this, block, ...rest); } finally { mine(block?.position); }
            };
            bot.dig._houses = true;
        }
        // mineflayer drops every diggingCompleted listener when she dies (digging.js): put this one back on respawn
        bot.on('spawn', () => { bot.removeListener('diggingCompleted', this._dug); bot.on('diggingCompleted', this._dug); });
        bot.on('blockPlaced', (_old, now) => mine(now?.position));
        bot.on('blockUpdate', (old, now) => this._onUpdate(old, now));
        bot.on('chunkColumnLoad', (corner) => setTimeout(() => this._onColumn(corner), 1000));
        bot._client?.on?.('explosion', (pk) => {
            const c = pk.center || (Number.isFinite(pk.x) ? { x: pk.x, y: pk.y, z: pk.z } : null);
            if (c) this.blasts = [...this.blasts.filter((b) => Date.now() - b.t < 30_000), { c: { x: Math.round(c.x), y: Math.round(c.y), z: Math.round(c.z) }, t: Date.now() }];
        });
        this._tick = setInterval(() => { try { this._where(); } catch (e) { console.warn('[houses] tick', e?.message); } }, 5000);
        this._tick.unref?.();
        // houses whose chunks were loaded before the world was known: check them now
        setTimeout(() => { try { this._checkLoaded(); } catch (e) { console.warn('[houses] check', e?.message); } }, 1500);
    }

    _onUpdate(old, now) {
        if (!now?.position) return;
        const p = now.position;
        for (const h of this.load().houses) {
            if (!h.blocks || !inBox(houseBox(h), p)) continue;
            this.pending.set(`${h.n}|${rel(h, p)}`, { n: h.n, p: p.clone(), t: Date.now() });
            if (!this._batch) this._batch = setTimeout(() => { this._batch = null; try { this._flush(); } catch (e) { console.warn('[houses] flush', e?.message); } }, BATCH_MS);
        }
    }

    _building() { return /^action:(buildHouse|buildHouseHere)$/.test(this.agent.actions?.currentActionLabel || ''); }

    _flush() {
        const d = this.load(), now = Date.now(), changes = [...this.pending.values()];
        this.pending.clear();
        this.own = this.own.filter((o) => now - o.t < 30_000);
        const building = this._building();
        const hers = (c) => building || this.own.some((o) => Math.abs(o.t - c.t) <= OWN_MS && Math.max(Math.abs(o.p.x - c.p.x), Math.abs(o.p.y - c.p.y), Math.abs(o.p.z - c.p.z)) <= 1);
        let changed = false;
        for (const c of changes) {
            const h = d.houses.find((x) => x.n === c.n), cur = this.bot?.blockAt?.(new Vec3(c.p.x, c.p.y, c.p.z))?.name;
            if (!h?.blocks || !cur) continue;
            const r = rel(h, c.p), rec = h.blocks[r];
            if (hers(c)) {
                // her own change is the house now: a block she took out is no longer part of it, one she put in is
                if (EMPTY.has(cur)) delete h.blocks[r]; else h.blocks[r] = cur;
                delete h.damage[r]; changed = true; continue;
            }
            if (rec === undefined) continue;   // something new where the house had nothing: not damage
            if (cur === rec) { if (h.damage[r]) { delete h.damage[r]; changed = true; } continue; }
            if (!h.damage[r]) { h.damage[r] = { was: rec, now: cur, at: now }; changed = true; }
            else if (h.damage[r].now !== cur) { h.damage[r].now = cur; changed = true; }
        }
        if (changed) this.save();
        this._tell();
    }

    /** A chunk came (back) into view: what of a house in it is not as she left it. */
    _onColumn(corner) {
        if (!corner) return;
        const x0 = corner.x, z0 = corner.z;
        this._checkLoaded((p) => p.x >= x0 && p.x < x0 + 16 && p.z >= z0 && p.z < z0 + 16);
    }

    _checkLoaded(inColumn = () => true) {
        const d = this.load(), now = Date.now();
        let changed = false;
        for (const h of d.houses) {
            const b = houseBox(h);
            if (!inColumn(b.min) && !inColumn(b.max) && !inColumn({ x: b.min.x, z: b.max.z }) && !inColumn({ x: b.max.x, z: b.min.z })) continue;
            if (!h.blocks) { h.blocks = this._snapshot(h); if (h.blocks) changed = true; continue; }
            for (const [r, rec] of Object.entries(h.blocks)) {
                const p = abs(h, r);
                if (!inColumn(p)) continue;
                const cur = this.bot?.blockAt?.(new Vec3(p.x, p.y, p.z))?.name;
                if (!cur) continue;
                if (cur === rec) { if (h.damage[r]) { delete h.damage[r]; changed = true; } }
                else if (!h.damage[r]) { h.damage[r] = { was: rec, now: cur, at: now, away: true }; changed = true; }
            }
        }
        if (changed) this.save();
        this._tell();
    }

    /** Which house she is in, kept as "last stayed"; a house moving into the three told about may have damage she has not heard. */
    _where() {
        const pos = this.bot?.entity?.position;
        if (!pos) return;
        const p = pos.floored(), now = Date.now();
        let changed = false;
        for (const h of this.active()) {
            if (!inBox(houseBox(h), p)) continue;
            if (now - (h.lastIn || 0) > 60_000) changed = true;
            h.lastIn = now;
        }
        if (changed) { this.save(); this._tell(); }
    }

    _tell() {
        // owner 10-29 ("补墙全部删了吧，房子只要封闭就行…一直想着补家，家也回不去"): told about every missing block she spent the night
        // patching walls block by block and died to creepers by the corner. Damage is no longer told; the record stays for in/out only.
        if (!TELL_DAMAGE) return;
        const now = Date.now();
        for (const h of this.told()) {
            const fresh = Object.entries(h.damage || {}).filter(([, v]) => !v.told);
            if (!fresh.length) continue;
            const wait = (h.toldAt || 0) + TELL_GAP_MS - now;
            if (wait > 0) { if (!this._later) this._later = setTimeout(() => { this._later = null; this._tell(); }, wait + 100); continue; }
            const text = this.describe(h, fresh, fresh.every(([, v]) => v.away) ? 'away' : 'now');
            for (const [, v] of fresh) v.told = true;
            h.toldAt = now;
            this.save();
            console.log('[houses] told', h.name, fresh.length);
            this.agent.history?.add?.('system', text)?.catch?.(() => {});
        }
    }

    /** The damage of one house in groups by part: how many, what they were, where. */
    damageLines(h, rows = Object.entries(h.damage || {})) {
        const groups = new Map();
        for (const [r, v] of rows) {
            const p = abs(h, r), part = housePart(h, p);
            const g = groups.get(part) || { part, cells: [], was: new Map(), now: new Set() };
            g.cells.push(p); g.was.set(v.was, (g.was.get(v.was) || 0) + 1); g.now.add(v.now);
            groups.set(part, g);
        }
        const span = (vs) => { const lo = Math.min(...vs), hi = Math.max(...vs); return lo === hi ? `${lo}` : `${lo}~${hi}`; };
        return [...groups.values()].sort((a, b) => b.cells.length - a.cells.length).map((g) => {
            const was = [...g.was].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}${c > 1 ? ' ' + c : ''}`).join('、');
            const where = g.cells.length <= 2 ? g.cells.map(at).join('、') : `x ${span(g.cells.map((c) => c.x))}，y ${span(g.cells.map((c) => c.y))}，z ${span(g.cells.map((c) => c.z))}`;
            const now = [...g.now].every((n) => EMPTY.has(n)) ? '现在是空的' : `现在那里是 ${[...g.now].map((n) => (EMPTY.has(n) ? '空' : n)).join('、')}`;
            return `${g.part}少了 ${g.cells.length} 块（${was}；${where}；${now}）`;
        });
    }

    describe(h, rows, when) {
        const cells = rows.map(([r]) => abs(h, r));
        const blast = when === 'now' && this.blasts.find((b) => Date.now() - b.t < 15_000 && cells.some((c) => Math.hypot(c.x - b.c.x, c.y - b.c.y, c.z - b.c.z) <= 8));
        const lines = this.damageLines(h, rows);
        const floor = h.interior ? `地板在 y ${h.interior.floorY}，` : '';
        return `（你的「${h.name}」（${h.style}，${floor}门在 ${h.door ? at(h.door) : '—'}）${when === 'away' ? '在你不在附近的时候被弄坏了' : '刚刚被弄坏了'}，不是你挖的`
            + `${blast ? `——附近刚有爆炸，中心约在 ${at(blast.c)}` : ''}：${lines.slice(0, 5).join('；')}${lines.length > 5 ? `；还有 ${lines.length - 5} 处` : ''}。`
            + `修不修、怎么修你自己定；!myHouses 能看还有哪些没补上。）`;
    }

    /** !myHouses: every house in this save, the last stayed in first. */
    summary() {
        const d = this.load();
        if (!d.houses.length) return '这个存档里还没有记下你的房子（用 !buildHouse / !buildHouseHere 盖的会记下来）。';
        const now = Date.now();
        const ago = (t) => { const m = Math.round((now - t) / 60000); return m < 1 ? '刚才' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`; };
        const rows = [...d.houses].sort((a, b) => Number(a.abandoned) - Number(b.abandoned) || (b.lastIn || b.builtAt) - (a.lastIn || a.builtAt)).slice(0, 8).map((h) => {
            const r = h.interior, room = r ? `屋里 x ${r.min.x}..${r.max.x}、z ${r.min.z}..${r.max.z}，地板 y ${r.floorY}（站上去脚在 y ${r.feetY}）` : '';
            const state = h.abandoned ? '（已放弃）' : '';
            const beds = this.bedsOf(h);
            return `- ${h.name}：${h.style}，门 ${h.door ? at(h.door) : '—'}，${room}；${beds.length ? `床 ${beds.map(at).join('、')}` : '没有床'}；上次待在里面：${ago(h.lastIn || h.builtAt)}。${state}`;
        });
        return `你在这个存档里的房子（最近待过的在前）：\n${rows.join('\n')}${d.houses.length > 8 ? `\n（还有 ${d.houses.length - 8} 处没列出）` : ''}`;
    }
}
