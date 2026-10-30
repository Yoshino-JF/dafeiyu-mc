// Death black box (owner 10-27 "可以想办法加速吗"). Every death so far was rebuilt from [pos] samples 5 s apart plus a lab replay - hours
// each (final-82 edge snap, final-83 drowning and the walk after respawn). The last ~10 s of her body, tick by tick, is kept in memory
// and written to logs/blackbox/ when she dies; the first seconds after the respawn go into the same file. Recording never acts.
import fs from 'fs';
import path from 'path';
import { logLifecycle } from './dafeiyu_log.js';

const DIR = path.join(process.env.DAFEIYU_LOG_DIR || './logs', 'blackbox');
const KEEP_FILES = 100;
const r2 = (v) => Math.round(v * 100) / 100;
const KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];

function sample(agent) {
    const bot = agent.bot, e = bot.entity, p = e.position, v = e.velocity || { x: 0, y: 0, z: 0 }, g = bot.pathfinder?.goal;
    const at = (dy) => bot.blockAt(p.offset(0, dy, 0))?.name ?? null;
    return {
        t: Date.now(), p: [r2(p.x), r2(p.y), r2(p.z)], v: [r2(v.x), r2(v.y), r2(v.z)], g: e.onGround ? 1 : 0, w: e.isInWater ? 1 : 0,
        hp: r2(bot.health ?? 0), air: bot.oxygenLevel ?? null, head: at(1), feet: at(0), below: at(-1),
        goal: !g ? null : Number.isFinite(g.x) ? [g.x, g.y, g.z] : (g.constructor?.name || 'goal'),
        // GPT #3865: mineflayer's controlState fields are not enumerable - Object.keys() read every tick as no keys held
        keys: KEYS.filter((k) => bot.getControlState ? bot.getControlState(k) : bot.controlState?.[k]).join(','),
        act: agent.actions?.currentActionLabel || ''
    };
}

function prune() {
    try {
        const old = fs.readdirSync(DIR).filter((f) => f.startsWith('death-')).sort();
        for (const f of old.slice(0, Math.max(0, old.length - KEEP_FILES))) fs.unlinkSync(path.join(DIR, f));
    } catch { /* best effort */ }
}

/** Keeps the last `ticks` physics ticks of her body; on death writes them, then adds the ticks of the first `afterMs` after it. */
export function attachBlackbox(agent, { ticks = 200, afterMs = 5000 } = {}) {
    const bot = agent.bot, ring = [];
    let after = null;
    bot.on('physicsTick', () => {
        try {
            if (!bot.entity?.position) return;
            const s = sample(agent);
            if (after) after.push(s);
            ring.push(s);
            if (ring.length > ticks) ring.shift();
        } catch { /* recording must never break her */ }
    });
    bot.on('death', () => {
        try {
            fs.mkdirSync(DIR, { recursive: true });
            const at = Date.now(), file = path.join(DIR, `death-${new Date(at).toISOString().replace(/[:.]/g, '-')}.json`);
            const box = { at, deathPos: ring.at(-1)?.p ?? null, ticks: ring.slice(), after: [] };
            fs.writeFileSync(file, JSON.stringify(box));
            logLifecycle('blackbox', { file: file.replaceAll('\\', '/'), ticks: box.ticks.length });
            const mine = after = [];
            setTimeout(() => {
                if (after === mine) after = null;
                try { box.after = mine; fs.writeFileSync(file, JSON.stringify(box)); } catch { /* best effort */ }
                prune();
            }, afterMs);
        } catch { /* best effort */ }
    });
}
