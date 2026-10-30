// [decision] / [act] lines for the freedom and learning audit (contract: docs/log-spec.md, DeepSeek #2929 / #2961).
// One line per entry in logs/agent.ndjson, written as `[decision] {json}` / `[act] {json}`. The file of an earlier day is renamed
// to agent-YYYY-MM-DD.ndjson on start; seven days are kept. Writing never throws: a full disk must not stop her.
import fs from 'fs';
import path from 'path';
import { ACT_REASONS } from './act-reasons.js';
import { classifyFailure } from './failure-reasons.js';
import { isCancelledAction, cancelledBy } from './action_manager.js';

export { ACT_REASONS };

const DIR = process.env.DAFEIYU_LOG_DIR || './logs';
const FILE = path.join(DIR, 'agent.ndjson');
const KEEP_DAYS = 7;

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
function rotate() {
    try {
        fs.mkdirSync(DIR, { recursive: true });
        if (fs.existsSync(FILE)) {
            const was = day(fs.statSync(FILE).mtimeMs);
            if (was !== day(Date.now())) fs.renameSync(FILE, path.join(DIR, `agent-${was}.ndjson`));
        }
        const old = fs.readdirSync(DIR).filter((f) => /^agent-\d{4}-\d{2}-\d{2}\.ndjson$/.test(f)).sort();
        for (const f of old.slice(0, Math.max(0, old.length - KEEP_DAYS))) fs.unlinkSync(path.join(DIR, f));
    } catch { /* logging is best effort */ }
}
rotate();

// Only her own agent process writes agent.ndjson (agent.js calls setLogOwner at start). Anything else that imports this module - dev
// test bots, offline checks - writes test.ndjson, so it cannot land in her natural-play audits (2026-10-26, GPT #3081).
let target = path.join(DIR, 'test.ndjson');
export function setLogOwner() { target = FILE; }
function write(tag, entry) {
    try { fs.appendFileSync(target, `[${tag}] ${JSON.stringify(entry)}\n`); } catch { /* best effort */ }
}
export function logDecision(entry) { write('decision', { at: Date.now(), ...entry }); }
let actObserver = null;
/** Something that wants every [act] entry as it is written (agent.js: failures -> memory lessons). */
export function setActObserver(fn) { actObserver = typeof fn === 'function' ? fn : null; }
export function logAct(entry) { const e = { at: Date.now(), ...entry }; write('act', e); try { actObserver?.(e); } catch { /* best effort */ } }
/** [pos] every few seconds - PLAN I's stall test needs "moved under 1 m" (DeepSeek #3090: there was no position sampling). */
export function logPos(p) { write('pos', { at: Date.now(), x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 }); }
/** [lifecycle] (DeepSeek #2968): start, spawn, death, exit, MindServer link - so a long quiet stretch reads as "stopped" or "stuck". */
export function logLifecycle(event, detail = {}) { write('lifecycle', { at: Date.now(), event, ...detail }); }
/** [combat] one line per !fight encounter (contract #3351, schema DeepSeek): the receipt plus what else was true at the start. */
export function logCombat(entry) { write('combat', { at: Date.now(), ...entry }); }

/** The enum reason for a failed primitive, from what the skill (or she) said - bilingual (failure-reasons.js, DeepSeek #2972). */
export const reasonFrom = (text) => classifyFailure(String(text || ''));
const plain = (v) => {
    if (v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v)) return v;
    if (typeof v === 'object' && 'x' in v && 'y' in v && 'z' in v) return { x: v.x, y: v.y, z: v.z };   // a Vec3 or an entity position
    if (typeof v === 'object' && (v.name || v.username)) return v.username || v.name;   // an entity
    return String(v);
};
/**
 * A primitive skill that writes one [act] line per call: ok only when the skill itself returned true (the skills check the world
 * before they do), reason from its own log lines otherwise.
 */
export function actLogged(kind, fn, names) {
    const wrapped = async function (bot, ...args) {
        const at = Date.now(), before = String(bot?.output || '').length;
        let result, error;
        try { result = await fn(bot, ...args); if (isCancelledAction(bot)) result = false; return result; }
        catch (e) { error = e; throw e; }
        finally {
            const cancelled = isCancelledAction(bot);
            const ok = !cancelled && !error && result === true;
            const said = String(bot?.output || '').slice(before) + (error ? ' ' + error.message : '');
            const entry = { kind, args: Object.fromEntries(names.map((n, i) => [n, plain(args[i])]).filter(([, v]) => v !== undefined)), ok, ms: Date.now() - at };
            if (!ok) Object.assign(entry, { reason: cancelled || (error && /interrupt/i.test(error.message)) ? 'refused' : reasonFrom(said), msg: cancelled ? `Action cancelled${cancelledBy(bot) ? ` by ${cancelledBy(bot)}` : ''}; late result ignored.` : said.trim().slice(-200), ...(cancelled ? { cancelledBy: cancelledBy(bot) } : {}), tries: 1, fallback: 'none' });   // msg: DeepSeek #2968
            logAct(entry);
        }
    };
    // library/index.js reads each skill's name and its /** doc **/ from the function source - keep both those of the real skill, or the
    // skill vanishes from her docs and the code linter says it "does not exist" (found 2026-10-26: skills.collectBlock).
    Object.defineProperty(wrapped, 'name', { value: fn.name.replace(/^_/, '') });
    wrapped.toString = () => fn.toString();
    return wrapped;
}
